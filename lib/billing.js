// Planes, suscripciones y facturación. REGLAS:
//  - Un redireccionamiento de «pago exitoso» NO activa nada. Solo cuenta un webhook con firma verificada.
//  - Los webhooks son idempotentes (un evento no se aplica dos veces) y tolerantes al desorden (un evento más viejo no pisa a uno más nuevo).
//  - Si algo es dudoso (precio desconocido, usuario inexistente, estado raro) NO se concede acceso: falla cerrado y queda auditado.
//  - Los límites de plan se aplican en el servidor (motor de órdenes y rutas), nunca solo en pantalla.
//  - Los precios son PROPUESTAS a validar con clientes reales; no son oferta ni asesoría.
import crypto from 'node:crypto';

export const TRIAL_DAYS = 14;
export const PAST_DUE_GRACE_MS = 0; // sin gracia: con el pago vencido el trading real se pausa (el papel sigue)
export const PLANS = {
  free_trial: { label: 'Prueba gratis', priceUsdMonth: 0, proposed: false, live: false, maxOrderUsd: 0, maxDailyUsd: 0, maxConnections: 1,
    blurb: `${TRIAL_DAYS} días en modo papel (simulación), sin tarjeta.` },
  starter: { label: 'Starter', priceUsdMonth: 29, proposed: true, live: true, maxOrderUsd: 100, maxDailyUsd: 300, maxConnections: 1,
    blurb: 'Trading real con límites bajos. Un exchange.' },
  pro: { label: 'Pro', priceUsdMonth: 79, proposed: true, live: true, maxOrderUsd: 500, maxDailyUsd: 2000, maxConnections: 2,
    blurb: 'Límites medios y dos exchanges.' },
  business: { label: 'Business', priceUsdMonth: 249, proposed: true, live: true, maxOrderUsd: 1000, maxDailyUsd: 5000, maxConnections: 5,
    blurb: 'Límites más altos (siempre bajo el tope de la plataforma).' },
};
export const PAID = ['starter', 'pro', 'business'];

// Estados de Stripe → los nuestros. Cualquier cosa desconocida se trata como «ended» (sin acceso de pago).
export function mapStripeStatus(s) {
  if (s === 'active') return 'active';
  if (s === 'trialing') return 'trialing';
  if (s === 'past_due' || s === 'unpaid') return 'past_due';
  return 'ended';
}

export function priceMap(env) { return { [env.STRIPE_PRICE_STARTER || '']: 'starter', [env.STRIPE_PRICE_PRO || '']: 'pro', [env.STRIPE_PRICE_BUSINESS || '']: 'business' }; }

// Qué puede hacer hoy un usuario. `enforce` apagado = comportamiento anterior (sin límites de plan); así el lanzamiento es gradual y reversible.
export async function entitlement(store, user, now = Date.now()) {
  const enforce = (await store.getSetting('billing_enforce', 'off')) === 'on';
  if (user.role === 'owner') return { enforced: false, plan: 'owner', status: 'owner', live: true, caps: null, maxConnections: 99, reason: '' };
  const sub = await store.getSubscription(user.id);
  let plan = 'free_trial'; let status = 'trialing'; let periodEnd = null;
  if (sub && PLANS[sub.plan] && sub.plan !== 'free_trial') { plan = sub.plan; status = sub.status; periodEnd = sub.current_period_end; }
  else { periodEnd = (user.created_at || now) + TRIAL_DAYS * 86400000; status = now < periodEnd ? 'trialing' : 'expired'; }
  const p = PLANS[plan];
  const paidOk = plan !== 'free_trial' && (status === 'active' || status === 'trialing') && (!periodEnd || periodEnd + 3 * 86400000 > now); // 3 días de margen por retrasos del webhook de renovación
  const live = paidOk && p.live;
  const reason = live ? '' : plan === 'free_trial' ? 'La prueba gratis es solo en modo papel. Elige un plan para operar en real.'
    : status === 'past_due' ? 'Tu pago está vencido: el trading real está en pausa hasta regularizarlo.' : 'Tu suscripción no está activa: el trading real está en pausa.';
  return { enforced: enforce, plan, status, live, caps: live ? { maxOrderUsd: p.maxOrderUsd, maxDailyUsd: p.maxDailyUsd } : null,
    maxConnections: plan === 'free_trial' ? PLANS.free_trial.maxConnections : (paidOk ? p.maxConnections : 1), period_end: periodEnd, reason };
}

