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

// --- Motion. Off under prefers-reduced-motion (values land instantly). Every tween starts from what is on screen now
// and is replaced, never queued, by the next input, so the last frame always shows the current state.
const EASE = 'cubic-bezier(0.23, 1, 0.32, 1)'
const easeOut = t => 1 - (1 - t) ** 4
const calm = () => matchMedia('(prefers-reduced-motion: reduce)').matches

// Hero numbers count from the value currently displayed (0 on first load) to the new one in 500ms.
let shown = [], tweenFrame = 0
function tweenNumbers() {
  cancelAnimationFrame(tweenFrame)
  const els = [...$('hero').querySelectorAll('.num')]
  const runs = els.map((el, i) => el.dataset.to ? { el, i, from: shown[i] ?? 0, to: +el.dataset.to, d: +el.dataset.d } : (shown[i] = undefined))
  if (calm()) { runs.forEach(r => r && (shown[r.i] = r.to)); return }
  const t0 = performance.now()
  $('hero').setAttribute('aria-busy', 'true')   // screen readers announce the settled value, not every frame
  const frame = now => {
    const k = Math.min(1, (now - t0) / 500), e = easeOut(k)
    for (const r of runs) if (r) { shown[r.i] = k < 1 ? r.from + (r.to - r.from) * e : r.to; r.el.textContent = sol(shown[r.i], r.d) }
    if (k < 1) tweenFrame = requestAnimationFrame(frame)
    else $('hero').setAttribute('aria-busy', 'false')
  }
  frame(t0)
}

// Replace a container's HTML; its stacked-bar segments grow from their current on-screen widths (keyed by colour).
function withBars(id, html) {
  const el = $(id), before = {}
  for (const i of el.querySelectorAll('.bar i')) before[i.style.background] = i.getBoundingClientRect().width / i.parentNode.getBoundingClientRect().width * 100
  el.innerHTML = html
  if (calm()) return
  for (const i of el.querySelectorAll('.bar i'))
    i.animate([{ width: `${before[i.style.background] ?? 0}%` }, { width: i.style.width }], { duration: 300, easing: EASE })
}

// Swap a chart's SVG; on 'morph' the line, area and marks travel from their on-screen positions to the new ones in 300ms.
const pointsOf = d => (d.match(/-?[\d.]+,-?[\d.]+/g) || []).map(p => p.split(',').map(Number))
const resample = (pts, n) => Array.from({ length: n }, (_, i) => {
  const f = n > 1 ? i * (pts.length - 1) / (n - 1) : 0, a = pts[Math.floor(f)], b = pts[Math.ceil(f)], t = f - Math.floor(f)
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
})
const chartFrames = {}
function morphInto(id, mode, html) {
  const box = $(id), old = box.querySelector('svg')
  const oldLine = old && pointsOf(old.querySelector('.plot').getAttribute('d'))
  const oldMarks = old ? [...old.querySelectorAll('.mk')].map(g => {
    const c = g.querySelector('circle:not(.ring)'), m = new DOMMatrix(getComputedStyle(g).transform)
    return [+c.getAttribute('cx') + m.e, +c.getAttribute('cy') + m.f]
  }) : []
  const sameSize = old?.getAttribute('viewBox') === html.match(/viewBox="([^"]+)"/)[1]
  cancelAnimationFrame(chartFrames[id])
  box.innerHTML = html
  const svg = box.querySelector('svg'), line = svg.querySelector('.plot'), area = svg.querySelector('.area')
  const ring = svg.querySelector('.ring')
  if (calm() || mode === 'none') return
  if (ring) ring.animate([{ opacity: .7, transform: 'scale(1)' }, { opacity: 0, transform: 'scale(2.8)' }], { duration: 700, easing: EASE, delay: mode === 'intro' ? 800 : 250 })
  if (mode !== 'morph' || !oldLine?.length || !sameSize) return
  const lineD = line.getAttribute('d'), tail = area.getAttribute('d').slice(lineD.length), to = pointsOf(lineD), from = resample(oldLine, to.length)
  svg.querySelectorAll('.mk').forEach((g, i) => {
    const c = g.querySelector('circle:not(.ring)'), o = oldMarks[i]
    if (o) g.animate([{ transform: `translate(${o[0] - c.getAttribute('cx')}px, ${o[1] - c.getAttribute('cy')}px)` }, { transform: 'none' }], { duration: 300, easing: EASE })
  })
  const t0 = performance.now()
  const frame = now => {
    const k = Math.min(1, (now - t0) / 300), e = easeOut(k)
    const d = k < 1 ? to.map(([x, y], i) => `${i ? 'L' : 'M'}${(from[i][0] + (x - from[i][0]) * e).toFixed(1)},${(from[i][1] + (y - from[i][1]) * e).toFixed(1)}`).join('') : lineD
    line.setAttribute('d', d); area.setAttribute('d', d + tail)
    if (k < 1) chartFrames[id] = requestAnimationFrame(frame)
  }
  frame(t0)
}

