// Máquina del Tiempo: NO predice el futuro. Reconstruye lo que pasó y simula miles de futuros posibles con la volatilidad real del activo
// (remuestreo por bloques de rendimientos históricos). Entrega rangos de probabilidad, no un precio. Sirve para cripto y acciones.
const q = (a, p) => { const i = (a.length - 1) * p; const lo = Math.floor(i); const hi = Math.ceil(i); return a[lo] + (a[hi] - a[lo]) * (i - lo); };
const rng = (seed) => () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const seedOf = (s) => { let h = 2166136261; for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0; };
const mean = (a) => a.reduce((x, y) => x + y, 0) / (a.length || 1);
const sd = (a) => { const m = mean(a); return Math.sqrt(mean(a.map((x) => (x - m) ** 2))); };

// closes: cierres DIARIOS en orden cronológico. horizon: días hacia adelante.
export function project(closes, { horizon = 30, paths = 2000, key = 'x', block = 5 } = {}) {
  const c = closes.filter((x) => x > 0 && Number.isFinite(x)); if (c.length < 40) return null;
  const H = Math.max(1, Math.min(180, Math.round(horizon)));
  const r = []; for (let i = 1; i < c.length; i++) r.push(Math.log(c[i] / c[i - 1]));
  const mu = mean(r); const adj = r.map((x) => x - mu * 0.5); // se encoge la tendencia pasada a la mitad: no se extrapola lo que ya subió o bajó
  const rand = rng(seedOf(`${key}|${c.length}|${c[c.length - 1]}`)); const p0 = c[c.length - 1];
  const fin = []; const byDay = Array.from({ length: H }, () => []); let dd10 = 0; let worst = []; 
  for (let k = 0; k < paths; k++) {
    let lp = 0; let peak = 0; let minLp = 0; let d = 0;
    while (d < H) { const s = Math.floor(rand() * (adj.length - block)); for (let b = 0; b < block && d < H; b++, d++) { lp += adj[s + b]; byDay[d].push(lp); if (lp > peak) peak = lp; if (lp < minLp) minLp = lp; } }
    fin.push(lp); worst.push(minLp); if (Math.exp(minLp) <= 0.9) dd10++;
  }
  const bands = { p5: [], p25: [], p50: [], p75: [], p95: [] };
  for (const day of byDay) { day.sort((a, b) => a - b); for (const [k, p] of [['p5', 0.05], ['p25', 0.25], ['p50', 0.5], ['p75', 0.75], ['p95', 0.95]]) bands[k].push(p0 * Math.exp(q(day, p))); }
  fin.sort((a, b) => a - b); worst.sort((a, b) => a - b);
  const volD = sd(r); const vol14 = sd(r.slice(-14)); const vol90 = sd(r.slice(-90));
  return { start: p0, horizon: H, paths, bands, prob_up: fin.filter((x) => x > 0).length / paths, prob_drop10: dd10 / paths,
    prob_up5: fin.filter((x) => Math.exp(x) >= 1.05).length / paths, prob_down5: fin.filter((x) => Math.exp(x) <= 0.95).length / paths,
    median_pct: (Math.exp(q(fin, 0.5)) - 1) * 100, range90_pct: [(Math.exp(q(fin, 0.05)) - 1) * 100, (Math.exp(q(fin, 0.95)) - 1) * 100],
    typical_dip_pct: (Math.exp(q(worst, 0.5)) - 1) * 100, vol_daily_pct: volD * 100, vol_now_ratio: vol90 ? vol14 / vol90 : 1,
    regime: vol90 && vol14 / vol90 > 1.3 ? 'más agitado de lo normal' : vol90 && vol14 / vol90 < 0.7 ? 'más calmado de lo normal' : 'volatilidad normal' };
}

// Viaje al pasado: qué habría pasado si hubieras comprado hace N días (sin costos; es referencia, no tu resultado).
export function replay(closes, days) {
  const c = closes.filter((x) => x > 0); if (c.length <= days) return null; const seg = c.slice(-days - 1); const p0 = seg[0]; let peak = p0; let dd = 0; let up = 0;
  for (const x of seg) { if (x > peak) peak = x; dd = Math.min(dd, x / peak - 1); up = Math.max(up, x / p0 - 1); }
  return { days, ret_pct: (seg[seg.length - 1] / p0 - 1) * 100, max_drawdown_pct: dd * 100, max_runup_pct: up * 100 };
}

export function context(closes) {
  const c = closes; const sm = (n) => (c.length >= n ? mean(c.slice(-n)) : null); const s20 = sm(20); const s50 = sm(50);
  let g = 0; let l = 0; const n = Math.min(14, c.length - 1); for (let i = c.length - n; i < c.length; i++) { const d = c[i] - c[i - 1]; if (d > 0) g += d; else l -= d; }
  const rsi = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  return { trend: s20 && s50 ? (s20 > s50 ? 'alcista (media de 20 días sobre la de 50)' : 'bajista (media de 20 días bajo la de 50)') : 'sin datos suficientes', rsi: Math.round(rsi) };
}

// Acciones: datos diarios públicos de Stooq (CSV). Si la fuente falla se dice, no se inventa.
export const STOCK_RE = /^[A-Z]{1,5}(\.[A-Z])?$/;
export async function fetchStock(symbol, f = fetch) {
  if (!STOCK_RE.test(symbol)) throw new Error('Símbolo de acción inválido');
  const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), 9000);
  try {
    const r = await f(`https://stooq.com/q/d/l/?s=${encodeURIComponent(symbol.toLowerCase())}.us&i=d`, { signal: ctl.signal, headers: { 'User-Agent': 'quantum-trading' } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const rows = (await r.text()).trim().split(/\r?\n/).slice(1).map((l) => l.split(',')); const out = rows.map((x) => Number(x[4])).filter((x) => x > 0);
    if (out.length < 40) throw new Error('sin datos para ese símbolo');
    return out.slice(-320);
  } catch (e) { throw new Error(`No se pudo leer la acción ${symbol}: ${e.message}`); } finally { clearTimeout(tm); }
}
