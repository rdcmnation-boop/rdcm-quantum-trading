// Estrategias transparentes + gestión de riesgo. Funciones puras: no hacen llamadas de red.
// Este archivo se incluye tal cual dentro del bot descargable.
import { sma, rsi, macd } from './indicators.js';

export const STRATEGIES = ['dca', 'sma', 'rsi', 'macd'];
const COOLDOWN_MS = 6 * 3600000; // tras vender, no se vuelve a comprar durante 6 h (evita recompras en bucle)

export const DEFAULT_CFG = {
  enabled: false,
  mode: 'paper',          // 'paper' (simulado) o 'live' (dinero real)
  connectionId: null,     // solo para live
  symbol: 'BTC-USD',
  strategy: 'dca',        // dca | sma | rsi | macd
  usd: 10,                // monto por compra
  intervalMin: 1440,      // DCA: cada cuántos minutos
  fast: 20,               // SMA rápida (velas de 1 h)
  slow: 50,               // SMA lenta
  rsiBuy: 30,             // RSI: compra si baja de este nivel
  rsiSell: 60,            // RSI: vende si sube de este nivel
  stopLossPct: 8,         // vende todo si el precio cae este % bajo tu costo promedio (no aplica a DCA); 0 = sin stop
  maxOrderUsd: 25,        // tope por orden
  maxDailyUsd: 100,       // tope de compras por 24 h (live)
  autoMode: 'pro',        // AUTO: 'active' = compra cuando la tendencia es alcista en criptos que ganaron la prueba; 'validated' = solo cruces de las validadas
  sizing: 'fixed',        // 'fixed' = monto fijo; 'balance' = reparte el saldo disponible del exchange (siempre bajo los topes)
  maxPositions: 3,        // modo AUTO: máximo de criptos distintas a la vez
  paperExchange: 'coinbase', liveAck: false,         // el cliente confirmó que entiende el riesgo
};

// Posición del bot a partir de sus órdenes exitosas (costo promedio). orders: [{side, qty, usd, ts}]
export function positionFromOrders(orders) {
  const sorted = orders.slice().sort((a, b) => a.ts - b.ts);
  let qty = 0; let cost = 0; let lastBuyAt = 0; let lastSellAt = 0;
  for (const o of sorted) {
    if (o.side === 'buy') { qty += o.qty; cost += o.usd; lastBuyAt = o.ts; }
    else {
      const avg = qty > 0 ? cost / qty : 0;
      const q = Math.min(o.qty, qty);
      qty -= q; cost -= avg * q; lastSellAt = o.ts;
    }
  }
  if (qty < 1e-12) { qty = 0; cost = 0; }
  return { qty, avgCost: qty > 0 ? cost / qty : 0, lastBuyAt, lastSellAt };
}

// ctx: { closes, now, price, lastBuyAt, lastSellAt, position, avgCost }
export function decide(cfg, ctx) {
  const c = ctx.closes || [];
  const price = ctx.price || c[c.length - 1];
  const flat = !(ctx.position > 0);

  if (cfg.strategy !== 'dca' && !flat && cfg.stopLossPct > 0 && price && ctx.avgCost > 0
    && price <= ctx.avgCost * (1 - cfg.stopLossPct / 100)) {
    return { action: 'sell', qty: ctx.position, reason: `Stop-loss: el precio ${price.toFixed(2)} cayó ${cfg.stopLossPct}% bajo tu costo promedio ${ctx.avgCost.toFixed(2)}` };
  }
  const cooling = ctx.lastSellAt && ctx.now - ctx.lastSellAt < COOLDOWN_MS;
  const hold = (reason) => ({ action: 'hold', reason });

  if (cfg.strategy === 'dca') {
    const every = cfg.intervalMin * 60000;
    if (!ctx.lastBuyAt || ctx.now - ctx.lastBuyAt >= every) {
      return { action: 'buy', usd: cfg.usd, reason: `Compra periódica (DCA) cada ${cfg.intervalMin} min` };
    }
    return hold('Esperando el próximo intervalo');
  }

  if (cfg.strategy === 'sma') {
    const f = sma(c, cfg.fast); const s = sma(c, cfg.slow);
    const pf = sma(c.slice(0, -1), cfg.fast); const ps = sma(c.slice(0, -1), cfg.slow);
    if ([f, s, pf, ps].some((x) => x === null)) return hold('Faltan velas para calcular');
    if (pf <= ps && f > s && flat) {
      return cooling ? hold('Enfriamiento tras una venta') : { action: 'buy', usd: cfg.usd, reason: `Cruce alcista: SMA${cfg.fast} (${f.toFixed(2)}) pasó sobre SMA${cfg.slow} (${s.toFixed(2)})` };
    }
    if (pf >= ps && f < s && !flat) return { action: 'sell', qty: ctx.position, reason: `Cruce bajista: SMA${cfg.fast} (${f.toFixed(2)}) cayó bajo SMA${cfg.slow} (${s.toFixed(2)})` };
    return hold('Sin cruce');
  }

  if (cfg.strategy === 'rsi') {
    const r = rsi(c, 14);
    if (r === null) return hold('Faltan velas para calcular');
    if (flat && r < cfg.rsiBuy) {
      return cooling ? hold('Enfriamiento tras una venta') : { action: 'buy', usd: cfg.usd, reason: `RSI(14) = ${r.toFixed(1)}, bajo ${cfg.rsiBuy}: sobreventa` };
    }
    if (!flat && r > cfg.rsiSell) return { action: 'sell', qty: ctx.position, reason: `RSI(14) = ${r.toFixed(1)}, sobre ${cfg.rsiSell}: rebote completado` };
    return hold(`RSI(14) = ${r.toFixed(1)}, sin señal`);
  }

  if (cfg.strategy === 'macd') {
    const m = macd(c);
    if (!m) return hold('Faltan velas para calcular');
    if (m.prevMacd <= m.prevSignal && m.macd > m.signal && flat) {
      return cooling ? hold('Enfriamiento tras una venta') : { action: 'buy', usd: cfg.usd, reason: `MACD cruzó sobre su señal (histograma ${m.hist.toFixed(2)})` };
    }
    if (m.prevMacd >= m.prevSignal && m.macd < m.signal && !flat) return { action: 'sell', qty: ctx.position, reason: `MACD cruzó bajo su señal (histograma ${m.hist.toFixed(2)})` };
    return hold('Sin cruce de MACD');
  }
  return hold('Estrategia desconocida');
}