// Form tabs: [label, number of GROUPS entries]. Every field stays in the DOM; inactive panels are only hidden.
const TABS = [['Basics', 4], ['Fees', 2], ['After graduation', 1], ['Simulation', 1]]

function renderForm() {
  let at = 0
  $('tabs').innerHTML = TABS.map(([t], i) => `<button type="button" class="tab" role="tab" id="tab-${i}" aria-controls="panel-${i}" aria-selected="${!i}"><span class="n">${i + 1}</span>${t}</button>`).join('')
  $('form').innerHTML = TABS.map(([, n], i) => `<div role="tabpanel" id="panel-${i}" aria-labelledby="tab-${i}"${i ? ' hidden' : ''}>${GROUPS.slice(at, at += n).map(group).join('')}</div>`).join('')
  $('tabs').onclick = e => {
    const tab = e.target.closest('.tab'); if (!tab) return
    document.querySelectorAll('.tab').forEach((b, i) => {
      const panel = $(`panel-${i}`), show = b === tab
      if (show && panel.hidden && !calm()) panel.animate([{ opacity: 0, transform: 'translateY(4px)' }, { opacity: 1, transform: 'none' }], { duration: 180, easing: EASE })
      b.setAttribute('aria-selected', show); panel.hidden = !show
    })
  }
}

function group([title, fields]) {
  return `<fieldset><legend>${title}</legend>${fields.map(([k, label, kind]) => {
    const input = Array.isArray(kind) ? `<select name="${k}">${kind.map(([v, t]) => `<option value="${v}">${t}</option>`).join('')}</select>`
      : kind === 'checkbox' ? `<input type="checkbox" name="${k}">`
      : kind === 'weights' ? `<input name="${k}" placeholder="1, 1, 1, …">`
      : `<input name="${k}" type="number" step="any">`
    return `<label class="${kind === 'weights' || Array.isArray(kind) ? 'wide' : ''}">${label}${input}<span class="err" data-err="${k}"></span></label>`
  }).join('')}${title.startsWith('LP') ? '<span class="err" data-err="lp"></span>' : ''}</fieldset>`
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
  TABS.forEach((_, i) => $(`tab-${i}`).classList.toggle('has-err', [...$(`panel-${i}`).querySelectorAll('[data-err]')].some(el => el.textContent)))
}

