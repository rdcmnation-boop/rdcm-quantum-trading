// Arnés de validación: ¿la lógica «Pro» tiene ventaja REAL fuera de muestra, después de costos?
//  - Walk-forward sin mirar el futuro: en cada ventana se elige la mejor configuración con datos de ENTRENAMIENTO y se mide en
//    datos posteriores que nunca vio (con una separación «embargo» para que no se contaminen).
//  - Costos exactos del modelo de costs.js (comisión por nivel, spread, impacto, latencia) por exchange.
//  - Resultados separados por régimen (alcista / bajista / lateral / volátil), comparados con comprar y mantener.
//  - Prueba de estrés: repite lo mismo con deslizamiento ×2 y ×3.
// Un buen resultado aquí NO garantiza ganancias futuras; un mal resultado sí es una razón fuerte para no arriesgar dinero.
import { stdev } from './indicators.js';
import { features, entrySignal, exitSignal, roundTripPct, confidenceSize } from './pro.js';
import { simulateFill, volume30d } from './costs.js';

export const DEFAULT_WF = Object.freeze({
  trainBars: 500, testBars: 168, embargoBars: 24, step: 168, // velas de 1 h
  exchange: 'coinbase', usd: 100, capital: 1000, symbol: 'BTC-USD',
  grid: { minEdge: [1.05, 1.5, 2], stopLossPct: [5, 8], takeProfitPct: [0, 2, 3] },
  minTrainTrades: 3,
});

const mean = (a) => a.reduce((s, x) => s + x, 0) / (a.length || 1);
const WARM = 60;

// Régimen de cada vela usando SOLO datos anteriores (sin mirar el futuro).
export function regimeAt(closes, i, { volDailyPct = 4.5, trendPct = 4 } = {}) {
  if (i < 170) return 'sideways';
  const rets = []; for (let k = i - 47; k <= i; k++) rets.push(closes[k] / closes[k - 1] - 1);
  const dvol = stdev(rets) * Math.sqrt(24) * 100;
  if (dvol > volDailyPct) return 'volatile';
  const roc = (closes[i] / closes[i - 168] - 1) * 100;
  return roc > trendPct ? 'bull' : roc < -trendPct ? 'bear' : 'sideways';
}

// Simulación barra por barra de la lógica Pro en UNA cripto (una posición a la vez), con costos reales del modelo.
export function proSim(closes, params, { exchange = 'coinbase', symbol = 'BTC-USD', usd = 100, capital = 1000, slipMult = 1, candleMs = 3600000, regimeFn = null } = {}) {
  if (closes.length < WARM + 5) throw new Error('Pocas velas');
  let cash = capital; let qty = 0; let cost = 0; let entryI = -1; let high = 0;
  const equity = []; const trades = []; const vf = []; let feesUsd = 0; let slipUsd = 0;
  for (let i = WARM; i < closes.length; i++) {
    const px = closes[i]; const nxt = closes[i + 1] ?? null; const now = i * candleMs;
    const f = features(closes.slice(0, i + 1));
    if (f && qty === 0) {
      const rt = roundTripPct({ symbol, exchange, usd, price: px });
      const reg = regimeFn ? regimeFn(closes, i) : null;
      const sg = entrySignal(f, { rtPct: rt, regime: reg === 'sideways' ? 'range' : reg, minEdge: params.minEdge });
      if (sg.ok) {
        const want = Math.min(usd * sg.size * confidenceSize(sg.edge), cash);
        const fl = simulateFill({ side: 'buy', usd: want, price: px, nextPrice: nxt, symbol, exchange, vol30d: volume30d(vf, now), candleMs, slipMult });
        const spend = Math.min(want, cash / (1 + fl.feePct / 100));
        if (spend >= 1) { const fee = spend * fl.feePct / 100; cash -= spend + fee; qty = spend / fl.price; cost = spend + fee; entryI = i; high = px; feesUsd += fee; slipUsd += qty * (fl.price - fl.midPrice); vf.push({ usd: spend, ts: now }); }
      }
    } else if (f && qty > 0) {
      high = Math.max(high, px);
      const rt = roundTripPct({ symbol, exchange, usd: qty * px, price: px });
      const ex = exitSignal(f, { avgCost: cost / qty, heldHours: i - entryI, highSince: high, rtPct: rt, stopLossPct: params.stopLossPct, takeProfitPct: params.takeProfitPct });
      if (ex.sell) {
        const fl = simulateFill({ side: 'sell', usd: qty * px, price: px, nextPrice: nxt, symbol, exchange, vol30d: volume30d(vf, now), candleMs, slipMult });
        const gross = qty * fl.price; const fee = gross * fl.feePct / 100; const proceeds = gross - fee;
        feesUsd += fee; slipUsd += qty * (fl.midPrice - fl.price); vf.push({ usd: gross, ts: now });
        trades.push({ i, pnl: proceeds - cost, pct: ((proceeds - cost) / cost) * 100, bars: i - entryI });
        cash += proceeds; qty = 0; cost = 0;
      }
    }
    equity.push(cash + qty * px);
  }
  return { equity, trades, start: WARM, feesUsd, slipUsd, capital };
}

