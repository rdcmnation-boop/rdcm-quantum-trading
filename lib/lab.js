// Laboratorio de papel ($1M virtual). PRUEBA HACIA ADELANTE con memoria:
//  1) elige un "campeón" por par con datos pasados (entrena 70 % / valida 30 %, costos de Coinbase),
//  2) lo CONGELA y desde ese momento lo simula en Coinbase y Robinhood con los costos estimados de cada uno,
//  3) en cada corrida del Director guarda una foto del avance. Así el progreso es real y acumulado, no un backtest repetido.
// Nada de esto mueve dinero. Solo informa y propone.
import { backtest, minStart } from './backtest.js';

export const LAB_CAPITAL = 1000000;
export const LAB_SYMBOLS = ['BTC-USD', 'ETH-USD'];
const HOUR = 3600000;
const RESELECT_AFTER = 14 * 24 * HOUR;
const MIN_FWD_CANDLES = 168; // 7 días antes de proponer algo basado en el avance hacia adelante

const BASE = { usd: 50000, maxOrderUsd: 250000, maxDailyUsd: 1000000, stopLossPct: 8, intervalMin: 60, fast: 20, slow: 50, rsiBuy: 30, rsiSell: 60 };
export const GRID = [
  { strategy: 'sma', fast: 5, slow: 20 }, { strategy: 'sma', fast: 10, slow: 30 }, { strategy: 'sma', fast: 20, slow: 50 },
  { strategy: 'macd' }, { strategy: 'rsi', rsiBuy: 30, rsiSell: 60 }, { strategy: 'rsi', rsiBuy: 25, rsiSell: 55 },
].map((g) => ({ ...BASE, ...g }));

export const labelOf = (c) => (c.strategy === 'sma' ? `SMA ${c.fast}/${c.slow}` : c.strategy === 'rsi' ? `RSI ${c.rsiBuy}/${c.rsiSell}` : c.strategy.toUpperCase());
const opt = (exchange) => ({ capital: LAB_CAPITAL, exchange });
const small = (eq, n = 60) => { const step = Math.max(1, Math.floor(eq.length / n)); return eq.filter((_, i) => i % step === 0 || i === eq.length - 1).map((x) => Math.round(x)); };

export function selectChampion(closes, symbol, now) {
  const cut = Math.floor(closes.length * 0.7);
  const train = closes.slice(0, cut); const test = closes.slice(cut - 60);
  let best = null;
  for (const cfg of GRID) {
    try {
      const r = backtest(train, { ...cfg, symbol }, opt('coinbase'));
      const s = r.metrics.sharpe ?? -Infinity;
      if (r.metrics.closedTrades >= 3 && (!best || s > best.s)) best = { cfg, s, train: r.metrics };
    } catch { /* sin datos suficientes */ }
  }
  if (!best) return null;
  const v = backtest(test, { ...best.cfg, symbol }, opt('coinbase'));
  const m = v.metrics;
  return { symbol, cfg: best.cfg, label: labelOf(best.cfg), selected_at: now,
    train_sharpe: best.train.sharpe, val_return: m.totalReturnPct, val_bh: m.buyHoldPct, val_sharpe: m.sharpe, val_trades: m.closedTrades,
    validated: m.totalReturnPct > 0 && m.totalReturnPct > m.buyHoldPct && m.closedTrades >= 3 && (m.sharpe ?? 0) > 1 };
}

export async function getLab(store) {
  try { const s = JSON.parse(await store.getSetting('lab:state', 'null')); if (s) return s; } catch { /* vacío */ }
  return { capital: LAB_CAPITAL, started_at: null, champions: {}, latest: {}, snapshots: [], lessons: [], runs: 0 };
}

