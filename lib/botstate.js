// Ciclo de vida del bot (persistido). Cada cambio de estado queda registrado con motivo en bot_events.
export const BOT_STATES = ['CREATED', 'CONFIGURED', 'VALIDATING', 'RUNNING', 'PAUSED', 'STOPPING', 'STOPPED', 'ERROR', 'EMERGENCY_STOP'];
export const BOT_TRANSITIONS = {
  CREATED: ['CONFIGURED'],
  CONFIGURED: ['VALIDATING', 'CONFIGURED'],
  VALIDATING: ['RUNNING', 'ERROR', 'CONFIGURED'],
  RUNNING: ['PAUSED', 'STOPPING', 'ERROR', 'EMERGENCY_STOP', 'VALIDATING'],
  PAUSED: ['RUNNING', 'STOPPING', 'EMERGENCY_STOP'],
  STOPPING: ['STOPPED', 'ERROR'],
  STOPPED: ['CONFIGURED', 'VALIDATING'],
  ERROR: ['CONFIGURED', 'VALIDATING', 'STOPPING', 'STOPPED'],
  EMERGENCY_STOP: ['RUNNING', 'STOPPING', 'STOPPED', 'CONFIGURED', 'VALIDATING'],
};
export const canBotTransition = (from, to) => (BOT_TRANSITIONS[from] || []).includes(to);
// Camino más corto válido entre dos estados (los intermedios también se registran).
export function botPath(from, to) {
  if (from === to) return [];
  const prev = new Map([[from, null]]); const q = [from];
  while (q.length) { const x = q.shift(); if (x === to) break; for (const n of BOT_TRANSITIONS[x] || []) if (!prev.has(n)) { prev.set(n, x); q.push(n); } }
  if (!prev.has(to)) return null;
  const out = []; for (let c = to; c !== from; c = prev.get(c)) out.unshift(c); return out;
}
// Estado que corresponde a una configuración guardada, dado el estado previo.
export function targetFor(prev, enabled) {
  if (enabled) return (prev === 'PAUSED' ? 'PAUSED' : 'RUNNING');
  if (!prev || prev === 'CREATED') return 'CONFIGURED';
  if (['RUNNING', 'PAUSED', 'VALIDATING'].includes(prev)) return 'STOPPED';
  return prev; // STOPPED / ERROR / EMERGENCY_STOP / CONFIGURED se conservan
}
// Salud a partir de latido y estado.
export function healthOf({ state, enabled, last_run, errors }, now = Date.now()) {
  const age = last_run ? Math.round((now - last_run) / 1000) : null;
  if (state === 'EMERGENCY_STOP') return { status: 'emergency', heartbeat_age_s: age };
  if (state === 'ERROR' || (errors || 0) >= 2) return { status: 'error', heartbeat_age_s: age };
  if (enabled && state === 'RUNNING') return { status: age === null || age > 300 ? 'stale' : 'ok', heartbeat_age_s: age };
  return { status: 'idle', heartbeat_age_s: age };
}