// Firma de webhooks de Stripe: encabezado «t=...,v1=...[,v1=...]»; HMAC-SHA256 de «t.cuerpoCrudo» con el secreto del endpoint; tolerancia de 5 min.
export function verifyStripeSignature(raw, header, secret, nowSec = Math.floor(Date.now() / 1000), tolerance = 300) {
  if (!secret || !header || !raw) return false;
  const parts = String(header).split(',').map((x) => x.trim().split('='));
  const t = Number((parts.find((p) => p[0] === 't') || [])[1]);
  const sigs = parts.filter((p) => p[0] === 'v1').map((p) => p[1]).filter(Boolean);
  if (!Number.isFinite(t) || !sigs.length || Math.abs(nowSec - t) > tolerance) return false;
  const good = crypto.createHmac('sha256', secret).update(`${t}.`).update(raw).digest('hex');
  return sigs.some((s) => s.length === good.length && crypto.timingSafeEqual(Buffer.from(s), Buffer.from(good)));
}
export const signStripe = (raw, secret, t = Math.floor(Date.now() / 1000)) => `t=${t},v1=${crypto.createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex')}`; // para pruebas

// Aplica un evento YA verificado. Devuelve { status: 'done'|'ignored'|'duplicate', detail }. Lanza si algo transitorio falla (el proveedor reintenta).
export async function applyStripeEvent({ store, env, event, audit }) {
  if (!event || typeof event.id !== 'string' || typeof event.type !== 'string') return { status: 'ignored', detail: 'evento mal formado' };
  if (!(await store.beginWebhook(event.id, event.type))) return { status: 'duplicate', detail: 'ya procesado' };
  try {
    const obj = event.data && event.data.object || {};
    const finish = async (status, detail) => { await store.finishWebhook(event.id, status, detail); return { status, detail }; };
    if (event.type.startsWith('customer.subscription.')) {
      const customer = typeof obj.customer === 'string' ? obj.customer : null;
      let userId = obj.metadata && obj.metadata.user_id || null;
      let u = userId ? await store.getUserById(userId) : null;
      if (!u && customer) { const s = await store.getSubscriptionByCustomer(customer); u = s ? await store.getUserById(s.user_id) : null; }
      if (!u) { await audit({ action: 'billing_unknown_user', detail: `evento ${event.id}` }); return await finish('ignored', 'usuario no identificado'); }
      const existing = await store.getSubscription(u.id);
      if (existing && existing.event_at && event.created && event.created < existing.event_at) return await finish('ignored', 'evento más viejo que el estado guardado');
      const priceId = obj.items && obj.items.data && obj.items.data[0] && obj.items.data[0].price && obj.items.data[0].price.id;
      const plan = event.type === 'customer.subscription.deleted' ? (existing ? existing.plan : 'free_trial') : priceMap(env)[priceId || ''];
      if (!plan) { await audit({ user_id: u.id, action: 'billing_unknown_price', detail: `evento ${event.id}` }); return await finish('ignored', 'precio desconocido: no se concede nada'); }
      const status = event.type === 'customer.subscription.deleted' ? 'ended' : mapStripeStatus(obj.status);
      await store.upsertSubscription(u.id, { plan, status, provider: 'stripe', provider_customer: customer, provider_sub: obj.id || null,
        current_period_end: obj.current_period_end ? Number(obj.current_period_end) * 1000 : null, cancel_at_period_end: !!obj.cancel_at_period_end, event_at: event.created || null });
      await audit({ user_id: u.id, action: 'billing_subscription', detail: `${plan}/${status}` });
      return await finish('done', `${plan}/${status}`);
    }
    if (event.type === 'invoice.payment_failed' || event.type === 'invoice.paid') {
      const s = typeof obj.customer === 'string' ? await store.getSubscriptionByCustomer(obj.customer) : null;
      if (!s) return await finish('ignored', 'cliente sin suscripción conocida');
      if (s.event_at && event.created && event.created < s.event_at) return await finish('ignored', 'evento más viejo');
      if (event.type === 'invoice.payment_failed') { await store.upsertSubscription(s.user_id, { status: 'past_due', event_at: event.created || null }); await audit({ user_id: s.user_id, action: 'billing_payment_failed', detail: event.id }); return await finish('done', 'past_due'); }
      await audit({ user_id: s.user_id, action: 'billing_invoice_paid', detail: event.id }); return await finish('done', 'invoice_paid'); // el estado «active» lo fija subscription.updated
    }
    // checkout.session.completed y demás: se registran pero NO conceden acceso (la fuente de verdad es la suscripción).
    return await finish('ignored', `tipo sin acción: ${event.type}`);
  } catch (e) { await store.finishWebhook(event.id, 'failed', String(e.message).slice(0, 200)).catch(() => {}); throw e; }
}

// Llamadas a la API de Stripe (formulario). NO verificado contra una cuenta real: ver docs/LAUNCH-READINESS.md.
export async function stripeCall(env, f, path, params) {
  const body = new URLSearchParams(); for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) body.append(k, String(v));
  const r = await f(`https://api.stripe.com/v1/${path}`, { method: 'POST', signal: AbortSignal.timeout(10000), headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Stripe ${r.status}: ${(j.error && j.error.message || 'error').slice(0, 120)}`);
  return j;
}
