// Resultados por periodo y verificación contra el exchange. Todo sale de TUS órdenes guardadas y de lo que el propio
// exchange reporta; si algo no se puede comprobar, se dice "no verificado" en vez de dar por buena la cifra.
import { closedTrades } from './pro.js';

const DAY = 86400000;
export const PERIODS = [['24h', 1], ['7d', 7], ['30d', 30], ['total', null]];

// orders: [{symbol, side, qty, usd, created_at, status}] del modo elegido. Devuelve resultados realizados (operaciones CERRADAS) por periodo.
export function periodResults(orders, nowMs = Date.now()) {
  const ok = orders.filter((o) => o.status === 'ok');
  const closed = closedTrades(ok);
  const res = {};
  for (const [name, days] of PERIODS) {
    const from = days === null ? 0 : nowMs - days * DAY;
    const c = closed.filter((x) => x.t >= from); const o = ok.filter((x) => x.created_at >= from);
    const wins = c.filter((x) => x.pnl > 0).length; const pnl = c.reduce((s, x) => s + x.pnl, 0);
    let cum = 0; let peak = 0; let dd = 0; for (const x of c) { cum += x.pnl; peak = Math.max(peak, cum); dd = Math.min(dd, cum - peak); }
    res[name] = { closed: c.length, wins, win_rate: c.length ? (wins / c.length) * 100 : null, pnl, avg: c.length ? pnl / c.length : null,
      best: c.length ? Math.max(...c.map((x) => x.pnl)) : null, worst: c.length ? Math.min(...c.map((x) => x.pnl)) : null, max_drawdown: dd,
      orders: o.length, bought: o.filter((x) => x.side === 'buy').reduce((s, x) => s + x.usd, 0), sold: o.filter((x) => x.side === 'sell').reduce((s, x) => s + x.usd, 0) };
  }
  // pérdidas/ganancias realizadas por día (últimos 14)
  const daily = []; const day0 = Math.floor(nowMs / DAY) * DAY;
  for (let i = 13; i >= 0; i--) { const a = day0 - i * DAY; const c = closed.filter((x) => x.t >= a && x.t < a + DAY); daily.push({ day: a, pnl: c.reduce((s, x) => s + x.pnl, 0), closed: c.length }); }
  return { periods: res, daily, note: 'Solo cuenta operaciones cerradas (compra y luego venta). Las posiciones abiertas se ven en «Invertido ahora».' };
}

// Compara el libro del bot (órdenes reales ok) con lo que reporta el exchange.
// balances: [{asset, available, hold, usd}], exchangeOrders: [{id, symbol, side, state, qty, price, t}], px: Map symbol -> precio
export function reconcile({ ledger, balances, exchangeOrders, nowMs = Date.now(), tol = 0.02 }) {
  const book = new Map();
  for (const o of ledger.slice().sort((a, b) => a.created_at - b.created_at)) {
    const b = book.get(o.symbol) || { qty: 0 }; book.set(o.symbol, b);
    b.qty += o.side === 'buy' ? o.qty : -Math.min(o.qty, b.qty);
  }
  const have = new Map((balances || []).map((b) => [b.asset, { qty: (b.available || 0) + (b.hold || 0), usd: b.usd }]));
  const positions = [];
  for (const [sym, b] of book) {
    if (b.qty < 1e-12) continue; const asset = sym.split('-')[0]; const ex = have.get(asset); const q = ex ? ex.qty : 0;
    const diff = q - b.qty; const rel = Math.abs(diff) / Math.max(b.qty, 1e-12); const px = ex && ex.usd && q ? ex.usd / q : null;
    const small = px !== null && Math.abs(diff) * px < 0.05;
    let status = 'ok'; let msg = 'coincide con el exchange';
    if (!ex) { status = 'alerta'; msg = 'el bot registra esta posición, pero el exchange no muestra saldo'; }
    else if (rel > tol && !small) { if (diff > 0) { status = 'info'; msg = 'tienes más en el exchange que lo comprado por el bot (normal si compraste por fuera)'; } else { status = 'alerta'; msg = 'el bot cree tener MÁS de lo que hay en el exchange: revisa'; } }
    positions.push({ symbol: sym, ledger_qty: b.qty, exchange_qty: q, diff, status, msg });
  }
  const recent = ledger.filter((o) => nowMs - o.created_at < 2 * DAY && o.ext_id);
  const byId = new Map((exchangeOrders || []).map((o) => [String(o.id), o]));
  let matched = 0; let mismatched = 0; let unseen = 0; const issues = [];
  for (const o of recent) {
    const x = byId.get(String(o.ext_id));
    if (!x) { unseen++; continue; }
    const filled = ['filled', 'done', 'closed'].includes(String(x.state).toLowerCase());
    const qtyOk = x.qty === null || x.qty === undefined || Math.abs(x.qty - o.qty) / Math.max(o.qty, 1e-12) <= 0.05;
    if (filled && qtyOk && x.side === o.side) matched++; else { mismatched++; issues.push(`${o.symbol} ${o.side}: el exchange dice «${x.state}»${qtyOk ? '' : ` con cantidad ${x.qty} (el bot anotó ${o.qty})`}`); }
  }
  const alerts = positions.filter((p) => p.status === 'alerta').length + mismatched;
  return { positions, orders: { checked: recent.length, matched, mismatched, unseen, issues }, ok: alerts === 0, alerts };
}