const compound = (rets) => rets.reduce((e, r) => e * (1 + r), 1) - 1;
const barRets = (eq) => { const r = []; for (let i = 1; i < eq.length; i++) r.push(eq[i] / eq[i - 1] - 1); return r; };
function maxDd(rets) { let e = 1; let pk = 1; let dd = 0; for (const r of rets) { e *= 1 + r; pk = Math.max(pk, e); dd = Math.min(dd, e / pk - 1); } return dd * 100; }
const score = (sim) => { const r = barRets(sim.equity); const tot = compound(r) * 100; return tot - 0.5 * Math.abs(maxDd(r)); };

function gridOf(g) { const out = []; for (const a of g.minEdge) for (const b of g.stopLossPct) for (const c of g.takeProfitPct) out.push({ minEdge: a, stopLossPct: b, takeProfitPct: c }); return out; }

/**
 * walkForward(closes, opts, btcCloses?) → informe fuera de muestra.
 * closes y btcCloses: cierres de 1 h alineados (misma longitud y misma última vela).
 */
export function walkForward(closes, opts = {}, btcCloses = null) {
  const O = { ...DEFAULT_WF, ...opts, grid: { ...DEFAULT_WF.grid, ...(opts.grid || {}) } };
  const sim = { exchange: O.exchange, symbol: O.symbol, usd: O.usd, capital: O.capital, regimeFn: regimeAt };
  const g = gridOf(O.grid);
  const windows = []; const n = closes.length;
  for (let s = 0; s + O.trainBars + O.embargoBars + O.testBars <= n; s += O.step) {
    const trEnd = s + O.trainBars; const teStart = trEnd + O.embargoBars; const teEnd = teStart + O.testBars;
    // 1) elegir con ENTRENAMIENTO
    let best = null;
    for (const p of g) {
      let r; try { r = proSim(closes.slice(s, trEnd), p, sim); } catch { continue; }
      if (r.trades.length < O.minTrainTrades) continue;
      const sc = score(r); if (!best || sc > best.sc) best = { p, sc, r };
    }
    // sin operaciones suficientes en entrenamiento: se usa la configuración más prudente (la más exigente) en lugar de inventar
    const params = best ? best.p : { minEdge: Math.max(...O.grid.minEdge), stopLossPct: Math.min(...O.grid.stopLossPct), takeProfitPct: 0 };
    // 2) medir en datos POSTERIORES (con las 60 velas previas solo como memoria de indicadores)
    const from = teStart - WARM;
    const test = proSim(closes.slice(from, teEnd), params, { ...sim, regimeFn: (c, i) => regimeAt(closes, from + i) });
    windows.push({ s, trEnd, teStart, teEnd, params, chosen: !!best, trainScorePct: best ? best.sc : null, trainTrades: best ? best.r.trades.length : 0, test, from });
  }
  if (!windows.length) throw new Error('Pocas velas para walk-forward (se necesitan al menos train + embargo + test)');

  const per = windows.map((w) => {
    const r = barRets(w.test.equity); const coin = (closes[w.teEnd - 1] / closes[w.teStart] - 1) * 100;
    const btc = btcCloses && btcCloses.length === n ? (btcCloses[w.teEnd - 1] / btcCloses[w.teStart] - 1) * 100 : null;
    return { teStart: w.teStart, teEnd: w.teEnd, params: w.params, chosen: w.chosen, trainScorePct: w.trainScorePct, testReturnPct: compound(r) * 100, coinHoldPct: coin, btcHoldPct: btc, trades: w.test.trades.length, maxDdPct: maxDd(r) };
  });

  // Agregado fuera de muestra
  const allRets = []; const byRegime = { bull: [], bear: [], sideways: [], volatile: [] }; const regimeTrades = { bull: [], bear: [], sideways: [], volatile: [] };
  const trades = []; let fees = 0; let slip = 0;
  for (const w of windows) {
    const r = barRets(w.test.equity);
    r.forEach((x, k) => { allRets.push(x); const gi = w.from + w.test.start + 1 + k; byRegime[regimeAt(closes, Math.min(gi, n - 1))].push(x); });
    for (const t of w.test.trades) { trades.push(t); regimeTrades[regimeAt(closes, Math.min(w.from + t.i, n - 1))].push(t); }
    fees += w.test.feesUsd; slip += w.test.slipUsd;
  }
  // El tramo OOS se mide solo en las velas de prueba: las primeras WARM del slice son memoria y no operan.
  const wins = trades.filter((t) => t.pnl > 0); const losses = trades.filter((t) => t.pnl < 0);
  const gl = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const oosReturn = compound(allRets) * 100;
  const spanBars = windows.reduce((a, w) => a + (w.teEnd - w.teStart), 0);
  const first = windows[0].teStart; const last = windows[windows.length - 1].teEnd;
  const coinHold = (closes[last - 1] / closes[first] - 1) * 100;
  const btcHold = btcCloses && btcCloses.length === n ? (btcCloses[last - 1] / btcCloses[first] - 1) * 100 : null;
  const sharpe = stdev(allRets) > 0 ? (mean(allRets) / stdev(allRets)) * Math.sqrt(8760) : null;
  const regimes = Object.fromEntries(Object.entries(byRegime).map(([k, r]) => [k, { bars: r.length, sharePct: allRets.length ? (r.length / allRets.length) * 100 : 0, returnPct: r.length ? compound(r) * 100 : null, meanBarBps: r.length ? mean(r) * 1e4 : null,
    trades: regimeTrades[k].length, winRatePct: regimeTrades[k].length ? (regimeTrades[k].filter((t) => t.pnl > 0).length / regimeTrades[k].length) * 100 : null, avgTradePct: regimeTrades[k].length ? mean(regimeTrades[k].map((t) => t.pct)) : null }]));

  // Estrés de deslizamiento: mismas configuraciones elegidas, pero con deslizamiento ×2 y ×3.
  const stress = [1, 2, 3].map((m) => {
    const rets = [];
    for (const w of windows) rets.push(...barRets(proSim(closes.slice(w.from, w.teEnd), w.params, { ...sim, slipMult: m, regimeFn: (c, i) => regimeAt(closes, w.from + i) }).equity));
    return { slipMult: m, returnPct: compound(rets) * 100 };
  });

  const isMean = mean(windows.filter((w) => w.chosen).map((w) => w.trainScorePct)); const oosMean = mean(per.map((p) => p.testReturnPct));
  const posWin = per.filter((p) => p.testReturnPct > 0).length;
  const checks = {
    muestra: trades.length >= 20, positivo: oosReturn > 0, consistente: posWin / per.length >= 0.6, aguanta_estres: stress[1].returnPct > 0, supera_mantener: oosReturn > coinHold,
  };
  const verdict = checks.muestra && checks.positivo && checks.consistente && checks.aguanta_estres
    ? 'EVIDENCIA RAZONABLE: positiva fuera de muestra, consistente y aguanta deslizamiento ×2. No es garantía.'
    : !checks.muestra ? 'MUESTRA INSUFICIENTE: menos de 20 operaciones fuera de muestra; no se puede concluir nada.' : 'VENTAJA NO DEMOSTRADA: no cumple todas las pruebas; no arriesgues dinero real con esta lógica en esta cripto.';
  return { symbol: O.symbol, exchange: O.exchange, params: { trainBars: O.trainBars, testBars: O.testBars, embargoBars: O.embargoBars, step: O.step, usd: O.usd, grid: O.grid }, bars: n,
    windows: per, oos: { spanBars, returnPct: oosReturn, coinHoldPct: coinHold, btcHoldPct: btcHold, sharpe, maxDdPct: maxDd(allRets), trades: trades.length, winRatePct: trades.length ? (wins.length / trades.length) * 100 : null,
      profitFactor: gl > 0 ? wins.reduce((s, t) => s + t.pnl, 0) / gl : null, avgTradePct: trades.length ? mean(trades.map((t) => t.pct)) : null, feesUsd: fees, slippageUsd: slip, positiveWindows: posWin, windowCount: per.length },
    is_vs_oos: { inSampleScoreMean: isMean, oosReturnMean: oosMean, gap: isMean - oosMean }, regimes, stress, checks, verdict };
}

