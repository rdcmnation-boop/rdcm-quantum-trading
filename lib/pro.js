// Reglas de "day trader" profesional, explícitas y auditables (funciones puras, sin red).
// Filosofía: operar solo cuando el movimiento esperado supera con holgura el costo real de entrar y salir,
// dimensionar por volatilidad, salir con stop dinámico, y volverse más cauteloso si los últimos trades salen mal.
import { sma, rsi, stdev } from './indicators.js';
import { simulateFill } from './costs.js';

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

export function features(closes) {
  const n = closes.length;
  if (n < 60) return null;
  const rets = []; for (let i = n - 48; i < n; i++) rets.push(closes[i] / closes[i - 1] - 1);
  const px = closes[n - 1];
  const hi24 = Math.max(...closes.slice(-24));
  return { px, vol: stdev(rets), s10: sma(closes, 10), s30: sma(closes, 30), s50: sma(closes, 50), rsi: rsi(closes, 14),
    roc6: px / closes[n - 7] - 1, roc24: px / closes[n - 25] - 1, offHigh: px / hi24 - 1 };
}

// Costo de ida y vuelta (comisión + spread + impacto) en % para un tamaño y exchange.
export function roundTripPct({ symbol, exchange, usd, price }) {
  const b = simulateFill({ side: 'buy', usd, price, symbol, exchange });
  const s = simulateFill({ side: 'sell', usd, price, symbol, exchange });
  return b.feePct + b.slipPct + s.feePct + s.slipPct;
}

// Movimiento esperado en ~12 h (1 desviación estándar) en %.
export const expectedMovePct = (f) => f.vol * 100 * Math.sqrt(12);

// Puntaje de confianza 0–100: qué tan por encima del umbral de costos está la ventaja (no es una probabilidad de ganar).
export const confidenceOf = (edge, need) => Math.max(5, Math.min(95, Math.round(45 + 25 * ((edge || 0) / (need || 1) - 1))));

export function entrySignal(f, { rtPct, regime = null, risk = 'normal' }) {
  if (!f) return { ok: false, reason: 'faltan datos' };
  if (risk === 'pausa') return { ok: false, reason: 'pausa por racha negativa' };
  const up = f.s10 > f.s30 && f.s30 >= f.s50 * 0.995 && f.px > f.s10;
  if (!up) return { ok: false, reason: 'sin tendencia alcista limpia' };
  if (!(f.roc6 > 0 && f.roc24 > 0)) return { ok: false, reason: 'momentum 6 h / 24 h no es positivo' };
  if (f.rsi === null || f.rsi < 42 || f.rsi > 72) return { ok: false, reason: `RSI ${f.rsi === null ? '—' : f.rsi.toFixed(0)} fuera de 42–72` };
  if (f.offHigh < -0.06) return { ok: false, reason: 'lejos del máximo de 24 h' };
  const exp = expectedMovePct(f);
  const need = (risk === 'defensivo' || regime === 'bear') ? 2 : 1.05;
  const edge = exp / rtPct;
  const regEs = regime ? regimeEs(regime) : null;
  const ev = [`Tendencia: SMA10 ${f.s10.toFixed(f.s10 < 10 ? 4 : 2)} sobre SMA30 ${f.s30.toFixed(f.s30 < 10 ? 4 : 2)}, precio sobre ambas`, `RSI ${f.rsi.toFixed(0)} (zona sana 42–72)`, `Momentum +${(f.roc6 * 100).toFixed(2)} % en 6 h y +${(f.roc24 * 100).toFixed(2)} % en 24 h`, `Movimiento esperado ${exp.toFixed(2)} % vs costo ida y vuelta ${rtPct.toFixed(2)} % = ${edge.toFixed(1)}× (mínimo ${need}×)`].concat(regEs ? [`Mercado ${regEs}`] : []);
  const stopPct = Math.min(8, Math.max(1.5, f.vol * 100 * 4)); const rr = Math.max(0, (exp - rtPct) / stopPct);
  ev.push(`Stop sugerido −${stopPct.toFixed(1)} % · objetivo +${exp.toFixed(2)} % · R:R neto de costos ${rr.toFixed(1)}:1 (referencia 1.8:1)`, `Invalidación: pierde la SMA10 o cae al stop`);
  const conf = confidenceOf(edge, need);
  if (edge < need) return { ok: false, reason: `movimiento esperado ${exp.toFixed(2)} % vs costo ida y vuelta ${rtPct.toFixed(2)} % (necesita ${need}×)`, edge, need, rr, conf: Math.min(conf, 40), ev };
  const size = regime === 'volatile' || risk === 'defensivo' ? 0.5 : 1;
  return { ok: true, edge, need, rr, conf, ev, size, score: edge * (1 + Math.max(0, f.roc6 / (f.vol || 1)) / 10),
    reason: `tendencia alcista, RSI ${f.rsi.toFixed(0)}, movimiento esperado ${exp.toFixed(2)} % = ${edge.toFixed(1)}× el costo (${rtPct.toFixed(2)} %)` };
}

