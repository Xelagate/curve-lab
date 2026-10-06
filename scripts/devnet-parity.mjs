// After one real devnet buy, on-chain sqrtPrice and quoteReserve must equal the simulator's state
// after one buy of the same size at the same second. Uses the funded key from Task 1.
import { readFileSync } from 'node:fs'
import { Keypair } from '@solana/web3.js'
import { localWallet, createConfigAndPool, buy, readPool, blockTime, txLink } from '../src/chain.js'
import { buildConfig, simulateBuys } from '../src/sim.js'
import { PRESETS, inputsOf } from '../src/presets.js'

const secret = JSON.parse(readFileSync(new URL('../.secrets/devnet-keypair.json', import.meta.url), 'utf8'))
const wallet = localWallet(Keypair.fromSecretKey(Uint8Array.from(secret)))
const { config } = buildConfig(inputsOf(PRESETS.devnet))
const lamports = 100_000_000

const made = await createConfigAndPool(config, wallet)
const { signature } = await buy(made.pool, wallet, lamports)
const onChain = await readPool(made.pool)
const t = (await blockTime(signature)) - onChain.activationPoint
console.log('pool', made.pool, 'buy', txLink(signature), 'seconds after activation', t)
console.log('chain', { sqrtPrice: onChain.sqrtPrice, quoteReserve: onChain.quoteReserve })

// blockTime can differ from the program's Clock by a second or two; report which offset matches.
for (const dt of [0, -1, 1, -2, 2]) {
  const s = simulateBuys(config, { buyLamports: lamports, interval: 0, t0: Math.max(0, t + dt), maxBuys: 1 }).pool
  if (s.sqrtPrice.toString() === onChain.sqrtPrice && s.quoteReserve.toString() === onChain.quoteReserve) {
    console.log(`PARITY OK (simulated at t=${t + dt}, blockTime offset ${dt} s)`)
    process.exit(0)
  }
}
const s = simulateBuys(config, { buyLamports: lamports, interval: 0, t0: t, maxBuys: 1 }).pool
console.log('sim  ', { sqrtPrice: s.sqrtPrice.toString(), quoteReserve: s.quoteReserve.toString() })
console.log('PARITY MISMATCH')
process.exit(1)