// Valida y normaliza la configuración. Devuelve { ok, cfg } o { ok:false, error }.
export function validateCfg(input, { hardMaxOrder = 250, hardMaxDaily = 1000, symbols = [] } = {}) {
  const c = { ...DEFAULT_CFG };
  for (const k of Object.keys(DEFAULT_CFG)) if (input && k in input) c[k] = input[k];
  c.connectionId = typeof c.connectionId === 'string' && c.connectionId.length <= 64 ? c.connectionId : null;
  const n = (x) => Number(x);
  if (!['paper', 'live'].includes(c.mode)) return { ok: false, error: 'Modo inválido' };
  if (!STRATEGIES.includes(c.strategy)) return { ok: false, error: 'Estrategia inválida' };
  if (symbols.length && c.symbol !== 'AUTO' && !symbols.includes(c.symbol)) return { ok: false, error: 'Símbolo no permitido' };
  c.usd = n(c.usd); c.intervalMin = Math.floor(n(c.intervalMin)); c.fast = Math.floor(n(c.fast));
  c.slow = Math.floor(n(c.slow)); c.maxOrderUsd = n(c.maxOrderUsd); c.maxDailyUsd = n(c.maxDailyUsd);
  c.rsiBuy = n(c.rsiBuy); c.rsiSell = n(c.rsiSell); c.stopLossPct = n(c.stopLossPct);
  if (![c.usd, c.intervalMin, c.fast, c.slow, c.maxOrderUsd, c.maxDailyUsd, c.rsiBuy, c.rsiSell, c.stopLossPct].every(Number.isFinite)) {
    return { ok: false, error: 'Números inválidos' };
  }
  if (c.usd < 1) return { ok: false, error: 'El monto mínimo es $1' };
  if (c.maxOrderUsd < c.usd) return { ok: false, error: 'El tope por orden no puede ser menor que el monto' };
  if (c.maxOrderUsd > hardMaxOrder) return { ok: false, error: `El tope por orden máximo es $${hardMaxOrder}` };
  if (c.maxDailyUsd > hardMaxDaily) return { ok: false, error: `El tope diario máximo es $${hardMaxDaily}` };
  if (c.maxDailyUsd < c.maxOrderUsd) return { ok: false, error: 'El tope diario no puede ser menor que el tope por orden' };
  if (c.intervalMin < 15) return { ok: false, error: 'El intervalo mínimo es 15 minutos' };
  if (c.fast < 2 || c.slow <= c.fast || c.slow > 150) return { ok: false, error: 'SMA: rápida >= 2 y lenta mayor que la rápida (máx. 150)' };
  if (c.rsiBuy < 5 || c.rsiBuy > 50 || c.rsiSell < c.rsiBuy + 5 || c.rsiSell > 95) return { ok: false, error: 'RSI: compra entre 5 y 50, venta entre compra+5 y 95' };
  if (c.stopLossPct < 0 || c.stopLossPct > 50) return { ok: false, error: 'El stop-loss debe estar entre 0 y 50 %' };
  c.paperExchange = ['coinbase', 'robinhood', 'best'].includes(c.paperExchange) ? c.paperExchange : 'coinbase';
  c.autoMode = ['validated', 'active', 'pro'].includes(c.autoMode) ? c.autoMode : 'pro';
  c.sizing = c.sizing === 'balance' ? 'balance' : 'fixed';
  c.maxPositions = Math.min(10, Math.max(1, Math.floor(n(c.maxPositions)) || 3));
  c.enabled = !!c.enabled;
  c.liveAck = !!c.liveAck;
  return { ok: true, cfg: c };
}
