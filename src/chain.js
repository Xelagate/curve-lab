// Devnet only: build, sign and send DBC transactions; read pool state. Never asks for or stores a private key.
import * as S from '@meteora-ag/dynamic-bonding-curve-sdk'
import { Connection, Keypair, PublicKey, Transaction } from '@solana/web3.js'
import BN from 'bn.js'

export const DEVNET_RPC = 'https://api.devnet.solana.com'
export const WSOL = new PublicKey('So11111111111111111111111111111111111111112')   // NATIVE_MINT lives in spl-token
export const connection = new Connection(DEVNET_RPC, 'confirmed')
const client = new S.DynamicBondingCurveClient(connection, 'confirmed')

export const txLink = sig => `https://solscan.io/tx/${sig}?cluster=devnet`
export const accountLink = addr => `https://solscan.io/account/${addr}?cluster=devnet`

// A wallet is { publicKey, signTransaction(tx) -> Promise<tx> } — Phantom's provider, or localWallet() in Node.
export const localWallet = kp => ({ publicKey: kp.publicKey, signTransaction: async tx => { tx.partialSign(kp); return tx } })

// Phantom returns objects from its own web3.js copy; rebuild them with ours so the SDK and partialSign see our classes.
export async function phantomWallet(provider) {
  const { publicKey } = await provider.connect()
  return { publicKey: new PublicKey(publicKey.toString()),
    signTransaction: async tx => Transaction.from((await provider.signTransaction(tx)).serialize({ requireAllSignatures: false, verifySignatures: false })) }
}

const sameBytes = (a, b) => a.length === b.length && a.every((x, i) => x === b[i])

// order 'wallet-first' (spec default) or 'local-first' (fallback 1).
async function signAndSend(tx, wallet, signers, order) {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash()
  tx.feePayer = wallet.publicKey
  tx.recentBlockhash = blockhash
  const before = tx.serializeMessage()
  let signed
  if (order === 'local-first') { if (signers.length) tx.partialSign(...signers); signed = await wallet.signTransaction(tx) }
  else { signed = await wallet.signTransaction(tx); if (signers.length) signed.partialSign(...signers) }
  const raw = signed.serialize()
  const mutated = !sameBytes(before, signed.serializeMessage())
  const signature = await connection.sendRawTransaction(raw)
  const res = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed')
  if (res.value.err) throw new Error(`tx failed: ${JSON.stringify(res.value.err)} ${txLink(signature)}`)
  return { signature, bytes: raw.length, mutated }
}

// One tx (createConfigAndPool) or, with twoTx, createConfig then createPool (fallback 2).
export async function createConfigAndPool(config, wallet, { order = 'wallet-first', twoTx = false,
  name = 'Curve Lab Test', symbol = 'CLAB', uri = 'https://xelagate.github.io/curve-lab/public/metadata.json' } = {}) {
  const configKp = Keypair.generate(), mintKp = Keypair.generate(), me = wallet.publicKey
  const accounts = { config: configKp.publicKey, feeClaimer: me, leftoverReceiver: me, quoteMint: WSOL, payer: me }
  const pool = { baseMint: mintKp.publicKey, name, symbol, uri, poolCreator: me }
  const sent = []
  if (!twoTx) {
    const tx = await client.partner.createConfigAndPool({ ...config, ...accounts, preCreatePoolParam: pool })
    sent.push(await signAndSend(tx, wallet, [configKp, mintKp], order))
  } else {
    sent.push(await signAndSend(await client.partner.createConfig({ ...config, ...accounts }), wallet, [configKp], order))
    const tx = await client.creator.createPool({ ...pool, config: configKp.publicKey, payer: me })
    sent.push(await signAndSend(tx, wallet, [mintKp], order))
  }
  return { config: configKp.publicKey.toBase58(), mint: mintKp.publicKey.toBase58(),
    pool: S.deriveDbcPoolAddress(WSOL, mintKp.publicKey, configKp.publicKey).toBase58(), sent }
}

// Devnet test buy. PartialFill so the graduating buy fills up to the threshold instead of failing;
// minimumAmountOut 0 because this is devnet SOL only.
export async function buy(pool, wallet, lamports) {
  const tx = await client.pool.swap2({ owner: wallet.publicKey, pool: new PublicKey(pool), swapBaseForQuote: false,
    referralTokenAccount: null, swapMode: S.SwapMode.PartialFill, amountIn: new BN(lamports), minimumAmountOut: new BN(0) })
  return signAndSend(tx, wallet, [], 'wallet-first')
}

export async function readPool(pool) {
  const p = (await client.state.getPool(pool))?.poolState   // SDK 1.5.13 wraps the account in { poolState }
  if (!p) throw new Error(`pool ${pool} not found on devnet`)
  const f = await client.state.getPoolFeeBreakdown(pool)
  return { sqrtPrice: p.sqrtPrice.toString(), quoteReserve: p.quoteReserve.toString(), activationPoint: p.activationPoint.toNumber(),
    isMigrated: !!p.isMigrated, progress: await client.state.getPoolQuoteTokenCurveProgress(pool),
    partnerFeeSol: f.partner.totalQuoteFee.toNumber() / 1e9, creatorFeeSol: f.creator.totalQuoteFee.toNumber() / 1e9 }
}

export async function blockTime(signature) {
  return (await connection.getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 })).blockTime
}
