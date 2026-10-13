// Ventaja (edge) transparente: confluencia multi-timeframe + volumen relativo + valor esperado NETO de costos.
// Funciones puras, sin red. Cada filtro devuelve su resultado en `checks` para poder registrarlo y analizarlo después.
//
// IMPORTANTE (honestidad): esto es un filtro de calidad de señales, NO una predicción ni una garantía de ganancia.
// El «valor esperado» es una estimación prudente basada en el impulso reciente; solo se confirma midiendo resultados reales
// (por eso arranca en modo «sombra»: registra qué habría vetado, sin cambiar las órdenes, hasta que lo valides).
import { sma, rsi, stdev } from './indicators.js';

// Parámetros que puedes ajustar. Todos tienen un valor prudente por defecto.
export const DEFAULT_EDGE = Object.freeze({
  minScore: 70,          // edge_score mínimo (0–100) para permitir la señal
  evCostMultiple: 1.5,   // el movimiento esperado bruto debe ser ≥ este múltiplo del costo total de ida y vuelta
  minRelVol: 1.0,        // volumen de la última vela ÷ promedio reciente (1 = igual al promedio)
  relVolLookback: 24,    // velas de 1 h para el promedio de volumen
  fast: 10, slow: 30,    // medias móviles para decidir la dirección de cada timeframe
  rsiLo: 42, rsiHi: 72,  // zona sana de RSI en 1 h
  horizonBars: 12,       // horizonte de la operación, en velas de 1 h
  driftShrink: 0.5,      // cuánto del impulso reciente se cree (0–1). Más bajo = más conservador
  minAgree: 3,           // cuántos de los 3 timeframes (15m/1h/4h) deben coincidir
});

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const pct = (x) => Math.round(x * 100) / 100;

// Agrupa velas de 1 h en velas de 4 h alineadas al final (la última vela completa es la más reciente).
export function aggregate(candles, k = 4) {
  const out = []; const n = candles.length;
  for (let end = n; end - k >= 0; end -= k) {
    const g = candles.slice(end - k, end);
    out.unshift({ t: g[0].t, o: g[0].o, h: Math.max(...g.map((x) => x.h)), l: Math.min(...g.map((x) => x.l)), c: g[k - 1].c, v: g.reduce((s, x) => s + x.v, 0) });
  }
  return out;
}

// Dirección de una serie de velas: 'up' (SMA rápida sobre lenta y precio sobre la rápida), 'down' (inverso) o 'flat'.
export function direction(candles, { fast, slow }) {
  const cl = candles.map((x) => x.c);
  const f = sma(cl, fast); const s = sma(cl, slow); const px = cl[cl.length - 1];
  if (f === null || s === null) return { dir: 'na' };
  if (f > s && px > f) return { dir: 'up', gapPct: ((f / s - 1) * 100) };
  if (f < s && px < f) return { dir: 'down', gapPct: ((f / s - 1) * 100) };
  return { dir: 'flat', gapPct: ((f / s - 1) * 100) };
}

// Volumen relativo: volumen medio de las últimas 3 velas ÷ promedio de las `lookback` anteriores (suaviza velas sueltas).
export function relativeVolume(candles, lookback = 24) {
  if (candles.length < lookback + 3) return null;
  const recent = candles.slice(-3).reduce((s, x) => s + x.v, 0) / 3;
  const base = candles.slice(-3 - lookback, -3).reduce((s, x) => s + x.v, 0) / lookback;
  return base > 0 ? recent / base : null;
}

/**
 * evaluateEdge: decide si una señal de COMPRA tiene ventaja suficiente después de costos.
 * @param {{m15:Array,h1:Array,h4?:Array}} tf  velas {t,o,h,l,c,v} por timeframe (h4 se calcula desde h1 si falta)
 * @param {{rtPct:number, slipExtraPct?:number, regime?:string|null}} ctx
 *   rtPct: costo de ida y vuelta en % (comisión + spread + impacto, de roundTripPct)
 *   slipExtraPct: deslizamiento medido real por encima del modelo, por lado (de slippage.js); se cobra 2 veces
 * @returns {{edge_score:number, tradeable:boolean, ev_gross_pct:number, cost_pct:number, ev_net_pct:number, checks:Array, reasons:Array}}
 */
