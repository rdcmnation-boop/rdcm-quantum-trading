// Deslizamiento REAL: compara el precio al decidir con el precio real de ejecución del broker, y lo guarda para análisis.
// El modelo de costos (costs.js) ya estima comisión + medio spread + impacto; aquí se mide cuánto se aleja la realidad.
const KEY = 'slip:log';
const MAX = 400;

// Deslizamiento adverso en % (positivo = peor para ti): compra pagó más, venta cobró menos que el precio de decisión.
export const adversePct = (side, decision, fill) => (side === 'buy' ? (fill - decision) / decision : (decision - fill) / decision) * 100;

export async function recordFill(store, { userId, exchange, symbol, side, decisionPrice, fillPrice, modelPct, usd, cid = null, now = Date.now() }) {
  if (!(decisionPrice > 0) || !(fillPrice > 0)) return null;
  const real = adversePct(side, decisionPrice, fillPrice);
  if (!Number.isFinite(real) || Math.abs(real) > 25) return null; // dato absurdo: no se guarda
  let arr = []; try { arr = JSON.parse(await store.getSetting(KEY, '[]')); } catch { arr = []; }
  const e = { t: now, uid: userId, ex: exchange, sym: symbol, side, dec: decisionPrice, fill: fillPrice, real: Math.round(real * 10000) / 10000, model: Math.round((modelPct || 0) * 10000) / 10000, usd: Math.round(usd || 0), cid };
  if (cid && arr.some((x) => x.cid === cid)) return null; // ya registrada
  arr.push(e);
  await store.setSetting(KEY, JSON.stringify(arr.slice(-MAX)));
  return e;
}

export async function loadLog(store) { try { const a = JSON.parse(await store.getSetting(KEY, '[]')); return Array.isArray(a) ? a : []; } catch { return []; } }

// Resumen por exchange: mediana del deslizamiento real y del exceso sobre el modelo (solo si hay ≥ minN fills).
export function summarize(log, { exchange = null, minN = 10, sinceMs = 30 * 86400000, now = Date.now() } = {}) {
  const xs = log.filter((e) => (!exchange || e.ex === exchange) && now - e.t <= sinceMs);
  if (xs.length < minN) return { n: xs.length, enough: false, medianRealPct: null, medianExcessPct: null, extraPct: 0 };
  const med = (a) => { const s = a.slice().sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  const mr = med(xs.map((e) => e.real)); const me = med(xs.map((e) => e.real - e.model));
  return { n: xs.length, enough: true, medianRealPct: mr, medianExcessPct: me, extraPct: Math.max(0, me), worstPct: Math.max(...xs.map((e) => e.real)) };
}
