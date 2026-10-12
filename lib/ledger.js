// Libro de órdenes: ciclo de vida explícito + identificadores idempotentes.
// Una orden NUNCA se considera ejecutada hasta que el broker lo confirma (filled/partial); «submitted» solo significa «aceptada».
import crypto from 'node:crypto';

export const LIFECYCLE = ['signal', 'simulated', 'submitting', 'submitted', 'confirmed', 'partial', 'filled', 'cancelled', 'rejected', 'unknown'];
// Transiciones permitidas. «unknown» = se envió pero no sabemos si llegó (timeout/reinicio): solo la reconciliación la resuelve.
export const TRANSITIONS = {
  signal: ['simulated', 'submitting', 'cancelled'],
  simulated: [],
  submitting: ['submitted', 'rejected', 'unknown', 'cancelled'],
  submitted: ['confirmed', 'partial', 'filled', 'cancelled', 'rejected', 'unknown'],
  confirmed: ['partial', 'filled', 'cancelled', 'rejected'],
  partial: ['partial', 'filled', 'cancelled'],
  unknown: ['submitted', 'confirmed', 'partial', 'filled', 'cancelled', 'rejected'],
  filled: [], cancelled: [], rejected: [],
};
export const TERMINAL = ['simulated', 'filled', 'cancelled', 'rejected'];
// Estados que ya cuentan como riesgo/gasto reservado (conservador: incluye lo que no sabemos si se ejecutó).
export const COUNTS_AS_EXPOSURE = ['submitting', 'submitted', 'confirmed', 'partial', 'filled', 'unknown'];
export const canTransition = (from, to) => (TRANSITIONS[from] || []).includes(to);
// Estado heredado (`status`) para las pantallas antiguas: ok / pending / error.
export const legacyStatus = (lc) => (['submitted', 'confirmed', 'partial', 'filled', 'simulated'].includes(lc) ? 'ok' : ['rejected', 'cancelled'].includes(lc) ? 'error' : 'pending');

export const BUCKET_MS = 60000;
// Misma decisión (cliente, modo, exchange, símbolo, lado, minuto) => mismo ID. Un reintento, un reinicio o una segunda instancia
// producen el mismo ID y la base de datos (índice único) impide enviarla dos veces.
export function clientOrderId({ userId, mode, exchange, symbol, side, t = Date.now(), attempt = 0 }) {
  const h = crypto.createHash('sha256').update([userId, mode, exchange, symbol, side, Math.floor(t / BUCKET_MS), attempt].join('|')).digest();
  h[6] = (h[6] & 0x0f) | 0x50; h[8] = (h[8] & 0x3f) | 0x80; // forma UUID válida (los brokers piden UUID)
  const x = h.subarray(0, 16).toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}
// ¿El fallo es definitivo (el broker dijo que no) o ambiguo (no sabemos si llegó)?
export const isAmbiguous = (err) => /timeout|timed out|abort|network|fetch failed|econn|enotfound|socket|HTTP 5\d\d|\b5\d\d\b/i.test(String(err || ''));
