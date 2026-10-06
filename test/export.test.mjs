import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildConfig } from '../src/sim.js'
import { DEFAULTS, SHAPES } from '../src/presets.js'
import { configJson, inventJsonc, encodeHash, decodeHash } from '../src/export.js'

test('URL hash round-trip rebuilds an identical config', () => {
  const inp = { ...DEFAULTS, shape: 'long', weights: SHAPES.long, creatorFeePct: 35 }
  const back = decodeHash(encodeHash(inp))
  assert.deepEqual(back, inp)
  assert.equal(configJson(buildConfig(back).config), configJson(buildConfig(inp).config))
})

test('a broken or foreign hash decodes to null', () => {
  assert.equal(decodeHash(''), null)
  assert.equal(decodeHash('#c=%7Bbad'), null)
  assert.equal(decodeHash('#section-2'), null)
})

test('config JSON writes BN values as decimal strings', () => {
  const json = JSON.parse(configJson(buildConfig(DEFAULTS).config))
  assert.equal(json.migrationQuoteThreshold, '72075922005')
})

test('invent jsonc uses the builder mode that matches the curve shape', () => {
  for (const [shape, weights, mode] of [['constant', [], 1], ['flat', SHAPES.flat, 3]]) {
    const inp = { ...DEFAULTS, shape, weights }
    const text = inventJsonc(inp, buildConfig(inp).params)
    const file = JSON.parse(text.slice(text.indexOf('\n') + 1))
    assert.equal(file.dbcConfig.buildCurveMode, mode)
    assert.equal(file.dbcConfig.initialMarketCap, 30)
    assert.equal('liquidityWeights' in file.dbcConfig, mode === 3)
  }
})
