// API HTTP (sin frameworks). Reglas de seguridad principales:
//  - El rol "owner" solo existe para OWNER_EMAIL (variable de entorno); nunca se asigna por la API.
//  - Todo dato de cliente se consulta SIEMPRE con el id de la sesión: un cliente no puede ver a otro.
//  - El dueño ve solo agregados y estados; jamás las llaves API ni las órdenes individuales de clientes.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  hashPassword, verifyPassword, signSession, readSession, encrypt, decrypt,
  newTotpSecret, verifyTotp, createLimiter,
} from './security.js';
import { validateCfg, DEFAULT_CFG } from './strategy.js';
import { SYMBOLS } from './exchanges.js';
import { backtest } from './backtest.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const TOS_VERSION = '2026-10-11';
const DAY = 86400000;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;

export function buildBotBundle() {
  const strip = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8')
    .replace(/^import .*$/gm, '').replace(/^export (async function|function|const|let|class)/gm, '$1');
  return [
    '#!/usr/bin/env node',
    '// Quantum Bot (descargable). Modo papel por defecto. No es asesoría financiera.',
    "import crypto from 'node:crypto';",
    "import fs from 'node:fs';",
    strip('lib/exchanges.js'), strip('lib/strategy.js'), strip('bot/runner.js'),
  ].join('\n');
}

