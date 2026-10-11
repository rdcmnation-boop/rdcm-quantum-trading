// Estrategias simples y transparentes. Función pura: no hace llamadas de red.
// Este archivo se incluye tal cual dentro del bot descargable.

export const DEFAULT_CFG = {
  enabled: false,
  mode: 'paper',          // 'paper' (simulado) o 'live' (dinero real)
  connectionId: null,     // solo para live
  symbol: 'BTC-USD',
  strategy: 'dca',        // 'dca' o 'sma'
  usd: 10,                // monto por compra
  intervalMin: 1440,      // DCA: cada cuántos minutos
  fast: 20,               // SMA rápida (velas de 1 h)
  slow: 50,               // SMA lenta
  maxOrderUsd: 25,        // tope por orden
  maxDailyUsd: 100,       // tope de compras por 24 h (live)
  liveAck: false,         // el cliente confirmó que entiende el riesgo
};

export function sma(arr, n) {
  if (arr.length < n) return null;
  let s = 0;
  for (let i = arr.length - n; i < arr.length; i++) s += arr[i];
  return s / n;
}

// ctx: { closes, now, lastBuyAt, position }  (position = cantidad que el bot tiene)
export function decide(cfg, ctx) {
  if (cfg.strategy === 'dca') {
    const every = cfg.intervalMin * 60000;
    if (!ctx.lastBuyAt || ctx.now - ctx.lastBuyAt >= every) {
      return { action: 'buy', usd: cfg.usd, reason: `Compra periódica (DCA) cada ${cfg.intervalMin} min` };
    }
    return { action: 'hold', reason: 'Esperando el próximo intervalo' };
  }
  if (cfg.strategy === 'sma') {
    const c = ctx.closes || [];
    const f = sma(c, cfg.fast);
    const s = sma(c, cfg.slow);
    const pf = sma(c.slice(0, -1), cfg.fast);
    const ps = sma(c.slice(0, -1), cfg.slow);
    if ([f, s, pf, ps].some((x) => x === null)) return { action: 'hold', reason: 'Faltan velas para calcular' };
    if (pf <= ps && f > s && ctx.position <= 0) return { action: 'buy', usd: cfg.usd, reason: `Cruce alcista: SMA${cfg.fast} (${f.toFixed(2)}) pasó sobre SMA${cfg.slow} (${s.toFixed(2)})` };
    if (pf >= ps && f < s && ctx.position > 0) return { action: 'sell', qty: ctx.position, reason: `Cruce bajista: SMA${cfg.fast} (${f.toFixed(2)}) cayó bajo SMA${cfg.slow} (${s.toFixed(2)})` };
    return { action: 'hold', reason: 'Sin cruce' };
  }
  return { action: 'hold', reason: 'Estrategia desconocida' };
}

// Valida y normaliza la configuración. Devuelve { ok, cfg } o { ok:false, error }.
export function validateCfg(input, { hardMaxOrder = 250, hardMaxDaily = 1000, symbols = [] } = {}) {
  const c = { ...DEFAULT_CFG };
  for (const k of Object.keys(DEFAULT_CFG)) if (input && k in input) c[k] = input[k];
  c.connectionId = typeof c.connectionId === 'string' && c.connectionId.length <= 64 ? c.connectionId : null;
  const n = (x) => Number(x);
  if (!['paper', 'live'].includes(c.mode)) return { ok: false, error: 'Modo inválido' };
  if (!['dca', 'sma'].includes(c.strategy)) return { ok: false, error: 'Estrategia inválida' };
  if (symbols.length && !symbols.includes(c.symbol)) return { ok: false, error: 'Símbolo no permitido' };
  c.usd = n(c.usd); c.intervalMin = Math.floor(n(c.intervalMin)); c.fast = Math.floor(n(c.fast));
  c.slow = Math.floor(n(c.slow)); c.maxOrderUsd = n(c.maxOrderUsd); c.maxDailyUsd = n(c.maxDailyUsd);
  if (![c.usd, c.intervalMin, c.fast, c.slow, c.maxOrderUsd, c.maxDailyUsd].every(Number.isFinite)) {
    return { ok: false, error: 'Números inválidos' };
  }
  if (c.usd < 1) return { ok: false, error: 'El monto mínimo es $1' };
  if (c.maxOrderUsd < c.usd) return { ok: false, error: 'El tope por orden no puede ser menor que el monto' };
  if (c.maxOrderUsd > hardMaxOrder) return { ok: false, error: `El tope por orden máximo es $${hardMaxOrder}` };
  if (c.maxDailyUsd > hardMaxDaily) return { ok: false, error: `El tope diario máximo es $${hardMaxDaily}` };
  if (c.maxDailyUsd < c.maxOrderUsd) return { ok: false, error: 'El tope diario no puede ser menor que el tope por orden' };
  if (c.intervalMin < 15) return { ok: false, error: 'El intervalo mínimo es 15 minutos' };
  if (c.fast < 2 || c.slow <= c.fast || c.slow > 150) return { ok: false, error: 'SMA: rápida >= 2 y lenta mayor que la rápida (máx. 150)' };
  c.enabled = !!c.enabled;
  c.liveAck = !!c.liveAck;
  return { ok: true, cfg: c };
}
