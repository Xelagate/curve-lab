import { test } from 'node:test'
import assert from 'node:assert/strict'
import { precheck, buildConfig, simulateBuys, summary, feeSeries, buyFee, curveSeries, revenue } from '../src/sim.js'
import { DEFAULTS, SHAPES } from '../src/presets.js'

// Research/review fixture: iMC 30 / mMC 300 SOL, 1B supply, decimals 6/9, exponential 5000 -> 100 bps,
// 10 periods / 60 s, creator 20%, LP 100% partner-locked, migration fee 0, FixedBps100.
const FIXTURE = { ...DEFAULTS }

test('fixture: threshold 72,075,922,005 lamports, 5 SOL buys every 3 s graduate on buy #18', () => {
  const { config, error } = buildConfig(FIXTURE)
  assert.equal(error, null)
  assert.equal(config.migrationQuoteThreshold.toString(), '72075922005')
  const sim = simulateBuys(config, { buyLamports: 5e9, interval: 3 })
  assert.equal(sim.buysToGraduate, 18)
  assert.ok(sim.pool.quoteReserve.gte(config.migrationQuoteThreshold))
})

test('each curve shape graduates', () => {
  for (const [shape, weights] of Object.entries(SHAPES)) {
    const { config } = buildConfig({ ...FIXTURE, shape, weights })
    assert.ok(simulateBuys(config, { buyLamports: 5e9, interval: 3 }).graduated, shape)
  }
})

test('the buy count depends on the interval because fees decay', () => {
  const { config } = buildConfig(FIXTURE)
  assert.equal(simulateBuys(config, { buyLamports: 5e9, interval: 0 }).buysToGraduate, 29)
  assert.equal(simulateBuys(config, { buyLamports: 5e9, interval: 10 }).buysToGraduate, 16)
})

test('fixed fee (0 periods) builds and its fee series is flat', () => {
  const inp = { ...FIXTURE, startBps: 100, endBps: 100, periods: 0, duration: 0 }
  assert.deepEqual(precheck(inp), {})
  const { config } = buildConfig(inp)
  assert.ok(feeSeries(config, 10).every(p => p.bps === 100))
})

test('fee series decays from start to end fee; a bot at t=0 pays more than a human at t=60', () => {
  const { config } = buildConfig(FIXTURE)
  const s = feeSeries(config, 70)
  assert.equal(s[0].bps, 5000)
  assert.ok(Math.abs(s[70].bps - 100) < 1)
  assert.ok(buyFee(config, 1e9, 0) > 10 * buyFee(config, 1e9, 60))
})

test('one buy larger than the whole raise graduates via partial fill', () => {
  const { config } = buildConfig(FIXTURE)
  const sim = simulateBuys(config, { buyLamports: 200e9, interval: 0 })
  assert.equal(sim.buysToGraduate, 1)
  assert.ok(sim.surplus >= 0)
})

test('summary and curve series are consistent with the threshold', () => {
  const { config } = buildConfig(FIXTURE)
  const s = summary(config, FIXTURE)
  assert.equal(s.thresholdSol, 72.075922005)
  assert.ok(Math.abs(s.pctSold + s.pctPool - 100) < 0.1)
  assert.ok(s.gradPrice / s.startPrice > 9.9 && s.gradPrice / s.startPrice < 10.1)
  const pts = curveSeries(config, FIXTURE)
  assert.ok(pts.at(-1).raised >= s.thresholdSol)
  assert.ok(pts.every((p, i) => i === 0 || p.price >= pts[i - 1].price))
})

test('revenue split: creator 20% -> partner 64 / creator 16 / protocol 20; referral takes 4 of protocol 20', () => {
  const { config } = buildConfig(FIXTURE)
  const none = { fees: { trading: 0, protocol: 0, referral: 0 }, surplus: 0 }
  const [, extra] = revenue({ ...none, hasReferral: false }, config, FIXTURE, 100)   // 100 SOL x 1% = 1 SOL fee
  assert.deepEqual([extra.partner, extra.creator, extra.protocol, extra.referral].map(x => +x.toFixed(9)), [0.64, 0.16, 0.2, 0])
  const [, ref] = revenue({ ...none, hasReferral: true }, config, FIXTURE, 100)
  assert.deepEqual([ref.protocol, ref.referral].map(x => +x.toFixed(9)), [0.16, 0.04])
})

test('revenue from simulated buys follows the same 80/20 split', () => {
  const { config } = buildConfig(FIXTURE)
  const sim = simulateBuys(config, { buyLamports: 5e9, interval: 3 })
  const [fees] = revenue(sim, config, FIXTURE, 0)
  const total = fees.partner + fees.creator + fees.protocol
  assert.ok(Math.abs(fees.protocol / total - 0.2) < 1e-6)
  assert.ok(Math.abs(fees.creator / total - 0.16) < 1e-6)
})

test('tiny buys hit the buy cap: truncated, not graduated', () => {
  const { config } = buildConfig(FIXTURE)
  const sim = simulateBuys(config, { buyLamports: 1e6, interval: 0 })
  assert.equal(sim.truncated, true)
  assert.equal(sim.buysToGraduate, null)
  assert.equal(simulateBuys(config, { buyLamports: 5e9, interval: 3 }).truncated, false)
})

test('feeSeries is capped near 200 points even for a very long scheduler', () => {
  const { config } = buildConfig(FIXTURE)
  const s = feeSeries(config, 1e6)
  assert.ok(s.length <= 201)
  assert.deepEqual([s[0].t, s.at(-1).t], [0, 1e6])
})

test('after graduation extra volume earns DAMM v2 LP fees, not DBC fees', () => {
  const { config } = buildConfig(FIXTURE)   // dammTier 2 = 1%, LP 100% partner-locked
  const none = { fees: { trading: 0, protocol: 0, referral: 0 }, surplus: 0, hasReferral: false, graduated: true }
  const [, extra] = revenue(none, config, FIXTURE, 100)
  assert.match(extra.source, /DAMM v2 LP fees/)
  assert.deepEqual([extra.partner, extra.creator, extra.protocol, extra.referral].map(x => +x.toFixed(9)), [1, 0, 0, 0])
})
