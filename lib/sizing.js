// Tamaño de posición y riesgo de portafolio. Funciones puras, sin red.
// REGLA DE ORO: este módulo solo puede REDUCIR o VETAR una compra; nunca la aumenta por encima de lo que el cliente
// configuró (usd) ni de los topes de la plataforma. Los topes duros (lib/risk.js) siguen aplicándose después.

// Parámetros ajustables (valores prudentes por defecto).
export const DEFAULT_SIZING = Object.freeze({
  targetDailyRiskPct: 0.5,   // volatilidad diaria que puede aportar UNA posición, en % del capital de riesgo
  maxPositionPct: 5,         // máximo % del capital de riesgo en una sola posición
  maxExposurePct: 40,        // máximo % del capital de riesgo invertido en total (todas las posiciones)
  kellyMult: 0.35,           // Kelly fraccional: 0.25–0.5 recomendado
  kellyMinTrades: 20,        // sin al menos esta cantidad de operaciones cerradas no se usa Kelly (no hay datos suficientes)
  maxCorrelation: 0.85,      // si el candidato se mueve casi igual que algo que ya tienes, no se abre
  softCorrelation: 0.7,      // entre soft y max: la mitad del tamaño
  maxDrawdownPct: 10,        // pausa de compras si el capital cae este % desde su máximo (curva de resultados cerrados)
  dailyLossPct: 3,           // pausa de compras si las pérdidas de las últimas 24 h superan este % del capital de riesgo
  volatileMult: 0.5,         // multiplicador en régimen volátil
  bearMult: 0.5,             // multiplicador en mercado bajista
  lowEdgeScore: 80,          // por debajo de este edge_score se reduce el tamaño
  lowEdgeMult: 0.6,
  minTradeUsd: 10,          // tamaño mínimo para abrir (evita órdenes diminutas que se comen las comisiones)
});

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const mean = (a) => a.reduce((s, x) => s + x, 0) / (a.length || 1);

// Volatilidad diaria (fracción) a partir de retornos por vela de 1 h.
export function dailyVol(hourlyRets) {
  if (hourlyRets.length < 12) return null;
  const m = mean(hourlyRets);
  const sd = Math.sqrt(mean(hourlyRets.map((r) => (r - m) ** 2)));
  return sd * Math.sqrt(24);
}

// Tamaño por objetivo de volatilidad: usd tal que usd × volDiaria = capital × targetDailyRiskPct.
export const volTargetUsd = ({ equityUsd, dailyVolFrac, targetDailyRiskPct }) => (dailyVolFrac > 0 ? (equityUsd * targetDailyRiskPct / 100) / dailyVolFrac : null);

// Kelly fraccional a partir de resultados cerrados (pnlPct por operación, en %).
// f* = p − (1−p)/b, con b = ganancia media ÷ pérdida media. Devuelve null si no hay datos suficientes.
export function kellyFromTrades(pnlPcts, { kellyMult, kellyMinTrades }) {
  if (!pnlPcts || pnlPcts.length < kellyMinTrades) return null;
  const wins = pnlPcts.filter((x) => x > 0); const losses = pnlPcts.filter((x) => x < 0);
  const p = wins.length / pnlPcts.length;
  if (!wins.length) return { p, b: 0, full: 0, fraction: 0, n: pnlPcts.length };
  if (!losses.length) return { p, b: Infinity, full: 1, fraction: clamp(kellyMult, 0, 1), n: pnlPcts.length, note: 'sin pérdidas registradas (muestra corta)' };
  const b = mean(wins) / Math.abs(mean(losses));
  const full = p - (1 - p) / b;
  return { p, b, full, fraction: clamp(full * kellyMult, 0, 1), n: pnlPcts.length };
}

// Caída desde el máximo de una curva de capital (fracción negativa o 0) y caída actual.
export function drawdown(curve) {
  let peak = -Infinity; let maxDd = 0; let cur = 0;
  for (const e of curve) { peak = Math.max(peak, e); cur = peak > 0 ? e / peak - 1 : 0; maxDd = Math.min(maxDd, cur); }
  return { current: cur, max: maxDd };
}

