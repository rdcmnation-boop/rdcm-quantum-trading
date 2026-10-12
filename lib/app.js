// API HTTP (sin frameworks). Reglas de seguridad principales:
//  - El rol "owner" solo existe para OWNER_EMAIL (variable de entorno); nunca se asigna por la API.
//  - Todo dato de cliente se consulta SIEMPRE con el id de la sesión: un cliente no puede ver a otro.
//  - El dueño ve solo agregados y estados; jamás las llaves API ni las órdenes individuales de clientes.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  hashPassword, verifyPassword, signSession, readSession, encrypt, decrypt,
  newTotpSecret, verifyTotp, createLimiter,
} from './security.js';
import { validateCfg, DEFAULT_CFG, positionFromOrders, STRATEGY_VERSION } from './strategy.js';
import { healthOf } from './botstate.js';
import { reconcileAll, PENDING_STATES } from './reconcile.js';
import { SYMBOLS } from './exchanges.js';
import { backtest } from './backtest.js';
import { EXCHANGES, COST_PROFILES } from './costs.js';
import { getLab } from './lab.js';
import { setRobinhoodSpreads } from './costs.js';
import { getUniverse, robinhoodPairs, SYMBOL_RE } from './universe.js';
import { getScanner } from './scanner.js';
import { project, replay, context, fetchStock, STOCK_RE } from './timemachine.js';
import { createTts } from './tts.js';
import { loadPlatform, getEmergency, setEmergency, DEFAULT_PLATFORM } from './risk.js';
import { okEndpoint, getVapid, loadSubs, saveSubs } from './push.js';
import { perfSummary } from './pro.js';
import { profitSince } from './charts.js';
import { periodResults, reconcile } from './verify.js';
import { getMarket } from './market.js';
import { rsi, macd, bollinger, sma } from './indicators.js';
import { getGuardrails, setGuardrails, agentVersion } from './agents.js';
import { buildTarGz, collectSource } from './export.js';
import { createMailer } from './mailer.js';
import { PLANS, PAID, TRIAL_DAYS, entitlement, verifyStripeSignature, applyStripeEvent, stripeCall, priceMap } from './billing.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const TOS_VERSION = '2026-10-11';
export const APP_VERSION = '19.40.0';
const DAY = 86400000;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;

export function buildBotBundle() {
  const strip = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8')
    .replace(/^import .*$/gm, '').replace(/^export (async function|function|const|let|class)/gm, '$1');
  return [
    '#!/usr/bin/env node',
    '// Quantum Bot (descargable). Modo papel por defecto. No es asesoría financiera.',
    "import crypto from 'node:crypto';",
    "import fs from 'node:fs';",
    strip('lib/exchanges.js'), strip('lib/indicators.js'), strip('lib/strategy.js'), strip('bot/runner.js'),
  ].join('\n');
}

