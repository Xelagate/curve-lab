// Curve shapes: 16 relative liquidity weights, one per equal price step (buildCurveWithLiquidityWeights).
// More liquidity in a step = more SOL raised while the price is in that step.
const geo = r => Array.from({ length: 16 }, (_, i) => Number((r ** i).toFixed(4)))
export const SHAPES = {
  flat: Array(16).fill(1),   // liquidity spread evenly over price levels
  exponential: geo(0.8),     // most SOL raised at low prices, price shoots up near graduation
  long: geo(1.25),           // price climbs early, long raise near the graduation price
}

export const DEFAULTS = {
  supply: 1_000_000_000, baseDecimals: 6,
  imc: 30, mmc: 300,
  shape: 'constant', weights: [],
  feeMode: 'exponential', startBps: 5000, endBps: 100, periods: 10, duration: 60,
  creatorFeePct: 20, poolCreationFee: 0,
  migFeePct: 0, migCreatorPct: 0,
  lpPartner: 0, lpPartnerLocked: 100, lpCreator: 0, lpCreatorLocked: 0,
  dammTier: 2, dynamicFee: false,
  buySol: 5, interval: 3, extraVolumeSol: 1000, hasReferral: false,
}

export const PRESETS = {
  meme: { label: 'Meme launch', ...DEFAULTS },
  jupiter: { label: 'Jupiter-style anti-sniper', ...DEFAULTS, startBps: 9900, endBps: 100, periods: 60, duration: 60,
    creatorFeePct: 50, lpPartnerLocked: 50, lpCreatorLocked: 50 },
  calm: { label: 'Calm launch', ...DEFAULTS, shape: 'flat', weights: SHAPES.flat, startBps: 100, endBps: 100, periods: 0, duration: 0,
    lpPartner: 45, lpPartnerLocked: 5, lpCreator: 45, lpCreatorLocked: 5 },
  devnet: { label: 'Devnet graduation demo (2.4 SOL)', ...DEFAULTS, imc: 1, mmc: 10, buySol: 0.1 },
}

export function inputsOf(preset) { const { label, ...inputs } = preset; return inputs }