export function createApp({ store, env, adapters, feed, engine, log = console }) {
  const limiter = createLimiter();
  const prod = env.NODE_ENV === 'production';
  const ownerEmail = (env.OWNER_EMAIL || '').trim().toLowerCase();
  const hardMaxOrder = Number(env.HARD_MAX_ORDER_USD) || 250;
  const hardMaxDaily = Number(env.HARD_MAX_DAILY_USD) || 1000;
  const pending2fa = new Map();
  const dummyHashPromise = hashPassword('x'.repeat(16));

  // ---------- utilidades ----------
  const ipOf = (req) => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
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
  const cookies = (req) => Object.fromEntries(String(req.headers.cookie || '').split(';').map((p) => p.trim().split('=')).filter((p) => p[0]).map(([k, ...v]) => [k, v.join('=')]));
  const setCookie = (token, maxAge) =>
    `qt_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${prod ? '; Secure' : ''}`;
  const publicUser = (u) => ({ id: u.id, email: u.email, role: u.role, status: u.status, created_at: u.created_at,
    totp: !!u.totp_secret });
  const audit = (req, user, action, detail = '') =>
    store.addAudit({ user_id: user ? user.id : null, actor: user ? user.email : null, action, ip: ipOf(req), detail });

  async function currentUser(req) {
    const s = readSession(env.SESSION_SECRET, cookies(req).qt_session);
    if (!s) return null;
    const u = await store.getUserById(s.uid);
    if (!u || u.status !== 'active' || u.sv !== s.sv) return null;
    return u;
  }
  async function startSession(res, u) {
    const token = signSession(env.SESSION_SECRET, { uid: u.id, sv: u.sv, exp: Date.now() + 12 * 3600000 });
    res.setHeader('Set-Cookie', setCookie(token, 12 * 3600));
  }

  // ---------- arranque: dueño y esquema ----------
  async function bootstrap() {
    await store.init();
    if (!ownerEmail || !env.OWNER_PASSWORD) {
      log.warn('OWNER_EMAIL / OWNER_PASSWORD no definidos: el menú de dueño está desactivado.');
      return;
    }
    let o = await store.getUserByEmail(ownerEmail);
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
      if (u.role === 'owner' && u.email !== ownerEmail) await store.updateUser(u.id, { role: 'client' });
    }
  }

  // ---------- rutas ----------
  const routes = [];
  const route = (method, pattern, opts, handler) => {
    const keys = [];
    const re = new RegExp(`^${pattern.replace(/:([a-z]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; })}$`);
    routes.push({ method, re, keys, opts, handler });
  };

  route('GET', '/api/health', {}, async (ctx) => {
    ctx.json(200, { status: 'ok', version: '13.0.0', database: store.kind, owner_enabled: !!ownerEmail && !!env.OWNER_PASSWORD });
  });

  route('POST', '/api/auth/register', {}, async (ctx) => {
    const { email, password, acceptTos } = ctx.body;
    if (!ctx.allow(`reg:${ctx.ip}`, Number(env.REG_LIMIT_PER_HOUR) || 5, 3600000)) return ctx.json(429, { error: 'Demasiados registros. Intenta más tarde.' });
    if ((await store.getSetting('registration_open', 'on')) !== 'on') return ctx.json(403, { error: 'Registro cerrado por el momento.' });
    const em = String(email || '').trim().toLowerCase();
    if (!EMAIL_RE.test(em)) return ctx.json(400, { error: 'Correo inválido' });
    if (typeof password !== 'string' || password.length < 10 || password.length > 200) return ctx.json(400, { error: 'La contraseña debe tener al menos 10 caracteres' });
    if (acceptTos !== true) return ctx.json(400, { error: 'Debes aceptar los Términos, la Privacidad y el aviso de riesgo' });
    if (em === ownerEmail || (await store.getUserByEmail(em))) return ctx.json(409, { error: 'No se pudo crear la cuenta con ese correo' });
    const u = await store.createUser({ email: em, pass_hash: await hashPassword(password), role: 'client', tos_version: TOS_VERSION });
    await audit(ctx.req, u, 'register');
    await startSession(ctx.res, u);
    ctx.json(201, { user: publicUser(u) });
  });

  route('POST', '/api/auth/login', {}, async (ctx) => {
    const em = String(ctx.body.email || '').trim().toLowerCase();
    const password = String(ctx.body.password || '');
    if (!ctx.allow(`login:ip:${ctx.ip}`, 20, 900000) || !ctx.allow(`login:em:${em}`, 8, 900000)) {
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
    if (u.role === 'owner' && u.totp_secret) {
      if (!ctx.body.totp) return ctx.json(401, { error: 'Código 2FA requerido', need_totp: true });
      if (!verifyTotp(u.totp_secret, ctx.body.totp)) {
        await audit(ctx.req, u, 'login_fail', '2fa');
        return ctx.json(401, { error: 'Código 2FA inválido', need_totp: true });
      }
    }
    await store.updateUser(u.id, { failed: 0, locked_until: 0, last_login: Date.now() });
    await audit(ctx.req, u, 'login_ok');
    await startSession(ctx.res, u);
    ctx.json(200, { user: publicUser(u) });
  });

  route('POST', '/api/auth/logout', { auth: true }, async (ctx) => {
    await store.bumpSv(ctx.user.id);
    await audit(ctx.req, ctx.user, 'logout');
    ctx.res.setHeader('Set-Cookie', setCookie('', 0));
    ctx.json(200, { ok: true });
  });

  route('GET', '/api/me', { auth: true }, async (ctx) => {
    const live = (await store.getSetting('live_trading', 'off')) === 'on';
    ctx.json(200, { user: publicUser(ctx.user), liveTradingEnabled: live, symbols: SYMBOLS,
      limits: { hardMaxOrder, hardMaxDaily }, tosVersion: TOS_VERSION });
  });

  // ----- Exchanges del cliente -----
  route('GET', '/api/connections', { auth: true }, async (ctx) => {
    ctx.json(200, { connections: await store.listConnections(ctx.user.id) });
  });

  route('POST', '/api/connections', { auth: true }, async (ctx) => {
    const { exchange, label, keyId, secret } = ctx.body;
    const adapter = adapters[exchange];
    if (!adapter) return ctx.json(400, { error: 'Exchange no soportado' });
    if (!keyId || !secret || String(keyId).length > 300 || String(secret).length > 5000) return ctx.json(400, { error: 'Faltan datos de la llave' });
    if (!ctx.allow(`conn:${ctx.user.id}`, 10, 3600000)) return ctx.json(429, { error: 'Demasiados intentos' });
    let chk;
    try { chk = await adapter.check({ keyId: String(keyId).trim(), secret: String(secret) }); }
    catch (e) { return ctx.json(400, { error: `Llave inválida: ${e.message}` }); }
    if (!chk.ok) return ctx.json(400, { error: chk.error });
    if (!chk.canTrade) return ctx.json(400, { error: 'La llave no tiene permiso de trading. Crea una con permiso de ver y operar.' });
    if (chk.canTransfer) return ctx.json(400, { error: 'RECHAZADA: la llave permite retiros/transferencias. Crea una llave SOLO de trading (sin retiros).' });
    const c = await store.addConnection({ user_id: ctx.user.id, exchange, label: String(label || adapter.label).slice(0, 60),
      key_id: String(keyId).trim(), secret_enc: encrypt(env.ENCRYPTION_KEY, String(secret)),
      can_trade: !!chk.canTrade, can_transfer: !!chk.canTransfer });
    await audit(ctx.req, ctx.user, 'connection_add', exchange);
    const { secret_enc, ...safe } = c;
    ctx.json(201, { connection: safe });
  });

  route('GET', '/api/connections/:id/balances', { auth: true }, async (ctx) => {
    const c = await store.getConnection(ctx.user.id, ctx.params.id);
    if (!c) return ctx.json(404, { error: 'No encontrada' });
    try {
      const b = await adapters[c.exchange].balances({ keyId: c.key_id, secret: decrypt(env.ENCRYPTION_KEY, c.secret_enc) });
      ctx.json(200, { balances: b });
    } catch (e) { ctx.json(502, { error: e.message }); }
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
    ctx.json(200, { cfg: b ? b.cfg : DEFAULT_CFG, last_run: b ? b.last_run : 0 });
  });

  route('PUT', '/api/bot', { auth: true }, async (ctx) => {
    const v = validateCfg(ctx.body, { hardMaxOrder, hardMaxDaily, symbols: SYMBOLS });
    if (!v.ok) return ctx.json(400, { error: v.error });
    const cfg = v.cfg;
    if (cfg.mode === 'live' && cfg.enabled) {
      if ((await store.getSetting('live_trading', 'off')) !== 'on') return ctx.json(403, { error: 'El trading real aún no está habilitado por la plataforma. Usa modo papel.' });
      if (!cfg.liveAck) return ctx.json(400, { error: 'Debes confirmar que entiendes el riesgo de perder dinero.' });
      const c = cfg.connectionId ? await store.getConnection(ctx.user.id, cfg.connectionId) : null;
      if (!c) return ctx.json(400, { error: 'Elige una conexión de exchange para operar en real.' });
      if (!c.can_trade || c.can_transfer) return ctx.json(400, { error: 'La conexión no es válida para trading real.' });
    }
    if (cfg.connectionId && !(await store.getConnection(ctx.user.id, cfg.connectionId))) cfg.connectionId = null;
    await store.saveBot(ctx.user.id, cfg);
    await audit(ctx.req, ctx.user, cfg.mode === 'live' && cfg.enabled ? 'bot_live_enable' : 'bot_update', `${cfg.strategy} ${cfg.symbol} ${cfg.mode}`);
    ctx.json(200, { cfg });
  });

  route('POST', '/api/bot/kill', { auth: true }, async (ctx) => {
    const b = await store.getBot(ctx.user.id);
    if (b) await store.patchBot(ctx.user.id, { cfg: { ...b.cfg, enabled: false } });
    await audit(ctx.req, ctx.user, 'bot_kill');
    ctx.json(200, { ok: true });
  });

  route('POST', '/api/backtest', { auth: true }, async (ctx) => {
    if (!ctx.allow(`bt:${ctx.user.id}`, 20, 3600000)) return ctx.json(429, { error: 'Demasiadas pruebas. Intenta más tarde.' });
    const v = validateCfg({ ...ctx.body, mode: 'paper' }, { hardMaxOrder, hardMaxDaily, symbols: SYMBOLS });
    if (!v.ok) return ctx.json(400, { error: v.error });
    try {
      const closes = await feed.getCloses(v.cfg.symbol);
      ctx.json(200, backtest(closes, v.cfg));
    } catch (e) { ctx.json(502, { error: e.message }); }
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

  route('GET', '/api/owner/settings', { owner: true }, async (ctx) => {
    ctx.json(200, { live_trading: (await store.getSetting('live_trading', 'off')) === 'on',
      registration_open: (await store.getSetting('registration_open', 'on')) === 'on' });
  });

  route('PUT', '/api/owner/settings', { owner: true }, async (ctx) => {
    if (typeof ctx.body.live_trading === 'boolean') await store.setSetting('live_trading', ctx.body.live_trading ? 'on' : 'off');
    if (typeof ctx.body.registration_open === 'boolean') await store.setSetting('registration_open', ctx.body.registration_open ? 'on' : 'off');
    await audit(ctx.req, ctx.user, 'owner_settings', JSON.stringify(ctx.body).slice(0, 200));
    ctx.json(200, { ok: true });
  });

  route('POST', '/api/owner/2fa/setup', { owner: true }, async (ctx) => {
    const secret = newTotpSecret();
    pending2fa.set(ctx.user.id, { secret, exp: Date.now() + 600000 });
    ctx.json(200, { secret, otpauth: `otpauth://totp/Quantum%20Trading:${encodeURIComponent(ctx.user.email)}?secret=${secret}&issuer=Quantum%20Trading` });
  });

  route('POST', '/api/owner/2fa/enable', { owner: true }, async (ctx) => {
    const p = pending2fa.get(ctx.user.id);
    if (!p || p.exp < Date.now() || !verifyTotp(p.secret, ctx.body.code)) return ctx.json(400, { error: 'Código inválido o expirado' });
    await store.updateUser(ctx.user.id, { totp_secret: p.secret });
    pending2fa.delete(ctx.user.id);
    await audit(ctx.req, ctx.user, 'owner_2fa_enabled');
    ctx.json(200, { ok: true });
  });

  // ---------- servidor de archivos estáticos ----------
  function serveStatic(req, res, pathname) {
    const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const file = path.normalize(path.join(PUBLIC, rel));
    if (!file.startsWith(PUBLIC + path.sep) && file !== PUBLIC) { res.writeHead(403); return res.end('Forbidden'); }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(data);
    });
  }

  const SEC_HEADERS = {
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    ...(prod ? { 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains' } : {}),
  };

  async function handler(req, res) {
    for (const [k, v] of Object.entries(SEC_HEADERS)) res.setHeader(k, v);
    const url = new URL(req.url, 'http://x');
    const pathname = url.pathname;
    try {
      if (!pathname.startsWith('/api/')) {
        if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
        return serveStatic(req, res, pathname);
      }
      // Protección CSRF: las peticiones que cambian datos exigen este encabezado (la cookie es SameSite=Strict).
      if (!['GET', 'HEAD'].includes(req.method) && req.headers['x-requested-with'] !== 'qt') {
        return send(res, 403, { error: 'Solicitud no permitida' });
      }
      const r = routes.find((x) => x.method === req.method && x.re.test(pathname));
      if (!r) return send(res, 404, { error: 'No encontrado' });
      const m = pathname.match(r.re);
      const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      const ctx = { req, res, params, query: url.searchParams, ip: ipOf(req), user: null, body: {},
        allow: limiter, json: (s, o) => send(res, s, o) };
      if (r.opts.auth || r.opts.owner) {
        ctx.user = await currentUser(req);
        if (!ctx.user) return send(res, 401, { error: 'Inicia sesión' });
        if (r.opts.owner && (ctx.user.role !== 'owner' || ctx.user.email !== ownerEmail)) {
          await audit(req, ctx.user, 'owner_denied', pathname);
          return send(res, 403, { error: 'Solo el dueño' });
        }
        if (r.opts.owner && !ctx.user.totp_secret && !pathname.startsWith('/api/owner/2fa/')) {
          return send(res, 403, { error: 'Activa la verificación en dos pasos (2FA) para usar la consola del dueño.', need_2fa_setup: true });
        }
      }
      if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
        try { ctx.body = await readBody(req); } catch { return send(res, 400, { error: 'Cuerpo inválido' }); }
      }
      await r.handler(ctx);
    } catch (e) {
      log.error(req.method, pathname, e.message);
      if (!res.headersSent) send(res, 500, { error: 'Error interno' });
    }
  }

  return { handler, bootstrap, engine };
}