export function exitSignal(f, { avgCost, heldHours, highSince, rtPct, stopLossPct = 8 }) {
  const trail = clamp(f.vol * 100 * 4, 1.5, 8) / 100;
  const stop = Math.max(Math.max(highSince, f.px) * (1 - trail), avgCost * (1 - stopLossPct / 100));
  const gain = (f.px / avgCost - 1) * 100;
  if (f.px <= stop) return { sell: true, reason: `Stop dinámico (${(trail * 100).toFixed(1)} % bajo el máximo desde la compra): ${gain >= 0 ? 'protege ganancia' : 'limita la pérdida'} de ${gain.toFixed(2)} %` };
  if (heldHours >= 1 && f.s10 < f.s30) return { sell: true, reason: `Tendencia rota (SMA10 bajo SMA30), resultado ${gain.toFixed(2)} %` };
  if (gain > 3 * rtPct && f.rsi !== null && f.rsi > 75) return { sell: true, reason: `Toma de ganancia: +${gain.toFixed(2)} % y RSI ${f.rsi.toFixed(0)} sobrecomprado` };
  return { sell: false, reason: `mantiene (${gain >= 0 ? '+' : ''}${gain.toFixed(2)} %, stop en ${stop.toFixed(stop < 10 ? 4 : 2)})` };
}

// Operaciones cerradas con su resultado (costo promedio), en orden cronológico. orders: [{symbol, side, qty, usd, created_at}]
export function closedTrades(orders) {
  const book = new Map(); const out = [];
  for (const o of orders.slice().sort((a, b) => a.created_at - b.created_at)) {
    const b = book.get(o.symbol) || { qty: 0, cost: 0 }; book.set(o.symbol, b);
    if (o.side === 'buy') { b.qty += o.qty; b.cost += o.usd; continue; }
    const avg = b.qty > 0 ? b.cost / b.qty : 0; const q = Math.min(o.qty, b.qty);
    const pnl = o.usd - avg * q; const base = avg * q;
    b.cost -= avg * q; b.qty -= q;
    out.push({ symbol: o.symbol, t: o.created_at, pnl, pct: base > 0 ? (pnl / base) * 100 : 0 });
  }
  return out;
}

export function perfSummary(orders) {
  const c = closedTrades(orders);
  const last = c.slice(-10);
  const wins = c.filter((x) => x.pnl > 0).length;
  let risk = 'normal';
  const l6 = c.slice(-6); const l8 = c.slice(-8);
  if (l8.length >= 8 && l8.reduce((s, x) => s + x.pnl, 0) < 0 && l8.filter((x) => x.pnl < 0).length >= 6) risk = 'pausa';
  else if (l6.length >= 4 && l6.reduce((s, x) => s + x.pnl, 0) < 0) risk = 'defensivo';
  return { closed: c.length, wins, win_rate: c.length ? (wins / c.length) * 100 : null, pnl: c.reduce((s, x) => s + x.pnl, 0), last: last.map((x) => ({ symbol: x.symbol, pnl: x.pnl, pct: x.pct })), risk,
    pause_until: risk === 'pausa' ? (c[c.length - 1].t + 6 * 3600000) : null };
}

