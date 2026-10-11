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
import { EXCHANGES, COST_PROFILES } from './costs.js';
import { getLab } from './lab.js';
import { getMarket } from './market.js';
import { rsi, macd, bollinger, sma } from './indicators.js';
import { getGuardrails, setGuardrails } from './agents.js';
import { buildTarGz, collectSource } from './export.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const TOS_VERSION = '2026-10-11';
export const APP_VERSION = '14.4.0';
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
    strip('lib/exchanges.js'), strip('lib/indicators.js'), strip('lib/strategy.js'), strip('bot/runner.js'),
  ].join('\n');
}

export function createApp({ store, env, adapters, feed, engine, director, market = getMarket, log = console }) {
  const limiter = createLimiter();
  const prod = env.NODE_ENV === 'production';
  const ownerEmail = (env.OWNER_EMAIL || '').trim().toLowerCase();
  const hardMaxOrder = Number(env.HARD_MAX_ORDER_USD) || 250;
  const hardMaxDaily = Number(env.HARD_MAX_DAILY_USD) || 1000;
  const pending2fa = new Map();
  const dummyHashPromise = hashPassword('x'.repeat(16));
  const sigCache = new Map();

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
      guardrails: guard, agents, lab: await getLab(store), runs: JSON.parse(await store.getSetting('director:runs', '[]')),
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
    ctx.json(200, { status: 'ok', version: APP_VERSION, database: store.kind, owner_enabled: !!ownerEmail && !!env.OWNER_PASSWORD });
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
    await startSession(ctx.res, u);
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
    ctx.json(200, { cfg: b ? { ...DEFAULT_CFG, ...b.cfg } : await defaultCfg(), last_run: b ? b.last_run : 0 });
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
    if (!SYMBOLS.includes(symbol)) return ctx.json(400, { error: 'Símbolo no permitido' });
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
    ctx.json(200, { app_version: APP_VERSION, brain_version: Number(await store.getSetting('brain_version', '1')) || 1,
      last_run: Number(await store.getSetting('director_last_run', '0')) || null, agents, guardrails,
      pending: pending.map(parseProposal), history: all.filter((p) => p.status !== 'pending').slice(0, 50).map(parseProposal), models,
      lab: await getLab(store), runs: JSON.parse(await store.getSetting('director:runs', '[]')),
      stats: { applied: all.filter((p) => p.status === 'applied').length, rejected: all.filter((p) => p.status === 'rejected').length, total: all.length } });
  });


  // ----- Lista de lanzamiento comercial (datos reales + pasos manuales que marca el dueño) -----
  const MANUAL = {
    attorney: ['Abogado de Florida revisó Términos, Privacidad y Aviso de riesgo', 'Contrata una revisión (valores, FinCEN/OFR, consumidor). Luego reemplaza los [corchetes] en public/legal.html.'],
    exchange_terms: ['Revisé los términos de API de Coinbase y Robinhood para uso comercial', 'Lee sus términos de API; confirma que un software de terceros puede operar cuentas de clientes.'],
    own_live: ['Probé trading real con mi propia cuenta y montos mínimos', 'Activa "trading real" solo para ti, con $10-25, y verifica una compra y una venta.'],
    billing: ['Cobros configurados (Stripe)', 'Aún no incluido. Define precio y conecta Stripe antes de cobrar.'],
    domain: ['Dominio propio y correo de soporte', 'Compra un dominio, apúntalo a Render y define SUPPORT_EMAIL.'],
  };
  async function readiness(user) {
    const lab = await getLab(store);
    const clients = (await store.listUsers()).filter((u) => u.role === 'client');
    let legalOpen = true;
    try { legalOpen = /\[[A-ZÁÉÍÓÚÑ ]{4,}\]/.test(fs.readFileSync(path.join(ROOT, 'public', 'legal.html'), 'utf8')); } catch { /* sin archivo */ }
    const auto = [
      ['owner_2fa', 'Verificación en dos pasos del dueño', !!user.totp_secret, 'Ajustes → Activar 2FA.'],
      ['database', 'Base de datos persistente (Postgres)', store.kind === 'pg', 'Define DATABASE_URL; en memoria se pierden los datos.'],
      ['secrets', 'Secretos de sesión y cifrado definidos', String(env.SESSION_SECRET || '').length >= 32 && String(env.ENCRYPTION_KEY || '').length >= 32, 'SESSION_SECRET y ENCRYPTION_KEY de 32+ caracteres.'],
      ['legal_filled', 'Datos legales completados', !legalOpen, 'Reemplaza los [corchetes] de public/legal.html.'],
      ['brain_ran', 'El Cerebro ya corrió al menos una vez', (lab.runs || 0) > 0, 'Cerebro → Correr análisis.'],
      ['lab_forward', 'Laboratorio de papel con 7+ días hacia adelante', Object.values(lab.latest || {}).some((l) => l.candles >= 168), 'Deja correr el laboratorio; el avance se acumula solo.'],
      ['brain_applied', 'Aprobaste al menos una mejora del Cerebro', (Number(await store.getSetting('brain_version', '1')) || 1) > 1, 'Cerebro → revisa y aprueba propuestas.'],
      ['first_client', 'Tienes al menos un cliente real', clients.length > 0, 'Comparte tu landing.'],
    ].map(([id, label, ok, step]) => ({ id, label, status: ok ? 'ok' : 'todo', manual: false, step }));
    const manual = [];
    for (const [id, [label, step]] of Object.entries(MANUAL)) manual.push({ id, label, status: (await store.getSetting(`launch:${id}`, 'no')) === 'yes' ? 'ok' : 'todo', manual: true, step });
    const items = [...auto, ...manual];
    return { items, score: Math.round((items.filter((i) => i.status === 'ok').length / items.length) * 100),
      live_trading: (await store.getSetting('live_trading', 'off')) === 'on', registration_open: (await store.getSetting('registration_open', 'on')) === 'on' };
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
    await store.updateUser(ctx.user.id, { totp_secret: p.secret });
    pending2fa.delete(ctx.user.id);
    await audit(ctx.req, ctx.user, 'owner_2fa_enabled');
    ctx.json(200, { ok: true });
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
