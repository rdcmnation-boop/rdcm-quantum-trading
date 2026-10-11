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

export function entrySignal(f, { rtPct, regime = null, risk = 'normal' }) {
  if (!f) return { ok: false, reason: 'faltan datos' };
  if (risk === 'pausa') return { ok: false, reason: 'pausa por racha negativa' };
  const up = f.s10 > f.s30 && f.s30 >= f.s50 * 0.995 && f.px > f.s10;
  if (!up) return { ok: false, reason: 'sin tendencia alcista limpia' };
  if (!(f.roc6 > 0 && f.roc24 > 0)) return { ok: false, reason: 'momentum 6 h / 24 h no es positivo' };
  if (f.rsi === null || f.rsi < 45 || f.rsi > 68) return { ok: false, reason: `RSI ${f.rsi === null ? '—' : f.rsi.toFixed(0)} fuera de 45–68` };
  if (f.offHigh < -0.04) return { ok: false, reason: 'lejos del máximo de 24 h' };
  const exp = expectedMovePct(f);
  const need = (risk === 'defensivo' || regime === 'bear') ? 2 : 1.2;
  const edge = exp / rtPct;
  if (edge < need) return { ok: false, reason: `movimiento esperado ${exp.toFixed(2)} % vs costo ida y vuelta ${rtPct.toFixed(2)} % (necesita ${need}×)`, edge };
  const size = regime === 'volatile' || risk === 'defensivo' ? 0.5 : 1;
  return { ok: true, edge, size, score: edge * (1 + Math.max(0, f.roc6 / (f.vol || 1)) / 10),
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
