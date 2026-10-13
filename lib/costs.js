// Modelo de costos de ejecución por exchange para simulaciones (backtest y papel).
// IMPORTANTE: son ESTIMACIONES de trabajo, no tarifas oficiales. Las comisiones y los spreads cambian;
// verifica siempre en tu exchange. Los números están aquí, en un solo lugar, para poder ajustarlos.
// Solo usa aritmética: sin dependencias.

const DAY = 86400000;

export const COST_PROFILES = {
  coinbase: {
    label: 'Coinbase Advanced (estimado)',
    // Comisión taker (órdenes de mercado) según volumen de los últimos 30 días, en USD. Estimación conservadora.
    takerTiers: [{ minVol: 0, pct: 0.8 }, { minVol: 10000, pct: 0.4 }, { minVol: 50000, pct: 0.25 }, { minVol: 100000, pct: 0.2 }, { minVol: 1000000, pct: 0.12 }],
    halfSpreadPct: 0.01, // medio spread típico en BTC/ETH
    latencyMs: 350,
  },
  robinhood: {
    label: 'Robinhood Crypto (estimado)',
    takerTiers: [{ minVol: 0, pct: 0 }], // sin comisión explícita: el costo va en el spread
    halfSpreadPct: 0.25, // estimación: el costo real de Robinhood está en el spread, normalmente mayor que en un exchange abierto
    latencyMs: 700,
  },
};

// Liquidez diaria asumida (USD) para estimar impacto de mercado. Estimaciones gruesas.
const ADV = { 'BTC-USD': 8e8, 'ETH-USD': 3e8 };
const ADV_DEFAULT = 5e7;
const DAILY_VOL = 0.03;

// Calibración con datos reales (spread y volumen de Coinbase Exchange). Si no hay, se usan los supuestos de arriba.
let CAL = null;
export function setCalibration(c) { CAL = c && (c.coinbase || c.robinhood) ? { ...(CAL || {}), ...c } : null; }
// Spreads REALES de Robinhood medidos con tus cotizaciones (mitad del spread compra/venta, en %). Mejoran el costo estimado de Robinhood.
export function setRobinhoodSpreads(map) {
  const vals = Object.values(map || {}).filter((x) => Number.isFinite(x) && x > 0);
  if (!vals.length) return;
  CAL = { ...(CAL || {}), robinhood: { halfSpreadPct: { ...map }, avgHalfSpreadPct: vals.reduce((a, b) => a + b, 0) / vals.length } };
}
export const getCalibration = () => CAL;

export const EXCHANGES = Object.keys(COST_PROFILES);

export function takerFeePct(profile, vol30d) {
  let pct = profile.takerTiers[0].pct;
  for (const t of profile.takerTiers) if (vol30d >= t.minVol) pct = t.pct;
  return pct;
}

// Precio de ejecución de una orden de mercado simulada.
//   price: precio al decidir; nextPrice: precio una vela después (para modelar la latencia, opcional)
//   latencyMs / candleMs: fracción de la vela que tarda la orden en llegar. El precio se interpola; puede ayudar o perjudicar.
export function simulateFill({ side, usd, price, nextPrice = null, symbol = 'BTC-USD', exchange = 'coinbase', vol30d = 0, candleMs = 3600000, slipMult = 1 }) {
  const prof = COST_PROFILES[exchange] || COST_PROFILES.coinbase;
  const real = exchange === 'coinbase' && CAL ? CAL.coinbase : null;
  const lag = nextPrice === null ? 0 : Math.min(1, prof.latencyMs / candleMs);
  const mid = price + (nextPrice === null ? 0 : (nextPrice - price) * lag);
  const impactPct = DAILY_VOL * Math.sqrt(Math.max(0, usd) / ((real && real.advUsd[symbol]) || ADV[symbol] || ADV_DEFAULT)) * 100;
  const rreal = exchange === 'robinhood' && CAL ? CAL.robinhood : null;
  const half = real ? ((real.halfSpreadPct[symbol]) ?? prof.halfSpreadPct) : rreal ? (rreal.halfSpreadPct[symbol] ?? rreal.avgHalfSpreadPct ?? prof.halfSpreadPct) : prof.halfSpreadPct;
  const slipPct = (half + impactPct) * slipMult; // slipMult > 1 = prueba de estrés del deslizamiento
  const px = side === 'buy' ? mid * (1 + slipPct / 100) : mid * (1 - slipPct / 100);
  const feePct = takerFeePct(prof, vol30d);
  return { price: px, feePct, slipPct, feeUsd: (usd * feePct) / 100, midPrice: mid };
}

// Volumen de los últimos 30 días a partir de fills [{usd, ts}]
export function volume30d(fills, now) {
  let v = 0;
  for (let i = fills.length - 1; i >= 0; i--) { if (fills[i].ts < now - 30 * DAY) break; v += fills[i].usd; }
  return v;
}
