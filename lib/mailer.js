// Envío de correo transaccional (verificación, recuperación, avisos de seguridad).
// Sin proveedor configurado NO se envía nada y se dice con honestidad: send() devuelve { sent:false }.
// Con RESEND_API_KEY + EMAIL_FROM usa la API HTTPS de Resend (integración NO verificada contra una cuenta real: ver docs/LAUNCH-READINESS.md).
// La bandeja `outbox` (solo fuera de producción) existe para pruebas y desarrollo; en producción jamás se guardan los mensajes (llevan enlaces con token).
export function createMailer({ env = {}, f = fetch, log = console } = {}) {
  const prod = env.NODE_ENV === 'production';
  const configured = !!(env.RESEND_API_KEY && env.EMAIL_FROM);
  const outbox = [];
  async function send({ to, subject, text }) {
    if (!to || !subject || !text) return { sent: false, reason: 'incompleto' };
    if (configured) {
      try {
        const r = await f('https://api.resend.com/emails', {
          method: 'POST', signal: AbortSignal.timeout(8000),
          headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ from: env.EMAIL_FROM, to: [to], subject, text }) });
        if (!r.ok) { log.warn?.(`mailer: el proveedor respondió ${r.status}`); return { sent: false, provider: 'resend', reason: `http ${r.status}` }; }
        return { sent: true, provider: 'resend' };
      } catch (e) { log.warn?.(`mailer: fallo de red (${String(e.message).slice(0, 80)})`); return { sent: false, provider: 'resend', reason: 'red' }; }
    }
    if (!prod) { outbox.push({ to, subject, text, t: Date.now() }); if (outbox.length > 50) outbox.shift(); }
    return { sent: false, provider: 'none', reason: 'sin proveedor de correo' };
  }
  return { send, outbox, configured, provider: configured ? 'resend' : 'none' };
}