// Correlación de Pearson de los retornos de dos series (misma longitud, o se recorta al final).
export function correlation(a, b) {
  const n = Math.min(a.length, b.length); if (n < 12) return null;
  const x = a.slice(-n); const y = b.slice(-n); const mx = mean(x); const my = mean(y);
  let sxy = 0; let sxx = 0; let syy = 0;
  for (let i = 0; i < n; i++) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) ** 2; syy += (y[i] - my) ** 2; }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : null;
}

/**
 * sizeDecision: decide si se compra y cuánto, y deja cada razón registrada.
 * @param {object} i
 *  i.configuredUsd      tamaño que pidió el cliente/bot (techo absoluto)
 *  i.equityUsd          capital de riesgo (dato del cliente; ver cfg.riskCapitalUsd)
 *  i.openExposureUsd    USD ya invertidos en posiciones abiertas
 *  i.candidateRets      retornos por hora del candidato
 *  i.heldRets           [{sym, rets}] retornos por hora de lo que ya tiene
 *  i.closedPnlPcts      resultados cerrados recientes en % (para Kelly)
 *  i.equityCurve        curva de capital con resultados cerrados (para la caída máxima)
 *  i.pnl24hUsd          resultado de las últimas 24 h (negativo = pérdida)
 *  i.regime             'bull'|'bear'|'volatile'|'sideways'|…
 *  i.edgeScore          0–100 (de evaluateEdge) o null
 *  i.killSwitch         true si el apagado de emergencia está activo
 */
