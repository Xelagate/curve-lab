import * as S from '@meteora-ag/dynamic-bonding-curve-sdk'
import BN from 'bn.js'
import { PRESETS, SHAPES, DEFAULTS, inputsOf } from './presets.js'
import * as sim from './sim.js'
import { encodeHash, decodeHash, configJson, inventJsonc, tsSnippet } from './export.js'
import * as chain from './chain.js'

// Self-check: the page's bn.js must be the SDK's instance, otherwise BN math across modules breaks.
if (!(S.buildCurveWithMarketCap(sim.builderParams(DEFAULTS)).migrationQuoteThreshold instanceof BN))
  throw new Error('bn.js instance mismatch between page and SDK')

export const $ = id => document.getElementById(id)
export const sol = (x, d = 4) => Number(x).toLocaleString('en-US', { maximumFractionDigits: d })

// [key, label, kind]; kind: number | select options | checkbox | weights
export const GROUPS = [
  ['Preset', [['preset', 'Start from', Object.entries(PRESETS).map(([k, p]) => [k, p.label])]]],
  ['Token', [['supply', 'Total supply'], ['baseDecimals', 'Decimals (6–9)']]],
  ['Market cap (SOL)', [['imc', 'Initial'], ['mmc', 'At graduation']]],
  ['Curve shape', [['shape', 'Shape', [['constant', 'Constant product'], ['flat', 'Flat'], ['exponential', 'Exponential'], ['long', 'Long']]],
    ['weights', '16 liquidity weights', 'weights']]],
  ['Anti-sniper fee', [['startBps', 'Start fee (bps)'], ['endBps', 'End fee (bps)'],
    ['feeMode', 'Decay', [['exponential', 'Exponential'], ['linear', 'Linear']]], ['periods', 'Periods'], ['duration', 'Duration (s)'],
    ['dynamicFee', 'Dynamic fee (not simulated)', 'checkbox']]],
  ['Fees', [['creatorFeePct', 'Creator share of trading fee %'], ['poolCreationFee', 'Pool creation fee (SOL)'],
    ['migFeePct', 'Migration fee %'], ['migCreatorPct', 'Creator share of migration fee %']]],
  ['LP after graduation (%)', [['lpPartner', 'Partner, unlocked'], ['lpPartnerLocked', 'Partner, locked'],
    ['lpCreator', 'Creator, unlocked'], ['lpCreatorLocked', 'Creator, locked'],
    ['dammTier', 'DAMM v2 fee tier', [[0, '0.25%'], [1, '0.3%'], [2, '1%'], [3, '2%'], [4, '4%'], [5, '6%']]]]],
  ['Simulation', [['buySol', 'Buy size (SOL)'], ['interval', 'Seconds between buys'],
    ['extraVolumeSol', 'Extra volume after the scheduler (SOL)'], ['hasReferral', 'Trades pass a referral account', 'checkbox']]],
]

function renderForm() {
  $('form').innerHTML = GROUPS.map(([title, fields]) => `<fieldset><legend>${title}</legend>${fields.map(([k, label, kind]) => {
    const input = Array.isArray(kind) ? `<select name="${k}">${kind.map(([v, t]) => `<option value="${v}">${t}</option>`).join('')}</select>`
      : kind === 'checkbox' ? `<input type="checkbox" name="${k}">`
      : kind === 'weights' ? `<input name="${k}" placeholder="1, 1, 1, …">`
      : `<input name="${k}" type="number" step="any">`
    return `<label class="${kind === 'weights' ? 'wide' : ''}">${label}${input}<span class="err" data-err="${k}"></span></label>`
  }).join('')}${title.startsWith('LP') ? '<span class="err" data-err="lp"></span>' : ''}</fieldset>`).join('')
}

function writeForm(inp) {
  for (const el of $('form').elements) {
    if (!(el.name in inp)) continue
    if (el.type === 'checkbox') el.checked = inp[el.name]
    else el.value = el.name === 'weights' ? inp.weights.join(', ') : inp[el.name]
  }
  $('form').elements.weights.closest('label').hidden = inp.shape === 'constant'
}

function readForm() {
  const inp = {}
  for (const el of $('form').elements) {
    if (!el.name || el.name === 'preset') continue
    inp[el.name] = el.type === 'checkbox' ? el.checked : ['shape', 'feeMode'].includes(el.name) ? el.value
      : el.name === 'weights' ? el.value.split(',').map(Number).filter(n => !Number.isNaN(n)) : Number(el.value)
  }
  return inp
}

function showErrors(errs) {
  for (const el of document.querySelectorAll('[data-err]')) el.textContent = errs[el.dataset.err] ?? ''
}