export function evaluateEdge(tf, ctx, params = {}) {
  const P = { ...DEFAULT_EDGE, ...params };
  const checks = []; const reasons = [];
  const add = (id, label, ok, detail) => { checks.push({ id, label, ok: !!ok, detail }); if (!ok) reasons.push(`${label}: ${detail}`); };
  const h1 = tf && tf.h1; const m15 = tf && tf.m15;
  if (!h1 || h1.length < P.slow + P.relVolLookback + 3 || !m15 || m15.length < P.slow + 1) {
    return { edge_score: 0, tradeable: false, ev_gross_pct: 0, cost_pct: ctx.rtPct, ev_net_pct: 0, checks: [], reasons: ['faltan velas para evaluar'], insufficient: true };
  }
  const h4 = (tf.h4 && tf.h4.length >= P.slow + 1) ? tf.h4 : aggregate(h1, 4);

  // 1) Confluencia multi-timeframe: 15 m, 1 h y 4 h deben apuntar al alza.
  const dirs = { m15: direction(m15, P), h1: direction(h1, P), h4: direction(h4, P) };
  const agree = Object.values(dirs).filter((d) => d.dir === 'up').length;
  add('mtf', 'Confluencia 15m/1h/4h', agree >= P.minAgree, `${agree} de 3 al alza (15m ${dirs.m15.dir}, 1h ${dirs.h1.dir}, 4h ${dirs.h4.dir}; mínimo ${P.minAgree})`);

  // 2) Volumen relativo: operar solo cuando hay participación (el movimiento no es ruido de poca liquidez).
  const rv = relativeVolume(h1, P.relVolLookback);
  add('relvol', 'Volumen relativo', rv !== null && rv >= P.minRelVol, rv === null ? 'sin datos de volumen' : `${rv.toFixed(2)}× el promedio (mínimo ${P.minRelVol}×)`);

  // 3) RSI sano en 1 h (ni débil ni sobrecomprado).
  const cl1 = h1.map((x) => x.c); const r = rsi(cl1, 14);
  add('rsi', 'RSI 1h en zona sana', r !== null && r >= P.rsiLo && r <= P.rsiHi, r === null ? 'sin dato' : `RSI ${r.toFixed(0)} (zona ${P.rsiLo}–${P.rsiHi})`);

  // 4) Valor esperado NETO de costos.
  //    movimiento esperado bruto = impulso reciente (media de retorno por vela de las últimas 24 h) × horizonte × driftShrink.
  //    No se usa la volatilidad como si fuera ganancia: solo cuenta el impulso real, recortado a la mitad por prudencia.
  const rets = []; for (let i = cl1.length - 24; i < cl1.length; i++) rets.push(cl1[i] / cl1[i - 1] - 1);
  const mean = rets.reduce((s, x) => s + x, 0) / rets.length;
  const sd = stdev(rets);
  const evGross = Math.max(0, mean) * P.horizonBars * P.driftShrink * 100;
  const cost = ctx.rtPct + 2 * Math.max(0, ctx.slipExtraPct || 0);
  const evNet = evGross - cost;
  add('ev', 'Valor esperado después de costos', evNet > 0 && evGross >= P.evCostMultiple * cost,
    `esperado bruto ${pct(evGross)} % vs costo total ${pct(cost)} % → neto ${pct(evNet)} % (se exige bruto ≥ ${P.evCostMultiple}× el costo)`);

  // edge_score 0–100: suma de componentes (pesos fijos y visibles).
  const regimePts = { bull: 10, sideways: 5, range: 5, volatile: 3, bear: 0 }[ctx.regime] ?? 5;
  const comp = {
    confluencia: (agree / 3) * 35,
    tendencia_y_rsi: (r !== null && r >= P.rsiLo && r <= P.rsiHi ? 8 : 0) + clamp(((dirs.h1.gapPct || 0) / 1.5) * 7, 0, 7),
    volumen: rv === null ? 0 : clamp((rv - 0.5) / 1.5, 0, 1) * 15,
    holgura_de_costos: cost > 0 ? clamp(evGross / (3 * cost), 0, 1) * 25 : 0,
    regimen: regimePts,
  };
  const score = Math.round(Object.values(comp).reduce((s, x) => s + x, 0));
  add('score', 'edge_score', score >= P.minScore, `${score} (mínimo ${P.minScore})`);
  const tradeable = checks.every((c) => c.ok);
  return { edge_score: score, tradeable, ev_gross_pct: pct(evGross), cost_pct: pct(cost), ev_net_pct: pct(evNet), vol_sd_pct: pct(sd * 100),
    rel_volume: rv === null ? null : pct(rv), components: Object.fromEntries(Object.entries(comp).map(([k, v]) => [k, Math.round(v)])), checks, reasons };
}
