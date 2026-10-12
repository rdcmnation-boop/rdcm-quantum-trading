// Avisos push con la app cerrada (Web Push + VAPID), sin dependencias. El aviso va VACÍO: no lleva texto ni datos de nadie;
// al llegar, el service worker pide el último titular público a /api/news/last-push y lo muestra.
import crypto from 'node:crypto';

const b64u = (b) => Buffer.from(b).toString('base64url');
// Solo se aceptan servicios de push conocidos (evita que alguien nos haga llamar a direcciones internas).
export const okEndpoint = (u) => {
  try {
    const x = new URL(String(u)); if (x.protocol !== 'https:' || x.username || x.password || x.port) return false;
    return /(^|\.)(fcm\.googleapis\.com|push\.services\.mozilla\.com|push\.apple\.com|notify\.windows\.com)$/i.test(x.hostname) && String(u).length < 700;
  } catch { return false; }
};

export async function getVapid(store) {
  let v = null; try { v = JSON.parse(await store.getSetting('push:vapid', 'null')); } catch { v = null; }
  if (v && v.priv && v.pub) return v;
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  v = { priv: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'), pub: b64u(publicKey.export({ type: 'spki', format: 'der' }).subarray(-65)) };
  await store.setSetting('push:vapid', JSON.stringify(v)); return v;
}

export function vapidHeader(endpoint, vapid, subject, now = Date.now()) {
  const head = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const body = b64u(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject }));
  const key = crypto.createPrivateKey({ key: Buffer.from(vapid.priv, 'base64'), format: 'der', type: 'pkcs8' });
  const sig = crypto.sign('sha256', Buffer.from(`${head}.${body}`), { key, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${head}.${body}.${b64u(sig)}, k=${vapid.pub}`;
}

export async function sendPush(endpoint, vapid, subject, f = fetch) {
  const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), 8000);
  try {
    const r = await f(endpoint, { method: 'POST', signal: ctl.signal, headers: { Authorization: vapidHeader(endpoint, vapid, subject), TTL: '3600', Urgency: 'high', 'Content-Length': '0' } });
    return { ok: r.ok, gone: r.status === 404 || r.status === 410, status: r.status };
  } catch (e) { return { ok: false, gone: false, status: 0, error: e.message }; } finally { clearTimeout(tm); }
}

const keyOf = (i) => String((i && i.title) || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 90);
export async function loadSubs(store) { try { const a = JSON.parse(await store.getSetting('push:subs', '[]')); return Array.isArray(a) ? a : []; } catch { return []; } }
export const saveSubs = (store, subs) => store.setSetting('push:subs', JSON.stringify(subs.slice(-2000)));

// Llamar después de cada lectura de noticias: si hay algo nuevo y relevante, avisa a quien se suscribió.
export async function notifyNews(store, news, { subject, f = fetch, now = Date.now() } = {}) {
  if (!news || !Array.isArray(news.items)) return { sent: 0 };
  let st = null; try { st = JSON.parse(await store.getSetting('push:state', 'null')); } catch { st = null; }
  const seen = new Set(st ? st.seen : []); const fresh = news.items.filter((i) => i && i.title && !seen.has(keyOf(i)));
  for (const i of news.items) seen.add(keyOf(i));
  const first = !st; const lastAt = st ? st.lastAt || 0 : 0;
  const neg = fresh.filter((i) => i.neg); const worth = neg.length > 0 || fresh.length >= 3;
  const go = !first && worth && now - lastAt > 10 * 60000;
  await store.setSetting('push:state', JSON.stringify({ seen: [...seen].slice(-300), lastAt: go ? now : lastAt }));
  if (!go) return { sent: 0 };
  const top = neg[0] || fresh[0];
  await store.setSetting('news:lastpush', JSON.stringify({ t: now, neg: neg.length > 0, n: fresh.length, title: neg.length ? '⚠ Noticia negativa de trading' : `📰 ${fresh.length} noticias nuevas de trading`, body: String(top.title).slice(0, 140) }));
  const subs = await loadSubs(store); if (!subs.length) return { sent: 0 };
  const vapid = await getVapid(store); let sent = 0; const keep = [];
  for (const s of subs) { if (!okEndpoint(s.endpoint)) continue; const r = await sendPush(s.endpoint, vapid, subject, f); if (r.ok) sent++; if (!r.gone) keep.push(s); }
  if (keep.length !== subs.length) await saveSubs(store, keep);
  return { sent };
}
