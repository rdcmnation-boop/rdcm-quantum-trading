// Escáner de oportunidades: recorre las criptos más grandes que Coinbase lista, elige para cada una una estrategia con el pasado
// (entrena 70 % / valida 30 %), y la prueba fuera de muestra con los costos estimados de Coinbase Y de Robinhood.
// Resultado: ranking honesto con la brecha de costo (gap) entre exchanges. Nada de esto mueve dinero.
import { backtest } from './backtest.js';
import { selectChampion, LAB_CAPITAL } from './lab.js';
import { fetchTopCoins, fetchBook } from './market.js';
import { getUniverse } from './universe.js';
import { SYMBOLS } from './exchanges.js';

const FALLBACK = ['BTC', 'ETH', 'SOL', 'XRP', 'ADA', 'DOGE', 'AVAX', 'LINK', 'DOT', 'LTC', 'BCH', 'XLM', 'ATOM', 'UNI', 'AAVE', 'NEAR', 'HBAR', 'ETC', 'SHIB', 'ARB', 'OP', 'FIL', 'APT'].map((s) => `${s}-USD`);
const TOP = 60; const MAX_SCAN = 30; const HIST = 720; const MIN_CANDLES = 400;
const okTest = (m) => m.totalReturnPct > 0 && m.totalReturnPct > m.buyHoldPct && m.closedTrades >= 3 && (m.sharpe ?? 0) > 1;

export function evaluateSymbol(symbol, closes, now) {
  const ch = selectChampion(closes, symbol, now);
  if (!ch) return null;
  const test = closes.slice(Math.floor(closes.length * 0.7) - 60);
  const per = {};
  for (const ex of ['coinbase', 'robinhood']) {
    const r = backtest(test, { ...ch.cfg, symbol }, { capital: LAB_CAPITAL, exchange: ex });
    per[ex] = { ret: r.metrics.totalReturnPct, bh: r.metrics.buyHoldPct, sharpe: r.metrics.sharpe, trades: r.metrics.closedTrades, drag: r.costs.dragPct, ok: okTest(r.metrics) };
  }
  const gap = per.robinhood.drag - per.coinbase.drag; // >0 = Robinhood cuesta más
  const cheaper = Math.abs(gap) < 0.01 ? 'igual' : gap > 0 ? 'coinbase' : 'robinhood';
  const qualified = per.coinbase.ok && per.robinhood.ok;
  const best = per.coinbase.ret >= per.robinhood.ret ? 'coinbase' : 'robinhood';
  const score = Math.min(per.coinbase.ret, per.robinhood.ret) - Math.max(0, per.coinbase.bh);
  return { symbol, label: ch.label, cfg: ch.cfg, train_sharpe: ch.train_sharpe, coinbase: per.coinbase, robinhood: per.robinhood, gap_pct: +gap.toFixed(3), cheaper, best_net: best,
    qualified, score: +score.toFixed(2), candles: closes.length, test_days: +((test.length) / 24).toFixed(1) };
}

export async function runScanner({ store, feed, market = null, f = fetch, now = Date.now() }) {
  const notes = [];
  const uni = await getUniverse({ f, now });
  let top = [];
  try { top = await fetchTopCoins(TOP, f); } catch (e) { notes.push(`CoinGecko sin ranking (${e.message}); se usa una lista fija de criptos grandes`); }
  const meta = new Map(top.map((c) => [c.symbol, c]));
  let cands = (top.length ? top.map((c) => c.symbol) : FALLBACK).filter((s) => uni.coinbase.includes(s) && !/^(USDT|USDC|DAI|PYUSD|WBTC|WETH|STETH)-/.test(s));
  const skipped = Math.max(0, cands.length - MAX_SCAN);
  cands = cands.slice(0, MAX_SCAN);
  if (!uni.live) notes.push(`Lista de Coinbase no disponible (${uni.error || 'sin datos'}); se usa la base`);
  const items = [];
  for (const symbol of cands) {
    let closes;
    try { closes = await feed.getHistory(symbol, HIST); } catch (e) { notes.push(`${symbol}: ${e.message}`); continue; }
    if (closes.length < MIN_CANDLES) { notes.push(`${symbol}: historial corto (${closes.length} velas)`); continue; }
    let it = null; try { it = evaluateSymbol(symbol, closes, now); } catch { it = null; }
    if (!it) continue;
    const m = meta.get(symbol); if (m) Object.assign(it, { mcap: m.mcap, vol24: m.vol24, ch24: m.ch24, ch7: m.ch7 });
    items.push(it);
  }
  items.sort((a, b) => (b.qualified - a.qualified) || (b.score - a.score));
  // Afina con el libro real de Coinbase solo a los mejores (spread alto = no operable con seguridad).
  for (const it of items.slice(0, 6)) {
    try { const b = await fetchBook(it.symbol, f); if (b) { it.spread_pct = +b.spreadPct.toFixed(4); if (b.spreadPct > 0.5) { it.qualified = false; it.warning = `Spread real ${b.spreadPct.toFixed(2)} %: demasiado caro`; } } } catch { /* sin libro */ }
  }
  let regime = null; try { regime = JSON.parse(await store.getSetting('market:snapshot', 'null'))?.regime?.code || null; } catch { /* sin régimen */ }
  const res = { t: now, regime, scanned: items.length, universe: uni.coinbase.length, skipped, items, notes,
    warning: `Prueba fuera de muestra de ~${items[0]?.test_days ?? 0} días con costos ESTIMADOS. Es evidencia parcial, no garantía.` };
  if (items.length) await store.setSetting('scanner:latest', JSON.stringify(res)); // si todo falló, se conserva el último resultado bueno
  return res;
}

export async function getScanner(store) {
  try { return JSON.parse(await store.getSetting('scanner:latest', 'null')); } catch { return null; }
}

export function scannerProposals(sc) {
  if (!sc || !sc.items.length) return [];
  const q = sc.items.filter((i) => i.qualified);
  const top = q.slice(0, 3).map((i) => `${i.symbol} (${i.label}, ${i.coinbase.ret.toFixed(1)} % / ${i.robinhood.ret.toFixed(1)} %, más barato en ${i.cheaper})`).join(', ');
  const worst = [...sc.items].sort((a, b) => Math.abs(b.gap_pct) - Math.abs(a.gap_pct))[0];
  const out = [];
  out.push({ kind: 'insight', key: `scanner:top:${q.map((i) => i.symbol).slice(0, 3).join('+') || 'ninguna'}`,
    title: q.length ? `Escáner: ${q.length} de ${sc.scanned} criptos superan a comprar y mantener en ambos exchanges` : `Escáner: ninguna de ${sc.scanned} criptos supera a comprar y mantener, neto de costos`,
    detail: { text: q.length ? `Mejores: ${top}. El bot en modo AUTO solo opera estas. ${sc.warning}` : `El Cerebro no compra nada en modo AUTO hasta que aparezca una oportunidad validada. ${sc.warning}` },
    evidence: { regimen: sc.regime, escaneadas: sc.scanned, calificadas: q.length }, touches: [] });
  if (worst && Math.abs(worst.gap_pct) > 0.5) out.push({ kind: 'insight', key: `scanner:gap:${worst.symbol}`,
    title: `Brecha de costo: ${worst.symbol} sale ${Math.abs(worst.gap_pct).toFixed(2)} % del capital más caro en ${worst.gap_pct > 0 ? 'Robinhood' : 'Coinbase'}`,
    detail: { text: 'El ruteo "mejor exchange" prefiere el más barato cuando tienes ambos conectados.' }, evidence: { gap: worst.gap_pct }, touches: [] });
  return out;
}
