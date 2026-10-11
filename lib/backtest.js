// Backtest simple y honesto sobre velas históricas: incluye comisiones y compara con "comprar y mantener".
// Solo largo, una posición por par. No predice el futuro: sirve para descartar estrategias malas.
import { decide } from './strategy.js';

const STEPS_PER_YEAR = 24 * 365; // velas de 1 hora

function stats(arr) {
  const n = arr.length;
  const mean = arr.reduce((s, x) => s + x, 0) / (n || 1);
  const v = arr.reduce((s, x) => s + (x - mean) ** 2, 0) / (n || 1);
  return { mean, sd: Math.sqrt(v) };
}

export function backtest(closes, cfg, { feePct = 0.6, capital = 1000, candleMs = 3600000 } = {}) {
  let cash = capital;
  let qty = 0;
  let costBasis = 0;
  let lastBuyAt = 0;
  let buys = 0;
  const closed = [];
  const equity = [];
  const start = cfg.strategy === 'sma' ? cfg.slow + 1 : 1;
  if (closes.length <= start + 2) throw new Error('Pocas velas para probar esta configuración');
  const fee = feePct / 100;

  for (let i = start; i < closes.length; i++) {
    const price = closes[i];
    const now = i * candleMs;
    const d = decide(cfg, { closes: closes.slice(0, i + 1), now, lastBuyAt, position: qty });
    if (d.action === 'buy') {
      const usd = Math.min(d.usd, cfg.maxOrderUsd, cash / (1 + fee));
      if (usd >= 1) {
        cash -= usd * (1 + fee);
        qty += usd / price;
        costBasis += usd * (1 + fee);
        lastBuyAt = now;
        buys += 1;
      }
    } else if (d.action === 'sell' && qty > 0) {
      const proceeds = qty * price * (1 - fee);
      closed.push(proceeds - costBasis);
      cash += proceeds;
      qty = 0;
      costBasis = 0;
    }
    equity.push(cash + qty * price);
  }

  const rets = [];
  for (let i = 1; i < equity.length; i++) rets.push(equity[i] / equity[i - 1] - 1);
  const { mean, sd } = stats(rets);
  const down = stats(rets.map((r) => Math.min(0, r)));
  const downSd = Math.sqrt(rets.reduce((s, r) => s + Math.min(0, r) ** 2, 0) / (rets.length || 1));
  let peak = -Infinity;
  let maxDd = 0;
  for (const e of equity) { peak = Math.max(peak, e); maxDd = Math.min(maxDd, e / peak - 1); }
  const wins = closed.filter((x) => x > 0);
  const losses = closed.filter((x) => x < 0);
  const grossLoss = Math.abs(losses.reduce((s, x) => s + x, 0));
  const last = equity[equity.length - 1];
  const step = Math.max(1, Math.floor(equity.length / 120));
  void down;

  return {
    candles: closes.length - start,
    feePct,
    capital,
    metrics: {
      totalReturnPct: (last / capital - 1) * 100,
      buyHoldPct: (closes[closes.length - 1] / closes[start] - 1) * 100,
      maxDrawdownPct: maxDd * 100,
      sharpe: sd > 0 ? (mean / sd) * Math.sqrt(STEPS_PER_YEAR) : null,
      sortino: downSd > 0 ? (mean / downSd) * Math.sqrt(STEPS_PER_YEAR) : null,
      buys,
      closedTrades: closed.length,
      winRatePct: closed.length ? (wins.length / closed.length) * 100 : null,
      profitFactor: grossLoss > 0 ? wins.reduce((s, x) => s + x, 0) / grossLoss : null,
    },
    equity: equity.filter((_, i) => i % step === 0),
  };
}