export function createApp({ store, env, adapters, feed, engine, director, market = getMarket, log = console, mailer = createMailer({ env, log }), fetchFn = fetch }) {
  const limiter = createLimiter();
  const usedTotp = new Map(); // códigos 2FA ya usados (anti-reuso)
  const prod = env.NODE_ENV === 'production';
  const ownerEmail = (env.OWNER_EMAIL || '').trim().toLowerCase();
  const hardMaxOrder = Number(env.HARD_MAX_ORDER_USD) || 250;
  const hardMaxDaily = Number(env.HARD_MAX_DAILY_USD) || 1000;
  const pending2fa = new Map();
  const dummyHashPromise = hashPassword('x'.repeat(16));
  const sigCache = new Map();

  const allowedSymbols = async () => [...new Set([...SYMBOLS, ...(await getUniverse()).coinbase])];
  async function defaultCfg() {
    let o = {};
    try { o = JSON.parse(await store.getSetting('default_cfg', '{}')); } catch { o = {}; }
    const v = validateCfg({ ...DEFAULT_CFG, ...o }, { symbols: SYMBOLS });
    return v.ok ? v.cfg : DEFAULT_CFG;
  }
  const parseProposal = (p) => ({ ...p, detail: JSON.parse(p.detail || '{}'), evidence: JSON.parse(p.evidence || '{}'), touches: JSON.parse(p.touches || '[]') });
  const jsonAttachment = (res, name, obj) => {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}"`, 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(obj, null, 2));
  };

  async function brainSnapshot() {
    const [guard, agents, proposals, audits] = await Promise.all([getGuardrails(store), director.overview(),
      store.listProposals(null, 500), store.listAudit(500)]);
    const models = {};
    for (const sym of ['BTC-USD', 'ETH-USD']) {
      for (const kind of ['candidate', 'active']) {
        const raw = await store.getSetting(`model:${kind}:${sym}`, null);
        if (raw) (models[sym] ||= {})[kind] = JSON.parse(raw);
      }
    }
    return {
      format: 'quantum-brain/1', exported_at: Date.now(), app_version: APP_VERSION,
      brain_version: Number(await store.getSetting('brain_version', '1')) || 1,
      guardrails: guard, agents, lab: await getLab(store), scanner: await getScanner(store), runs: JSON.parse(await store.getSetting('director:runs', '[]')),
      platform: { live_trading: (await store.getSetting('live_trading', 'off')) === 'on',
        registration_open: (await store.getSetting('registration_open', 'on')) === 'on', default_cfg: await defaultCfg() },
      models,
      changelog: proposals.filter((p) => p.status === 'applied').map((p) => ({ at: p.applied_at, kind: p.kind, title: p.title, note: p.decided_note })),
      proposals: proposals.map(parseProposal),
      agent_audit: audits.filter((a) => /^(agent:|director)/.test(a.actor || '') || /^(agent_|proposal_|director_|owner_export)/.test(a.action)),
      note: 'Sin llaves API, sin contraseñas y sin datos individuales de clientes.',
    };
  }

  // ---------- utilidades ----------
  // IP del cliente sin confiar en lo que él mismo escribe: prioriza el encabezado que pone el proxy (Cloudflare/Render) y
  // de X-Forwarded-For toma la entrada que agregó NUESTRO proxy (la última, o N saltos desde el final con TRUSTED_PROXY_HOPS).
  const ipOf = (req) => {
    const direct = String(req.socket.remoteAddress || '');
    if (!prod) return direct;
    const cf = String(req.headers['cf-connecting-ip'] || '').trim();
    if (cf && cf.length < 46) return cf;
    const parts = String(req.headers['x-forwarded-for'] || '').split(',').map((x) => x.trim()).filter(Boolean);
    const hops = Math.max(1, Number(env.TRUSTED_PROXY_HOPS) || 1);
    return (parts.length ? parts[Math.max(0, parts.length - hops)] : direct).slice(0, 45);
  };
  const send = (res, status, obj, headers = {}) => {
    const body = JSON.stringify(obj);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
    res.end(body);
  };
  const readBody = (req, max = 100000) => new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > max) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString())); } catch { reject(new Error('bad json')); }
    });
    req.on('error', reject);
  });
  const readRaw = (req, max) => new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > max) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks))); req.on('error', reject);
  });
  const cookies = (req) => Object.fromEntries(String(req.headers.cookie || '').split(';').map((p) => p.trim().split('=')).filter((p) => p[0]).map(([k, ...v]) => [k, v.join('=')]));
  const setCookie = (token, maxAge) =>
    `qt_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${prod ? '; Secure' : ''}`;
  const publicUser = (u) => ({ id: u.id, email: u.email, role: u.role, status: u.status, created_at: u.created_at,
    totp: !!u.totp_secret, email_verified: !!u.email_verified_at });
  const audit = (req, user, action, detail = '') =>
    store.addAudit({ user_id: user ? user.id : null, actor: user ? user.email : null, action, ip: ipOf(req), detail });

  async function currentUser(req) {
    const s = readSession(env.SESSION_SECRET, cookies(req).qt_session);
    if (!s) return null;
    const u = await store.getUserById(s.uid);
    if (!u || u.status !== 'active' || u.sv !== s.sv) return null;
    if (s.sid) { // sesión con registro: se puede revocar desde «Dispositivos»
      const ss = await store.getSession(s.sid);
      if (!ss || ss.revoked_at || ss.user_id !== u.id || ss.expires_at < Date.now()) return null;
      if (Date.now() - ss.last_seen > 300000) fire(store.touchSession(s.sid));
      u.sid = s.sid;
    }
    return u;
  }
  async function startSession(res, u, req) {
    const sid = crypto.randomBytes(16).toString('hex');
    const exp = Date.now() + 12 * 3600000;
    await store.createSession({ id: sid, user_id: u.id, expires_at: exp, ip: req ? ipOf(req) : null, ua: req ? String(req.headers['user-agent'] || '').slice(0, 160) : null });
    const token = signSession(env.SESSION_SECRET, { uid: u.id, sv: u.sv, sid, exp });
    res.setHeader('Set-Cookie', setCookie(token, 12 * 3600));
  }
  // Tareas en segundo plano (p. ej. enviar correo sin revelar con la demora si una cuenta existe). idle() las espera (pruebas / cierre).
  const bg = new Set();
  const fire = (p) => { const x = Promise.resolve(p).catch(() => {}).finally(() => bg.delete(x)); bg.add(x); return x; };
  const sha = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
  const siteUrl = () => String(env.PUBLIC_URL || '').replace(/\/+$/, '');
  const TOKEN_TTL = { verify: 24 * 3600000, reset: 30 * 60000 };
  async function issueMail(u, kind) {
    const tok = crypto.randomBytes(32).toString('base64url');
    await store.createAuthToken({ hash: sha(tok), user_id: u.id, kind, expires_at: Date.now() + TOKEN_TTL[kind] });
    const link = `${siteUrl()}/app#${kind}=${tok}`;
    const txt = kind === 'verify'
      ? { subject: 'Verifica tu correo — RDCMNATION QUANTUM', text: `Abre este enlace para verificar tu correo (válido 24 horas):\n\n${link}\n\nSi no creaste una cuenta, ignora este mensaje.` }
      : { subject: 'Restablece tu contraseña — RDCMNATION QUANTUM', text: `Abre este enlace para elegir una contraseña nueva (válido 30 minutos y de un solo uso):\n\n${link}\n\nSi no lo pediste, ignora este mensaje: tu contraseña no cambia.` };
    return mailer.send({ to: u.email, ...txt });
  }
  const makeRecoveryCodes = () => Array.from({ length: 8 }, () => { const h = crypto.randomBytes(5).toString('hex'); return `${h.slice(0, 5)}-${h.slice(5)}`; });

  // ---------- arranque: dueño y esquema ----------
  // El secreto 2FA del dueño se guarda cifrado (AES-256-GCM). Lee valores antiguos en texto plano y los cifra al arrancar.
  const sealTotp = (x) => encrypt(env.ENCRYPTION_KEY, x);
  const openTotp = (x) => (String(x).startsWith('v1.') ? decrypt(env.ENCRYPTION_KEY, x) : x);

  // Alcance del trading real: 'off' (nadie), 'owner' (solo el dueño, para probar) o 'on' (todos los clientes).
  const liveScope = async () => { const v = await store.getSetting('live_trading', 'off'); return v === 'on' ? 'on' : v === 'owner' ? 'owner' : 'off'; };
  const liveAllowedFor = async (user) => { if (user.role !== 'owner' && !user.email_verified_at) return false; const sc = await liveScope(); return sc === 'on' || (sc === 'owner' && user.role === 'owner' && user.email === ownerEmail); };

  async function bootstrap() {
    await store.init();
    if (!ownerEmail || !env.OWNER_PASSWORD) {
      log.warn('OWNER_EMAIL / OWNER_PASSWORD no definidos: el menú de dueño está desactivado.');
      return;
    }
    let o = await store.getUserByEmail(ownerEmail);
    if (o && !o.email_verified_at) { await store.updateUser(o.id, { email_verified_at: Date.now() }); } // el correo del dueño viene de OWNER_EMAIL (configuración, no de un formulario)
    if (!o) {
      o = await store.createUser({ email: ownerEmail, pass_hash: await hashPassword(env.OWNER_PASSWORD), role: 'owner' });
    } else {
      if (!(await verifyPassword(env.OWNER_PASSWORD, o.pass_hash))) {
        await store.updateUser(o.id, { pass_hash: await hashPassword(env.OWNER_PASSWORD) });
        await store.bumpSv(o.id);
      }
      if (o.role !== 'owner' || o.status !== 'active') await store.updateUser(o.id, { role: 'owner', status: 'active' });
    }
    for (const u of await store.listUsers()) {
      if (u.totp_secret && !String(u.totp_secret).startsWith('v1.') && env.ENCRYPTION_KEY) await store.updateUser(u.id, { totp_secret: sealTotp(u.totp_secret) });
      if (u.role === 'owner' && u.email !== ownerEmail) await store.updateUser(u.id, { role: 'client' });
    }
  }

  // ---------- rutas ----------
  const routes = [];
  const readyFlag = { v: false }; const metrics = { req: { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0 }, ms: 0, errors: 0 };
  const route = (method, pattern, opts, handler) => {
    const keys = [];
    const re = new RegExp(`^${pattern.replace(/:([a-z]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; })}$`);
    routes.push({ method, re, keys, opts, handler });
  };

  // Liveness: el proceso responde (sin tocar dependencias). Readiness: además la base de datos responde y el arranque terminó.
  route('GET', '/api/live', {}, async (ctx) => ctx.json(200, { status: 'alive', uptime_s: Math.round(process.uptime()) }));
  route('GET', '/api/ready', {}, async (ctx) => {
    const checks = { startup: readyFlag.v, database: false };
    try { await Promise.race([store.ping(), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 2500))]); checks.database = true; } catch { checks.database = false; }
    const ok = checks.startup && checks.database; ctx.json(ok ? 200 : 503, { status: ok ? 'ready' : 'not_ready', version: APP_VERSION, checks });
  });
  route('GET', '/api/owner/metrics', { owner: true }, async (ctx) => {
    const mo = await store.listAllOrdersSince(Date.now() - 86400000); const byLc = {}; for (const o of mo) byLc[o.lifecycle || 'legacy'] = (byLc[o.lifecycle || 'legacy'] || 0) + 1;
    const bots = await store.listBots(); const byState = {}; for (const b of bots) byState[b.state] = (byState[b.state] || 0) + 1;
    const lines = ['# HELP qt_requests_total Peticiones HTTP por clase de estado', '# TYPE qt_requests_total counter', ...Object.entries(metrics.req).map(([k, v]) => `qt_requests_total{class="${k}"} ${v}`),
      '# TYPE qt_request_ms_sum counter', `qt_request_ms_sum ${Math.round(metrics.ms)}`, '# TYPE qt_uptime_seconds gauge', `qt_uptime_seconds ${Math.round(process.uptime())}`,
      '# TYPE qt_orders_24h gauge', ...Object.entries(byLc).map(([k, v]) => `qt_orders_24h{lifecycle="${k}"} ${v}`), '# TYPE qt_bots gauge', ...Object.entries(byState).map(([k, v]) => `qt_bots{state="${k}"} ${v}`),
      '# TYPE qt_errors_total counter', `qt_errors_total ${metrics.errors}`];
    ctx.res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8', 'Cache-Control': 'no-store' }); ctx.res.end(`${lines.join('\n')}\n`);
  });
  route('GET', '/api/health', {}, async (ctx) => {
    ctx.json(200, { status: 'ok', version: APP_VERSION, database: store.kind, mail: mailer.provider, owner_enabled: !!ownerEmail && !!env.OWNER_PASSWORD });
  });

  route('POST', '/api/auth/register', {}, async (ctx) => {
    const { email, password, acceptTos } = ctx.body;
    if (!ctx.allow(`reg:${ctx.ip}`, Number(env.REG_LIMIT_PER_HOUR) || 5, 3600000) || !ctx.allow('reg:all', Number(env.REG_GLOBAL_PER_HOUR) || 200, 3600000)) return ctx.json(429, { error: 'Demasiados registros. Intenta más tarde.' });
    if ((await store.getSetting('registration_open', 'on')) !== 'on') return ctx.json(403, { error: 'Registro cerrado por el momento.' });
    const em = String(email || '').trim().toLowerCase();
    if (!EMAIL_RE.test(em)) return ctx.json(400, { error: 'Correo inválido' });
    if (typeof password !== 'string' || password.length < 10 || password.length > 200) return ctx.json(400, { error: 'La contraseña debe tener al menos 10 caracteres' });
    if (acceptTos !== true) return ctx.json(400, { error: 'Debes aceptar los Términos, la Privacidad y el aviso de riesgo' });
    if (em === ownerEmail || (await store.getUserByEmail(em))) return ctx.json(409, { error: 'No se pudo crear la cuenta con ese correo' });
    const u = await store.createUser({ email: em, pass_hash: await hashPassword(password), role: 'client', tos_version: TOS_VERSION });
    await audit(ctx.req, u, 'register');
    fire(issueMail(u, 'verify'));
    await startSession(ctx.res, u, ctx.req);
    ctx.json(201, { user: publicUser(u) });
  });

  route('POST', '/api/auth/login', {}, async (ctx) => {
    const em = String(ctx.body.email || '').trim().toLowerCase();
    const password = String(ctx.body.password || '');
    if (password.length > 200) return ctx.json(401, { error: 'Credenciales inválidas' });
    if (!ctx.allow(`login:ip:${ctx.ip}`, Number(env.LOGIN_LIMIT_IP) || 20, 900000) || !ctx.allow(`login:em:${em}`, 8, 900000)) {
      return ctx.json(429, { error: 'Demasiados intentos. Espera 15 minutos.' });
    }
    const u = await store.getUserByEmail(em);
    const stored = u ? u.pass_hash : await dummyHashPromise;
    const ok = await verifyPassword(password, stored);
    if (!u || !ok || u.status !== 'active' || u.locked_until > Date.now()) {
      if (u && !ok) {
        const failed = u.failed + 1;
        await store.updateUser(u.id, { failed, locked_until: failed >= 5 ? Date.now() + 900000 : 0 });
        await audit(ctx.req, u, 'login_fail');
      } else await audit(ctx.req, null, 'login_fail', `email=${em.slice(0, 80)}`);
      return ctx.json(401, { error: 'Credenciales inválidas' });
    }
    let usedTotpKey = null;
    if (u.totp_secret) {
      const rec = String(ctx.body.recovery || '').trim().toLowerCase();
      if (rec) { // código de respaldo de un solo uso (si perdió el teléfono)
        const hs = JSON.parse(u.recovery_codes || '[]');
        const h = sha(rec);
        if (!hs.includes(h)) { await audit(ctx.req, u, 'login_fail', '2fa_recovery'); return ctx.json(401, { error: 'Código de respaldo inválido', need_totp: true }); }
        await store.updateUser(u.id, { recovery_codes: JSON.stringify(hs.filter((x) => x !== h)) });
        await audit(ctx.req, u, '2fa_recovery_used', `quedan=${hs.length - 1}`);
      } else {
        if (!ctx.body.totp) return ctx.json(401, { error: 'Código 2FA requerido', need_totp: true });
        const tkey = `${u.id}:${String(ctx.body.totp).replace(/\s/g, '')}`;
        if (usedTotp.has(tkey) && usedTotp.get(tkey) > Date.now()) { await audit(ctx.req, u, 'login_fail', '2fa_replay'); return ctx.json(401, { error: 'Ese código ya se usó. Espera el siguiente.', need_totp: true }); }
        if (!verifyTotp(openTotp(u.totp_secret), ctx.body.totp)) {
          await audit(ctx.req, u, 'login_fail', '2fa');
          return ctx.json(401, { error: 'Código 2FA inválido', need_totp: true });
        }
        usedTotpKey = tkey;
      }
    }
    if (usedTotpKey) { usedTotp.set(usedTotpKey, Date.now() + 120000); if (usedTotp.size > 200) for (const [k, v] of usedTotp) if (v < Date.now()) usedTotp.delete(k); }
    await store.updateUser(u.id, { failed: 0, locked_until: 0, last_login: Date.now() });
    await audit(ctx.req, u, 'login_ok');
    await startSession(ctx.res, u, ctx.req);
    ctx.json(200, { user: publicUser(u) });
  });

  route('POST', '/api/auth/logout', { auth: true }, async (ctx) => {
    if (ctx.user.sid) await store.revokeSession(ctx.user.id, ctx.user.sid); else await store.bumpSv(ctx.user.id);
    await audit(ctx.req, ctx.user, 'logout');
    ctx.res.setHeader('Set-Cookie', setCookie('', 0));
    ctx.json(200, { ok: true });
  });

  route('GET', '/api/me', { auth: true }, async (ctx) => {
    const live = await liveAllowedFor(ctx.user);
    ctx.json(200, { user: publicUser(ctx.user), liveTradingEnabled: live, symbols: SYMBOLS, auto: true,
      limits: { hardMaxOrder, hardMaxDaily }, tosVersion: TOS_VERSION });
  });

  // Todas las criptos operables: Coinbase (público) + Robinhood (pares de las conexiones del usuario). Cada una con su disponibilidad.
  route('GET', '/api/universe', { auth: true }, async (ctx) => {
    const uni = await getUniverse();
    let rh = null; let rhVerified = false;
    const conn = (await store.listConnections(ctx.user.id)).find((c) => c.exchange === 'robinhood');
    if (conn && adapters && adapters.robinhood.pairs) {
      const full = await store.getConnection(ctx.user.id, conn.id);
      try {
        const r = await robinhoodPairs({ store, adapters, userId: ctx.user.id, creds: { keyId: full.key_id, secret: decrypt(env.ENCRYPTION_KEY, full.secret_enc) } });
        rh = r.symbols; rhVerified = r.verified;
      } catch { rh = null; }
    }
    const all = [...new Set([...uni.coinbase, ...(rh || [])])].sort();
    ctx.json(200, { t: uni.t, live: uni.live, coinbase: uni.coinbase, robinhood: rh, robinhood_verified: rhVerified, total: all.length,
      symbols: all.map((s) => ({ s, cb: uni.coinbase.includes(s), rh: rh ? rh.includes(s) : null })) });
  });

  // Tablero: lo REAL primero (dinero real: resultado, invertido, errores), luego papel y lo que el Cerebro aprendió/actualizó solo.
  route('GET', '/api/dashboard', { auth: true }, async (ctx) => {
    const orders = await store.listOrders(ctx.user.id, 5000);
    const prices = new Map();
    const px = async (s) => { if (!prices.has(s)) { let v = null; try { v = await feed.getPrice(s); } catch { v = null; } prices.set(s, v); } return prices.get(s); };
    const summarize = async (mode) => {
      const mine = orders.filter((o) => o.mode === mode).slice().reverse();
      const ok = mine.filter((o) => o.status === 'ok'); const pending = mine.filter((o) => o.status === 'pending'); const bad = mine.filter((o) => o.status !== 'ok' && o.status !== 'pending');
      // Transparencia: cuántas órdenes confirmó el broker (con cantidad y comisión reales) y cuántas siguen siendo estimadas.
      const confirmed = ok.filter((o) => ['filled', 'partial'].includes(o.lifecycle)).length; const legacy = ok.length - confirmed;
      const feesUsd = ok.reduce((a, o) => a + (Number.isFinite(o.fee_usd) ? o.fee_usd : 0), 0);
      const book = new Map(); let realized = 0; let bought = 0; let sold = 0; let fees = 0;
      for (const o of ok) {
        const b = book.get(o.symbol) || { symbol: o.symbol, qty: 0, cost: 0, venue: o.exchange }; book.set(o.symbol, b);
        if (o.side === 'buy') { b.qty += o.qty; b.cost += o.usd; b.venue = o.exchange; bought += o.usd; }
        else { const avg = b.qty > 0 ? b.cost / b.qty : 0; const q = Math.min(o.qty, b.qty); realized += o.usd - avg * q; b.cost -= avg * q; b.qty -= q; sold += o.usd; }
      }
      const holdings = []; let value = 0; let cost = 0; let known = true;
      for (const b of book.values()) { if (b.qty < 1e-12) continue; const p = await px(b.symbol); if (p === null) known = false; holdings.push({ symbol: b.symbol, qty: b.qty, cost: b.cost, venue: b.venue, value: p === null ? null : b.qty * p }); value += p === null ? 0 : b.qty * p; cost += b.cost; }
      const last = mine.slice(-6).reverse().map((o) => ({ t: o.created_at, side: o.side, symbol: o.symbol, usd: o.usd, status: o.status, exchange: o.exchange, old: o.status !== 'ok' && Date.now() - o.created_at >= 6 * 3600000, note: o.status === 'ok' ? null : o.note }));
      const recentBad = bad.filter((o) => Date.now() - o.created_at < 6 * 3600000);
      return { orders: ok.length, pending: pending.length, confirmed, legacy, fees_usd: feesUsd, estimated: pending.length > 0 || legacy > 0 || confirmed < ok.length, errors: recentBad.length, errors_old: bad.length - recentBad.length, bought, sold, realized, invested_now: cost, value: known ? value : null, unrealized: known ? value - cost : null,
        total: known ? realized + value - cost : realized, holdings, last, last_error: recentBad.length ? recentBad[recentBad.length - 1].note : null };
    };
    const [real, paper] = [await summarize('live'), await summarize('paper')];
    const sc = await getScanner(store);
    let regime = null; try { regime = JSON.parse(await store.getSetting('market:snapshot', 'null'))?.regime || null; } catch { regime = null; }
    const lab = await getLab(store);
    const g = await getGuardrails(store);
    const lastRun = Number(await store.getSetting('director_last_run', '0')) || null;
    const b = await store.getBot(ctx.user.id);
    const conns = (await store.listConnections(ctx.user.id)).filter((c) => c.can_trade && !c.can_transfer).map((c) => ({ id: c.id, exchange: c.exchange, label: c.label }));
    const perfMode = real.orders ? 'live' : 'paper';
    const perf = perfSummary(orders.filter((o) => o.mode === perfMode && o.status === 'ok'));
    let nw = null; try { nw = JSON.parse(await store.getSetting('news:latest', 'null')); } catch { nw = null; }
    ctx.json(200, { real, paper, perf: { ...perf, mode: perfMode }, news: nw ? { t: nw.t, risk_off: !!nw.risk_off, negatives: nw.items.filter((i) => i.neg).length } : null, can_live: await liveAllowedFor(ctx.user), connections: conns, limits: { hardMaxDaily }, bot: { enabled: !!(b && b.cfg.enabled), mode: b ? b.cfg.mode : 'paper', symbol: b ? b.cfg.symbol : null, errors: b ? b.errors : 0 },
      brain: { scanner_t: sc ? sc.t : null, scanned: sc ? sc.scanned : 0, qualified: sc ? sc.items.filter((i) => i.qualified).length : 0, top: sc ? sc.items.filter((i) => i.qualified).slice(0, 3).map((i) => i.symbol) : [],
        regime, last_run: lastRun, next_run: lastRun ? lastRun + g.autoRunHours * 3600000 : null, auto: g.autopilot.enabled, lessons: (lab.lessons || []).slice(0, 3).map((l) => ({ t: l.t, text: l.text })), version: Number(await store.getSetting('brain_version', '1')) || 1 } });
  });

  // Lo que pasa AHORA en tus exchanges: saldos (con valor en USD), tus últimas órdenes reales y, en Robinhood,
  // precio de compra/venta vs Coinbase (la brecha real). Solo de tus propias conexiones. Cada parte falla por separado y se muestra el error.
  const liveCache = new Map();
  route('GET', '/api/exchange/live', { auth: true }, async (ctx) => {
    const hit = liveCache.get(ctx.user.id);
    if (hit && Date.now() - hit.t < 20000 && !ctx.query.get('force')) return ctx.json(200, hit.v);
    if (!ctx.allow(`xl:${ctx.user.id}`, 180, 3600000)) return ctx.json(429, { error: 'Demasiadas consultas' });
    const out = []; const rhSpreads = {};
    const held = new Set(['BTC-USD', 'ETH-USD', 'DOGE-USD', 'SOL-USD']);
    for (const o of (await store.listOrders(ctx.user.id, 50))) held.add(o.symbol);
    for (const c of await store.listConnections(ctx.user.id)) {
      const full = await store.getConnection(ctx.user.id, c.id);
      const ad = adapters && adapters[c.exchange];
      const e = { exchange: c.exchange, label: c.label, balances: [], orders: [], quotes: [], errors: [] };
      if (!full || !ad) { e.errors.push('conexión no disponible'); out.push(e); continue; }
      let creds; try { creds = { keyId: full.key_id, secret: decrypt(env.ENCRYPTION_KEY, full.secret_enc) }; } catch { e.errors.push('no se pudo abrir la llave'); out.push(e); continue; }
      try {
        const bal = await ad.balances(creds);
        for (const b of bal.slice(0, 15)) {
          const stable = ['USD', 'USDC'].includes(b.asset);
          let px = stable ? 1 : null;
          if (!stable) { try { px = await feed.getPrice(`${b.asset}-USD`); } catch { px = null; } }
          e.balances.push({ asset: b.asset, available: b.available, hold: b.hold, usd: px !== null ? (b.available + b.hold) * px : null });
        }
      } catch (err) { e.errors.push(err.message); }
      if (ad.activity) { try { e.orders = await ad.activity(creds); } catch (err) { e.errors.push(err.message); } }
      if (ad.quotes) {
        try {
          const syms = [...held].filter((s) => /^[A-Z0-9]{2,12}-USD$/.test(s)).slice(0, 8);
          const qs = await ad.quotes(creds, syms);
          for (const q of qs) {
            let cbp = null; try { cbp = await feed.getPrice(q.symbol); } catch { cbp = null; }
            if (c.exchange === 'robinhood') { rhSpreads[q.symbol] = ((q.ask - q.bid) / ((q.ask + q.bid) / 2)) * 50; }
            e.quotes.push({ symbol: q.symbol, bid: q.bid, ask: q.ask, spread_pct: ((q.ask - q.bid) / ((q.ask + q.bid) / 2)) * 100, coinbase: cbp, gap_pct: cbp ? ((q.ask - cbp) / cbp) * 100 : null });
          }
        } catch (err) { e.errors.push(err.message); }
      }
      out.push(e);
    }
    if (Object.keys(rhSpreads).length) {
      let prev = {}; try { prev = JSON.parse(await store.getSetting('market:rhspread', '{}')); } catch { prev = {}; }
      const merged = { ...prev, ...rhSpreads }; setRobinhoodSpreads(merged);
      await store.setSetting('market:rhspread', JSON.stringify(merged)); // dato de mercado, sin nada personal
    }
    const v = { t: Date.now(), exchanges: out };
    liveCache.set(ctx.user.id, { t: Date.now(), v });
    ctx.json(200, v);
  });


  // Máquina del Tiempo: simula futuros posibles y repasa el pasado. No es una predicción ni asesoría.
  const futureCache = new Map();
  route('GET', '/api/future', { auth: true }, async (ctx) => {
    const symbol = String(ctx.query.get('symbol') || 'BTC-USD').toUpperCase().trim(); const days = Math.max(7, Math.min(90, Number(ctx.query.get('days')) || 30));
    const crypto_ = SYMBOL_RE.test(symbol); if (!crypto_ && !STOCK_RE.test(symbol)) return ctx.json(400, { error: 'Escribe una cripto (BTC-USD) o una acción de EE. UU. (AAPL)' });
    if (!ctx.allow(`fu:${ctx.user.id}`, 60, 3600000)) return ctx.json(429, { error: 'Demasiadas consultas. Intenta más tarde.' });
    const key = `${symbol}`; let hit = futureCache.get(key);
    if (!hit || Date.now() - hit.t > 1800000) {
      try { hit = { t: Date.now(), closes: crypto_ ? await feed.getHistory(symbol, 300, 86400) : await fetchStock(symbol) }; futureCache.set(key, hit); if (futureCache.size > 60) futureCache.delete(futureCache.keys().next().value); }
      catch (e) { return ctx.json(502, { error: e.message }); }
    }
    const p = project(hit.closes, { horizon: days, key: symbol }); if (!p) return ctx.json(502, { error: 'No hay historial suficiente para simular' });
    const bands = Object.fromEntries(Object.entries(p.bands).map(([k, v]) => [k, v.map((x) => Number(x.toPrecision(6)))]));
    ctx.json(200, { symbol, kind: crypto_ ? 'cripto' : 'acción', days, paths: p.paths, start: p.start, history: hit.closes.slice(-90), bands, prob_up: p.prob_up, prob_up5: p.prob_up5, prob_down5: p.prob_down5, prob_drop10: p.prob_drop10,
      median_pct: p.median_pct, range90_pct: p.range90_pct, typical_dip_pct: p.typical_dip_pct, vol_daily_pct: p.vol_daily_pct, regime: p.regime,
      replay: [7, 30, 90].map((d) => replay(hit.closes, d)).filter(Boolean), context: context(hit.closes),
      note: 'Escenarios simulados con la volatilidad real del activo. No es una predicción ni asesoría: el futuro real puede salirse de estos rangos.' });
  });

  // Voz natural (Azure). El navegador pide el audio de una frase; la llave nunca sale del servidor. Con límite por usuario.
  const tts = createTts({ env });
  route('GET', '/api/voice/config', { auth: true }, async (ctx) => ctx.json(200, { azure: tts.enabled }));
  route('POST', '/api/tts', { auth: true }, async (ctx) => {
    if (!tts.enabled) return ctx.json(503, { error: 'Voz Azure no configurada' });
    if (!ctx.allow(`tts:${ctx.user.id}`, 240, 3600000)) return ctx.json(429, { error: 'Demasiadas frases por hora' });
    const r = await tts.speak((ctx.body || {}).text, (ctx.body || {}).lang);
    if (!r.ok) return ctx.json(r.status, { error: r.error });
    ctx.res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'private, max-age=3600', 'Content-Length': r.audio.length }); ctx.res.end(r.audio);
  });
  // Evaluar ahora (solo PAPEL): pide una decisión inmediata del Cerebro. Con dinero real el motor ya corre solo con tus topes.
  route('POST', '/api/bot/evaluate-now', { auth: true }, async (ctx) => {
    const b = await store.getBot(ctx.user.id);
    if (!b || !b.cfg.enabled) return ctx.json(409, { error: 'El Cerebro está apagado' });
    if (b.cfg.mode !== 'paper') return ctx.json(403, { error: 'Con dinero real no se ordena por voz ni por este botón: el Cerebro opera solo, con tus topes.' });
    if (!ctx.allow(`ev:${ctx.user.id}`, 12, 3600000)) return ctx.json(429, { error: 'Demasiadas evaluaciones por hora' });
    if (engine) setImmediate(() => engine.tick().catch(() => {}));
    ctx.json(200, { ok: true });
  });

  // Avisos push (app cerrada). El aviso va vacío; solo se guardan el endpoint del navegador y a qué usuario pertenece.
  const pushSubject = () => (env.PUSH_SUBJECT || env.RENDER_EXTERNAL_URL || 'https://quantum-trading.invalid');
  route('GET', '/api/push/key', { auth: true }, async (ctx) => ctx.json(200, { key: (await getVapid(store)).pub }));
  route('POST', '/api/push/subscribe', { auth: true }, async (ctx) => {
    const ep = String((ctx.body || {}).endpoint || '');
    if (!okEndpoint(ep)) return ctx.json(400, { error: 'Servicio de avisos no permitido' });
    if (!ctx.allow(`ps:${ctx.user.id}`, 20, 3600000)) return ctx.json(429, { error: 'Demasiados intentos' });
    const subs = (await loadSubs(store)).filter((s) => s.endpoint !== ep);
    const mine = subs.filter((s) => s.uid === ctx.user.id); if (mine.length >= 5) { const drop = mine[0].endpoint; subs.splice(subs.findIndex((s) => s.endpoint === drop), 1); }
    subs.push({ uid: ctx.user.id, endpoint: ep, t: Date.now() }); await saveSubs(store, subs);
    ctx.json(200, { ok: true });
  });
  route('POST', '/api/push/unsubscribe', { auth: true }, async (ctx) => {
    const ep = String((ctx.body || {}).endpoint || '');
    await saveSubs(store, (await loadSubs(store)).filter((s) => !(s.endpoint === ep && s.uid === ctx.user.id)));
    ctx.json(200, { ok: true });
  });
  route('GET', '/api/news/last-push', { auth: true }, async (ctx) => {
    let n = null; try { n = JSON.parse(await store.getSetting('news:lastpush', 'null')); } catch { n = null; }
    // Una alerta crítica reciente del propio usuario (bot apagado, orden sin confirmar) tiene prioridad sobre las noticias.
    let a = null; try { a = JSON.parse(await store.getSetting(`alert:last:${ctx.user.id}`, 'null')); } catch { a = null; }
    if (a && Date.now() - a.t < 5 * 60000 && (!n || a.t >= n.t)) return ctx.json(200, { t: a.t, title: a.title, body: a.body, alert: true });
    ctx.json(200, n || {});
  });

  route('GET', '/api/news', { auth: true }, async (ctx) => {
    let n = null; try { n = JSON.parse(await store.getSetting('news:latest', 'null')); } catch { n = null; }
    ctx.json(200, n ? { t: n.t, risk_off: !!n.risk_off, global_neg: n.global_neg, risk: n.risk, items: n.items.slice(0, 30) } : { t: null, risk_off: false, items: [] });
  });

  // Ranking del escáner del Cerebro (análisis de mercado, igual para todos; no contiene datos de nadie).
  route('GET', '/api/scanner', { auth: true }, async (ctx) => {
    const sc = await getScanner(store);
    ctx.json(200, sc ? { ...sc, items: sc.items.map((i) => ({ ...i, cfg: undefined })) } : { items: [], scanned: 0, t: null });
  });

  // ----- Exchanges del cliente -----
  route('GET', '/api/connections', { auth: true }, async (ctx) => {
    ctx.json(200, { connections: await store.listConnections(ctx.user.id) });
  });

  route('POST', '/api/connections', { auth: true }, async (ctx) => {
    const { exchange, label } = ctx.body;
    const adapter = adapters[exchange];
    if (!adapter) return ctx.json(400, { error: 'Exchange no soportado' });
    { const ent = await entitlement(store, ctx.user); if (ent.enforced && (await store.listConnections(ctx.user.id)).length >= ent.maxConnections) return ctx.json(403, { error: `Tu plan permite ${ent.maxConnections} conexión(es). Mejora tu plan para añadir más.`, need_plan: true }); }
    const keyId = String(ctx.body.keyId || '').trim();
    let secret = String(ctx.body.secret || '').trim();
    if (!keyId || !secret || keyId.length > 300 || secret.length > 5000) return ctx.json(400, { error: 'Faltan datos de la llave', hint: 'Pega los dos campos: el identificador y la llave privada.' });
    if (!ctx.allow(`conn:${ctx.user.id}`, 10, 3600000)) return ctx.json(429, { error: 'Demasiados intentos' });
    const checks = [];
    const fail = (error, hint) => ctx.json(400, { error, hint, checks });
    // Errores típicos de copiado, explicados en lenguaje simple antes de llamar al exchange.
    if (exchange === 'coinbase') {
      secret = secret.replace(/\\n/g, '\n'); // el JSON de Coinbase trae los saltos de línea como \n literal
      if (!keyId.startsWith('organizations/')) return fail('Ese identificador no parece de Coinbase', 'Debe empezar con "organizations/" (el "API key name").');
      if (!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(secret)) return fail('Esa llave privada no parece de Coinbase', 'Debe empezar con "-----BEGIN EC PRIVATE KEY-----". Copia el bloque completo.');
    } else if (exchange === 'robinhood') {
      if (/\s/.test(secret) || !/^[A-Za-z0-9+/=_-]{40,200}$/.test(secret)) return fail('Esa llave privada no parece de Robinhood', 'Es una sola línea de letras y números (base64), sin espacios. Cópiala completa.');
    }
    let chk;
    try { chk = await adapter.check({ keyId, secret }); }
    catch (e) { checks.push({ id: 'valid', label: 'Llave válida', ok: false }); return fail(`El exchange no aceptó la llave: ${e.message}`, 'Revisa que copiaste los dos campos completos y que la llave no esté vencida.'); }
    checks.push({ id: 'valid', label: 'Llave válida', ok: !!chk.ok });
    if (!chk.ok) return fail(chk.error, 'Crea una llave nueva y vuelve a pegarla.');
    checks.push({ id: 'trade', label: 'Puede operar (trading)', ok: !!chk.canTrade });
    checks.push({ id: 'nowithdraw', label: 'Sin permiso de retiros', ok: !chk.canTransfer });
    if (!chk.canTrade) return fail('La llave no tiene permiso de trading', 'Crea otra con permisos de ver y operar (Trade).');
    if (chk.canTransfer) return fail('RECHAZADA: la llave permite retiros', 'Por tu seguridad solo aceptamos llaves SIN retiros. Crea una nueva sin el permiso Transfer/Withdraw.');
    const c = await store.addConnection({ user_id: ctx.user.id, exchange, label: String(label || adapter.label).slice(0, 60),
      key_id: keyId, secret_enc: encrypt(env.ENCRYPTION_KEY, secret),
      can_trade: !!chk.canTrade, can_transfer: !!chk.canTransfer });
    await audit(ctx.req, ctx.user, 'connection_add', exchange);
    const { secret_enc, ...safe } = c;
    ctx.json(201, { connection: { ...safe, encrypted: true }, checks });
  });

  route('GET', '/api/connections/:id/balances', { auth: true }, async (ctx) => {
    const c = await store.getConnection(ctx.user.id, ctx.params.id);
    if (!c) return ctx.json(404, { error: 'No encontrada' });
    try {
      const b = await adapters[c.exchange].balances({ keyId: c.key_id, secret: decrypt(env.ENCRYPTION_KEY, c.secret_enc) });
      ctx.json(200, { balances: b });
    } catch (e) { ctx.json(502, { error: e.message }); }
  });

  // Probar conexión: SOLO lecturas (permisos, saldos, precio). Nunca envía ni simula una orden en el exchange.
  route('POST', '/api/connections/:id/test', { auth: true }, async (ctx) => {
    if (!ctx.allow(`conntest:${ctx.user.id}`, 12, 3600000)) return ctx.json(429, { error: 'Demasiadas pruebas, espera un rato' });
    const c = await store.getConnection(ctx.user.id, ctx.params.id);
    const ad = c && adapters[c.exchange];
    if (!c || !ad) return ctx.json(404, { error: 'No encontrada' });
    const steps = []; const step = (id, label, ok, detail, hint) => steps.push({ id, label, ok: !!ok, detail: detail || null, hint: ok ? null : (hint || null) });
    let creds;
    try { creds = { keyId: c.key_id, secret: decrypt(env.ENCRYPTION_KEY, c.secret_enc) }; } catch { step('open', 'Abrir la llave guardada', false, null, 'Quita esta conexión y vuelve a pegar la llave.'); return ctx.json(200, { ok: false, steps, orders_sent: 0 }); }
    step('open', 'Abrir la llave guardada', true);
    try {
      const chk = await ad.check(creds);
      step('valid', 'El exchange acepta la llave', chk.ok, chk.ok ? null : chk.error, 'Crea una llave nueva y vuelve a conectar.');
      if (chk.ok) {
        step('trade', 'Puede operar (trading)', chk.canTrade, null, 'Crea otra llave con permiso de Trade.');
        step('nowithdraw', 'Sin permiso de retiros', !chk.canTransfer, null, 'Esta llave permite retirar: quítala y crea una sin retiros.');
      }
    } catch (e) { step('valid', 'El exchange acepta la llave', false, e.message, 'Revisa que la llave no esté vencida o revocada.'); }
    if (steps.every((x) => x.ok)) {
      try { const b = await ad.balances(creds); step('balances', 'Puede leer tus saldos', true, `${b.length} activo(s) con saldo`); }
      catch (e) { step('balances', 'Puede leer tus saldos', false, e.message, 'Revisa que la llave tenga permiso de ver (View).'); }
      try { const px = await feed.getPrice('BTC-USD'); step('price', 'Precio de mercado disponible', Number.isFinite(px) && px > 0, null, 'El precio público no responde ahora; reintenta en un minuto.'); }
      catch { step('price', 'Precio de mercado disponible', false, null, 'El precio público no responde ahora; reintenta en un minuto.'); }
    }
    const ok = steps.every((x) => x.ok);
    await audit(ctx.req, ctx.user, 'connection_test', `${c.exchange} ${ok ? 'ok' : 'falló'}`);
    ctx.json(200, { ok, steps, orders_sent: 0, note: 'Prueba de solo lectura: no se envió ninguna orden.' });
  });

  route('DELETE', '/api/connections/:id', { auth: true }, async (ctx) => {
    const ok = await store.deleteConnection(ctx.user.id, ctx.params.id);
    if (!ok) return ctx.json(404, { error: 'No encontrada' });
    const b = await store.getBot(ctx.user.id);
    if (b && b.cfg.connectionId === ctx.params.id) await store.patchBot(ctx.user.id, { cfg: { ...b.cfg, enabled: false, connectionId: null } });
    await audit(ctx.req, ctx.user, 'connection_remove');
    ctx.json(200, { ok: true });
  });

  // ----- Bot del cliente -----
  route('GET', '/api/bot', { auth: true }, async (ctx) => {
    const b = await store.getBot(ctx.user.id);
    ctx.json(200, { cfg: b ? { ...DEFAULT_CFG, ...b.cfg } : await defaultCfg(), last_run: b ? b.last_run : 0 });
  });

  route('PUT', '/api/bot', { auth: true }, async (ctx) => {
    const v = validateCfg(ctx.body, { hardMaxOrder, hardMaxDaily, symbols: await allowedSymbols() });
    if (!v.ok) return ctx.json(400, { error: v.error });
    const cfg = v.cfg;
    if (cfg.mode === 'live' && cfg.enabled) {
      if (ctx.user.role !== 'owner' && !ctx.user.email_verified_at) return ctx.json(403, { error: 'Verifica tu correo antes de operar en real (Ajustes → Cuenta).', need_email_verify: true });
      if (!(await liveAllowedFor(ctx.user))) return ctx.json(403, { error: 'El trading real aún no está habilitado para tu cuenta. Usa modo papel.' });
      const ent = await entitlement(store, ctx.user);
      if (ent.enforced) {
        if (!ent.live) return ctx.json(403, { error: ent.reason, need_plan: true });
        if (cfg.maxOrderUsd > ent.caps.maxOrderUsd || cfg.maxDailyUsd > ent.caps.maxDailyUsd) return ctx.json(400, { error: `Tu plan permite hasta $${ent.caps.maxOrderUsd} por orden y $${ent.caps.maxDailyUsd} por día.`, caps: ent.caps });
      }
      if (!cfg.liveAck) return ctx.json(400, { error: 'Debes confirmar que entiendes el riesgo de perder dinero.' });
      const c = cfg.connectionId ? await store.getConnection(ctx.user.id, cfg.connectionId) : null;
      if (!c) return ctx.json(400, { error: 'Elige una conexión de exchange para operar en real.' });
      if (!c.can_trade || c.can_transfer) return ctx.json(400, { error: 'La conexión no es válida para trading real.' });
    }
    if (cfg.connectionId && !(await store.getConnection(ctx.user.id, cfg.connectionId))) cfg.connectionId = null;
    { const prev = await store.getBot(ctx.user.id);
      if (cfg.enabled && !(prev && prev.cfg.enabled && prev.cfg.mode === cfg.mode)) await store.setSetting(`botstart:${ctx.user.id}`, String(Date.now())); }
    await store.saveBot(ctx.user.id, cfg);
    await store.patchBot(ctx.user.id, { errors: 0 }); // config nueva = empezar sin errores arrastrados
    await audit(ctx.req, ctx.user, cfg.mode === 'live' && cfg.enabled ? 'bot_live_enable' : 'bot_update', `${cfg.strategy} ${cfg.symbol} ${cfg.mode}`);
    if (cfg.enabled && engine) setImmediate(() => engine.tick().catch(() => {})); // primera decisión al instante, sin esperar al ciclo
    ctx.json(200, { cfg });
  });

  const scannerBrief = async () => { const sc = await getScanner(store); return sc ? { t: sc.t, scanned: sc.scanned, qualified: sc.items.filter((i) => i.qualified).slice(0, 6).map((i) => ({ symbol: i.symbol, label: i.label, cheaper: i.cheaper, gap_pct: i.gap_pct })) } : null; };
  // "¿Cómo va mi bot?": estado, última decisión y por qué, posición, resultado y últimas órdenes. Solo del propio usuario.
  route('GET', '/api/bot/status', { auth: true }, async (ctx) => {
    const b = await store.getBot(ctx.user.id);
    const cfg = { ...DEFAULT_CFG, ...(b ? b.cfg : {}) };
    let last = null; try { last = JSON.parse(await store.getSetting(`botlast:${ctx.user.id}`, 'null')); } catch { last = null; }
    const isAuto = cfg.symbol === 'AUTO';
    const all = (await store.listOrders(ctx.user.id, 5000)).filter((o) => o.status === 'ok' && o.mode === cfg.mode && (isAuto || o.symbol === cfg.symbol)).reverse();
    const pos = positionFromOrders(all.filter((o) => isAuto || o.symbol === cfg.symbol).map((o) => ({ side: o.side, qty: o.qty, usd: o.usd, ts: o.created_at })));
    // Libro por cripto (en AUTO pueden ser varias): cantidad, costo, resultado realizado y valor actual.
    const book = new Map(); let realized = 0; const curve = [0];
    for (const o of all) {
      const bk = book.get(o.symbol) || { symbol: o.symbol, qty: 0, cost: 0, venue: o.exchange }; book.set(o.symbol, bk);
      if (o.side === 'buy') { bk.qty += o.qty; bk.cost += o.usd; bk.venue = o.exchange; }
      else { const avg = bk.qty > 0 ? bk.cost / bk.qty : 0; const q = Math.min(o.qty, bk.qty); realized += o.usd - avg * q; bk.cost -= avg * q; bk.qty -= q; curve.push(Math.round(realized * 100) / 100); }
    }
    const prices = new Map();
    const priceOf = async (sym) => { if (!prices.has(sym)) { let px = null; try { px = await feed.getPrice(sym); } catch { px = null; } prices.set(sym, px); } return prices.get(sym); };
    const holdings = [];
    for (const bk of book.values()) {
      if (bk.qty < 1e-12) continue;
      const px = await priceOf(bk.symbol);
      holdings.push({ symbol: bk.symbol, qty: bk.qty, cost: bk.cost, venue: bk.venue, price: px, value: px !== null ? bk.qty * px : null, unrealized: px !== null ? bk.qty * px - bk.cost : null });
    }
    const qty = holdings.reduce((x, h) => x + h.qty, 0); const cost = holdings.reduce((x, h) => x + h.cost, 0);
    const price = isAuto ? null : await priceOf(cfg.symbol) ?? (last ? last.price : null);
    const known = holdings.every((h) => h.value !== null);
    const value = known ? holdings.reduce((x, h) => x + h.value, 0) : null;
    const unrealized = value !== null ? value - cost : null;
    let closes48 = []; let sig = null;
    if (!isAuto) try { const cl = await feed.getCloses(cfg.symbol); closes48 = cl.slice(-48); sig = { rsi: rsi(cl, 14), trend: (sma(cl, 20) && sma(cl, 50)) ? (sma(cl, 20) > sma(cl, 50) ? 'alcista' : 'bajista') : null }; } catch { /* sin velas */ }
    const recent = (await store.listOrders(ctx.user.id, 8)).map((o) => ({ t: o.created_at, mode: o.mode, symbol: o.symbol, side: o.side, usd: o.usd, price: o.price, status: o.status, note: o.note }));
    const unreconciled = (await store.listOrders(ctx.user.id, 200)).filter((o) => o.mode === 'live' && PENDING_STATES.includes(o.lifecycle)).length;
    const lifecycle = b ? { unreconciled_live_orders: unreconciled, tenant: b.user_id, state: b.state, reason: b.state_reason, since: b.state_at, strategy_version: b.strategy_version || STRATEGY_VERSION, ...healthOf({ state: b.state, enabled: !!cfg.enabled, last_run: b.last_run, errors: b.errors }) } : { state: 'CREATED', status: 'idle' };
    ctx.json(200, { lifecycle, enabled: !!cfg.enabled, mode: cfg.mode, symbol: cfg.symbol, strategy: cfg.strategy, limits: { usd: cfg.usd, maxOrderUsd: cfg.maxOrderUsd, maxDailyUsd: cfg.maxDailyUsd, stopLossPct: cfg.stopLossPct, spent24: Math.round(all.filter((o) => o.side === 'buy' && Date.now() - Number(o.created_at) < 86400000).reduce((s, o) => s + (o.usd || 0), 0) * 100) / 100 }, last_run: b ? b.last_run : null, last, price,
      position: { qty, cost, value, unrealized, avgCost: isAuto ? null : pos.avgCost }, holdings, octopus: isAuto ? await (async () => { try { return JSON.parse(await store.getSetting(`octo:${ctx.user.id}`, 'null')); } catch { return null; } })() : null, scanner: isAuto ? await scannerBrief() : null, realized, total: unrealized === null ? realized : realized + unrealized, curve, recent, errors: b ? b.errors : 0, closes: closes48, signals: sig, next_check: b && cfg.enabled ? (b.last_run || 0) + 15000 : null, server_time: Date.now() });
  });


  // Gráfico de precio estilo Robinhood: velas horarias (1D/1S/1M) o diarias (3M) + tus propias órdenes marcadas.
  const RANGES = { '1D': { n: 24, g: 3600 }, '1W': { n: 168, g: 3600 }, '1M': { n: 720, g: 3600 }, '3M': { n: 90, g: 86400 } };
  const chartCache = new Map();
  route('GET', '/api/chart', { auth: true }, async (ctx) => {
    const symbol = String(ctx.query.get('symbol') || 'BTC-USD').toUpperCase(); const range = RANGES[ctx.query.get('range')] ? ctx.query.get('range') : '1D';
    if (!SYMBOL_RE.test(symbol)) return ctx.json(400, { error: 'Símbolo inválido' });
    if (!ctx.allow(`ch:${ctx.user.id}`, 240, 3600000)) return ctx.json(429, { error: 'Demasiadas consultas' });
    const key = `${symbol}:${range}`; const R = RANGES[range];
    let hit = chartCache.get(key);
    if (!hit || Date.now() - hit.t > 60000) {
      try {
        const closes = await feed.getHistory(symbol, R.n + 1, R.g); let price = closes[closes.length - 1];
        try { price = await feed.getPrice(symbol); } catch { /* usa el último cierre */ }
        const step = R.g * 1000; const endMs = Math.floor(Date.now() / step) * step;
        const pts = closes.slice(-R.n).map((c, i, a) => ({ t: endMs - (a.length - 1 - i) * step, v: c }));
        pts.push({ t: Date.now(), v: price });
        hit = { t: Date.now(), v: { symbol, range, points: pts, price } };
        chartCache.set(key, hit); if (chartCache.size > 300) chartCache.delete(chartCache.keys().next().value);
      } catch (e) { return ctx.json(502, { error: `No pude leer el gráfico de ${symbol} ahora` }); }
    }
    const first = hit.v.points[0].t;
    const mine = (await store.listOrders(ctx.user.id, 300)).filter((o) => o.symbol === symbol && o.status === 'ok' && o.created_at >= first).map((o) => ({ t: o.created_at, side: o.side, price: o.price, usd: o.usd, mode: o.mode }));
    const vals = hit.v.points.map((p) => p.v);
    ctx.json(200, { ...hit.v, open: vals[0], change_pct: (vals[vals.length - 1] / vals[0] - 1) * 100, hi: Math.max(...vals), lo: Math.min(...vals), mine });
  });

  // "Cuánto he ganado desde que encendí el bot": capital(t) - capital(inicio), con curva. Solo del propio usuario.
  // Resultados por periodo (24 h, 7 d, 30 d, total) separados en REAL y PAPEL. Solo operaciones cerradas.
  route('GET', '/api/results', { auth: true }, async (ctx) => {
    if (!ctx.allow(`rs:${ctx.user.id}`, 240, 3600000)) return ctx.json(429, { error: 'Demasiadas consultas' });
    const all = (await store.listOrders(ctx.user.id, 5000)).slice().reverse(); const now = Date.now();
    ctx.json(200, { t: now, real: periodResults(all.filter((o) => o.mode === 'live'), now), paper: periodResults(all.filter((o) => o.mode !== 'live'), now) });
  });
  // Verificación: cruza el libro del bot con lo que dice el exchange (saldos y órdenes). Falla por conexión y lo dice.
  const verifyCache = new Map();
  route('GET', '/api/verify', { auth: true }, async (ctx) => {
    const hit = verifyCache.get(ctx.user.id);
    if (hit && Date.now() - hit.t < 30000) return ctx.json(200, hit.v);
    if (!ctx.allow(`vf:${ctx.user.id}`, 60, 3600000)) return ctx.json(429, { error: 'Demasiadas consultas' });
    const ledgerAll = (await store.listOrders(ctx.user.id, 5000)).filter((o) => o.mode === 'live' && o.status === 'ok');
    const out = [];
    for (const c of await store.listConnections(ctx.user.id)) {
      const e = { exchange: c.exchange, label: c.label, verified: false, error: null };
      const full = await store.getConnection(ctx.user.id, c.id); const ad = adapters && adapters[c.exchange];
      if (!full || !ad) { e.error = 'conexión no disponible'; out.push(e); continue; }
      let creds; try { creds = { keyId: full.key_id, secret: decrypt(env.ENCRYPTION_KEY, full.secret_enc) }; } catch { e.error = 'no se pudo abrir la llave'; out.push(e); continue; }
      try {
        const bal = await ad.balances(creds); const balances = [];
        for (const b of bal.slice(0, 40)) { const stable = ['USD', 'USDC'].includes(b.asset); let px = stable ? 1 : null; if (!stable) { try { px = await feed.getPrice(`${b.asset}-USD`); } catch { px = null; } } balances.push({ asset: b.asset, available: b.available, hold: b.hold, usd: px !== null ? (b.available + b.hold) * px : null }); }
        let orders = []; let ordersErr = null; if (ad.activity) { try { orders = await ad.activity(creds); } catch (err) { ordersErr = err.message; } }
        const r = reconcile({ ledger: ledgerAll.filter((o) => o.exchange === c.exchange), balances, exchangeOrders: orders });
        e.verified = true; e.balance_usd = balances.reduce((s, b) => s + (b.usd || 0), 0); e.positions = r.positions; e.orders = r.orders; e.ok = r.ok && !ordersErr; e.alerts = r.alerts; if (ordersErr) e.orders_error = ordersErr;
      } catch (err) { e.error = err.message; }
      out.push(e);
    }
    const v = { t: Date.now(), exchanges: out, note: 'Compara lo que el bot anotó con lo que reporta el exchange. «No verificado» significa que no se pudo consultar, no que esté bien.' };
    verifyCache.set(ctx.user.id, { t: Date.now(), v }); ctx.json(200, v);
  });
  route('GET', '/api/profit', { auth: true }, async (ctx) => {
    const b = await store.getBot(ctx.user.id);
    const mode = ctx.query.get('mode') === 'live' ? 'live' : ctx.query.get('mode') === 'paper' ? 'paper' : (b && b.cfg.mode) || 'paper';
    if (!ctx.allow(`pf:${ctx.user.id}`, 240, 3600000)) return ctx.json(429, { error: 'Demasiadas consultas' });
    const orders = (await store.listOrders(ctx.user.id, 5000)).filter((o) => o.mode === mode && o.status === 'ok').reverse();
    const now = Date.now();
    let start = Number(await store.getSetting(`botstart:${ctx.user.id}`, '0')) || 0;
    const firstOrder = orders.length ? orders[0].created_at : 0;
    if (!start) start = firstOrder; // bots anteriores a esta versión: desde su primera orden
    if (!start) return ctx.json(200, { mode, started: false, enabled: !!(b && b.cfg.enabled) });
    const hours = Math.min(720, Math.ceil((now - start) / 3600000) + 3);
    const hist = new Map(); const livePx = new Map();
    const syms = [...new Set(orders.map((o) => o.symbol))].slice(-15);
    await Promise.all(syms.map(async (s) => {
      try { livePx.set(s, await feed.getPrice(s)); } catch { /* sin precio actual */ }
      try { const cl = await feed.getHistory(s, hours + 1, 3600); hist.set(s, { closes: cl, endMs: Math.floor(now / 3600000) * 3600000 }); } catch { /* usa precios de tus órdenes */ }
    }));
    const r = profitSince({ orders, start, now, hist, livePx });
    ctx.json(200, { mode, started: true, enabled: !!(b && b.cfg.enabled), ...r });
  });

  // Pausa/reanuda: la pausa no cambia la configuración; el bot no decide ni opera hasta reanudar.
  route('POST', '/api/bot/pause', { auth: true }, async (ctx) => {
    const b = await store.getBot(ctx.user.id);
    if (!b || !b.cfg.enabled) return ctx.json(409, { error: 'El bot no está encendido' });
    if (b.state === 'PAUSED') return ctx.json(409, { error: 'El bot ya está en pausa' });
    const r = await store.setBotState(ctx.user.id, 'PAUSED', 'pausado por el cliente');
    if (!r.ok) return ctx.json(409, { error: r.error });
    await audit(ctx.req, ctx.user, 'bot_pause'); ctx.json(200, { ok: true, state: r.state });
  });
  route('POST', '/api/bot/resume', { auth: true }, async (ctx) => {
    const b = await store.getBot(ctx.user.id);
    if (!b || b.state !== 'PAUSED') return ctx.json(409, { error: 'El bot no está en pausa' });
    const r = await store.setBotState(ctx.user.id, 'RUNNING', 'reanudado por el cliente');
    await audit(ctx.req, ctx.user, 'bot_resume'); ctx.json(200, { ok: r.ok, state: r.state });
  });
  route('GET', '/api/bot/events', { auth: true }, async (ctx) => ctx.json(200, { events: await store.listBotEvents(ctx.user.id, 50) }));

  // Kill switch: apaga el bot y, con closeAll, VENDE todas las posiciones abiertas (real y papel) a precio de mercado.
  // Cerrar = solo vender (no abre nada nuevo); funciona aunque el trading real esté apagado por el administrador o haya parada de emergencia.
  route('POST', '/api/bot/kill', { auth: true }, async (ctx) => {
    const b = await store.getBot(ctx.user.id);
    if (b) await store.patchBot(ctx.user.id, { cfg: { ...b.cfg, enabled: false } });
    await audit(ctx.req, ctx.user, 'bot_kill', ctx.body.closeAll === true ? 'con cierre de posiciones' : 'solo apagado');
    if (ctx.body.closeAll !== true) return ctx.json(200, { ok: true, closed: [] });
    if (!engine || !engine.closePositions) return ctx.json(200, { ok: true, closed: [], warning: 'Motor no disponible' });
    if (!ctx.allow(`close:${ctx.user.id}`, 20, 3600000)) return ctx.json(429, { error: 'Demasiados cierres seguidos. Revisa el exchange.' });
    const closed = await engine.closePositions(ctx.user.id, { source: 'kill switch' });
    ctx.json(200, { ok: true, closed, failed: closed.filter((x) => !x.placed).length,
      note: 'Las órdenes de venta quedan «pendientes» hasta que el exchange las confirme. No se cancelan órdenes que ya estuvieran abiertas en el exchange: revísalas allí.' });
  });

  // Botones Comprar / Vender de una cripto. Siempre pide confirmación explícita; en real, comprar respeta todas las compuertas del bot.
  route('POST', '/api/trade', { auth: true }, async (ctx) => {
    const { side, mode } = ctx.body; const symbol = String(ctx.body.symbol || '').toUpperCase();
    if (!['buy', 'sell'].includes(side) || !['paper', 'live'].includes(mode)) return ctx.json(400, { error: 'Datos inválidos' });
    if (ctx.body.confirm !== true) return ctx.json(400, { error: 'Falta la confirmación.' });
    if (!SYMBOL_RE.test(symbol) || !(await allowedSymbols()).includes(symbol)) return ctx.json(400, { error: 'Cripto no disponible' });
    if (!engine || !engine.manualTrade) return ctx.json(503, { error: 'Motor no disponible' });
    if (!ctx.allow(`trade:${ctx.user.id}`, 30, 3600000)) return ctx.json(429, { error: 'Demasiadas órdenes manuales por hora.' });
    const bot = await store.getBot(ctx.user.id);
    let caps = { maxOrderUsd: Math.min(Number(bot && bot.cfg.maxOrderUsd) || 25, hardMaxOrder), maxDailyUsd: Math.min(Number(bot && bot.cfg.maxDailyUsd) || 100, hardMaxDaily) };
    if (side === 'buy') {
      const usd = Number(ctx.body.usd);
      if (!(usd >= 1) || usd > caps.maxOrderUsd) return ctx.json(400, { error: `Compra entre $1 y $${caps.maxOrderUsd} (tu tope por orden).` });
      if (mode === 'live') {
        if (ctx.body.liveAck !== true) return ctx.json(400, { error: 'Confirma que entiendes que es dinero real.' });
        if (ctx.user.role !== 'owner' && !ctx.user.email_verified_at) return ctx.json(403, { error: 'Verifica tu correo antes de operar en real.', need_email_verify: true });
        if (!(await liveAllowedFor(ctx.user))) return ctx.json(403, { error: 'El trading real aún no está habilitado para tu cuenta.' });
        const ent = await entitlement(store, ctx.user);
        if (ent.enforced) { if (!ent.live) return ctx.json(403, { error: ent.reason, need_plan: true }); caps = { maxOrderUsd: Math.min(caps.maxOrderUsd, ent.caps.maxOrderUsd), maxDailyUsd: Math.min(caps.maxDailyUsd, ent.caps.maxDailyUsd) }; if (usd > caps.maxOrderUsd) return ctx.json(400, { error: `Tu plan permite hasta $${caps.maxOrderUsd} por orden.` }); }
      }
    } else if (!(Number(ctx.body.fraction) > 0 && Number(ctx.body.fraction) <= 1)) return ctx.json(400, { error: 'Elige qué parte vender (25%, 50% o 100%).' });
    await audit(ctx.req, ctx.user, `manual_${side}`, `${mode} ${symbol}${side === 'buy' ? ` $${Number(ctx.body.usd)}` : ` ${Math.round(Number(ctx.body.fraction) * 100)}%`}`);
    const results = await engine.manualTrade(ctx.user.id, { side, symbol, usd: Number(ctx.body.usd), fraction: Number(ctx.body.fraction) || 1, mode, connectionId: ctx.body.connectionId || null, caps });
    ctx.json(200, { ok: true, results, note: mode === 'live' ? 'Las órdenes reales quedan «pendientes» hasta que el exchange las confirme.' : 'Simulado: no se movió dinero.' });
  });

  // Mis posiciones abiertas (libro de órdenes), para los botones Vender / Cerrar todo.
  route('GET', '/api/positions', { auth: true }, async (ctx) => {
    const live = engine && engine.livePositions ? await engine.livePositions(ctx.user.id) : [];
    const orders = (await store.listOrders(ctx.user.id, 2000)).filter((o) => o.mode === 'paper' && o.status === 'ok');
    const g = new Map(); for (const o of orders) { if (!g.has(o.symbol)) g.set(o.symbol, []); g.get(o.symbol).push({ side: o.side, qty: o.qty, usd: o.usd, ts: o.created_at }); }
    const paper = [...g.entries()].map(([symbol, l]) => ({ symbol, ...positionFromOrders(l) })).filter((p) => p.qty > 0);
    ctx.json(200, { live: live.map((p) => ({ symbol: p.symbol, exchange: p.exchange, qty: p.qty, avgCost: p.avgCost })), paper: paper.map((p) => ({ symbol: p.symbol, qty: p.qty, avgCost: p.avgCost })) });
  });

  route('POST', '/api/backtest', { auth: true }, async (ctx) => {
    if (!ctx.allow(`bt:${ctx.user.id}`, 20, 3600000)) return ctx.json(429, { error: 'Demasiadas pruebas. Intenta más tarde.' });
    const v = validateCfg({ ...ctx.body, mode: 'paper' }, { hardMaxOrder, hardMaxDaily, symbols: await allowedSymbols() });
    if (!v.ok) return ctx.json(400, { error: v.error });
    if (v.cfg.symbol === 'AUTO') return ctx.json(400, { error: 'AUTO no se puede probar con una sola cripto: mira el ranking del Cerebro.' });
    try {
      const closes = await feed.getCloses(v.cfg.symbol);
      // Simulación con capital virtual (hasta $1,000,000) y costos realistas del exchange elegido. No mueve dinero.
      const exchange = EXCHANGES.includes(ctx.body.exchange) ? ctx.body.exchange : 'coinbase';
      const capital = Math.min(1000000, Math.max(1000, Number(ctx.body.capital) || 1000));
      const k = capital / 1000;
      const cfg = { ...v.cfg, usd: v.cfg.usd * k, maxOrderUsd: v.cfg.maxOrderUsd * k, maxDailyUsd: v.cfg.maxDailyUsd * k };
      ctx.json(200, { ...backtest(closes, cfg, { capital, exchange }), cost_profile: COST_PROFILES[exchange].label });
    } catch (e) { ctx.json(502, { error: e.message }); }
  });

  route('GET', '/api/signals', { auth: true }, async (ctx) => {
    const symbol = ctx.query.get('symbol') || 'BTC-USD';
    if (!SYMBOL_RE.test(symbol) || !(await allowedSymbols()).includes(symbol)) return ctx.json(400, { error: 'Símbolo no permitido' });
    if (!ctx.allow(`sig:${ctx.user.id}`, 60, 3600000)) return ctx.json(429, { error: 'Demasiadas consultas' });
    try {
      let c = sigCache.get(symbol);
      if (!c || Date.now() - c.t > 60000) {
        const [price, closes] = await Promise.all([feed.getPrice(symbol), feed.getCloses(symbol)]);
        c = { t: Date.now(), price, closes };
        sigCache.set(symbol, c);
      }
      const m = macd(c.closes); const b = bollinger(c.closes); const s20 = sma(c.closes, 20); const s50 = sma(c.closes, 50);
      ctx.json(200, { symbol, price: c.price, rsi: rsi(c.closes, 14),
        macd: m ? { hist: m.hist, state: m.macd > m.signal ? 'alcista' : 'bajista' } : null,
        bollinger: b ? { pctB: b.pctB } : null, trend: s20 && s50 ? (s20 > s50 ? 'alcista' : 'bajista') : null,
        model: await director.signal(symbol, c.closes), disclaimer: 'Información educativa; no es asesoría de inversión.' });
    } catch (e) { ctx.json(502, { error: e.message }); }
  });

  route('POST', '/api/me/password', { auth: true }, async (ctx) => {
    const { current, next } = ctx.body;
    if (!ctx.allow(`pw:${ctx.user.id}`, 5, 900000)) return ctx.json(429, { error: 'Demasiados intentos' });
    if (ctx.user.role === 'owner') return ctx.json(400, { error: 'La contraseña del dueño se cambia en OWNER_PASSWORD (variables de entorno).' });
    if (!(await verifyPassword(String(current || ''), ctx.user.pass_hash))) return ctx.json(400, { error: 'La contraseña actual no coincide' });
    if (typeof next !== 'string' || next.length < 10 || next.length > 200) return ctx.json(400, { error: 'La nueva contraseña debe tener al menos 10 caracteres' });
    await store.updateUser(ctx.user.id, { pass_hash: await hashPassword(next) });
    await store.bumpSv(ctx.user.id);
    await audit(ctx.req, ctx.user, 'password_change');
    ctx.res.setHeader('Set-Cookie', setCookie('', 0));
    ctx.json(200, { ok: true });
  });

  route('GET', '/api/me/export', { auth: true }, async (ctx) => {
    const u = ctx.user;
    jsonAttachment(ctx.res, 'mis-datos-quantum-trading.json', {
      exported_at: Date.now(), profile: { email: u.email, created_at: u.created_at, tos_version: u.tos_version, tos_at: u.tos_at },
      connections: await store.listConnections(u.id), bot: (await store.getBot(u.id))?.cfg || null, orders: await store.listOrders(u.id, 5000),
      note: 'Tus llaves API no se incluyen: están cifradas y solo el motor puede usarlas.' });
  });

  route('DELETE', '/api/me', { auth: true }, async (ctx) => {
    if (ctx.user.role === 'owner') return ctx.json(400, { error: 'La cuenta de dueño no se puede borrar desde aquí.' });
    if (!ctx.allow(`del:${ctx.user.id}`, 5, 900000)) return ctx.json(429, { error: 'Demasiados intentos' });
    if (!(await verifyPassword(String(ctx.body.password || ''), ctx.user.pass_hash))) return ctx.json(400, { error: 'La contraseña no coincide' });
    await store.addAudit({ actor: 'usuario-eliminado', action: 'account_deleted', ip: ctx.ip });
    await store.deleteUserData(ctx.user.id);
    ctx.res.setHeader('Set-Cookie', setCookie('', 0));
    ctx.json(200, { ok: true });
  });

  route('GET', '/api/orders', { auth: true }, async (ctx) => {
    ctx.json(200, { orders: await store.listOrders(ctx.user.id, Math.min(Number(ctx.query.get('limit')) || 100, 500)) });
  });

  // Resultado por modo y símbolo (costo promedio). Solo con órdenes exitosas del propio usuario.
  route('GET', '/api/pnl', { auth: true }, async (ctx) => {
    const orders = (await store.listOrders(ctx.user.id, 5000)).filter((o) => o.status === 'ok').reverse();
    const book = {};
    for (const o of orders) {
      const k = `${o.mode}|${o.symbol}`;
      const b = book[k] || (book[k] = { mode: o.mode, symbol: o.symbol, qty: 0, cost: 0, realized: 0, invested: 0, orders: 0 });
      b.orders += 1;
      if (o.side === 'buy') { b.qty += o.qty; b.cost += o.usd; b.invested += o.usd; }
      else {
        const avg = b.qty > 0 ? b.cost / b.qty : 0;
        const q = Math.min(o.qty, b.qty);
        b.realized += o.usd - avg * q;
        b.cost -= avg * q; b.qty -= q;
      }
    }
    const out = [];
    for (const b of Object.values(book)) {
      let price = null;
      try { price = await feed.getPrice(b.symbol); } catch { /* sin precio */ }
      out.push({ ...b, price, value: price ? b.qty * price : null, unrealized: price ? b.qty * price - b.cost : null });
    }
    ctx.json(200, { positions: out });
  });

  route('GET', '/api/bot/download', { auth: true }, async (ctx) => {
    await audit(ctx.req, ctx.user, 'download_bot');
    ctx.res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8',
      'Content-Disposition': 'attachment; filename="quantum-bot.mjs"', 'Cache-Control': 'no-store' });
    ctx.res.end(buildBotBundle());
  });

  // ----- Menú del dueño -----
  route('GET', '/api/owner/overview', { owner: true }, async (ctx) => {
    const since30 = Date.now() - 30 * DAY;
    const users = await store.listUsers();
    const clients = users.filter((u) => u.role === 'client');
    const orders = await store.listAllOrdersSince(since30);
    const events = await store.listAuditSince(since30);
    const bots = await store.listBots();
    const day = (t) => new Date(t).toISOString().slice(0, 10);
    const series = (items, f) => {
      const m = {};
      for (let i = 29; i >= 0; i--) m[day(Date.now() - i * DAY)] = 0;
      for (const it of items) { const d = day(f(it)); if (d in m) m[d] += 1; }
      return Object.entries(m).map(([date, n]) => ({ date, n }));
    };
    const okOrders = orders.filter((o) => o.status === 'ok');
    const sum = (arr) => arr.reduce((s, o) => s + (o.usd || 0), 0);
    const topSymbols = {};
    for (const o of okOrders) topSymbols[o.symbol] = (topSymbols[o.symbol] || 0) + 1;
    ctx.json(200, {
      generated_at: Date.now(),
      users: { total: clients.length, active: clients.filter((u) => u.status === 'active').length,
        suspended: clients.filter((u) => u.status === 'suspended').length,
        new_7d: clients.filter((u) => u.created_at >= Date.now() - 7 * DAY).length,
        active_24h: clients.filter((u) => u.last_login && u.last_login >= Date.now() - DAY).length },
      signups_30d: series(clients, (u) => u.created_at),
      orders_30d: series(orders, (o) => o.created_at),
      connections_by_exchange: await store.countConnectionsByExchange(),
      bots: { enabled_paper: bots.filter((b) => b.cfg.enabled && b.cfg.mode === 'paper').length,
        enabled_live: bots.filter((b) => b.cfg.enabled && b.cfg.mode === 'live').length },
      orders: { paper_count: okOrders.filter((o) => o.mode === 'paper').length,
        live_count: okOrders.filter((o) => o.mode === 'live').length,
        paper_usd: sum(okOrders.filter((o) => o.mode === 'paper')), live_usd: sum(okOrders.filter((o) => o.mode === 'live')),
        errors: orders.filter((o) => o.status === 'error').length },
      top_symbols: Object.entries(topSymbols).sort((a, b) => b[1] - a[1]).slice(0, 5),
      security: { failed_logins_24h: events.filter((e) => e.action === 'login_fail' && e.created_at >= Date.now() - DAY).length,
        logins_ok_30d: events.filter((e) => e.action === 'login_ok').length },
      billing: 'pendiente',
      funnel: await (async () => {
        const allOrders = await store.listAllOrdersSince(0);
        const withConn = new Set(); for (const u of clients) if ((await store.listConnections(u.id)).length) withConn.add(u.id);
        const botOn = new Set(bots.filter((b) => b.cfg.enabled).map((b) => b.user_id));
        const paper = new Set(allOrders.filter((o) => o.mode === 'paper' && o.status === 'ok').map((o) => o.user_id));
        const live = new Set(allOrders.filter((o) => o.mode === 'live' && o.status === 'ok').map((o) => o.user_id));
        const mine = (set) => clients.filter((u) => set.has(u.id)).length;
        return [{ k: 'Registrados', n: clients.length }, { k: 'Conectaron exchange', n: mine(withConn) }, { k: 'Bot encendido', n: mine(botOn) },
          { k: 'Primera orden papel', n: mine(paper) }, { k: 'Primera orden real', n: mine(live) }];
      })(),
    });
  });

  route('GET', '/api/owner/users', { owner: true }, async (ctx) => {
    const conns = {};
    const bots = Object.fromEntries((await store.listBots()).map((b) => [b.user_id, b]));
    const users = (await store.listUsers()).filter((u) => u.role === 'client');
    for (const u of users) conns[u.id] = (await store.listConnections(u.id)).length;
    ctx.json(200, { users: users.map((u) => ({ id: u.id, email: u.email, status: u.status, created_at: u.created_at,
      last_login: u.last_login, tos_version: u.tos_version, connections: conns[u.id],
      bot: bots[u.id] ? (bots[u.id].cfg.enabled ? bots[u.id].cfg.mode : 'apagado') : 'sin configurar' })) });
  });

  route('POST', '/api/owner/users/:id/status', { owner: true }, async (ctx) => {
    const { status } = ctx.body;
    if (!['active', 'suspended'].includes(status)) return ctx.json(400, { error: 'Estado inválido' });
    const t = await store.getUserById(ctx.params.id);
    if (!t || t.role !== 'client') return ctx.json(404, { error: 'Cliente no encontrado' });
    await store.updateUser(t.id, { status });
    await store.bumpSv(t.id);
    if (status === 'suspended') {
      const b = await store.getBot(t.id);
      if (b) await store.patchBot(t.id, { cfg: { ...b.cfg, enabled: false } });
    }
    await audit(ctx.req, ctx.user, 'owner_user_status', `${t.email} -> ${status}`);
    ctx.json(200, { ok: true });
  });

  route('GET', '/api/owner/audit', { owner: true }, async (ctx) => {
    ctx.json(200, { events: await store.listAudit(300) });
  });


  // Seguridad del dueño: lo que pasó en las últimas 24 h (intentos fallidos, accesos del dueño, bloqueos). Solo agregados y metadatos.
  route('GET', '/api/owner/security', { owner: true }, async (ctx) => {
    const since = Date.now() - 24 * 3600000;
    const ev = await store.listAuditSince(since);
    const fails = ev.filter((e) => e.action === 'login_fail'); const byIp = new Map();
    for (const e of fails) byIp.set(e.ip || '?', (byIp.get(e.ip || '?') || 0) + 1);
    const owner = ev.filter((e) => e.actor === ownerEmail && ['login_ok', 'login_fail', 'owner_denied'].includes(e.action)).slice(-8).reverse()
      .map((e) => ({ t: e.created_at, action: e.action, ip: e.ip, detail: e.detail || '' }));
    const users = await store.listUsers();
    const flags = [];
    if (fails.length >= 20) flags.push(`${fails.length} intentos de acceso fallidos en 24 h`);
    if (ev.some((e) => e.action === 'owner_denied')) flags.push('Alguien sin permiso intentó entrar a la consola del dueño');
    if (fails.some((e) => /2fa/.test(e.detail || '') && e.actor === ownerEmail)) flags.push('Códigos 2FA del dueño fallidos');
    ctx.json(200, { window_h: 24, failed_logins: fails.length, distinct_ips: byIp.size, top_ips: [...byIp.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([ip, n]) => ({ ip, n })),
      owner_denied: ev.filter((e) => e.action === 'owner_denied').length, locked_now: users.filter((u) => u.locked_until > Date.now()).length, owner_events: owner, flags,
      checks: { twofa: !!ctx.user.totp_secret, https: prod, session_hours: 12, csrf_header: true, keys_encrypted: true, withdraw_keys_rejected: true } });
  });

  // CFO: ingresos y costos que el dueño declara + uso real agregado. No inventa ingresos: sin cobros conectados, el MRR sale de lo que anotas.
  const FIN_DEFAULT = { costs: [{ name: 'Render web (Less than 1 CPU)', usd: 7 }, { name: 'Render Postgres (Less than 1 CPU)', usd: 6 }, { name: 'Dominio (por mes)', usd: 0 }], price: 0, paying: 0, cac: 0, churn_pct: 5, target_margin_pct: 70 };
  const getFin = async () => { try { return { ...FIN_DEFAULT, ...JSON.parse(await store.getSetting('finance:model', 'null') || 'null') }; } catch { return FIN_DEFAULT; } };
  route('GET', '/api/owner/finance', { owner: true }, async (ctx) => {
    const f = await getFin(); const users = (await store.listUsers()).filter((u) => u.role !== 'owner' && u.status === 'active');
    const bots = await store.listBots(); const cost = f.costs.reduce((a, c) => a + (Number(c.usd) || 0), 0);
    const mrr = f.price * f.paying; const profit = mrr - cost;
    const marginPct = mrr > 0 ? (profit / mrr) * 100 : null;
    const breakeven = f.price > 0 ? Math.ceil(cost / f.price) : null;
    const forTarget = f.paying > 0 ? cost / f.paying / (1 - f.target_margin_pct / 100) : null; // precio mínimo para ese margen con los clientes actuales
    const life = f.churn_pct > 0 ? 100 / f.churn_pct : null; const ltv = life && f.price ? f.price * life : null;
    ctx.json(200, { model: f, usage: { users: users.length, bots_on: bots.filter((b) => b.cfg.enabled).length, live_bots_on: bots.filter((b) => b.cfg.enabled && b.cfg.mode === 'live').length },
      calc: { cost, mrr, profit, margin_pct: marginPct, breakeven_customers: breakeven, price_for_target: forTarget, ltv, ltv_cac: ltv && f.cac > 0 ? ltv / f.cac : null, arr: mrr * 12 },
      advice: ['Cobra una suscripción fija, no un % de las ganancias: cobrar por rendimiento o manejar dinero ajeno puede exigir licencias (asesor/gestor). Consúltalo con un abogado de Florida.',
        'Mientras no conectes cobros (p. ej. Stripe), estos números son los que tú anotas, no ingresos medidos.'] });
  });
  route('PUT', '/api/owner/finance', { owner: true }, async (ctx) => {
    const b = ctx.body || {}; const n = (x, d, lo = 0, hi = 1e7) => { const v = Number(x); return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d; };
    const cur = await getFin();
    const costs = Array.isArray(b.costs) ? b.costs.slice(0, 20).map((c) => ({ name: String(c.name || '').slice(0, 60), usd: n(c.usd, 0) })).filter((c) => c.name) : cur.costs;
    const m = { costs, price: n(b.price, cur.price, 0, 10000), paying: Math.round(n(b.paying, cur.paying, 0, 1e6)), cac: n(b.cac, cur.cac, 0, 1e5), churn_pct: n(b.churn_pct, cur.churn_pct, 0, 100), target_margin_pct: n(b.target_margin_pct, cur.target_margin_pct, 0, 95) };
    await store.setSetting('finance:model', JSON.stringify(m));
    await store.setSetting('public:price', String(m.price));
    await audit(ctx.req, ctx.user, 'owner_finance', `price=${m.price} paying=${m.paying}`);
    ctx.json(200, { ok: true, model: m });
  });
  // Precio público para la landing (solo si el dueño lo fijó).
  route('GET', '/api/public/plan', {}, async (ctx) => {
    const p = Number(await store.getSetting('public:price', '0')) || 0;
    const us = (await store.listUsers()).filter((u) => u.role !== 'owner').length;
    ctx.json(200, { price: p > 0 ? p : null, currency: 'USD', period: 'mes', beta_users: us >= 10 ? us : null });
  });

  route('GET', '/api/owner/settings', { owner: true }, async (ctx) => {
    ctx.json(200, { live_trading: (await store.getSetting('live_trading', 'off')) === 'on', live_scope: await liveScope(),
      registration_open: (await store.getSetting('registration_open', 'on')) === 'on' });
  });

  route('PUT', '/api/owner/settings', { owner: true }, async (ctx) => {
    if (typeof ctx.body.live_trading === 'boolean') await store.setSetting('live_trading', ctx.body.live_trading ? 'on' : 'off');
    if (['off', 'owner', 'on'].includes(ctx.body.live_scope)) await store.setSetting('live_trading', ctx.body.live_scope);
    if (typeof ctx.body.registration_open === 'boolean') await store.setSetting('registration_open', ctx.body.registration_open ? 'on' : 'off');
    await audit(ctx.req, ctx.user, 'owner_settings', JSON.stringify(ctx.body).slice(0, 200));
    ctx.json(200, { ok: true });
  });

  // ---- Riesgo central y parada de emergencia (solo dueño) ----
  route('POST', '/api/owner/reconcile', { owner: true }, async (ctx) => {
    const r = await reconcileAll({ store, adapters, encKey: env.ENCRYPTION_KEY });
    await audit(ctx.req, ctx.user, 'reconcile_run', JSON.stringify(r)); ctx.json(200, { ok: true, ...r });
  });
  route('GET', '/api/owner/risk', { owner: true }, async (ctx) => {
    const platform = await loadPlatform(store); const emergency = await getEmergency(store);
    const recent = (await store.listAuditSince(Date.now() - 86400000)).filter((a) => a.actor === 'risk').slice(-30).reverse();
    ctx.json(200, { platform: platform.error ? null : platform, platform_error: platform.error || null, defaults: DEFAULT_PLATFORM, emergency, recent,
      policy: 'La parada de emergencia bloquea toda orden REAL nueva (compras y ventas) y detiene los bots reales. NO cancela órdenes ya enviadas ni vende posiciones: eso lo decide la persona con su broker.' });
  });
  route('PUT', '/api/owner/risk', { owner: true }, async (ctx) => {
    const cur = await loadPlatform(store); const next = { ...(cur.error ? DEFAULT_PLATFORM : cur) };
    for (const k of Object.keys(DEFAULT_PLATFORM)) if (ctx.body[k] !== undefined) { const v = Number(ctx.body[k]); if (!(Number.isFinite(v) && v > 0)) return ctx.json(400, { error: `Valor inválido para ${k}` }); next[k] = v; }
    await store.setSetting('risk:platform', JSON.stringify(next));
    await audit(ctx.req, ctx.user, 'risk_limits_changed', JSON.stringify(next).slice(0, 300));
    ctx.json(200, { ok: true, platform: next });
  });
  route('POST', '/api/owner/emergency', { owner: true }, async (ctx) => {
    const on = ctx.body.on === true;
    await setEmergency(store, { on, by: ctx.user.id, reason: ctx.body.reason || '' });
    if (on) for (const b of await store.listBots()) if (b.cfg.mode === 'live' && b.cfg.enabled && ['RUNNING', 'PAUSED'].includes(b.state)) await store.setBotState(b.user_id, 'EMERGENCY_STOP', `parada de emergencia${ctx.body.reason ? `: ${String(ctx.body.reason).slice(0, 80)}` : ''}`);
    await audit(ctx.req, ctx.user, on ? 'emergency_stop_on' : 'emergency_stop_off', String(ctx.body.reason || '').slice(0, 200));
    ctx.json(200, { ok: true, emergency: await getEmergency(store) });
  });

  route('GET', '/api/owner/brain', { owner: true }, async (ctx) => {
    const [agents, guardrails, pending, all] = await Promise.all([director.overview(), getGuardrails(store),
      store.listProposals('pending', 100), store.listProposals(null, 200)]);
    const models = [];
    for (const symbol of ['BTC-USD', 'ETH-USD']) {
      const cand = await store.getSetting(`model:candidate:${symbol}`, null);
      const active = await store.getSetting(`model:active:${symbol}`, null);
      const c = cand ? JSON.parse(cand) : null;
      models.push({ symbol, active: !!active, candidate: c ? { trained_at: c.trained_at, candles: c.candles, metrics: c.metrics, drift: c.drift, importance: c.importance } : null });
    }
    const runsArr = JSON.parse(await store.getSetting('director:runs', '[]'));
    ctx.json(200, { app_version: APP_VERSION, brain_version: Number(await store.getSetting('brain_version', '1')) || 1,
      last_run: Number(await store.getSetting('director_last_run', '0')) || null, agents, guardrails,
      pending: pending.map(parseProposal), history: all.filter((p) => p.status !== 'pending').slice(0, 50).map(parseProposal), models,
      lab: await getLab(store), scanner: await getScanner(store), runs: JSON.parse(await store.getSetting('director:runs', '[]')), changes: JSON.parse(await store.getSetting('brain:changes', '[]')),
      agent_stats: agents.map((ag) => { const mine = all.filter((p) => p.agent === ag.name); const ra = runsArr.flatMap((r) => r.agents.filter((x) => x.agent === ag.name)); return { name: ag.name, label: ag.label, runs: ra.length, errors: ra.filter((x) => x.error).length, created: mine.length, applied: mine.filter((p) => p.status === 'applied').length, rejected: mine.filter((p) => p.status === 'rejected').length, pending: mine.filter((p) => p.status === 'pending').length }; }),
      stats: { applied: all.filter((p) => p.status === 'applied').length, rejected: all.filter((p) => p.status === 'rejected').length, total: all.length } });
  });


  // ----- Lista de lanzamiento comercial (datos reales + pasos manuales que marca el dueño) -----
  const MANUAL = {
    attorney: ['Abogado de Florida revisó Términos, Privacidad y Aviso de riesgo', 'Contrata una revisión (valores, FinCEN/OFR, consumidor). Luego reemplaza los [corchetes] en public/legal.html.', { tab: 'o_seguridad' },
      ['Descarga el "Paquete para abogado" en Seguridad → Cumplimiento y envíaselo.', 'Pídele revisar: Términos, Privacidad, Aviso de riesgo y si necesitas registro o licencia.', 'Cuando te devuelva cambios, reemplaza los [corchetes] de public/legal.html y márcalo como hecho.']],
    exchange_terms: ['Revisé los términos de API de Coinbase y Robinhood para uso comercial', 'Lee sus términos de API; confirma que un software de terceros puede operar cuentas de clientes.', { url: 'https://docs.cdp.coinbase.com' },
      ['Abre la documentación de Coinbase (CDP) y busca los términos de uso de la API.', 'Haz lo mismo con Robinhood Crypto API desde tu cuenta.', 'Confirma que permiten que tu software opere las cuentas de tus clientes con sus propias llaves.']],
    own_live: ['Probé trading real con mi propia cuenta y montos mínimos', 'Activa "trading real" solo para ti, con $10-25, y verifica una compra y una venta.', { tab: 'exchanges' },
      ['Conecta tu propia llave en Exchanges (solo trading).', 'En Ajustes, enciende "Permitir trading REAL" solo mientras pruebas.', 'En Bot usa modo REAL con tope de $10-25 y confirma una compra y una venta en tu exchange.', 'Apaga el trading real si aún no abres al público.']],
    billing: ['Cobros configurados (Stripe)', 'Aún no incluido. Define precio y conecta Stripe antes de cobrar.', { url: 'https://dashboard.stripe.com' },
      ['Crea tu cuenta de Stripe.', 'Define precio y plan.', 'Pídeme la integración de cobros cuando estés listo.']],
    domain: ['Dominio propio y correo de soporte', 'Compra un dominio, apúntalo a Render y define SUPPORT_EMAIL.', { url: 'https://dashboard.render.com' },
      ['Compra un dominio.', 'En Render → tu servicio → Settings → Custom Domains, agrégalo.', 'Define SUPPORT_EMAIL en Environment.']],
    incident: ['Plan de respuesta a incidentes escrito', 'Una página: quién decide, cómo se avisa a clientes y a las autoridades si hay una filtración.', { tab: 'o_seguridad' },
      ['Escribe quién decide y cómo apagas el trading real (Ajustes) y suspendes cuentas (Clientes).', 'Define cómo avisarías a clientes afectados. Pregunta a tu abogado los plazos legales de aviso en Florida.', 'Guárdalo en un lugar seguro y márcalo como hecho.']],
  };
  async function readiness(user) {
    const lab = await getLab(store);
    const clients = (await store.listUsers()).filter((u) => u.role === 'client');
    let legalOpen = true;
    try { legalOpen = /\[[A-ZÁÉÍÓÚÑ ]{4,}\]/.test(fs.readFileSync(path.join(ROOT, 'public', 'legal.html'), 'utf8')); } catch { /* sin archivo */ }
    const auto = [
      ['owner_2fa', 'Verificación en dos pasos del dueño', !!user.totp_secret, 'Ajustes → Activar 2FA.', { tab: 'o_ajustes' }, ['Abre Ajustes y pulsa "Activar 2FA".', 'En Google Authenticator elige "Ingresar clave de configuración" y pega la clave.', 'Escribe el código de 6 dígitos para confirmar.']],
      ['database', 'Base de datos persistente (Postgres)', store.kind === 'pg', 'Define DATABASE_URL; en memoria se pierden los datos.', { url: 'https://dashboard.render.com' }, ['En Render, confirma que existe la base quantum-trading-db.', 'Verifica que DATABASE_URL esté en Environment.', 'La base gratis de Render expira a los 30 días: usa Exportar como respaldo.']],
      ['secrets', 'Secretos de sesión y cifrado definidos', String(env.SESSION_SECRET || '').length >= 32 && String(env.ENCRYPTION_KEY || '').length >= 32, 'SESSION_SECRET y ENCRYPTION_KEY de 32+ caracteres.'],
      ['legal_filled', 'Datos legales completados', !legalOpen, 'Reemplaza los [corchetes] de public/legal.html.', { url: '/legal.html' }, ['Abre la página legal y mira los [corchetes].', 'Reemplaza nombre de la empresa, dirección y correos en public/legal.html (en GitHub).']],
      ['brain_ran', 'El Cerebro ya corrió al menos una vez', (lab.runs || 0) > 0, 'Cerebro → Correr análisis.', { tab: 'o_hoy' }, ['Abre Hoy y pulsa "Correr todo".', 'Espera unos segundos: los agentes leen mercado, entrenan y prueban.']],
      ['lab_forward', 'Laboratorio de papel con 7+ días hacia adelante', Object.values(lab.latest || {}).some((l) => l.candles >= 168), 'Deja correr el laboratorio; el avance se acumula solo.'],
      ['brain_applied', 'Aprobaste al menos una mejora del Cerebro', (Number(await store.getSetting('brain_version', '1')) || 1) > 1, 'Cerebro → revisa y aprueba propuestas.'],
      ['first_client', 'Tienes al menos un cliente real', clients.length > 0, 'Comparte tu landing.'],
    ].map(([id, label, ok, step, go, help]) => ({ id, label, status: ok ? 'ok' : 'todo', manual: false, step, go: go || null, help: help || null }));
    const manual = [];
    for (const [id, [label, step, go, help]] of Object.entries(MANUAL)) manual.push({ id, label, status: (await store.getSetting(`launch:${id}`, 'no')) === 'yes' ? 'ok' : 'todo', manual: true, step, go, help });
    const items = [...auto, ...manual];
    return { items, score: Math.round((items.filter((i) => i.status === 'ok').length / items.length) * 100),
      live_trading: (await store.getSetting('live_trading', 'off')) === 'on', live_scope: await liveScope(), registration_open: (await store.getSetting('registration_open', 'on')) === 'on' };
  }
  route('GET', '/api/owner/readiness', { owner: true }, async (ctx) => ctx.json(200, await readiness(ctx.user)));
  route('PUT', '/api/owner/readiness', { owner: true }, async (ctx) => {
    const { id, done } = ctx.body;
    if (!MANUAL[id]) return ctx.json(400, { error: 'Paso desconocido' });
    await store.setSetting(`launch:${id}`, done === true ? 'yes' : 'no');
    await audit(ctx.req, ctx.user, 'owner_launch_step', `${id}=${done === true}`);
    ctx.json(200, await readiness(ctx.user));
  });


  // ----- Resumen del Director: qué necesita tu atención hoy (sintetiza Cerebro, agentes, mercado, laboratorio, operación y lanzamiento) -----
  route('GET', '/api/owner/briefing', { owner: true }, async (ctx) => {
    const now = Date.now(); const items = [];
    const add = (level, text, tab) => items.push({ level, text, tab });
    const g = await getGuardrails(store);
    const rd = await readiness(ctx.user);
    const lab = await getLab(store);
    const pending = (await store.listProposals('pending', 200)).map(parseProposal);
    const changing = pending.filter((p) => ['strategy_defaults', 'agent_toggle', 'model_update'].includes(p.kind));
    const info = pending.filter((p) => !changing.includes(p));
    const lastRun = Number(await store.getSetting('director_last_run', '0')) || 0;
    const runs = JSON.parse(await store.getSetting('director:runs', '[]'));
    if (!ctx.user.totp_secret) add('crit', 'Activa la verificación en dos pasos (2FA)', 'o_ajustes');
    if (changing.length) add('warn', `${changing.length} propuesta${changing.length > 1 ? 's' : ''} que cambia${changing.length > 1 ? 'n' : ''} algo: decide`, 'o_cerebro');
    if (info.length) add('info', `${info.length} hallazgo${info.length > 1 ? 's' : ''} de los agentes por revisar`, 'o_cerebro');
    if (!lastRun) add('warn', 'Los agentes aún no han corrido: pulsa "Correr todo"', 'o_cerebro');
    else if (now - lastRun > g.autoRunHours * 1.5 * 3600000) add('warn', `El Director no corre desde ${Math.round((now - lastRun) / 3600000)} h`, 'o_cerebro');
    const errs = (runs[0]?.agents || []).filter((a) => a.error);
    if (errs.length) add('warn', `Fallaron ${errs.length} agente${errs.length > 1 ? 's' : ''} en la última corrida: ${errs.map((e) => e.agent).join(', ')}`, 'o_cerebro');
    const todo = rd.items.filter((i) => i.status === 'todo');
    if (todo.length) add(rd.score < 50 ? 'warn' : 'info', `Lanzamiento ${rd.score} %: faltan ${todo.length} pasos (siguiente: ${todo[0].label})`, 'o_launch');
    const snap = JSON.parse(await store.getSetting('market:snapshot', 'null'));
    if (snap) {
      const gl = snap.global || {};
      add('info', `Mercado ${snap.regime.label}${gl.btcDom ? ` · dominancia BTC ${gl.btcDom.toFixed(1)} %` : ''}${gl.mcap24 !== null && gl.mcap24 !== undefined ? ` · 24 h ${gl.mcap24 >= 0 ? '+' : ''}${gl.mcap24.toFixed(1)} %` : ''}`, 'o_cerebro');
    } else add('info', 'Sin datos de mercado todavía (CoinGecko y Coinbase)', 'o_cerebro');
    for (const sym of Object.keys(lab.champions || {})) {
      const l = lab.latest[sym];
      if (l && l.coinbase) add('info', `Laboratorio ${sym} ${lab.champions[sym].label}: ${l.coinbase.ret >= 0 ? '+' : ''}${l.coinbase.ret.toFixed(2)} % vs ${l.coinbase.bh >= 0 ? '+' : ''}${l.coinbase.bh.toFixed(2)} % comprar y mantener (${(l.candles / 24).toFixed(1)} d)`, 'o_cerebro');
    }
    const orders = await store.listAllOrdersSince(now - DAY);
    const ev = await store.listAuditSince(now - DAY);
    const oerr = orders.filter((o) => o.status === 'error').length;
    if (oerr) add('warn', `${oerr} orden${oerr > 1 ? 'es' : ''} con error en 24 h`, 'o_seguridad');
    const fails = ev.filter((e) => e.action === 'login_fail').length;
    if (fails >= 10) add('warn', `${fails} intentos de login fallidos en 24 h`, 'o_seguridad');
    if (!(await store.listConnections(ctx.user.id)).length) add('info', 'Conecta tu propio Robinhood o Coinbase para probar tu bot', 'exchanges');
    const clients = (await store.listUsers()).filter((u) => u.role === 'client');
    add('info', `${clients.length} cliente${clients.length === 1 ? '' : 's'} · ${clients.filter((u) => u.created_at >= now - 7 * DAY).length} nuevo(s) en 7 días`, 'o_clientes');
    const rank = { crit: 0, warn: 1, info: 2, ok: 3 };
    items.sort((a, b) => rank[a.level] - rank[b.level]);
    const crit = items.filter((i) => i.level === 'crit').length; const warn = items.filter((i) => i.level === 'warn').length;
    ctx.json(200, { t: now, status: crit ? 'crit' : warn ? 'warn' : 'ok',
      headline: crit ? 'Hay algo urgente' : warn ? `${warn} cosa${warn > 1 ? 's' : ''} por revisar` : 'Todo en orden',
      items, score: rd.score, brain_version: Number(await store.getSetting('brain_version', '1')) || 1, pending: pending.length, last_run: lastRun || null });
  });

  // Marca como "enterado" todos los hallazgos pendientes que NO cambian nada (alertas e insights). Nunca aprueba cambios.
  route('POST', '/api/owner/proposals/ack-info', { owner: true }, async (ctx) => {
    const list = (await store.listProposals('pending', 500)).filter((p) => !['strategy_defaults', 'agent_toggle', 'model_update'].includes(p.kind));
    for (const p of list) await director.approve(p.id, 'enterado (lote)', ctx.user.email);
    await audit(ctx.req, ctx.user, 'owner_ack_info', String(list.length));
    ctx.json(200, { acknowledged: list.length });
  });

  // Mercado: CoinGecko + Coinbase Exchange. Cacheado 5 min; si una fuente falla, se dice, no se inventa.
  route('GET', '/api/market', { auth: true }, async (ctx) => {
    if (!ctx.allow(`mk:${ctx.user.id}`, 60, 3600000)) return ctx.json(429, { error: 'Demasiadas consultas' });
    const m = await market();
    ctx.json(200, { t: m.t, regime: m.regime, global: m.gecko.global || null, coins: m.gecko.coins || [], trending: m.gecko.trending || [],
      books: m.books, sources: m.sources, errors: m.gecko.errors || [],
      note: 'Datos públicos de CoinGecko y Coinbase Exchange. Informativo; no es asesoría.' });
  });


  // ----- Cumplimiento: controles verificados EN VIVO + inventario de datos + proveedores + preguntas para el abogado -----
  async function compliance() {
    const users = await store.listUsers();
    const ea = await store.encryptionAudit();
    const audits = await store.listAuditSince(Date.now() - 30 * DAY);
    const owner = users.find((u) => u.role === 'owner');
    const prod = (env.NODE_ENV || 'development') === 'production';
    const live = [
      ['Llaves API de clientes cifradas en reposo (AES-256-GCM)', ea.encrypted === ea.total, `${ea.encrypted}/${ea.total} llave(s) cifradas`],
      ['Ninguna llave guardada permite retiros', ea.withdraw === 0, `${ea.withdraw} con retiros`],
      ['Contraseñas guardadas solo como huella (scrypt)', users.every((u) => String(u.pass_hash).startsWith('s1$')), `${users.length} cuenta(s)`],
      ['Secreto 2FA del dueño cifrado', !owner || !owner.totp_secret || String(owner.totp_secret).startsWith('v1.'), owner && owner.totp_secret ? '2FA activo' : '2FA no activado'],
      ['2FA obligatorio activo para el dueño', !!(owner && owner.totp_secret), ''],
      ['Clave de cifrado y clave de sesión distintas y largas', String(env.ENCRYPTION_KEY || '').length >= 32 && String(env.SESSION_SECRET || '').length >= 32 && env.ENCRYPTION_KEY !== env.SESSION_SECRET, ''],
      ['Producción: cookies Secure + HSTS', prod, prod ? 'NODE_ENV=production' : 'solo se activan en producción'],
      ['Base de datos persistente', store.kind === 'pg', store.kind],
      ['Registro de auditoría activo (30 días)', audits.length > 0, `${audits.length} eventos`],
    ].map(([label, ok, detail]) => ({ label, ok: !!ok, detail, live: true }));
    const design = [
      'Aislamiento por cliente: cada consulta usa el id de la sesión; no existen rutas que reciban el id de otro cliente (verificado por pruebas automáticas de ataque).',
      'El dueño ve totales; nunca llaves ni órdenes individuales de clientes.',
      'El rol de dueño solo existe para OWNER_EMAIL y no se puede asignar por la API.',
      'Límites de intentos de login, bloqueo temporal de cuenta y protección CSRF.',
      'Trading real apagado por defecto; topes por orden y por día; interruptor global y botón de apagado por cliente.',
      'Software no custodio: nunca mueve ni retiene fondos; rechaza llaves con retiros.',
      'Borrado de cuenta y descarga de datos a pedido del cliente.',
    ].map((label) => ({ label, ok: true, detail: 'control de diseño', live: false }));
    const gaps = [
      'No hay purga automática de la auditoría (política de retención por definir con tu abogado).',
      'No hay verificación de correo ni recuperación de contraseña por correo.',
      'Rotación de ENCRYPTION_KEY es manual (cambiarla invalida las llaves guardadas; los clientes tendrían que reconectar).',
      'Los textos legales son un borrador hasta que los revise un abogado.',
    ];
    const inventory = [
      { dato: 'Correo y huella de contraseña', para: 'Iniciar sesión', cifrado: 'Contraseña: scrypt (no reversible)', ve: 'Solo el cliente (el dueño ve el correo y el estado)' },
      { dato: 'Llaves API del exchange', para: 'Operar la cuenta del cliente', cifrado: 'AES-256-GCM', ve: 'Solo el motor; nadie, ni el dueño, las ve' },
      { dato: 'Órdenes y configuración del bot', para: 'Operar y mostrar resultados', cifrado: 'Base de datos con acceso restringido', ve: 'Solo el cliente (el dueño ve totales)' },
      { dato: 'Registro de auditoría (acción, IP, fecha)', para: 'Seguridad e investigación', cifrado: 'Base de datos con acceso restringido', ve: 'Solo el dueño' },
      { dato: 'Secreto 2FA del dueño', para: 'Proteger la consola del dueño', cifrado: 'AES-256-GCM', ve: 'Nadie' },
    ];
    const vendors = [
      { nombre: 'Render', uso: 'Alojamiento y base de datos Postgres' },
      { nombre: 'Coinbase / Robinhood', uso: 'Ejecutar órdenes del cliente con su propia llave' },
      { nombre: 'CoinGecko / Coinbase Exchange (datos públicos)', uso: 'Precios, mercado y libro de órdenes (sin datos de clientes)' },
    ];
    const questions = [
      '¿El modelo software no custodio, sin recomendaciones personalizadas, evita registrarme como asesor de inversión (SEC u Oficina de Regulación Financiera de Florida)?',
      '¿Necesito licencia de transmisor de dinero (FinCEN / Florida cap. 560) si nunca toco fondos?',
      '¿Qué debo decir y no decir en marketing (FTC, ley de prácticas comerciales engañosas de Florida)?',
      '¿Qué plazos y pasos de aviso de incidente de seguridad aplican en Florida?',
      '¿Cumplen los términos de API de Coinbase y Robinhood con un uso comercial de terceros?',
      '¿Cómo debo manejar impuestos y cobros (Stripe) y la retención de datos?',
    ];
    return { generated_at: Date.now(), live, design, gaps, inventory, vendors, questions,
      score: Math.round((live.filter((x) => x.ok).length / live.length) * 100) };
  }
  route('GET', '/api/owner/compliance', { owner: true }, async (ctx) => ctx.json(200, await compliance()));
  route('GET', '/api/owner/export/compliance', { owner: true }, async (ctx) => {
    const c = await compliance();
    const md = ['# Paquete para abogado — Quantum Trading', `Generado: ${new Date(c.generated_at).toISOString()} · versión ${APP_VERSION}`, '',
      '## Controles verificados en vivo', ...c.live.map((x) => `- [${x.ok ? 'x' : ' '}] ${x.label}${x.detail ? ` — ${x.detail}` : ''}`), '',
      '## Controles de diseño', ...c.design.map((x) => `- ${x.label}`), '',
      '## Brechas conocidas (honestas)', ...c.gaps.map((x) => `- ${x}`), '',
      '## Inventario de datos', ...c.inventory.map((i) => `- **${i.dato}** — para: ${i.para}; cifrado: ${i.cifrado}; quién lo ve: ${i.ve}`), '',
      '## Proveedores', ...c.vendors.map((v) => `- **${v.nombre}**: ${v.uso}`), '',
      '## Preguntas para el abogado', ...c.questions.map((q) => `1. ${q}`), '',
      'Este documento describe controles técnicos; no es asesoría legal.'].join('\n');
    await audit(ctx.req, ctx.user, 'owner_export', 'compliance');
    ctx.res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Content-Disposition': 'attachment; filename="paquete-abogado-quantum-trading.md"', 'Cache-Control': 'no-store' });
    ctx.res.end(md);
  });
  route('POST', '/api/owner/brain/undo', { owner: true }, async (ctx) => {
    try { ctx.json(200, await director.undo(String(ctx.body.id || ''), ctx.user.email)); } catch (e) { ctx.json(e.status || 500, { error: e.message }); }
  });

  route('GET', '/api/owner/director/traces', { owner: true }, async (ctx) => ctx.json(200, { traces: (await director.traces()).slice(0, 20), versions: Object.fromEntries(Object.entries(director.agents).filter(([, a]) => a.available).map(([n, a]) => [n, agentVersion(a)])) }));
  route('POST', '/api/owner/director/replay', { owner: true }, async (ctx) => {
    if (!ctx.allow(`dirreplay:${ctx.user.id}`, 20, 3600000)) return ctx.json(429, { error: 'Demasiadas reproducciones' });
    try { const r = await director.replay(String(ctx.body.trace || ''), String(ctx.body.agent || '')); await audit(ctx.req, ctx.user, 'director_replay', `${ctx.body.agent}`); ctx.json(200, r); }
    catch (e) { ctx.json(e.status || 500, { error: e.message }); }
  });

  route('POST', '/api/owner/brain/run', { owner: true }, async (ctx) => {
    if (!ctx.allow(`brainrun:${ctx.user.id}`, 6, 3600000)) return ctx.json(429, { error: 'Máximo 6 corridas por hora' });
    const summary = await director.run({ trigger: 'owner' });
    await audit(ctx.req, ctx.user, 'owner_brain_run');
    ctx.json(200, { summary });
  });

  route('POST', '/api/owner/proposals/:id/decision', { owner: true }, async (ctx) => {
    const { decision, note } = ctx.body;
    try {
      if (decision === 'approve') ctx.json(200, await director.approve(ctx.params.id, note, ctx.user.email));
      else if (decision === 'reject') { await director.reject(ctx.params.id, note, ctx.user.email); ctx.json(200, { ok: true }); }
      else ctx.json(400, { error: 'Decisión inválida' });
    } catch (e) { ctx.json(e.status || 500, { error: e.message }); }
  });

  route('PUT', '/api/owner/agents/:name', { owner: true }, async (ctx) => {
    try { await director.setAgentEnabled(ctx.params.name, ctx.body.enabled === true, ctx.user.email); ctx.json(200, { ok: true }); }
    catch (e) { ctx.json(e.status || 500, { error: e.message }); }
  });

  route('PUT', '/api/owner/guardrails', { owner: true }, async (ctx) => {
    const g = await setGuardrails(store, ctx.body);
    await audit(ctx.req, ctx.user, 'owner_guardrails', JSON.stringify(g).slice(0, 300));
    ctx.json(200, { guardrails: g });
  });

  route('GET', '/api/owner/export/brain', { owner: true }, async (ctx) => {
    const snap = await brainSnapshot();
    await audit(ctx.req, ctx.user, 'owner_export', `brain v${snap.brain_version}`);
    jsonAttachment(ctx.res, `quantum-brain-v${snap.brain_version}.json`, snap);
  });

  route('GET', '/api/owner/export/app', { owner: true }, async (ctx) => {
    const snap = await brainSnapshot();
    const files = [...collectSource(ROOT), { name: 'quantum-trading/BRAIN.json', data: JSON.stringify(snap, null, 2) }];
    await audit(ctx.req, ctx.user, 'owner_export', `app v${APP_VERSION} brain v${snap.brain_version}`);
    ctx.res.writeHead(200, { 'Content-Type': 'application/gzip', 'Cache-Control': 'no-store',
      'Content-Disposition': `attachment; filename="quantum-app-v${APP_VERSION}-brain${snap.brain_version}.tar.gz"` });
    ctx.res.end(buildTarGz(files));
  });

  route('POST', '/api/owner/2fa/setup', { owner: true }, async (ctx) => {
    const secret = newTotpSecret();
    pending2fa.set(ctx.user.id, { secret, exp: Date.now() + 600000 });
    ctx.json(200, { secret, otpauth: `otpauth://totp/Quantum%20Trading:${encodeURIComponent(ctx.user.email)}?secret=${secret}&issuer=Quantum%20Trading` });
  });

  route('POST', '/api/owner/2fa/enable', { owner: true }, async (ctx) => {
    const p = pending2fa.get(ctx.user.id);
    if (!p || p.exp < Date.now() || !verifyTotp(p.secret, ctx.body.code)) return ctx.json(400, { error: 'Código inválido o expirado' });
    await store.updateUser(ctx.user.id, { totp_secret: sealTotp(p.secret) });
    pending2fa.delete(ctx.user.id);
    await audit(ctx.req, ctx.user, 'owner_2fa_enabled');
    ctx.json(200, { ok: true });
  });


  // ---------- cuentas: verificación de correo, recuperación, 2FA de clientes, dispositivos ----------
  const GENERIC_FORGOT = { ok: true, message: 'Si ese correo tiene una cuenta, te enviamos instrucciones.' };
  route('POST', '/api/auth/forgot', {}, async (ctx) => {
    const em = String(ctx.body.email || '').trim().toLowerCase();
    if (!ctx.allow(`forgot:ip:${ctx.ip}`, 10, 3600000) || (em && !ctx.allow(`forgot:em:${em}`, 3, 3600000))) return ctx.json(429, { error: 'Demasiadas solicitudes. Intenta más tarde.' });
    if (EMAIL_RE.test(em) && em !== ownerEmail) { // el dueño se recupera por variables de entorno, nunca por correo
      const u = await store.getUserByEmail(em);
      if (u && u.status === 'active') { fire(issueMail(u, 'reset')); await audit(ctx.req, u, 'password_reset_requested'); }
    }
    ctx.json(200, GENERIC_FORGOT); // misma respuesta exista o no la cuenta
  });
  route('POST', '/api/auth/reset', {}, async (ctx) => {
    if (!ctx.allow(`reset:ip:${ctx.ip}`, 20, 3600000)) return ctx.json(429, { error: 'Demasiados intentos' });
    const { token, password } = ctx.body;
    if (typeof password !== 'string' || password.length < 10 || password.length > 200) return ctx.json(400, { error: 'La contraseña debe tener al menos 10 caracteres' });
    if (typeof token !== 'string' || token.length < 20 || token.length > 200) return ctx.json(400, { error: 'Enlace inválido o vencido' });
    const t = await store.consumeAuthToken(sha(token), 'reset');
    const u = t && await store.getUserById(t.user_id);
    if (!u || u.status !== 'active' || u.role === 'owner') return ctx.json(400, { error: 'Enlace inválido o vencido' });
    await store.updateUser(u.id, { pass_hash: await hashPassword(password), failed: 0, locked_until: 0, email_verified_at: u.email_verified_at || Date.now() });
    await store.bumpSv(u.id); await store.revokeSessions(u.id);
    await audit(ctx.req, u, 'password_reset_done');
    fire(mailer.send({ to: u.email, subject: 'Tu contraseña cambió — RDCMNATION QUANTUM', text: 'La contraseña de tu cuenta se cambió y se cerraron todas tus sesiones. Si no fuiste tú, usa «Olvidé mi contraseña» y escríbenos de inmediato.' }));
    ctx.json(200, { ok: true });
  });
  route('POST', '/api/auth/verify-email/send', { auth: true }, async (ctx) => {
    if (ctx.user.email_verified_at) return ctx.json(200, { ok: true, already: true });
    if (!ctx.allow(`vsend:${ctx.user.id}`, 3, 3600000)) return ctx.json(429, { error: 'Ya pediste varios correos. Espera una hora.' });
    const r = await issueMail(ctx.user, 'verify');
    await audit(ctx.req, ctx.user, 'verify_email_requested', r.sent ? 'enviado' : 'sin proveedor');
    ctx.json(200, { ok: true, sent: r.sent, ...(r.sent ? {} : { warning: 'El envío de correo no está configurado en este servidor. Escríbenos y verificamos tu cuenta a mano.' }) });
  });
  route('POST', '/api/auth/verify-email', {}, async (ctx) => {
    if (!ctx.allow(`vmail:ip:${ctx.ip}`, 30, 3600000)) return ctx.json(429, { error: 'Demasiados intentos' });
    const token = ctx.body.token;
    if (typeof token !== 'string' || token.length < 20 || token.length > 200) return ctx.json(400, { error: 'Enlace inválido o vencido' });
    const t = await store.consumeAuthToken(sha(token), 'verify');
    const u = t && await store.getUserById(t.user_id);
    if (!u) return ctx.json(400, { error: 'Enlace inválido o vencido' });
    await store.updateUser(u.id, { email_verified_at: Date.now() });
    await audit(ctx.req, u, 'email_verified');
    ctx.json(200, { ok: true });
  });

  // 2FA opcional para clientes (obligatorio para el dueño, ver /api/owner/2fa). Al activarlo se entregan 8 códigos de respaldo, una sola vez.
  route('POST', '/api/me/2fa/setup', { auth: true }, async (ctx) => {
    if (ctx.user.role === 'owner') return ctx.json(400, { error: 'El dueño usa Ajustes → 2FA de la consola.' });
    if (ctx.user.totp_secret) return ctx.json(400, { error: 'Ya tienes 2FA activo.' });
    if (!ctx.allow(`2fa:${ctx.user.id}`, 10, 900000)) return ctx.json(429, { error: 'Demasiados intentos' });
    if (!(await verifyPassword(String(ctx.body.password || ''), ctx.user.pass_hash))) return ctx.json(400, { error: 'La contraseña no coincide' });
    const secret = newTotpSecret();
    pending2fa.set(ctx.user.id, { secret, exp: Date.now() + 600000 });
    ctx.json(200, { secret, otpauth: `otpauth://totp/Quantum%20Trading:${encodeURIComponent(ctx.user.email)}?secret=${secret}&issuer=Quantum%20Trading` });
  });
  route('POST', '/api/me/2fa/enable', { auth: true }, async (ctx) => {
    if (ctx.user.role === 'owner' || ctx.user.totp_secret) return ctx.json(400, { error: 'No aplica' });
    if (!ctx.allow(`2fa:${ctx.user.id}`, 10, 900000)) return ctx.json(429, { error: 'Demasiados intentos' });
    const p = pending2fa.get(ctx.user.id);
    if (!p || p.exp < Date.now() || !verifyTotp(p.secret, ctx.body.code)) return ctx.json(400, { error: 'Código inválido o expirado' });
    const codes = makeRecoveryCodes();
    await store.updateUser(ctx.user.id, { totp_secret: sealTotp(p.secret), recovery_codes: JSON.stringify(codes.map(sha)) });
    pending2fa.delete(ctx.user.id);
    await store.revokeSessions(ctx.user.id, ctx.user.sid || null);
    await audit(ctx.req, ctx.user, 'mfa_enabled');
    ctx.json(200, { ok: true, recovery_codes: codes, note: 'Guárdalos ahora: no se vuelven a mostrar. Cada uno sirve una sola vez.' });
  });
  route('POST', '/api/me/2fa/disable', { auth: true }, async (ctx) => {
    if (ctx.user.role === 'owner') return ctx.json(400, { error: 'El 2FA del dueño es obligatorio.' });
    if (!ctx.user.totp_secret) return ctx.json(400, { error: 'No tienes 2FA activo.' });
    if (!ctx.allow(`2fa:${ctx.user.id}`, 10, 900000)) return ctx.json(429, { error: 'Demasiados intentos' });
    if (!(await verifyPassword(String(ctx.body.password || ''), ctx.user.pass_hash)) || !verifyTotp(openTotp(ctx.user.totp_secret), ctx.body.code)) return ctx.json(400, { error: 'Contraseña o código incorrectos' });
    await store.updateUser(ctx.user.id, { totp_secret: null, recovery_codes: null });
    await store.revokeSessions(ctx.user.id, ctx.user.sid || null);
    await audit(ctx.req, ctx.user, 'mfa_disabled');
    ctx.json(200, { ok: true });
  });

  // Dispositivos / sesiones: cada usuario ve y revoca SOLO las suyas (la consulta siempre filtra por user_id).
  route('GET', '/api/me/sessions', { auth: true }, async (ctx) => {
    const list = await store.listSessions(ctx.user.id);
    ctx.json(200, { sessions: list.map((x) => ({ id: x.id, created_at: x.created_at, last_seen: x.last_seen, ip: x.ip, ua: x.ua, current: x.id === ctx.user.sid })) });
  });
  route('POST', '/api/me/sessions/revoke', { auth: true }, async (ctx) => {
    const ok = await store.revokeSession(ctx.user.id, String(ctx.body.id || ''));
    if (!ok) return ctx.json(404, { error: 'Sesión no encontrada' });
    await audit(ctx.req, ctx.user, 'session_revoked');
    ctx.json(200, { ok: true });
  });
  route('POST', '/api/me/sessions/revoke-others', { auth: true }, async (ctx) => {
    const n = await store.revokeSessions(ctx.user.id, ctx.user.sid || null);
    await audit(ctx.req, ctx.user, 'sessions_revoked_others', `n=${n}`);
    ctx.json(200, { ok: true, revoked: n });
  });
  // Soporte: el dueño puede marcar un correo como verificado a mano (queda auditado) cuando aún no hay proveedor de correo.
  route('POST', '/api/owner/users/:id/verify-email', { owner: true }, async (ctx) => {
    const u = await store.getUserById(ctx.params.id);
    if (!u) return ctx.json(404, { error: 'Usuario no encontrado' });
    await store.updateUser(u.id, { email_verified_at: Date.now() });
    await audit(ctx.req, ctx.user, 'owner_verified_email', `user=${u.id}`);
    ctx.json(200, { ok: true });
  });


  // ---------- planes y facturación ----------
  const stripeOn = () => !!(env.STRIPE_SECRET_KEY && env.STRIPE_WEBHOOK_SECRET && Object.keys(priceMap(env)).some(Boolean));
  const publicPlans = () => Object.entries(PLANS).map(([id, p]) => ({ id, label: p.label, priceUsdMonth: p.priceUsdMonth, priceIsProposal: p.proposed, live: p.live, maxOrderUsd: p.maxOrderUsd, maxDailyUsd: p.maxDailyUsd, maxConnections: p.maxConnections, blurb: p.blurb }));
  route('GET', '/api/billing', { auth: true }, async (ctx) => {
    const ent = await entitlement(store, ctx.user); const sub = await store.getSubscription(ctx.user.id);
    ctx.json(200, { plans: publicPlans(), current: { plan: ent.plan, status: ent.status, live: ent.live, caps: ent.caps, period_end: ent.period_end || null, cancel_at_period_end: !!(sub && sub.cancel_at_period_end), reason: ent.reason },
      enforced: ent.enforced, checkout_available: stripeOn(), trialDays: TRIAL_DAYS,
      note: 'Los precios son propuestas en validación. El cobro lo gestiona el procesador de pagos; esta app no guarda datos de tarjeta.' });
  });
  route('POST', '/api/billing/checkout', { auth: true }, async (ctx) => {
    if (!stripeOn()) return ctx.json(503, { error: 'El cobro en línea todavía no está activado. Escríbenos para contratar un plan.' });
    if (!ctx.allow(`co:${ctx.user.id}`, 10, 3600000)) return ctx.json(429, { error: 'Demasiados intentos' });
    const plan = String(ctx.body.plan || '');
    if (!PAID.includes(plan)) return ctx.json(400, { error: 'Plan inválido' });
    const price = Object.entries(priceMap(env)).find(([k, v]) => k && v === plan);
    if (!price) return ctx.json(503, { error: 'Ese plan aún no está configurado para cobro.' });
    const sub = await store.getSubscription(ctx.user.id);
    try {
      const sess = await stripeCall(env, fetchFn, 'checkout/sessions', { mode: 'subscription', 'line_items[0][price]': price[0], 'line_items[0][quantity]': 1,
        success_url: `${siteUrl()}/app#billing=return`, cancel_url: `${siteUrl()}/app#billing=cancel`, client_reference_id: ctx.user.id,
        ...(sub && sub.provider_customer ? { customer: sub.provider_customer } : { customer_email: ctx.user.email }), 'subscription_data[metadata][user_id]': ctx.user.id });
      await audit(ctx.req, ctx.user, 'billing_checkout_started', plan);
      ctx.json(200, { url: sess.url });
    } catch (e) { log.error?.(`checkout: ${String(e.message).slice(0, 120)}`); ctx.json(502, { error: 'No se pudo iniciar el pago. Intenta de nuevo.' }); }
  });
  route('POST', '/api/billing/portal', { auth: true }, async (ctx) => {
    const sub = await store.getSubscription(ctx.user.id);
    if (!stripeOn() || !sub || !sub.provider_customer) return ctx.json(400, { error: 'No hay una suscripción de pago que administrar.' });
    try { const r = await stripeCall(env, fetchFn, 'billing_portal/sessions', { customer: sub.provider_customer, return_url: `${siteUrl()}/app` }); ctx.json(200, { url: r.url }); }
    catch (e) { ctx.json(502, { error: 'No se pudo abrir el portal de pagos.' }); }
  });
  // Webhook: SIN cookie ni CSRF; se autentica con la firma sobre el cuerpo crudo. Un redireccionamiento de «pago exitoso» nunca activa un plan.
  route('POST', '/api/billing/webhook/stripe', { raw: true }, async (ctx) => {
    if (!env.STRIPE_WEBHOOK_SECRET) return ctx.json(503, { error: 'Webhook no configurado' });
    if (!ctx.allow(`wh:${ctx.ip}`, 600, 60000)) return ctx.json(429, { error: 'Demasiadas solicitudes' });
    if (!verifyStripeSignature(ctx.raw, ctx.req.headers['stripe-signature'], env.STRIPE_WEBHOOK_SECRET)) { await audit(ctx.req, null, 'billing_webhook_bad_signature'); return ctx.json(400, { error: 'Firma inválida' }); }
    try {
      const r = await applyStripeEvent({ store, env, event: ctx.body, audit: (a) => store.addAudit({ actor: 'billing', ip: ctx.ip, ...a }) });
      ctx.json(200, { received: true, result: r.status });
    } catch (e) { log.error?.(`webhook: ${String(e.message).slice(0, 120)}`); ctx.json(500, { error: 'Error procesando el evento' }); } // Stripe reintenta
  });
  route('GET', '/api/owner/billing', { owner: true }, async (ctx) => {
    const subs = await store.listSubscriptions(); const users = await store.listUsers(); const hooks = await store.listWebhooks(30);
    const by = {}; for (const u of users.filter((x) => x.role !== 'owner')) { const e = await entitlement(store, u); const k = `${e.plan}/${e.status}`; by[k] = (by[k] || 0) + 1; }
    ctx.json(200, { enforce: (await store.getSetting('billing_enforce', 'off')) === 'on', stripe_configured: stripeOn(), mail: mailer.provider, by_plan: by, paid_active: subs.filter((x) => x.status === 'active').length,
      past_due: subs.filter((x) => x.status === 'past_due').length, webhooks: hooks.map((h) => ({ id: h.id.slice(0, 14), type: h.type, status: h.status, detail: h.detail, attempts: h.attempts, at: h.received_at })),
      failed_webhooks: hooks.filter((h) => h.status === 'failed').length, plans: publicPlans() });
  });
  route('PUT', '/api/owner/billing', { owner: true }, async (ctx) => {
    if (typeof ctx.body.enforce !== 'boolean') return ctx.json(400, { error: 'enforce debe ser true o false' });
    await store.setSetting('billing_enforce', ctx.body.enforce ? 'on' : 'off');
    await audit(ctx.req, ctx.user, 'billing_enforce', String(ctx.body.enforce));
    ctx.json(200, { ok: true, enforce: ctx.body.enforce });
  });
  // Concesión manual (pilotos, soporte). Queda auditada; solo planes y estados conocidos.
  route('POST', '/api/owner/users/:id/plan', { owner: true }, async (ctx) => {
    const u = await store.getUserById(ctx.params.id); if (!u || u.role === 'owner') return ctx.json(404, { error: 'Usuario no encontrado' });
    const plan = String(ctx.body.plan || ''); const status = String(ctx.body.status || 'active');
    if (!PLANS[plan] || !['active', 'past_due', 'ended'].includes(status)) return ctx.json(400, { error: 'Plan o estado inválido' });
    const days = Math.min(Math.max(Number(ctx.body.days) || 30, 1), 365);
    await store.upsertSubscription(u.id, { plan, status, provider: 'manual', current_period_end: Date.now() + days * 86400000, event_at: null });
    await audit(ctx.req, ctx.user, 'owner_set_plan', `user=${u.id} ${plan}/${status} ${days}d`);
    ctx.json(200, { ok: true });
  });
  // Soporte con acceso LIMITADO y auditado: solo resumen operativo, nunca llaves, contraseñas ni secretos. Cada consulta deja rastro.
  route('GET', '/api/owner/users/:id/support', { owner: true }, async (ctx) => {
    const u = await store.getUserById(ctx.params.id); if (!u || u.role === 'owner') return ctx.json(404, { error: 'Usuario no encontrado' });
    await audit(ctx.req, ctx.user, 'support_view', `user=${u.id}`);
    const ent = await entitlement(store, u); const bot = await store.getBot(u.id); const orders = await store.listOrders(u.id, 20);
    ctx.json(200, { user: { id: u.id, email: u.email, status: u.status, created_at: u.created_at, last_login: u.last_login, email_verified: !!u.email_verified_at, mfa: !!u.totp_secret },
      plan: { plan: ent.plan, status: ent.status, live: ent.live }, bot: bot ? { state: bot.state, mode: bot.cfg.mode, enabled: !!bot.cfg.enabled, symbol: bot.cfg.symbol, errors: bot.errors, last_run: bot.last_run } : null,
      connections: (await store.listConnections(u.id)).map((c) => ({ exchange: c.exchange, status: c.status, can_trade: c.can_trade })),
      recent_orders: orders.map((o) => ({ at: o.created_at, mode: o.mode, symbol: o.symbol, side: o.side, usd: o.usd, status: o.status, lifecycle: o.lifecycle })),
      note: 'Vista de soporte: sin llaves ni credenciales. Esta consulta quedó registrada en auditoría.' });
  });

  // ---------- servidor de archivos estáticos ----------
  function serveStatic(req, res, pathname) {
    const rel = pathname === '/' ? 'landing.html' : pathname === '/app' ? 'index.html' : pathname.replace(/^\/+/, '');
    const file = path.normalize(path.join(PUBLIC, rel));
    if (!file.startsWith(PUBLIC + path.sep) && file !== PUBLIC) { res.writeHead(403); return res.end('Forbidden'); }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(data);
    });
  }

  const SEC_HEADERS = {
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; media-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'",
    'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Resource-Policy': 'same-origin', 'X-Permitted-Cross-Domain-Policies': 'none',
    'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(self), geolocation=()',
    ...(prod ? { 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains' } : {}),
  };

  // Registro estructurado (una línea JSON por petición) con ID de petición. Nunca registra cuerpos, cabeceras, cookies ni la query.
  const reqLog = prod ? env.LOG_REQUESTS !== 'off' : env.LOG_REQUESTS === 'on';
  async function handler(req, res) {
    const t0 = Date.now();
    const given = String(req.headers['x-request-id'] || ''); const rid = /^[A-Za-z0-9._-]{8,64}$/.test(given) ? given : crypto.randomUUID();
    res.setHeader('X-Request-Id', rid); req.rid = rid;
    res.on('finish', () => {
      const ms = Date.now() - t0; const cls = `${Math.floor(res.statusCode / 100)}xx`; if (metrics.req[cls] !== undefined) metrics.req[cls]++; metrics.ms += ms;
      if (reqLog) console.log(JSON.stringify({ t: new Date().toISOString(), level: res.statusCode >= 500 ? 'error' : 'info', rid, method: req.method, path: String(req.url).split('?')[0].slice(0, 120), status: res.statusCode, ms, uid: req.uid || undefined }));
    });
    for (const [k, v] of Object.entries(SEC_HEADERS)) res.setHeader(k, v);
    const url = new URL(req.url, 'http://x');
    const pathname = url.pathname;
    try {
      if (!pathname.startsWith('/api/')) {
        if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
        return serveStatic(req, res, pathname);
      }
      // Protección CSRF: las peticiones que cambian datos exigen este encabezado (la cookie es SameSite=Strict).
      if (!['GET', 'HEAD'].includes(req.method) && req.headers['x-requested-with'] !== 'qt' && pathname !== '/api/billing/webhook/stripe') { // el webhook no usa cookies: se autentica solo con la firma del proveedor
        return send(res, 403, { error: 'Solicitud no permitida' });
      }
      const r = routes.find((x) => x.method === (req.method === 'HEAD' ? 'GET' : req.method) && x.re.test(pathname));
      if (!r) return send(res, 404, { error: 'No encontrado' });
      const m = pathname.match(r.re);
      const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      const ctx = { req, res, params, query: url.searchParams, ip: ipOf(req), user: null, body: {},
        allow: limiter, json: (s, o) => send(res, s, o) };
      if (r.opts.auth || r.opts.owner) {
        ctx.user = await currentUser(req);
        if (!ctx.user) return send(res, 401, { error: 'Inicia sesión' });
        req.uid = ctx.user.id;
        if (r.opts.owner && (ctx.user.role !== 'owner' || ctx.user.email !== ownerEmail)) {
          await audit(req, ctx.user, 'owner_denied', pathname);
          return send(res, 403, { error: 'Solo el dueño' });
        }
        if (r.opts.owner && !ctx.user.totp_secret && !pathname.startsWith('/api/owner/2fa/')) {
          return send(res, 403, { error: 'Activa la verificación en dos pasos (2FA) para usar la consola del dueño.', need_2fa_setup: true });
        }
      }
      if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
        try {
          if (r.opts.raw) { ctx.raw = await readRaw(req, 300000); ctx.body = ctx.raw.length ? JSON.parse(ctx.raw.toString()) : {}; }
          else ctx.body = await readBody(req);
        } catch { return send(res, 400, { error: 'Cuerpo inválido' }); }
      }
      await r.handler(ctx);
    } catch (e) {
      metrics.errors++; log.error(JSON.stringify({ level: 'error', rid, method: req.method, path: pathname.slice(0, 120), msg: String(e.message).slice(0, 200) }));
      if (!res.headersSent) send(res, 500, { error: 'Error interno' });
    }
  }

  return { handler, bootstrap: async () => { await bootstrap(); readyFlag.v = true; }, engine, mailer, idle: () => Promise.allSettled([...bg]) };
}
