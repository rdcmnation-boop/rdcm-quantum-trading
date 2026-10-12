// Conciliación con el broker: la ÚNICA vía por la que una orden pasa a «ejecutada».
// Nunca se inventa una ejecución: un estado que no se reconoce queda «unknown» y se sigue consultando.
import { decrypt } from './security.js';

const num = (x) => { if (x === null || x === undefined || x === '') return null; const n = Number(x); return Number.isFinite(n) ? n : null; };
// Normaliza la respuesta del broker a un vocabulario común. Devuelve null en un campo si el broker no lo informa (no se rellena).
export function normalizeBrokerOrder(exchange, raw) {
  if (!raw || typeof raw !== 'object') return { state: 'unknown' };
  if (exchange === 'coinbase') {
    const filledQty = num(raw.filled_size); const filledUsd = num(raw.filled_value); const st = String(raw.status || '').toUpperCase();
    const base = { filledQty, avgPrice: num(raw.average_filled_price), filledUsd, feeUsd: num(raw.total_fees), brokerId: raw.order_id || null, reason: raw.reject_message || raw.cancel_message || (raw.reject_reason && raw.reject_reason !== 'REJECT_REASON_UNSPECIFIED' ? raw.reject_reason : '') || '' };
    if (st === 'FILLED') return { ...base, state: 'filled' };
    if (['OPEN', 'PENDING', 'QUEUED', 'EDIT_QUEUED'].includes(st)) return { ...base, state: filledQty > 0 ? 'partial' : 'open' };
    if (['CANCELLED', 'EXPIRED', 'CANCEL_QUEUED'].includes(st)) return { ...base, state: 'cancelled' };
    if (st === 'FAILED') return { ...base, state: 'rejected' };
    return { ...base, state: 'unknown' };
  }
  if (exchange === 'robinhood') {
    const ex = Array.isArray(raw.executions) ? raw.executions : [];
    const qtyFromEx = ex.reduce((a, e) => a + (num(e.quantity) || 0), 0);
    const filledQty = num(raw.filled_asset_quantity) ?? (ex.length ? qtyFromEx : null);
    const avgPrice = num(raw.average_price) ?? (ex.length && qtyFromEx > 0 ? ex.reduce((a, e) => a + (num(e.quantity) || 0) * (num(e.effective_price) || 0), 0) / qtyFromEx : null);
    const base = { filledQty, avgPrice, filledUsd: filledQty != null && avgPrice != null ? filledQty * avgPrice : null, feeUsd: null /* la API de órdenes no informa comisión: no se inventa */, brokerId: raw.id || null, reason: '' };
    const st = String(raw.state || '').toLowerCase();
    if (st === 'filled') return { ...base, state: 'filled' };
    if (st === 'partially_filled') return { ...base, state: 'partial' };
    if (st === 'open') return { ...base, state: filledQty > 0 ? 'partial' : 'open' };
    if (st === 'canceled' || st === 'cancelled') return { ...base, state: 'cancelled' };
    if (st === 'failed') return { ...base, state: 'rejected' };
    return { ...base, state: 'unknown' };
  }
  return { state: 'unknown' };
}

export const GRACE_NOT_FOUND_MS = 10 * 60000; // una orden «unknown» que el broker no lista tras 10 min (consulta exitosa) se da por no enviada
export const STALE_SUBMITTING_MS = 2 * 60000; // «submitting» que lleva 2 min = el proceso murió a mitad del envío: pasa a «unknown»

async function credsFor(store, encKey, order) {
  const bot = await store.getBot(order.user_id);
  let conn = bot && bot.cfg.connectionId ? await store.getConnection(order.user_id, bot.cfg.connectionId) : null;
  if (!conn || conn.exchange !== order.exchange) conn = (await store.listConnections(order.user_id)).find((c) => c.exchange === order.exchange && c.status === 'active');
  if (!conn) return null;
  const full = await store.getConnection(order.user_id, conn.id); if (!full) return null;
  return { keyId: full.key_id, secret: decrypt(encKey, full.secret_enc) };
}

