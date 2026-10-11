// Backtest honesto sobre velas históricas: incluye comisiones, stop-loss y compara con "comprar y mantener".
// Solo largo, una posición por par. No predice el futuro: sirve para descartar estrategias malas.
import { decide, positionFromOrders } from './strategy.js';
import { stdev } from './indicators.js';
import { simulateFill, volume30d } from './costs.js';

export function minStart(cfg) {
  return { dca: 1, sma: cfg.slow + 1, rsi: 16, macd: 40 }[cfg.strategy] || 40;
}

// Con `exchange` ('coinbase'|'robinhood') usa el modelo de costos realista (comisión por nivel de volumen, spread,
// impacto y latencia). Sin `exchange` usa una comisión plana feePct (compatibilidad).
export function backtest(closes, cfg, { feePct = 0.6, capital = 1000, candleMs = 3600000, exchange = null } = {}) {
  const stepsPerYear = (365 * 86400000) / candleMs;
  let cash = capital;
  const fills = []; // {side, qty, usd, ts}
  const closed = [];
  const equity = [];
  const idx = [];
  let inMarket = 0;
  const start = minStart(cfg);
  if (closes.length <= start + 5) throw new Error('Pocas velas para probar esta configuración');
  const fee = feePct / 100;
  let feesUsd = 0; let slipUsd = 0;
  const volFills = [];
  const tradeLog = [];

  for (let i = start; i < closes.length; i++) {
    const price = closes[i];
    const now = i * candleMs;
    const pos = positionFromOrders(fills);
    const d = decide(cfg, { closes: closes.slice(0, i + 1), now, price, lastBuyAt: pos.lastBuyAt,
      lastSellAt: pos.lastSellAt, position: pos.qty, avgCost: pos.avgCost });
    if (d.action === 'buy') {
      if (exchange) {
        const want = Math.min(d.usd, cfg.maxOrderUsd, cash);
        const f = simulateFill({ side: 'buy', usd: want, price, nextPrice: closes[i + 1] ?? null, symbol: cfg.symbol, exchange, vol30d: volume30d(volFills, now), candleMs });
        const usd = Math.min(want, cash / (1 + f.feePct / 100));
        if (usd >= 1) {
          const feeU = usd * f.feePct / 100;
          cash -= usd + feeU; feesUsd += feeU; slipUsd += (usd / f.price) * (f.price - f.midPrice);
          fills.push({ side: 'buy', qty: usd / f.price, usd: usd + feeU, ts: now }); volFills.push({ usd, ts: now });
          tradeLog.push({ i, side: 'buy', price: f.price, usd: usd + feeU, qty: usd / f.price });
        }
      } else {
        const usd = Math.min(d.usd, cfg.maxOrderUsd, cash / (1 + fee));
        if (usd >= 1) { cash -= usd * (1 + fee); fills.push({ side: 'buy', qty: usd / price, usd: usd * (1 + fee), ts: now }); tradeLog.push({ i, side: 'buy', price, usd: usd * (1 + fee), qty: usd / price }); }
      }
    } else if (d.action === 'sell' && pos.qty > 0) {
      let proceeds; let sellPx = price;
      if (exchange) {
        const f = simulateFill({ side: 'sell', usd: pos.qty * price, price, nextPrice: closes[i + 1] ?? null, symbol: cfg.symbol, exchange, vol30d: volume30d(volFills, now), candleMs });
        const gross = pos.qty * f.price; const feeU = gross * f.feePct / 100;
        sellPx = f.price; proceeds = gross - feeU; feesUsd += feeU; slipUsd += pos.qty * (f.midPrice - f.price); volFills.push({ usd: gross, ts: now });
      } else proceeds = pos.qty * price * (1 - fee);
      closed.push(proceeds - pos.avgCost * pos.qty);
      tradeLog.push({ i, side: 'sell', price: sellPx, usd: proceeds, qty: pos.qty, pnl: proceeds - pos.avgCost * pos.qty });
      cash += proceeds;
      fills.push({ side: 'sell', qty: pos.qty, usd: proceeds, ts: now });
    }
    const q = positionFromOrders(fills).qty;
    if (q > 0) inMarket += 1;
    equity.push(cash + q * price);
    idx.push(i);
  }

  const rets = []; const arets = [];
  for (let i = 1; i < equity.length; i++) {
    rets.push(equity[i] / equity[i - 1] - 1);
    arets.push(closes[idx[i]] / closes[idx[i - 1]] - 1);
  }
  const mean = (a) => a.reduce((s, x) => s + x, 0) / (a.length || 1);
  const mr = mean(rets); const ma = mean(arets);
  const sd = stdev(rets);
  const downSd = Math.sqrt(rets.reduce((s, r) => s + Math.min(0, r) ** 2, 0) / (rets.length || 1));
  const varA = arets.reduce((s, x) => s + (x - ma) ** 2, 0) / (arets.length || 1);
  const cov = rets.reduce((s, r, i) => s + (r - mr) * (arets[i] - ma), 0) / (rets.length || 1);
  const beta = varA > 0 ? cov / varA : null;
  let peak = -Infinity; let maxDd = 0;
  for (const e of equity) { peak = Math.max(peak, e); maxDd = Math.min(maxDd, e / peak - 1); }
  const wins = closed.filter((x) => x > 0);
  const losses = closed.filter((x) => x < 0);
  const grossLoss = Math.abs(losses.reduce((s, x) => s + x, 0));
  const last = equity[equity.length - 1];
  const step = Math.max(1, Math.floor(equity.length / 120));
  const buys = fills.filter((f) => f.side === 'buy').length;

  return {
    candles: closes.length - start,
    feePct: exchange ? null : feePct, exchange, capital,
    costs: { feesUsd, slippageUsd: slipUsd, totalUsd: feesUsd + slipUsd, dragPct: ((feesUsd + slipUsd) / capital) * 100 },
    metrics: {
      totalReturnPct: (last / capital - 1) * 100,
      buyHoldPct: (closes[closes.length - 1] / closes[start] - 1) * 100,
      maxDrawdownPct: maxDd * 100,
      sharpe: sd > 0 ? (mr / sd) * Math.sqrt(stepsPerYear) : null,
      sortino: downSd > 0 ? (mr / downSd) * Math.sqrt(stepsPerYear) : null,
      beta,
      alphaAnnualPct: beta === null ? null : (mr - beta * ma) * stepsPerYear * 100,
      exposurePct: (inMarket / equity.length) * 100,
      buys,
      closedTrades: closed.length,
      winRatePct: closed.length ? (wins.length / closed.length) * 100 : null,
      profitFactor: grossLoss > 0 ? wins.reduce((s, x) => s + x, 0) / grossLoss : null,
    },
    equity: equity.filter((_, i) => i % step === 0),
    trades: tradeLog,
  };
}
