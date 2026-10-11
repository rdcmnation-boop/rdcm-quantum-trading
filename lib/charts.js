// Curvas de ganancia (funciones puras). Capital(t) = ventas - compras + valor de lo que se tiene a precio de t.
// Ganancia desde el encendido = Capital(t) - Capital(inicio): cuenta lo cerrado y lo abierto, sin importar qué se tenía antes.
const HOUR = 3600000;

// hist: Map símbolo -> { closes:[], endMs } (cierres horarios; el último cierra en endMs). livePx: Map símbolo -> precio actual.
function priceAt(sym, t, hist, orders, livePx, now) {
  const h = hist.get(sym);
  if (h && h.closes.length) {
    const i = h.closes.length - 1 - Math.round((h.endMs - t) / HOUR);
    if (i >= h.closes.length - 1 && livePx.get(sym) && t >= now - HOUR / 2) return livePx.get(sym);
    return h.closes[Math.max(0, Math.min(h.closes.length - 1, i))];
  }
  let p = null; for (const o of orders) { if (o.symbol === sym && o.created_at <= t && o.price > 0) p = o.price; }
  return p ?? livePx.get(sym) ?? null;
}

export function profitSince({ orders, start, now, hist = new Map(), livePx = new Map(), maxPoints = 240 }) {
  const ok = orders.filter((o) => o.status === 'ok').slice().sort((a, b) => a.created_at - b.created_at);
  const syms = [...new Set(ok.map((o) => o.symbol))];
  const equityAt = (t) => {
    let cash = 0; const qty = new Map();
    for (const o of ok) {
      if (o.created_at > t) break;
      if (o.side === 'buy') { cash -= o.usd; qty.set(o.symbol, (qty.get(o.symbol) || 0) + o.qty); }
      else { cash += o.usd; qty.set(o.symbol, Math.max(0, (qty.get(o.symbol) || 0) - o.qty)); }
    }
    let v = 0; let miss = false;
    for (const [s, q] of qty) { if (q < 1e-12) continue; const p = priceAt(s, t, hist, ok, livePx, now); if (p === null) miss = true; else v += q * p; }
    return { e: cash + v, miss };
  };
  const base = equityAt(start).e;
  const span = Math.max(HOUR, now - start);
  const step = Math.max(HOUR, Math.ceil(span / maxPoints / HOUR) * HOUR);
  const curve = [];
  for (let t = start; t < now; t += step) curve.push({ t, v: equityAt(t).e - base });
  const end = equityAt(now); curve.push({ t: now, v: end.e - base });
  // Capital máximo en juego (costo abierto) desde el inicio, para expresar el % ganado.
  const book = new Map(); let peak = 0; let realized = 0;
  for (const o of ok) {
    const b = book.get(o.symbol) || { qty: 0, cost: 0 }; book.set(o.symbol, b);
    if (o.side === 'buy') { b.qty += o.qty; b.cost += o.usd; }
    else { const avg = b.qty > 0 ? b.cost / b.qty : 0; const q = Math.min(o.qty, b.qty); if (o.created_at >= start) realized += o.usd - avg * q; b.cost -= avg * q; b.qty -= q; }
    if (o.created_at >= start) peak = Math.max(peak, [...book.values()].reduce((s, x) => s + x.cost, 0));
  }
  const total = end.e - base;
  const orders_since = ok.filter((o) => o.created_at >= start).length;
  return { start, total, realized, unrealized: end.miss ? null : total - realized, pct: peak > 0 ? (total / peak) * 100 : null, peak_capital: peak, orders: orders_since, curve, partial: end.miss, symbols: syms.length };
}