// Minimal SVG line chart: points [{x, y}].
function lineChart(points, { xLabel, yLabel, w = 640, h = 240 }) {
  const pad = { l: 64, r: 12, t: 10, b: 34 }
  const xs = points.map(p => p.x), ys = points.map(p => p.y)
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), 0, Math.max(...ys) * 1.05 || 1]
  const X = x => pad.l + (x - x0) / (x1 - x0 || 1) * (w - pad.l - pad.r)
  const Y = y => h - pad.b - (y - y0) / (y1 - y0) * (h - pad.t - pad.b)
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${X(p.x).toFixed(1)},${Y(p.y).toFixed(1)}`).join('')
  const tick = v => v >= 1000 ? sol(v, 0) : v >= 1 ? sol(v, 2) : v.toPrecision(2)
  return `<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="${yLabel} vs ${xLabel}">
    <line class="axis" x1="${pad.l}" y1="${h - pad.b}" x2="${w - pad.r}" y2="${h - pad.b}"/><line class="axis" x1="${pad.l}" y1="${pad.t}" x2="${pad.l}" y2="${h - pad.b}"/>
    <path class="plot" d="${d}"/>
    <text x="${pad.l}" y="${h - 8}">${tick(x0)}</text><text x="${w - pad.r}" y="${h - 8}" text-anchor="end">${tick(x1)} ${xLabel}</text>
    <text x="${pad.l - 6}" y="${pad.t + 10}" text-anchor="end">${tick(y1)}</text><text x="${pad.l - 6}" y="${h - pad.b}" text-anchor="end">0</text>
    <text x="${pad.l + 6}" y="${pad.t + 10}">${yLabel}</text></svg>`
}

export let last = null   // last valid {inp, config, params, run}; null while inputs are invalid (results stay dimmed)
let wallet = null, created = null, working = false

// Exports, share link and devnet actions work only on a valid current config.
function syncActions() {
  for (const b of document.querySelectorAll('#export button, #create, #buy, #read, #connect')) {
    b.disabled = working || (b.id === 'connect' ? false : b.id === 'read' ? !created
      : !last || (b.id === 'create' && !wallet) || (b.id === 'buy' && !created))
  }
  $('buy').textContent = last ? `Buy ${sol(last.inp.buySol)} SOL` : 'Buy'
}

function update() {
  const inp = readForm()
  $('form').elements.weights.closest('label').hidden = inp.shape === 'constant'
  history.replaceState(null, '', encodeHash(inp))
  $('export-out').textContent = ''   // an export is a snapshot; clear it so it is never shown stale
  URL.revokeObjectURL($('download').href); $('download').hidden = true
  const errs = sim.precheck(inp)
  if (!(inp.buySol > 0)) errs.buySol = 'must be > 0'
  if (!(inp.interval >= 0)) errs.interval = 'must be ≥ 0'
  const built = Object.keys(errs).length ? null : sim.buildConfig(inp)
  if (built?.error) errs.shape = `Meteora SDK: ${built.error}`
  showErrors(errs)
  $('results').classList.toggle('stale', !built?.config)
  if (!built?.config) { last = null; return syncActions() }
  let run
  try { run = sim.simulateBuys(built.config, { buyLamports: Math.round(inp.buySol * 1e9), interval: inp.interval, hasReferral: inp.hasReferral }) }
  catch (err) {
    last = null
    showErrors({ ...errs, buySol: `Simulation failed: ${err.message}` })
    $('results').classList.add('stale')
    return syncActions()
  }
  last = { inp, config: built.config, params: built.params, run }
  render(last)
  syncActions()
}

export function render({ inp, config, run }) {
  const s = sim.summary(config, inp)
  $('summary').innerHTML = `<h2>Summary</h2><dl>
    <dt>SOL to raise until graduation</dt><dd>${sol(s.thresholdSol)} SOL</dd>
    <dt>Start price → graduation price</dt><dd>${s.startPrice.toPrecision(3)} → ${s.gradPrice.toPrecision(3)} SOL per token</dd>
    <dt>Supply sold on the curve / into the pool</dt><dd>${sol(s.pctSold, 2)}% / ${sol(s.pctPool, 2)}%</dd>
    <dt>Buys of ${sol(inp.buySol)} SOL, one every ${inp.interval} s, to graduate</dt><dd>${run.buysToGraduate ?? (run.truncated ? 'more than 5000 buys' : 'not reached')}</dd></dl>`
  const curve = sim.curveSeries(config, inp)
  $('chart-curve').innerHTML = lineChart(curve.map(p => ({ x: p.raised, y: p.mcap })), { xLabel: 'SOL raised', yLabel: 'market cap, SOL' })
  const horizon = Math.max(10, Math.ceil(inp.duration * 1.2))
  $('chart-fee').innerHTML = lineChart(sim.feeSeries(config, horizon).map(p => ({ x: p.t, y: p.bps / 100 })), { xLabel: 'seconds', yLabel: 'fee, %' })
  const bot = sim.buyFee(config, Math.round(inp.buySol * 1e9), 0) / 1e9, human = sim.buyFee(config, Math.round(inp.buySol * 1e9), inp.duration) / 1e9
  $('bot-human').textContent = `A bot buying ${sol(inp.buySol)} SOL at t=0 pays ${sol(bot)} SOL in fees; a human buying at t=${inp.duration} s pays ${sol(human)} SOL.` +
    (inp.dynamicFee ? ` Dynamic fee is not simulated; it can add up to ${sol(inp.endBps * 0.2 / 100, 3)}% (20% of the end fee).` : '')
  renderRevenue({ inp, config, run })
}

renderForm()
const fromHash = decodeHash(location.hash)
const sane = (k, v) => k === 'weights' ? Array.isArray(v) && v.every(Number.isFinite) : typeof v === typeof DEFAULTS[k]
const merged = { ...DEFAULTS }
for (const [k, v] of Object.entries(fromHash && typeof fromHash === 'object' ? fromHash : {})) if (k in DEFAULTS && sane(k, v)) merged[k] = v
writeForm(merged)
$('form').addEventListener('input', e => {
  if (e.target.name === 'preset') { writeForm(inputsOf(PRESETS[e.target.value])); return update() }
  if (e.target.name === 'shape' && e.target.value !== 'constant') $('form').elements.weights.value = SHAPES[e.target.value].join(', ')
  update()
})
update()

// --- Revenue table and export ---
function renderRevenue({ inp, config, run }) {
  const rows = sim.revenue(run, config, inp, inp.extraVolumeSol)
  const cols = ['partner', 'creator', 'protocol', 'referral']
  const total = { source: 'Total', ...Object.fromEntries(cols.map(c => [c, rows.reduce((s, r) => s + r[c], 0)])) }
  $('revenue').innerHTML = `<h2>Who earns what, SOL</h2><div class="scroll"><table>
    <tr><th></th>${cols.map(c => `<th>${c}</th>`).join('')}</tr>
    ${[...rows, total].map(r => `<tr><td>${r.source}</td>${cols.map(c => `<td>${sol(r[c], 4)}</td>`).join('')}</tr>`).join('')}
    </table></div><p class="sub">Buys only. Simulated buys pay the real decaying fee; extra volume pays the end fee (${inp.endBps} bps).
    ${run.truncated ? 'Simulated-buy fees are partial: the simulation stopped at 5000 buys. ' : ''}Protocol keeps 20% of every trading fee (16% + 4% referral when a referral account is passed).</p>`
}

const EXPORTS = {
  json: ['curve-lab-config.json', l => configJson(l.config)],
  builder: ['curve-lab-builder-input.json', l => JSON.stringify(l.params, null, 2)],
  invent: ['dbc_config.jsonc', l => inventJsonc(l.inp, l.params)],
  ts: ['curve-lab.ts', l => tsSnippet(l.inp, l.params)],
}
$('export').addEventListener('click', e => {
  const kind = e.target.dataset.export
  if (!kind || !last) return
  const [name, make] = EXPORTS[kind], text = make(last), link = $('download')
  $('export-out').textContent = text
  URL.revokeObjectURL(link.href)
  link.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }))
  link.download = name; link.textContent = `Download ${name}`; link.hidden = false
})
$('share').onclick = async () => { await navigator.clipboard.writeText(location.href); $('share').textContent = 'Link copied' }

// --- Devnet test (Phantom) ---
const log = html => { $('devlog').insertAdjacentHTML('beforeend', html + '\n') }
const logText = t => { $('devlog').append(t + '\n') }   // untrusted RPC/wallet strings go through here, never log()
const a = (text, href) => `<a href="${href}" target="_blank" rel="noopener">${text}</a>`
const busy = fn => async () => {
  working = true; syncActions()
  try { await fn() } catch (err) { logText(`Error: ${err.message}${err.logs ? '\n' + err.logs.join('\n') : ''}`) } finally { working = false; syncActions() }
}

async function showPool() {
  const p = await chain.readPool(created.pool)
  log(`Progress to graduation ${(p.progress * 100).toFixed(2)}% · reserve ${sol(p.quoteReserve / 1e9)} SOL · ` +
    `fees so far: partner ${sol(p.partnerFeeSol, 6)} SOL, creator ${sol(p.creatorFeeSol, 6)} SOL`)
}

$('connect').onclick = busy(async () => {
  const provider = window.phantom?.solana
  if (!provider?.isPhantom) return log(`Phantom not found: install it from ${a('phantom.com', 'https://phantom.com')} and reload.`)
  wallet = await chain.phantomWallet(provider)
  log(`Connected ${a(wallet.publicKey.toBase58(), chain.accountLink(wallet.publicKey.toBase58()))}`)
})
$('create').onclick = busy(async () => {
  if (!last) return log('Fix the inputs first.')
  created = await chain.createConfigAndPool(last.config, wallet)
  for (const s of created.sent) log(`Sent ${a(s.signature.slice(0, 20) + '…', chain.txLink(s.signature))} (${s.bytes} bytes)`)
  log(`Config ${a(created.config, chain.accountLink(created.config))}\nPool ${a(created.pool, chain.accountLink(created.pool))}`)
})
$('buy').onclick = busy(async () => {
  if (!last) return log('Fix the inputs first.')
  const { buySol } = last.inp
  const s = await chain.buy(created.pool, wallet, Math.round(buySol * 1e9))
  log(`Bought ${sol(buySol)} SOL: ${a(s.signature.slice(0, 20) + '…', chain.txLink(s.signature))}`)
  await showPool()
})
$('read').onclick = busy(showPool)
