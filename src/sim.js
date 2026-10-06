// Pure Curve Lab model: inputs -> DBC config -> buy-by-buy simulation, fee series, revenue. No DOM, no RPC.
import * as S from '@meteora-ag/dynamic-bonding-curve-sdk'
import BN from 'bn.js'

const LAMPORTS = 1e9
const U64_MAX = 18446744073709551615n
// Any non-default pubkey: validateConfigParameters crashes on tokenSupply without a leftoverReceiver.
const PLACEHOLDER_RECEIVER = S.DYNAMIC_BONDING_CURVE_PROGRAM_ID

// Field-level checks that run before the SDK, because the program reports most fee errors as "Invalid pool fees".
export function precheck(inp) {
  const e = {}
  const int = (k, lo, hi) => { if (!Number.isInteger(inp[k]) || inp[k] < lo || inp[k] > hi) e[k] = `whole number ${lo}–${hi}` }
  int('baseDecimals', 6, 9)
  if (!Number.isFinite(inp.supply) || inp.supply <= 0 || (Number.isInteger(inp.baseDecimals) && BigInt(Math.round(inp.supply)) * 10n ** BigInt(inp.baseDecimals) > U64_MAX))
    e.supply = 'supply × 10^decimals must fit in u64 (≈1.8e19 raw units)'
  if (!(inp.imc > 0)) e.imc = 'must be > 0'
  if (!(inp.mmc > inp.imc)) e.mmc = 'must be above the initial market cap'
  int('startBps', 25, 9900); int('endBps', 25, 9900)
  if (!e.endBps && inp.endBps > inp.startBps) e.endBps = 'end fee must be ≤ start fee'
  if (inp.periods === 0) {
    if (inp.startBps !== inp.endBps || inp.duration !== 0) e.periods = 'fixed fee: set periods 0, duration 0 and end = start'
  } else {
    int('periods', 1, 65535)
    if (!(inp.duration > 0) || inp.duration % inp.periods !== 0) e.duration = 'duration must be a positive multiple of periods'
  }
  int('creatorFeePct', 0, 100); int('migFeePct', 0, 99); int('migCreatorPct', 0, 100)
  if (inp.migFeePct === 0 && inp.migCreatorPct !== 0) e.migCreatorPct = 'must be 0 when the migration fee is 0'
  if (inp.poolCreationFee !== 0 && !(inp.poolCreationFee >= 0.001 && inp.poolCreationFee <= 100)) e.poolCreationFee = '0 or 0.001–100 SOL'
  const lp = inp.lpPartner + inp.lpPartnerLocked + inp.lpCreator + inp.lpCreatorLocked
  if (lp !== 100) e.lp = `LP shares sum to ${lp}%, must be 100%`
  else if (inp.lpPartnerLocked + inp.lpCreatorLocked < 10) e.lp = 'at least 10% of LP must be permanently locked'
  int('dammTier', 0, 5)
  if (inp.shape !== 'constant' && (inp.weights.length !== 16 || !inp.weights.every(w => w > 0)))
    e.weights = 'exactly 16 weights, each > 0'
  return e
}

export function builderParams(inp) {
  return {
    token: { tokenType: S.TokenType.SPLToken, tokenBaseDecimal: inp.baseDecimals, tokenQuoteDecimal: 9,
      tokenAuthorityOption: S.TokenAuthorityOption.Immutable, totalTokenSupply: inp.supply,
      // buildCurveWithLiquidityWeights throws "leftOverDelta must be less than totalLeftover" with leftover 0.
      leftover: inp.shape === 'constant' ? 0 : inp.supply / 1e6 },
    fee: {
      baseFeeParams: { baseFeeMode: inp.feeMode === 'linear' ? S.BaseFeeMode.FeeSchedulerLinear : S.BaseFeeMode.FeeSchedulerExponential,
        feeSchedulerParam: { startingFeeBps: inp.startBps, endingFeeBps: inp.endBps, numberOfPeriod: inp.periods, totalDuration: inp.duration } },
      dynamicFeeEnabled: inp.dynamicFee, collectFeeMode: S.CollectFeeMode.QuoteToken,
      creatorTradingFeePercentage: inp.creatorFeePct, poolCreationFee: inp.poolCreationFee, enableFirstSwapWithMinFee: false },
    migration: { migrationOption: S.MigrationOption.MET_DAMM_V2, migrationFeeOption: inp.dammTier,
      migrationFee: { feePercentage: inp.migFeePct, creatorFeePercentage: inp.migCreatorPct } },
    liquidityDistribution: { partnerLiquidityPercentage: inp.lpPartner, partnerPermanentLockedLiquidityPercentage: inp.lpPartnerLocked,
      creatorLiquidityPercentage: inp.lpCreator, creatorPermanentLockedLiquidityPercentage: inp.lpCreatorLocked },
    lockedVesting: { totalLockedVestingAmount: 0, numberOfVestingPeriod: 0, cliffUnlockAmount: 0, totalVestingDuration: 0, cliffDurationFromMigrationTime: 0 },
    activationType: S.ActivationType.Timestamp,
    initialMarketCap: inp.imc, migrationMarketCap: inp.mmc,
    ...(inp.shape === 'constant' ? {} : { liquidityWeights: inp.weights }),
  }
}

