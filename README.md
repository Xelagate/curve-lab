# Curve Lab

Curve Lab is a single web page for designing a Meteora Dynamic Bonding Curve (DBC) config. It shows the graduation threshold, the anti-sniper fee decay and who earns what before you launch anything. You can then prove the config on devnet with Phantom and export it as JSON, a meteora-invent file or TypeScript.

Live page: https://xelagate.github.io/curve-lab/ <!-- TODO: confirm live link after publish -->

## Why

- `meteora-invent` is CLI-only and prints the graduation threshold after the config is already created.
- Jupiter Studio has fixed economics, so there is nothing to design.
- No official tool simulates the curve, the fee decay and the revenue split before launch. launch.meteora.ag is a guide hub; its DBC page walks through creating a pool and has no simulator.

## How it works

- The curve comes from the Meteora SDK (`@meteora-ag/dynamic-bonding-curve-sdk`): `buildCurveWithMarketCap` or `buildCurveWithLiquidityWeights`.
- The config is checked with `validateConfigParameters`.
- The simulation is an offline loop of `swapQuoteExactIn` calls over a stream of buys, with the anti-sniper fee scheduler applied by time.
- On devnet the page runs `createConfigAndPool` and `swap2` through Phantom.
- The page is a bundle: `npm run build` (esbuild, from the lockfile) writes `dist/app.js`, which is committed. A CSP allows only the page itself and `api.devnet.solana.com`.

### What you can and cannot trust

- Devnet only. The RPC is hardcoded to `https://api.devnet.solana.com`.
- The connected wallet becomes the pool creator, partner, fee claimer and leftover receiver.
- The buy has no slippage bound (`minimumAmountOut` is 0). That is fine on devnet and not ready for mainnet.
- The dynamic fee is not simulated.
- After graduation, the revenue table counts DAMM v2 LP fees before DAMM v2's own protocol cut. That cut was not verified.
- The simulation covers buys only.

## Devnet proof

Create-config-and-pool was signed three ways with a local keypair (wallet-first, local-first, two transactions) and wallet-first was also signed in Phantom. All confirmed. Phantom rewrote the message (1063 to 1115 bytes) and the transaction still went through. Creating a config, pool and metadata costs about 0.0266 SOL on devnet.

| Mode | Script (local keypair) | Phantom |
|---|---|---|
| wallet-first (default) | [tx](https://solscan.io/tx/4R8RPfvR5g2NmjciDJBYtdbaawbVHu1LiUQMq8nPdLnZT7tbJDP8Ciuuz14rfykQYmbEJ1qTjkjMJRHHDtAHHtJg?cluster=devnet) | [tx](https://solscan.io/tx/xa4xwpbpFdD6ge3CBT71SUAFjAVfWfTAG8CMHmgfpBrXDEVkLH6h3a9PKVR12gXqMxT7arKRaKvMBNsm9XS52Nu?cluster=devnet) |
| local-first | [tx](https://solscan.io/tx/2mmDvEAmCsKDt1F4ZPLiX2yq7sWEQxiVGBqrv631CeFqsdNFKxbHGjpFV8mM29VaxRAHJb73ybLGSiVfKvphYffM?cluster=devnet) | not tried |
| two transactions | [tx 1](https://solscan.io/tx/2Yp8He7gptmfvfAKsCxNKSuBVhG4e7MAtGp2qca1dCUxj8vnpUPK2Gg8iCnqftX71tHGw5xM6MBUcKiS2FdveRcf?cluster=devnet), [tx 2](https://solscan.io/tx/N7z2BSn7ZX6aDU5yTHNX1mxp9ED5NqXkwpmg2jrn446pz4a3zbVyseFyUjdxzwwu6SKEHcjTwJkC29Pi2GbTwmj?cluster=devnet) | not tried |

A 0.05 SOL test buy through Phantom: [tx](https://solscan.io/tx/4gd7xgbCqFRKtWdeq2qV37vRNyco5Cv7KzxnzH4jiGG9ZC25RFCZq571PKFrbR23TFyaUnp9Zvg2cccb4a5jYbee?cluster=devnet).

### Simulator against the chain

I created a pool on devnet, bought 0.1 SOL one second after activation, and ran the same buy in the offline simulator. The pool's `sqrtPrice` and quote reserve matched the simulation exactly, with no time offset needed.

- Pool: [`GML2YqcyiVVvppRMK3k6i4PErSM46iincmBfg9pDVX85`](https://solscan.io/account/GML2YqcyiVVvppRMK3k6i4PErSM46iincmBfg9pDVX85?cluster=devnet)
- Buy: [tx](https://solscan.io/tx/2dbQigLLUbtXBssgNnhook38EckJw4b31VwYBcecjt28rSxHYYXbNSAwFzfT9UefUAyVon137FGzQMc7Cxhh7TCw?cluster=devnet)

### A full run on the page

On 2026-10-06 the whole flow ran from the page in Phantom: create config and pool, then buy 0.1 SOL. Pool progress went to 2.75%. Partner fees were 0.021642 SOL and creator fees 0.00541 SOL. The fees are high because the anti-sniper fee was still near its starting value.

- Config: [`vUXkF3buQWT7Lw4DCNYN7DnwifTXkbKy26bkgfjqNGx`](https://solscan.io/account/vUXkF3buQWT7Lw4DCNYN7DnwifTXkbKy26bkgfjqNGx?cluster=devnet)
- Pool: [`7yzjidmmZs73BR5UEmuhjRJHXeM8SKvkkZBNzTqK4rtR`](https://solscan.io/account/7yzjidmmZs73BR5UEmuhjRJHXeM8SKvkkZBNzTqK4rtR?cluster=devnet)

## Phantom on a new site

Phantom may show "This domain is new or has not been reviewed yet" and a simulation warning on a fresh `github.io` page. That is expected on devnet. Phantom showed no warnings in our runs.

## Run locally

```bash
npm install && npm test && npm run build && npm run serve
```

Then open http://127.0.0.1:8787. For the devnet test, turn on Testnet Mode in Phantom (Settings, Developer Settings), select Devnet, and get free SOL from https://faucet.solana.com.