// Avanza el laboratorio con los datos más recientes. `feed.getHistory(symbol, n)` devuelve cierres por hora (el último = ahora).
export async function runLab({ store, feed, now = Date.now() }) {
  const lab = await getLab(store);
  const notes = [];
  if (!lab.started_at) lab.started_at = now;
  lab.runs = (lab.runs || 0) + 1;
  let regime = null; try { regime = JSON.parse(await store.getSetting('market:snapshot', 'null'))?.regime?.code || null; } catch { regime = null; }
  if (regime && lab.regime && regime !== lab.regime) lab.lessons.unshift({ t: now, text: `Régimen de mercado: ${lab.regime} → ${regime}. Se vigila cómo rinden los campeones.` });
  lab.regime = regime || lab.regime || null;
  const picks = [];
  for (const symbol of LAB_SYMBOLS) {
    let closes;
    try { closes = await feed.getHistory(symbol, 1200); } catch (e) { notes.push(`${symbol}: ${e.message}`); continue; }
    if (closes.length < 400) { notes.push(`${symbol}: historial insuficiente`); continue; }
    let ch = lab.champions[symbol];
    if (!ch || now - ch.selected_at > RESELECT_AFTER) {
      const nw = selectChampion(closes, symbol, now);
      if (nw) {
        if (ch) lab.lessons.unshift({ t: now, text: `${symbol}: nuevo campeón ${nw.label} (antes ${ch.label}); se reinicia la prueba hacia adelante.` });
        lab.champions[symbol] = ch = nw; picks.push(`${symbol}→${nw.label}`);
      } else { notes.push(`${symbol}: ninguna estrategia generó operaciones suficientes`); continue; }
    }
    const candles = Math.floor((now - ch.selected_at) / HOUR);
    const per = {};
    for (const ex of ['coinbase', 'robinhood']) {
      if (candles < 5) { per[ex] = null; continue; }
      const len = Math.min(closes.length, candles + minStart(ch.cfg) + 2);
      try {
        const r = backtest(closes.slice(-len), { ...ch.cfg, symbol }, opt(ex));
        per[ex] = { candles: r.candles, ret: r.metrics.totalReturnPct, bh: r.metrics.buyHoldPct, sharpe: r.metrics.sharpe, dd: r.metrics.maxDrawdownPct,
          trades: r.metrics.closedTrades, log: r.trades.slice(-20).map((x) => ({ t: now - (len - 1 - x.i) * HOUR, side: x.side, price: x.price, usd: x.usd, pnl: x.pnl ?? null })), fees: r.costs.feesUsd, slip: r.costs.slippageUsd, drag: r.costs.dragPct, equity: small(r.equity) };
      } catch { per[ex] = null; }
    }
    lab.latest[symbol] = { t: now, candles, ...per };
    for (const ex of ['coinbase', 'robinhood']) if (per[ex]) lab.snapshots.push({ t: now, regime, symbol, exchange: ex, candles: per[ex].candles, ret: per[ex].ret, bh: per[ex].bh, drag: per[ex].drag });
  }
  lab.snapshots = lab.snapshots.slice(-400);
  // Lección acumulada: qué exchange cuesta menos con la estrategia actual (solo si hay datos hacia adelante).
  for (const symbol of LAB_SYMBOLS) {
    const l = lab.latest[symbol];
    if (l && l.coinbase && l.robinhood) {
      const diff = l.robinhood.drag - l.coinbase.drag;
      const text = `${symbol} (${lab.champions[symbol].label}): costo de ejecución ${l.coinbase.drag.toFixed(3)} % del capital en Coinbase vs ${l.robinhood.drag.toFixed(3)} % en Robinhood${Math.abs(diff) > 0.01 ? ` → ${diff > 0 ? 'Coinbase' : 'Robinhood'} sale más barato` : ''}.`;
      if (!lab.lessons.length || lab.lessons[0].text.slice(0, 40) !== text.slice(0, 40) || now - lab.lessons[0].t > 6 * HOUR) lab.lessons.unshift({ t: now, text });
    }
  }
  lab.lessons = lab.lessons.slice(0, 30);
  await store.setSetting('lab:state', JSON.stringify(lab));
  if (picks.length) notes.unshift(`Campeones elegidos: ${picks.join(', ')}`);
  return { lab, notes };
}

// Propuestas basadas SOLO en el avance real hacia adelante (>= 7 días, gana a comprar y mantener neto de costos en AMBOS exchanges).
export function labProposals(lab) {
  const out = [];
  for (const symbol of LAB_SYMBOLS) {
    const ch = lab.champions[symbol]; const l = lab.latest[symbol];
    if (!ch || !l || !l.coinbase || !l.robinhood || l.candles < MIN_FWD_CANDLES) continue;
    const win = (x) => x.ret > 0 && x.ret > x.bh && x.trades >= 2;
    const evidence = { symbol, dias_hacia_adelante: +(l.candles / 24).toFixed(1), campeon: ch.label, coinbase: { ...l.coinbase, equity: undefined }, robinhood: { ...l.robinhood, equity: undefined },
      validacion_previa: { retorno: ch.val_return, comprar_y_mantener: ch.val_bh, sharpe: ch.val_sharpe } };
    if (win(l.coinbase) && win(l.robinhood)) {
      out.push({ kind: 'strategy_defaults', key: `lab:${symbol}:${ch.label}`, title: `${symbol}: ${ch.label} gana ${(l.candles / 24).toFixed(0)} días hacia adelante, neto de costos, en Coinbase y Robinhood`,
        detail: { text: 'Prueba de papel $1M en vivo (hacia adelante). Solo cambia la estrategia sugerida para clientes nuevos.',
          action: { type: 'default_cfg', cfg: { strategy: ch.cfg.strategy, fast: ch.cfg.fast, slow: ch.cfg.slow, rsiBuy: ch.cfg.rsiBuy, rsiSell: ch.cfg.rsiSell } } }, evidence, touches: ['strategy_defaults'] });
    } else {
      out.push({ kind: 'insight', key: `lab:insight:${symbol}`, title: `${symbol}: ${ch.label} no supera a comprar y mantener tras ${(l.candles / 24).toFixed(0)} días (coinbase ${l.coinbase.ret.toFixed(1)} %, robinhood ${l.robinhood.ret.toFixed(1)} %, B&H ${l.coinbase.bh.toFixed(1)} %)`,
        detail: { text: 'Sin cambios recomendados. El laboratorio reeligirá campeón automáticamente cada 14 días.' }, evidence, touches: [] });
    }
  }
  return out;
}