// -> { config, params, error }. The builder itself throws for some inputs, so both calls share one try.
export function buildConfig(inp) {
  try {
    const params = builderParams(inp)
    const config = inp.shape === 'constant' ? S.buildCurveWithMarketCap(params) : S.buildCurveWithLiquidityWeights(params)
    S.validateConfigParameters({ ...config, leftoverReceiver: PLACEHOLDER_RECEIVER })
    return { config, params, error: null }
  } catch (err) { return { config: null, params: null, error: err.message } }
}

const migrationSqrtPrice = c => S.getMigrationThresholdPrice(c.migrationQuoteThreshold, c.sqrtStartPrice, c.curve)

// Shape the swap quoter expects (research §3).
function quoteConfig(c) {
  const df = c.poolFees.dynamicFee
  return { ...c, migrationSqrtPrice: migrationSqrtPrice(c),
    poolFees: { ...c.poolFees, dynamicFee: df ? { ...df, initialized: 1 } : { initialized: 0, binStep: 0, variableFeeControl: 0 } } }
}

function freshPool(c) {
  return { poolState: { sqrtPrice: c.sqrtStartPrice, baseReserve: new BN(0), quoteReserve: new BN(0), activationPoint: new BN(0),
    volatilityTracker: { lastUpdateTimestamp: new BN(0), sqrtPriceReference: c.sqrtStartPrice,
      volatilityAccumulator: new BN(0), volatilityReference: new BN(0) } } }
}

function quoteBuy(pool, qc, lamports, t, hasReferral) {
  const args = [pool, qc, false, new BN(lamports), 0, hasReferral, new BN(t), false]
  try { return S.swapQuoteExactIn(...args) }
  catch (err) {
    if (err.message !== 'Insufficient Liquidity') throw err   // only the overshooting last buy is retried
    return S.swapQuotePartialFill(...args)
  }
}

export const priceOf = (sqrtPrice, baseDecimals) => Number(S.getPriceFromSqrtPrice(sqrtPrice, baseDecimals, 9).toString())

// Buys of buyLamports every `interval` seconds from t0 until graduation.
export function simulateBuys(c, { buyLamports, interval, t0 = 0, hasReferral = false, maxBuys = 5000 }) {
  const qc = quoteConfig(c), pool = freshPool(c), thr = c.migrationQuoteThreshold, buys = []
  let trading = 0, protocol = 0, referral = 0
  for (let i = 0; i < maxBuys && pool.poolState.quoteReserve.lt(thr); i++) {
    const t = t0 + i * interval
    const q = quoteBuy(pool, qc, buyLamports, t, hasReferral)
    // Mirror the program's apply_swap_result (collectFeeMode QuoteToken).
    pool.poolState.sqrtPrice = q.nextSqrtPrice
    pool.poolState.quoteReserve = pool.poolState.quoteReserve.add(q.excludedFeeInputAmount)
    const fee = q.tradingFee.add(q.protocolFee).add(q.referralFee).toNumber()
    trading += q.tradingFee.toNumber(); protocol += q.protocolFee.toNumber(); referral += q.referralFee.toNumber()
    buys.push({ t, paid: q.includedFeeInputAmount.toNumber(), fee, feeBps: (fee / q.includedFeeInputAmount.toNumber()) * 1e4,
      reserve: pool.poolState.quoteReserve.toNumber(), sqrtPrice: q.nextSqrtPrice })
  }
  const graduated = pool.poolState.quoteReserve.gte(thr)
  return { buys, graduated, truncated: !graduated, buysToGraduate: graduated ? buys.length : null, hasReferral,
    surplus: graduated ? pool.poolState.quoteReserve.sub(thr).toNumber() : 0,
    fees: { trading, protocol, referral }, pool: pool.poolState }
}

