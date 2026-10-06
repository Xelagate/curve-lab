// Task 1: prove createConfigAndPool on devnet with a local keypair in each signing mode, then one buy.
// Usage: node scripts/devnet-proof.mjs [wallet-first|local-first|two-tx ...]   (default: all three)
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { Keypair, LAMPORTS_PER_SOL } from '@solana/web3.js'
import { connection, localWallet, createConfigAndPool, buy, readPool, txLink } from '../src/chain.js'
import { buildConfig } from '../src/sim.js'
import { PRESETS, inputsOf } from '../src/presets.js'

const demoConfig = () => buildConfig(inputsOf(PRESETS.devnet)).config

const dir = new URL('../.secrets/', import.meta.url), file = new URL('devnet-keypair.json', dir)
if (!existsSync(file)) { mkdirSync(dir, { recursive: true }); writeFileSync(file, JSON.stringify([...Keypair.generate().secretKey]), { mode: 0o600 }) }
const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(file, 'utf8'))))
const wallet = localWallet(kp)
const balance = async () => (await connection.getBalance(kp.publicKey)) / LAMPORTS_PER_SOL

console.log('wallet', kp.publicKey.toBase58(), 'balance', await balance(), 'SOL')
if (await balance() < 0.3) {
  try { await connection.confirmTransaction(await connection.requestAirdrop(kp.publicKey, LAMPORTS_PER_SOL), 'confirmed') }
  catch (e) {
    console.error(`Airdrop failed: ${e.message}\nFund ${kp.publicKey.toBase58()} with 1 devnet SOL at https://faucet.solana.com, then rerun.`)
    process.exit(1)
  }
}

const modes = process.argv.length > 2 ? process.argv.slice(2) : ['wallet-first', 'local-first', 'two-tx']
let pool
for (const mode of modes) {
  const before = await balance()
  try {
    const r = await createConfigAndPool(demoConfig(), wallet, mode === 'two-tx' ? { twoTx: true } : { order: mode })
    pool ??= r.pool
    console.log(`${mode}: OK, cost ${(before - await balance()).toFixed(5)} SOL, pool ${r.pool}`)
    for (const s of r.sent) console.log(`  ${txLink(s.signature)} bytes=${s.bytes}`)
  } catch (e) {
    console.log(`${mode}: FAILED ${e.message}`)
    if (e.logs) console.log(e.logs.join('\n'))
    process.exitCode = 1
  }
}
if (pool) {
  const s = await buy(pool, wallet, 50_000_000)
  console.log('buy 0.05 SOL:', txLink(s.signature))
  console.log(await readPool(pool))
}