export function sizeDecision(i, params = {}) {
  const P = { ...DEFAULT_SIZING, ...params };
  const log = { inputs: { configuredUsd: i.configuredUsd, equityUsd: i.equityUsd, openExposureUsd: i.openExposureUsd, regime: i.regime || null, edgeScore: i.edgeScore ?? null }, steps: [] };
  const step = (id, text, extra) => log.steps.push({ id, text, ...(extra || {}) });
  const veto = (id, reason) => { step(id, reason); return { approved: false, usd: 0, mult: 0, reason, log }; };
  if (i.killSwitch) return veto('kill', 'Apagado de emergencia activo: no se abren posiciones');
  if (!(i.equityUsd > 0)) return veto('equity', 'Falta el capital de riesgo para dimensionar');
  const dd = drawdown(i.equityCurve && i.equityCurve.length ? i.equityCurve : [i.equityUsd]);
  step('drawdown', `Caída actual ${(dd.current * 100).toFixed(1)} % (máxima ${(dd.max * 100).toFixed(1)} %, pausa en −${P.maxDrawdownPct} %)`);
  if (dd.current * 100 <= -P.maxDrawdownPct) return veto('dd_pause', `Pausa por caída máxima: el capital cayó ${(dd.current * 100).toFixed(1)} % desde su máximo (límite −${P.maxDrawdownPct} %)`);
  const dl = -Math.min(0, i.pnl24hUsd || 0) / i.equityUsd * 100;
  step('daily_loss', `Pérdida 24 h ${dl.toFixed(2)} % del capital (límite ${P.dailyLossPct} %)`);
  if (dl >= P.dailyLossPct) return veto('daily_loss', `Límite de pérdida diaria: −${dl.toFixed(2)} % en 24 h (límite ${P.dailyLossPct} %)`);

  // Techos: el pedido del cliente, % máximo por posición y exposición total.
  const room = P.maxExposurePct / 100 * i.equityUsd - (i.openExposureUsd || 0);
  step('exposure', `Margen de exposición total: $${Math.max(0, room).toFixed(2)} (tope ${P.maxExposurePct} % del capital)`);
  if (room < 1) return veto('exposure', `Exposición total al tope (${P.maxExposurePct} % del capital de riesgo)`);
  let usd = Math.min(i.configuredUsd, P.maxPositionPct / 100 * i.equityUsd, room);
  step('caps', `Tope por posición ${P.maxPositionPct} %: $${usd.toFixed(2)}`);

  // Volatilidad objetivo.
  const dv = dailyVol(i.candidateRets || []);
  if (dv === null) step('vol', 'Sin datos suficientes de volatilidad: se mantiene el techo');
  else { const vt = volTargetUsd({ equityUsd: i.equityUsd, dailyVolFrac: dv, targetDailyRiskPct: P.targetDailyRiskPct }); usd = Math.min(usd, vt); step('vol', `Volatilidad diaria ${(dv * 100).toFixed(1)} % → tamaño objetivo $${vt.toFixed(2)}`); }

  // Kelly fraccional (solo con historial suficiente; si no, no se inventa).
  const k = kellyFromTrades(i.closedPnlPcts, P);
  if (!k) step('kelly', `Kelly: faltan operaciones cerradas (mínimo ${P.kellyMinTrades}); no se aplica`);
  else if (k.fraction <= 0) return veto('kelly', `Kelly ≤ 0: con ${k.n} operaciones (aciertos ${(k.p * 100).toFixed(0)} %, pago ${Number.isFinite(k.b) ? k.b.toFixed(2) : '∞'}) la estrategia no tiene ventaja demostrada`);
  else { const ku = k.fraction * i.equityUsd; usd = Math.min(usd, ku); step('kelly', `Kelly ${P.kellyMult}× = ${(k.fraction * 100).toFixed(1)} % del capital → $${ku.toFixed(2)} (aciertos ${(k.p * 100).toFixed(0)} %, pago ${Number.isFinite(k.b) ? k.b.toFixed(2) : '∞'}, n=${k.n})`); }

  // Correlación con lo que ya tienes.
  let mult = 1;
  if (i.candidateRets && i.heldRets && i.heldRets.length) {
    let worst = null;
    for (const h of i.heldRets) { const c = correlation(i.candidateRets, h.rets); if (c !== null && (worst === null || c > worst.c)) worst = { sym: h.sym, c }; }
    if (worst) {
      step('corr', `Correlación máxima con tus posiciones: ${worst.c.toFixed(2)} (${worst.sym})`);
      if (worst.c >= P.maxCorrelation) return veto('corr', `Se mueve casi igual que ${worst.sym} (correlación ${worst.c.toFixed(2)} ≥ ${P.maxCorrelation}): no suma diversificación`);
      if (worst.c >= P.softCorrelation) { mult *= 0.5; step('corr_soft', `Correlación alta (≥ ${P.softCorrelation}): mitad del tamaño`); }
    }
  }
  // Régimen y calidad de la señal.
  if (i.regime === 'volatile') { mult *= P.volatileMult; step('regime', `Régimen volátil: ×${P.volatileMult}`); }
  if (i.regime === 'bear') { mult *= P.bearMult; step('regime', `Mercado bajista: ×${P.bearMult}`); }
  if (i.edgeScore !== null && i.edgeScore !== undefined && i.edgeScore < P.lowEdgeScore) { mult *= P.lowEdgeMult; step('low_edge', `edge_score ${i.edgeScore} < ${P.lowEdgeScore}: ×${P.lowEdgeMult}`); }
  usd = Math.min(i.configuredUsd, usd * mult);
  if (usd < P.minTradeUsd) return veto('too_small', `Tamaño resultante $${usd.toFixed(2)} es menor que el mínimo $${P.minTradeUsd}: no se abre`);
  step('final', `Tamaño aprobado $${usd.toFixed(2)} (pedido $${i.configuredUsd.toFixed(2)})`);
  return { approved: true, usd, mult, reason: null, log };
}

// Resultados cerrados en % y curva de capital a partir de las operaciones cerradas de lib/pro.js (closedTrades).
export function curveFromClosed(closed, equityUsd) {
  const curve = [equityUsd]; let e = equityUsd; const pcts = [];
  for (const c of closed) { e += c.pnl; curve.push(e); if (Number.isFinite(c.pct)) pcts.push(c.pct); }
  return { curve, pcts };
}