// Concilia UNA orden. Devuelve {action} para registrar/contar. Es idempotente: repetirla no cambia nada si el broker no cambió.
export async function reconcileOrder({ store, adapters, encKey, order, now = Date.now() }) {
  const audit = (action, detail) => store.addAudit({ user_id: order.user_id, actor: 'reconcile', action, detail: String(detail).slice(0, 300) });
  let o = order;
  if (o.lifecycle === 'submitting') {
    if (now - (o.updated_at || o.created_at) < STALE_SUBMITTING_MS) return { action: 'skip_recent' };
    const r = await store.transitionOrder(o.user_id, o.id, 'unknown', {}, 'envío interrumpido (reinicio o caída): se consulta al broker');
    if (!r.ok) return { action: 'skip' }; o = r.order;
  }
  const ad = adapters[o.exchange]; if (!ad || !ad.getOrder) return { action: 'no_adapter' };
  let creds; try { creds = await credsFor(store, encKey, o); } catch { creds = null; }
  if (!creds) { await audit('reconcile_no_credentials', `${o.exchange} ${o.symbol}: sin conexión activa para consultar`); return { action: 'no_credentials' }; }
  let res;
  try { res = await ad.getOrder(creds, { extId: o.ext_id, clientOrderId: o.client_order_id, symbol: o.symbol }); }
  catch (e) { await audit('reconcile_error', `${o.exchange} ${o.symbol}: ${e.message}`); return { action: 'error' }; } // se reintenta en el próximo ciclo
  if (!res.found) {
    if (o.lifecycle === 'unknown' && now - (o.updated_at || o.created_at) >= GRACE_NOT_FOUND_MS) {
      await store.transitionOrder(o.user_id, o.id, 'rejected', { note: `${o.note || ''} · no aparece en el broker tras ${Math.round(GRACE_NOT_FOUND_MS / 60000)} min: no se envió` }, 'no encontrada en el broker');
      await audit('reconcile_not_found', `${o.exchange} ${o.symbol} ${o.client_order_id}: no existe en el broker, se marca rechazada`); return { action: 'not_found_rejected' };
    }
    return { action: 'not_found_yet' };
  }
  const n = normalizeBrokerOrder(o.exchange, res.raw);
  const patch = { ext_id: n.brokerId || o.ext_id };
  const hasFill = n.filledQty != null && n.filledQty > 0;
  if (hasFill) { patch.filled_qty = n.filledQty; patch.qty = n.filledQty; if (n.avgPrice != null) patch.price = n.avgPrice; if (n.filledUsd != null) patch.usd = n.filledUsd + (n.feeUsd != null ? (o.side === 'buy' ? n.feeUsd : -n.feeUsd) : 0); } // `usd` = efectivo neto (compra: valor + comisión; venta: valor − comisión), igual que en papel
  if (n.feeUsd != null) patch.fee_usd = n.feeUsd;
  const go = async (to, why) => { const r = await store.transitionOrder(o.user_id, o.id, to, patch, why); return r.ok ? { action: `to_${to}`, order: r.order } : { action: 'noop' }; };
  if (n.state === 'filled') {
    if (hasFill && o.qty > 0 && Math.abs(n.filledQty - o.qty) / o.qty > 0.01) await audit('reconcile_adjusted', `${o.symbol}: estimado ${o.qty.toFixed(8)} vs real ${n.filledQty} (${o.exchange})`);
    return go('filled', 'confirmada por el broker');
  }
  if (n.state === 'partial') return go('partial', 'llenado parcial confirmado por el broker');
  if (n.state === 'open') return go('confirmed', 'aceptada y abierta en el broker');
  if (n.state === 'cancelled') {
    if (hasFill) return go('filled', `cancelada tras llenarse ${n.filledQty}: se registra solo lo ejecutado`);
    return go('cancelled', n.reason || 'cancelada en el broker');
  }
  if (n.state === 'rejected') { patch.note = `${o.note || ''} · ${n.reason || 'rechazada por el broker'}`; return go('rejected', n.reason || 'rechazada por el broker'); }
  await audit('reconcile_unknown_state', `${o.exchange} ${o.symbol}: estado no reconocido, se mantiene sin resolver`); return { action: 'unknown_state' };
}

export const PENDING_STATES = ['submitting', 'submitted', 'confirmed', 'partial', 'unknown'];
export async function reconcileAll({ store, adapters, encKey, now = Date.now(), limit = 25 }) {
  const orders = (await store.listOrdersByLifecycle(PENDING_STATES, 0)).filter((o) => o.mode === 'live' && now - (o.updated_at || o.created_at) >= 15000).sort((a, b) => (a.updated_at || a.created_at) - (b.updated_at || b.created_at)).slice(0, limit);
  const summary = { checked: 0, changed: 0, errors: 0 };
  for (const o of orders) {
    summary.checked++;
    try { const r = await reconcileOrder({ store, adapters, encKey, order: o, now }); if (String(r.action).startsWith('to_') || r.action === 'not_found_rejected') summary.changed++; if (r.action === 'error') summary.errors++; }
    catch (e) { summary.errors++; await store.addAudit({ user_id: o.user_id, actor: 'reconcile', action: 'reconcile_error', detail: String(e.message).slice(0, 200) }); }
  }
  return summary;
}