const f1 = (x, d = 1) => (x === null || x === undefined || !Number.isFinite(x) ? '—' : x.toFixed(d));
export function formatReport(r) {
  const o = r.oos; const L = [];
  L.push(`# Validación fuera de muestra — ${r.symbol} en ${r.exchange}`, '', `**Veredicto:** ${r.verdict}`, '',
    `Método: walk-forward sin mirar el futuro. Cada ventana elige la mejor configuración con ${r.params.trainBars} h de entrenamiento y se mide en las ${r.params.testBars} h siguientes (separadas por ${r.params.embargoBars} h de embargo). ${r.windows.length} ventanas, ${o.spanBars} h fuera de muestra, ${r.bars} velas en total. Costos: modelo de comisión por nivel + spread + impacto + latencia del exchange.`, '',
    '## Resultado fuera de muestra', '',
    `| Estrategia | Comprar y mantener ${r.symbol.split('-')[0]} | Comprar y mantener BTC |`, '|---|---|---|', `| ${f1(o.returnPct)} % | ${f1(o.coinHoldPct)} % | ${f1(o.btcHoldPct)} % |`, '',
    `Operaciones ${o.trades} · aciertos ${f1(o.winRatePct, 0)} % · factor de beneficio ${f1(o.profitFactor, 2)} · promedio por operación ${f1(o.avgTradePct, 2)} % · caída máxima ${f1(o.maxDdPct)} % · Sharpe ${f1(o.sharpe, 2)} · comisiones $${f1(o.feesUsd, 2)} · deslizamiento $${f1(o.slippageUsd, 2)} · ventanas positivas ${o.positiveWindows}/${o.windowCount}`, '',
    '## Por régimen de mercado', '', '| Régimen | % del tiempo | Retorno | Operaciones | Aciertos | Promedio por operación |', '|---|---|---|---|---|---|');
  const nm = { bull: 'Alcista', bear: 'Bajista', sideways: 'Lateral', volatile: 'Volátil' };
  for (const [k, v] of Object.entries(r.regimes)) L.push(`| ${nm[k]} | ${f1(v.sharePct, 0)} % | ${f1(v.returnPct)} % | ${v.trades} | ${f1(v.winRatePct, 0)} % | ${f1(v.avgTradePct, 2)} % |`);
  L.push('', '## Estrés de deslizamiento', '', '| Deslizamiento | Retorno fuera de muestra |', '|---|---|', ...r.stress.map((s) => `| ×${s.slipMult} | ${f1(s.returnPct)} % |`), '',
    '## Ventanas', '', '| # | Parámetros elegidos | Entrenamiento | Prueba | Mantener | Operaciones |', '|---|---|---|---|---|---|',
    ...r.windows.map((w, i) => `| ${i + 1} | edge≥${w.params.minEdge}, stop ${w.params.stopLossPct} %, meta ${w.params.takeProfitPct} %${w.chosen ? '' : ' (sin datos: prudente)'} | ${f1(w.trainScorePct)} | ${f1(w.testReturnPct)} % | ${f1(w.coinHoldPct)} % | ${w.trades} |`), '',
    `Diferencia dentro vs fuera de muestra: ${f1(r.is_vs_oos.gap)} puntos (una diferencia grande es señal de sobreajuste).`, '',
    'Límites: no incluye el filtro de volumen ni de 15 min (no hay velas históricas con volumen guardadas; el modo «sombra» del bot las va registrando), ni funding/open interest (sin fuente verificada en spot). Resultados pasados no garantizan resultados futuros.');
  return L.join('\n');
}
