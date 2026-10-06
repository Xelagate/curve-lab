import { test } from 'node:test'
import assert from 'node:assert/strict'
import { precheck, buildConfig } from '../src/sim.js'
import { DEFAULTS, SHAPES, PRESETS, inputsOf } from '../src/presets.js'

const FIXTURE = { ...DEFAULTS }

test('fixture builds with threshold 72,075,922,005 lamports', () => {
  const { config, error } = buildConfig(FIXTURE)
  assert.equal(error, null)
  assert.equal(config.migrationQuoteThreshold.toString(), '72075922005')
})
test('each curve shape builds and validates with 16 segments', () => {
  for (const [shape, weights] of Object.entries(SHAPES)) {
    const { config, error } = buildConfig({ ...FIXTURE, shape, weights })
    assert.equal(error, null, shape)
    assert.equal(config.curve.length, 16, shape)
  }
})

test('every preset passes precheck and builds', () => {
  for (const [name, p] of Object.entries(PRESETS)) {
    const inp = inputsOf(p)
    assert.deepEqual(precheck(inp), {}, name)
    assert.equal(buildConfig(inp).error, null, name)
  }
})

test('devnet preset graduates at about 2.40 SOL', () => {
  const { config } = buildConfig(inputsOf(PRESETS.devnet))
  assert.equal(Math.round(config.migrationQuoteThreshold.toNumber() / 1e7) / 100, 2.4)
})

test('precheck gives field-level messages the program would hide behind "Invalid pool fees"', () => {
  const e = precheck({ ...FIXTURE, startBps: 100, endBps: 200, duration: 61, lpPartnerLocked: 5, lpPartner: 95 })
  assert.match(e.endBps, /≤ start/)
  assert.match(e.duration, /multiple of periods/)
  assert.match(e.lp, /10%/)
  assert.match(precheck({ ...FIXTURE, endBps: 10 }).endBps, /25–9900/)
})

test('precheck rejects a supply that overflows u64 raw units', () => {
  assert.match(precheck({ ...FIXTURE, supply: 1e12, baseDecimals: 9 }).supply, /u64/)
})

test('SDK errors come back as {error}, not exceptions', () => {
  const r = buildConfig({ ...FIXTURE, endBps: 10 })
  assert.equal(r.config, null)
  assert.match(r.error, /25 bps/)
})

test('precheck returns field message (no throw) for fractional baseDecimals', () => {
  const e = precheck({ ...FIXTURE, baseDecimals: 7.5 })
  assert(e.baseDecimals, 'should have baseDecimals error')
})

test('precheck returns field message (no throw) for Infinity supply', () => {
  const e = precheck({ ...FIXTURE, supply: Infinity })
  assert(e.supply, 'should have supply error')
})