export function summary(c, inp) {
  const mig = migrationSqrtPrice(c)
  const total = c.tokenSupply.preMigrationTokenSupply
  const pct = bn => bn.muln(10000).div(total).toNumber() / 100
  const sold = pct(S.getBaseTokenForSwap(c.sqrtStartPrice, mig, c.curve))
  const leftover = builderParams(inp).token.leftover / inp.supply * 100
  return { thresholdSol: c.migrationQuoteThreshold.toNumber() / LAMPORTS,
    startPrice: priceOf(c.sqrtStartPrice, inp.baseDecimals), gradPrice: priceOf(mig, inp.baseDecimals),
    pctSold: sold, pctPool: 100 - sold - leftover }
}

// Base (scheduler) fee in bps at ~200 evenly spaced whole seconds in 0..seconds. Dynamic fee is not simulated.
export function feeSeries(c, seconds) {
  const b = c.poolFees.baseFee, out = []
  const ts = [...new Set(Array.from({ length: 201 }, (_, i) => Math.round(seconds * i / 200)))]
  for (const t of ts) {
    const num = S.getBaseFeeNumerator(b.cliffFeeNumerator, b.firstFactor, b.secondFactor, b.thirdFactor, b.baseFeeMode, new BN(t), new BN(0))
    out.push({ t, bps: num.toNumber() / 1e5 })
  }
  return out
}

// Fee in lamports for one buy of buyLamports on a fresh pool at second t ("bot at t=0 vs human at t=T").
export function buyFee(c, buyLamports, t) {
  const q = quoteBuy(freshPool(c), quoteConfig(c), buyLamports, t, false)
  return q.tradingFee.add(q.protocolFee).add(q.referralFee).toNumber()
}

// Price and market cap vs SOL raised, sampled in n equal steps after the scheduler ends.
export function curveSeries(c, inp, n = 48) {
  const step = Math.ceil(c.migrationQuoteThreshold.toNumber() / n)
  const sim = simulateBuys(c, { buyLamports: step, interval: 0, t0: inp.duration + 1 })
  const start = { raised: 0, price: priceOf(c.sqrtStartPrice, inp.baseDecimals) }
  return [start, ...sim.buys.map(b => ({ raised: b.reserve / LAMPORTS, price: priceOf(b.sqrtPrice, inp.baseDecimals) }))]
    .map(p => ({ ...p, mcap: p.price * inp.supply }))
}

// Who earns what, in SOL. Constants: research §7 (protocol 20% of fee, referral 20% of protocol, surplus 80/20, creation fee 90/10).
export function revenue(sim, c, inp, extraVolumeSol) {
  const cr = inp.creatorFeePct / 100
  const split80 = x => ({ partner: x * (1 - cr), creator: x * cr })
  const row = (source, o) => ({ source, partner: 0, creator: 0, protocol: 0, referral: 0, ...o })
  const extraFee = extraVolumeSol * LAMPORTS * inp.endBps / 1e4
  const extraProtocol = extraFee * 0.2, extraReferral = sim.hasReferral ? extraProtocol * 0.2 : 0
  const tierPct = [0.25, 0.3, 1, 2, 4, 6][inp.dammTier]
  const lpFee = extraVolumeSol * LAMPORTS * tierPct / 100
  const extraRow = sim.graduated
    ? row(`DAMM v2 LP fees, extra ${extraVolumeSol} SOL at ${tierPct}% (before DAMM v2 protocol cut, not verified)`,
      { partner: lpFee * (inp.lpPartner + inp.lpPartnerLocked) / 100, creator: lpFee * (inp.lpCreator + inp.lpCreatorLocked) / 100 })
    : row(`Trading fees, extra ${extraVolumeSol} SOL at end fee`, { ...split80(extraFee * 0.8), protocol: extraProtocol - extraReferral, referral: extraReferral })
  const creation = c.poolCreationFee.toNumber()
  const migFee = c.migrationQuoteThreshold.toNumber() * inp.migFeePct / 100
  const rows = [
    row(`Trading fees, simulated buys${sim.truncated ? ' (partial: 5000 buys cap)' : ''}`, { ...split80(sim.fees.trading), protocol: sim.fees.protocol, referral: sim.fees.referral }),
    extraRow,
    row('Pool creation fee', { partner: creation * 0.9, protocol: creation * 0.1 }),
    row('Migration fee', { partner: migFee * (1 - inp.migCreatorPct / 100), creator: migFee * inp.migCreatorPct / 100 }),
    row('Surplus (last buy overshoot)', { ...split80(sim.surplus * 0.8), protocol: sim.surplus * 0.2 }),
  ]
  const sol = r => ({ ...r, partner: r.partner / LAMPORTS, creator: r.creator / LAMPORTS, protocol: r.protocol / LAMPORTS, referral: r.referral / LAMPORTS })
  return rows.map(sol)
}