// Minimal SVG line chart: points [{x, y}]; id keeps gradient ids unique per chart; marks [{x, y, text, gold}].
function lineChart(points, { id, xLabel, yLabel, marks = [], w = 640, h = 240, intro }) {
  const pad = { l: w < 480 ? 44 : 64, r: 16, t: 30, b: 34 }
  const xs = points.map(p => p.x), ys = points.map(p => p.y)
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), 0, Math.max(...ys) * 1.05 || 1]
  const X = x => pad.l + (x - x0) / (x1 - x0 || 1) * (w - pad.l - pad.r)
  const Y = y => h - pad.b - (y - y0) / (y1 - y0) * (h - pad.t - pad.b)
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${X(p.x).toFixed(1)},${Y(p.y).toFixed(1)}`).join('')
  const tick = v => v >= 1000 ? sol(v, 0) : v >= 1 ? sol(v, 2) : v.toPrecision(2)
  const grid = [0, .25, .5, .75, 1].map(f => `<line class="grid" x1="${pad.l}" x2="${w - pad.r}" y1="${Y(y1 * f).toFixed(1)}" y2="${Y(y1 * f).toFixed(1)}"/>`).join('')
  const area = `${d}L${X(x1).toFixed(1)},${Y(0)}L${X(x0).toFixed(1)},${Y(0)}Z`
  const mark = ({ x, y, text, gold }) => {
    const px = X(x), py = Y(y), right = px > w / 2, ty = gold ? py + 4 : py < h / 2 ? py + 22 : py - 12
    return `<g class="mk">${gold ? `<circle class="ring" cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="6"/>` : ''}<circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="${gold ? 6 : 5}" fill="${gold ? '#fdbf1c' : '#fff'}" stroke="#242433" stroke-width="2"/>
      <text class="mark${gold ? ' gold' : ''}" x="${(px + (right ? -12 : gold ? 12 : 8)).toFixed(1)}" y="${Math.max(ty, pad.t + 12).toFixed(1)}" text-anchor="${right ? 'end' : 'start'}">${text}</text></g>`
  }
  return `<svg${intro ? ' class="intro"' : ''} viewBox="0 0 ${w} ${h}" role="img" aria-label="${yLabel} vs ${xLabel}">
    <defs><linearGradient id="${id}-line"><stop offset="0" stop-color="#6a56e4"/><stop offset="1" stop-color="#f54b00"/></linearGradient>
    <linearGradient id="${id}-area" x2="0" y2="1"><stop offset="0" stop-color="#6a56e4" stop-opacity=".35"/><stop offset="1" stop-color="#6a56e4" stop-opacity="0"/></linearGradient></defs>
    ${grid}<path class="area" d="${area}" fill="url(#${id}-area)"/>
    <path class="plot" pathLength="1" d="${d}"${id === 'curve' ? ` style="stroke:url(#${id}-line)"` : ''}/>${marks.map(mark).join('')}
    <text x="${pad.l}" y="${h - 8}">${tick(x0)}</text><text x="${w - pad.r}" y="${h - 8}" text-anchor="end">${tick(x1)} ${xLabel}</text>
    <text x="${pad.l - 10}" y="${pad.t + 4}" text-anchor="end">${tick(y1)}</text><text x="${pad.l - 10}" y="${h - pad.b + 4}" text-anchor="end">0</text>
    <text x="${pad.l - 10}" y="${pad.t - 14}">${yLabel}</text></svg>`
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
  $('wallet-hint').hidden = !!wallet
}

const stale = on => { for (const id of ['results', 'hero', 'ticker']) $(id).classList.toggle('stale', on) }

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
  stale(!built?.config)
  if (!built?.config) { last = null; return syncActions() }
  let run
  try { run = sim.simulateBuys(built.config, { buyLamports: Math.round(inp.buySol * 1e9), interval: inp.interval, hasReferral: inp.hasReferral }) }
  catch (err) {
    last = null
    showErrors({ ...errs, buySol: `Simulation failed: ${err.message}` })
    stale(true)
    return syncActions()
  }
  last = { inp, config: built.config, params: built.params, run }
  render(last)
  syncActions()
}

// Charts are drawn at the container's real width so text stays legible on phones; re-drawn on resize.
// mode: 'intro' (first paint: draw-in), 'morph' (input change: old shape → new), 'none' (resize).
let charts = null
const widthOf = id => $(id).clientWidth || 640
function drawCharts(c = charts, mode = 'none') {
  if (!(charts = c)) return
  const { curve, grad, fees, feeAt, inp } = c
  const intro = mode === 'intro' && !calm()
  morphInto('chart-curve', mode, lineChart(curve.map(p => ({ x: p.raised, y: p.mcap })), { id: 'curve', w: widthOf('chart-curve'), intro, xLabel: 'SOL raised', yLabel: 'market cap, SOL',
    marks: [{ x: grad.raised, y: grad.mcap, text: `Graduation · ${sol(grad.mcap, 0)} SOL`, gold: true }] }))
  morphInto('chart-fee', mode, lineChart(fees, { id: 'fee', w: widthOf('chart-fee'), intro, xLabel: 'seconds', yLabel: 'fee, %',
    marks: [{ x: 0, y: feeAt(0).y, text: `Bot at t=0: ${sol(feeAt(0).y, 2)}%` }, { x: feeAt(inp.duration).x, y: feeAt(inp.duration).y, text: `Human at t=${inp.duration}s: ${sol(feeAt(inp.duration).y, 2)}%` }] }))
}
let resizeTimer, lastW = innerWidth
addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if (innerWidth !== lastW) { lastW = innerWidth; drawCharts() } }, 150) })

export function render({ inp, config, run }) {
  const s = sim.summary(config, inp)
  const curve = sim.curveSeries(config, inp), grad = curve.at(-1)
  const horizon = Math.max(10, Math.ceil(inp.duration * 1.2))
  const fees = sim.feeSeries(config, horizon).map(p => ({ x: p.t, y: p.bps / 100 }))
  const feeAt = t => fees.reduce((b, p) => Math.abs(p.x - t) < Math.abs(b.x - t) ? p : b)
  const buys = run.buysToGraduate ?? (run.truncated ? '5000+' : '—')
  const leftover = Math.max(0, 100 - s.pctSold - s.pctPool)
  const chips = [['Start price', `${s.startPrice.toPrecision(3)} SOL`], ['Graduation price', `${s.gradPrice.toPrecision(3)} SOL`],
    ['Fee at t=0', `${sol(feeAt(0).y, 2)}%`], [`Fee after ${inp.duration}s`, `${sol(feeAt(inp.duration).y, 2)}%`],
    ['Sold on curve', `${sol(s.pctSold, 2)}%`], ['Buys to graduate', buys]].map(([k, v]) => `<div class="chip"><span>${k}</span><b>${v}</b></div>`).join('')
  // Update the chips in place: replacing .track would restart the marquee on every keystroke.
  const halves = $('ticker').querySelectorAll('.track > div')
  if (halves.length) halves.forEach(h => { h.innerHTML = chips })
  else $('ticker').innerHTML = `<div class="track"><div>${chips}</div><div aria-hidden="true">${chips}</div></div>`
  const num = (v, d) => typeof v === 'number' ? `<span class="num" data-to="${v}" data-d="${d}">${sol(v, d)}</span>` : `<span class="num">${v}</span>`
  withBars('hero', `<div class="stats">
      <div class="stat"><span class="v">${num(grad.mcap, 0)}<small>SOL</small></span><span class="k">Market cap at graduation</span></div>
      <div class="stat"><span class="v">${num(s.thresholdSol, 2)}<small>SOL</small></span><span class="k">To raise until graduation</span></div>
      <div class="stat"><span class="v">${num(buys, 0)}</span><span class="k">Buys of ${sol(inp.buySol)} SOL, one every ${inp.interval} s, to graduate</span></div></div>
    <p class="prices">Price per token <b>${s.startPrice.toPrecision(3)}</b> → <b>${s.gradPrice.toPrecision(3)} SOL</b> at graduation</p>
    ${splitBar([['Sold on the curve', s.pctSold, '#6a56e4'], ['Into the pool', s.pctPool, '#f54b00'], ['Leftover', leftover, '#58587b']].filter(r => r[1] > 0.005), v => `${sol(v, 2)}%`, 100)}`)
  tweenNumbers()
  drawCharts({ curve, grad, fees, feeAt, inp }, charts ? 'morph' : 'intro')
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
setTimeout(() => document.body.classList.remove('enter'), 1500)

// Stacked horizontal bar with legend: rows [label, value, colour]; total = 100% width.
function splitBar(rows, fmt, total = rows.reduce((s, r) => s + r[1], 0)) {
  const pct = v => total ? v / total * 100 : 0
  return `<div class="split"><div class="bar">${rows.map(([, v, c]) => `<i style="width:${pct(v)}%;background:${c}"></i>`).join('')}</div>
    <div class="legend">${rows.map(([k, v, c]) => `<span style="--c:${c}">${k}<b>${fmt(v)}</b></span>`).join('')}</div></div>`
}

// --- Revenue table and export ---
function renderRevenue({ inp, config, run }) {
  const rows = sim.revenue(run, config, inp, inp.extraVolumeSol)
  const cols = ['partner', 'creator', 'protocol', 'referral']
  const total = { source: 'Total', ...Object.fromEntries(cols.map(c => [c, rows.reduce((s, r) => s + r[c], 0)])) }
  const colours = { partner: '#6a56e4', creator: '#d2d2ff', protocol: '#f54b00', referral: '#fdbf1c' }
  const sum = cols.reduce((s, c) => s + total[c], 0)
  withBars('revenue', `<h2>Who earns what, SOL</h2>${splitBar(cols.map(c => [c[0].toUpperCase() + c.slice(1), total[c], colours[c]]),
    v => `${sol(v, 2)} SOL (${sol(sum ? v / sum * 100 : 0, 1)}%)`)}<div class="scroll"><table>
    <tr><th></th>${cols.map(c => `<th>${c}</th>`).join('')}</tr>
    ${[...rows, total].map(r => `<tr><td>${r.source}</td>${cols.map(c => `<td>${sol(r[c], 4)}</td>`).join('')}</tr>`).join('')}
    </table></div><p class="sub">Buys only. Simulated buys pay the real decaying fee; extra volume pays the end fee (${inp.endBps} bps).
    ${run.truncated ? 'Simulated-buy fees are partial: the simulation stopped at 5000 buys. ' : ''}Protocol keeps 20% of every trading fee (16% + 4% referral when a referral account is passed).</p>`)
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
  if (p.progress >= 1 && !p.isMigrated)
    log(`Graduated. Migrate it to DAMM v2 on ${a('migrator.meteora.ag', 'https://migrator.meteora.ag')} (choose Devnet), using pool ${created.pool}.`)
  if (p.isMigrated) log('Migrated to DAMM v2.')
}

$('connect').onclick = busy(async () => {
  const provider = window.phantom?.solana
  if (!provider?.isPhantom) return log(`Phantom not found: install it from ${a('phantom.com', 'https://phantom.com')} and reload.`)
  wallet = await chain.phantomWallet(provider)
  log(`Connected ${a(wallet.publicKey.toBase58(), chain.accountLink(wallet.publicKey.toBase58()))}`)
  const key = wallet.publicKey.toBase58(), btn = $('connect')
  btn.textContent = `${key.slice(0, 4)}…${key.slice(-3)}`; btn.title = key; btn.classList.add('on')
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