// ---- Aprendizaje con TUS resultados reales y control de riesgo del portafolio ----
// Criptos que el bot ya probó varias veces en los últimos 7 días y le salieron mal: las deja descansar (se reevalúan solas al pasar la ventana).
export function losingSymbols(orders, nowMs = Date.now(), days = 7) {
  const per = new Map();
  for (const c of closedTrades(orders)) { if (nowMs - c.t > days * 86400000) continue; const a = per.get(c.symbol) || []; a.push(c); per.set(c.symbol, a); }
  const out = new Map();
  for (const [sym, a] of per) {
    const last = a.slice(-6); const pnl = last.reduce((s, x) => s + x.pnl, 0); const wins = last.filter((x) => x.pnl > 0).length;
    if (last.length >= 3 && pnl < 0 && wins / last.length < 0.34) out.set(sym, { trades: last.length, pnl, win_rate: (wins / last.length) * 100 });
  }
  return out;
}
// Resultado cerrado de las últimas 24 h (USD).
export function pnl24h(orders, nowMs = Date.now()) { return closedTrades(orders).filter((c) => nowMs - c.t <= 86400000).reduce((s, c) => s + c.pnl, 0); }
// Tamaño según convicción: señal apenas suficiente = 60 % del monto, señal fuerte = 100 %.
export const confidenceSize = (edge) => clamp(0.6 + (Math.max(0, edge - 1.2)) / 5, 0.6, 1);

// ---- Explicaciones en español: el "porqué" de cada decisión (lo que el pulpo cuenta y muestra) ----
const REG_ES = { bull: 'alcista', bear: 'bajista', volatile: 'volátil', range: 'lateral', unknown: 'sin datos' };
export const regimeEs = (r) => REG_ES[r] || null;
// Noticias: solo sirven de freno (detecta noticias NEGATIVAS). Lo decimos tal cual, sin inventar "buenas noticias".
export function newsNote(news, base) {
  if (!news || !news.items) return 'sin datos de noticias ahora';
  if (news.risk && news.risk[base] >= 1) return `hay ${news.risk[base]} noticia(s) negativa(s) sobre ${base}`;
  if (news.risk_off) return 'el mercado tiene noticias negativas (freno de riesgo)';
  return `sin noticias negativas sobre ${base} en las últimas 12 horas`;
}
export function buyTier(edge) { return edge >= 3 ? 'alta' : edge >= 2 ? 'buena' : 'moderada'; }
// Texto de una compra: señal, tamaño (grande o normal), mercado y noticias.
export function explainBuy({ base, sg, usd, baseUsd, regime, risk, news }) {
  const tier = buyTier(sg.edge); const ratio = baseUsd > 0 ? usd / baseUsd : 1;
  const big = tier === 'alta' && ratio >= 0.9;
  const size = big ? `compra grande de ${usd.toFixed(2)} dólares porque la convicción es alta` : ratio < 0.75 ? `compra reducida de ${usd.toFixed(2)} dólares por prudencia (${Math.round(ratio * 100)} % del tamaño base)` : `compra de ${usd.toFixed(2)} dólares`;
  const rg = regimeEs(regime);
  return { big, tier, text: `Compro ${base}: ${size}. Movimiento esperado ${sg.edge.toFixed(1)} veces el costo de operar, tendencia alcista${rg ? `, mercado ${rg}` : ''}${risk === 'defensivo' ? ', modo defensivo' : ''}; ${newsNote(news, base)}.` };
}
export const explainSell = (base, reason) => `Vendo ${base}: ${String(reason).replace(/^Pro( rota)?:\s*/i, '').replace(/\s+/g, ' ')}.`;
