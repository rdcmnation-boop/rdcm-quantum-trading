// Puerta de riesgo central. TODA orden real pasa por aquí antes de llegar al broker, venga del bot que venga.
// Reglas: falla cerrado (si falta o no se puede leer una configuración obligatoria, se bloquea) y todo lo que se bloquea se registra.
// Semántica de cálculo (documentada en docs/RISK.md):
//  - notional = USD de la orden (compras: monto; ventas: cantidad × precio)
//  - gasto diario = suma de USD de compras reales de las últimas 24 h con estado enviada/pendiente/desconocida/ejecutada (conservador)
//  - órdenes abiertas = reales en submitting/submitted/confirmed/partial/unknown
//  - los límites del cliente nunca pueden superar los de la plataforma: gana el MENOR
export const DEFAULT_PLATFORM = Object.freeze({ maxOrderUsd: 1000, maxDailyUsd: 5000, maxOpenOrders: 3, maxOrdersPerHour: 12, maxPriceAgeMs: 60000, maxPriceDeviationPct: 10, maxConsecutiveRejects: 3 });
export const OPEN_STATES = ['submitting', 'submitted', 'confirmed', 'partial', 'unknown'];
const pos = (x) => typeof x === 'number' && Number.isFinite(x) && x > 0;

// Límites de la plataforma: guardados por el dueño; si el JSON está corrupto -> error (falla cerrado). Sin ajuste -> valores por defecto conservadores.
export async function loadPlatform(store) {
  let raw; try { raw = await store.getSetting('risk:platform', null); } catch (e) { return { error: 'no se pudieron leer los límites de la plataforma' }; }
  if (raw === null || raw === undefined) return { ...DEFAULT_PLATFORM };
  try { const j = JSON.parse(raw); const out = { ...DEFAULT_PLATFORM }; for (const k of Object.keys(DEFAULT_PLATFORM)) if (j[k] !== undefined) { if (!pos(Number(j[k]))) return { error: `límite inválido: ${k}` }; out[k] = Number(j[k]); } return out; }
  catch { return { error: 'límites de la plataforma ilegibles' }; }
}
export async function getEmergency(store) {
  try { const raw = await store.getSetting('risk:emergency', null); if (!raw) return { on: false }; const j = JSON.parse(raw); return { on: j.on === true, at: j.at || null, by: j.by || null, reason: j.reason || '' }; }
  catch { return { on: true, reason: 'estado de emergencia ilegible: se bloquea por seguridad' }; } // falla cerrado
}
export async function setEmergency(store, { on, by, reason = '', now = Date.now() }) {
  await store.setSetting('risk:emergency', JSON.stringify({ on: !!on, at: now, by: by || null, reason: String(reason).slice(0, 200) }));
}

// Límites efectivos para una orden: el menor entre cliente y plataforma. Devuelve error si el cliente no tiene límites válidos.
export function effectiveLimits(cfg, platform) {
  if (!platform || platform.error) return { error: platform && platform.error || 'sin límites de plataforma' };
  if (!cfg || !pos(Number(cfg.maxOrderUsd)) || !pos(Number(cfg.maxDailyUsd))) return { error: 'el bot no tiene límites por orden y por día válidos' };
  return { maxNotional: Math.min(Number(cfg.maxOrderUsd), platform.maxOrderUsd), maxDaily: Math.min(Number(cfg.maxDailyUsd), platform.maxDailyUsd),
    maxOpen: platform.maxOpenOrders, maxPerHour: platform.maxOrdersPerHour, maxRejects: platform.maxConsecutiveRejects };
}

// Comprobaciones puras (sin base de datos). Las que necesitan leer órdenes (diario, abiertas, frecuencia, rechazos) se hacen
// de forma ATÓMICA dentro de store.reserveOrder(..., risk).
// reduceOnly = SOLO vender lo que ya se tiene (cerrar posiciones). Reduce riesgo, así que no se frena por parada de emergencia ni por topes de
// monto; sí exige precio válido y fresco y límites de plataforma legibles (fallar cerrado).
export function preCheck({ cfg, platform, emergency, order, ageMs, refPrice = null, reduceOnly = false }) {
  const block = (code, reason) => ({ ok: false, code, reason });
  if (reduceOnly) {
    if (!platform || platform.error) return block('risk_config_missing', (platform && platform.error) || 'sin límites de plataforma');
    if (order.side !== 'sell') return block('reduce_only_buy', 'solo se permiten ventas al cerrar posiciones');
    if (!order || !pos(order.price)) return block('invalid_price', 'precio inválido');
    if (!pos(order.usd)) return block('invalid_amount', 'monto inválido');
    if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > platform.maxPriceAgeMs) return block('stale_price', `precio demasiado viejo (${Number.isFinite(ageMs) ? Math.round(ageMs / 1000) : '?'} s)`);
    return { ok: true, limits: { maxNotional: Infinity, maxDaily: Infinity, maxOpen: Infinity, maxPerHour: Infinity, maxRejects: Infinity }, reduceOnly: true };
  }
  if (emergency && emergency.on) return block('emergency_stop', `Parada de emergencia activa${emergency.reason ? `: ${emergency.reason}` : ''}`);
  const lim = effectiveLimits(cfg, platform); if (lim.error) return block('risk_config_missing', lim.error);
  if (!order || !pos(order.price)) return block('invalid_price', 'precio inválido');
  if (!pos(order.usd)) return block('invalid_amount', 'monto inválido');
  if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > platform.maxPriceAgeMs) return block('stale_price', `precio demasiado viejo (${Number.isFinite(ageMs) ? Math.round(ageMs / 1000) : '?'} s; máximo ${Math.round(platform.maxPriceAgeMs / 1000)} s)`);
  // Las ventas (p. ej. un stop-loss en una caída fuerte) no se frenan por desviación de precio.
  if (pos(refPrice) && order.side !== 'sell') { const dev = Math.abs(order.price - refPrice) / refPrice * 100; if (dev > platform.maxPriceDeviationPct) return block('price_deviation', `el precio se desvía ${dev.toFixed(1)}% de la referencia (máximo ${platform.maxPriceDeviationPct}%)`); }
  if (order.usd > lim.maxNotional + 1e-9) return block('max_order', `orden de $${order.usd.toFixed(2)} supera el máximo $${lim.maxNotional}`);
  return { ok: true, limits: lim };
}
