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
import { validateCfg, DEFAULT_CFG, positionFromOrders } from './strategy.js';
import { SYMBOLS } from './exchanges.js';
import { backtest } from './backtest.js';
import { EXCHANGES, COST_PROFILES } from './costs.js';
import { getLab } from './lab.js';
import { setRobinhoodSpreads } from './costs.js';
import { getUniverse, robinhoodPairs, SYMBOL_RE } from './universe.js';
import { getScanner } from './scanner.js';
import { okEndpoint, getVapid, loadSubs, saveSubs } from './push.js';
import { perfSummary } from './pro.js';
import { profitSince } from './charts.js';
import { periodResults, reconcile } from './verify.js';
import { getMarket } from './market.js';
import { rsi, macd, bollinger, sma } from './indicators.js';
import { getGuardrails, setGuardrails } from './agents.js';
import { buildTarGz, collectSource } from './export.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const TOS_VERSION = '2026-10-11';
export const APP_VERSION = '19.19.0';
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

export function createApp({ store, env, adapters, feed, engine, director, market = getMarket, log = console }) {
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
  // El secreto 2FA del dueño se guarda cifrado (AES-256-GCM). Lee valores antiguos en texto plano y los cifra al arrancar.
  const sealTotp = (x) => encrypt(env.ENCRYPTION_KEY, x);
  const openTotp = (x) => (String(x).startsWith('v1.') ? decrypt(env.ENCRYPTION_KEY, x) : x);

  // Alcance del trading real: 'off' (nadie), 'owner' (solo el dueño, para probar) o 'on' (todos los clientes).
  const liveScope = async () => { const v = await store.getSetting('live_trading', 'off'); return v === 'on' ? 'on' : v === 'owner' ? 'owner' : 'off'; };
  const liveAllowedFor = async (user) => { const sc = await liveScope(); return sc === 'on' || (sc === 'owner' && user.role === 'owner' && user.email === ownerEmail); };

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
      if (u.totp_secret && !String(u.totp_secret).startsWith('v1.') && env.ENCRYPTION_KEY) await store.updateUser(u.id, { totp_secret: sealTotp(u.totp_secret) });
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
      const tkey = `${u.id}:${String(ctx.body.totp).replace(/\s/g, '')}`;
      if (usedTotp.has(tkey) && usedTotp.get(tkey) > Date.now()) { await audit(ctx.req, u, 'login_fail', '2fa_replay'); return ctx.json(401, { error: 'Ese código ya se usó. Espera el siguiente.', need_totp: true }); }
      if (!verifyTotp(openTotp(u.totp_secret), ctx.body.totp)) {
        await audit(ctx.req, u, 'login_fail', '2fa');
        return ctx.json(401, { error: 'Código 2FA inválido', need_totp: true });
      }
    }
    if (u.role === 'owner' && u.totp_secret) { usedTotp.set(`${u.id}:${String(ctx.body.totp).replace(/\s/g, '')}`, Date.now() + 120000); if (usedTotp.size > 200) for (const [k, v] of usedTotp) if (v < Date.now()) usedTotp.delete(k); }
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
      const ok = mine.filter((o) => o.status === 'ok'); const bad = mine.filter((o) => o.status !== 'ok');
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
      return { orders: ok.length, errors: recentBad.length, errors_old: bad.length - recentBad.length, bought, sold, realized, invested_now: cost, value: known ? value : null, unrealized: known ? value - cost : null,
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
      if (!(await liveAllowedFor(ctx.user))) return ctx.json(403, { error: 'El trading real aún no está habilitado para tu cuenta. Usa modo papel.' });
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
    ctx.json(200, { enabled: !!cfg.enabled, mode: cfg.mode, symbol: cfg.symbol, strategy: cfg.strategy, limits: { usd: cfg.usd, maxOrderUsd: cfg.maxOrderUsd, maxDailyUsd: cfg.maxDailyUsd, stopLossPct: cfg.stopLossPct, spent24: Math.round(all.filter((o) => o.side === 'buy' && Date.now() - Number(o.created_at) < 86400000).reduce((s, o) => s + (o.usd || 0), 0) * 100) / 100 }, last_run: b ? b.last_run : null, last, price,
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

  route('POST', '/api/bot/kill', { auth: true }, async (ctx) => {
    const b = await store.getBot(ctx.user.id);
    if (b) await store.patchBot(ctx.user.id, { cfg: { ...b.cfg, enabled: false } });
    await audit(ctx.req, ctx.user, 'bot_kill');
    ctx.json(200, { ok: true });
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
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'",
    'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Resource-Policy': 'same-origin', 'X-Permitted-Cross-Domain-Policies': 'none',
    'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(self), geolocation=()',
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
      const r = routes.find((x) => x.method === (req.method === 'HEAD' ? 'GET' : req.method) && x.re.test(pathname));
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
