// Capa de datos. Dos implementaciones con la misma interfaz:
//  - pgStore: PostgreSQL (producción)
//  - memoryStore: en memoria (solo pruebas locales)
// Todas las fechas son milisegundos (número).
import crypto from 'node:crypto';

const uid = () => crypto.randomUUID();
const now = () => Date.now();

// ============================ MEMORIA ============================
export function memoryStore() {
  const users = new Map();
  const conns = new Map();
  const bots = new Map();
  const orders = [];
  const audit = [];
  const settings = new Map();
  let auditSeq = 0;

  return {
    kind: 'memory',
    async init() {},
    async createUser({ email, pass_hash, role = 'client', tos_version = null }) {
      const u = { id: uid(), email, pass_hash, role, status: 'active', sv: 0, totp_secret: null,
        tos_version, tos_at: tos_version ? now() : null, created_at: now(), last_login: null,
        failed: 0, locked_until: 0 };
      users.set(u.id, u);
      return { ...u };
    },
    async getUserByEmail(email) {
      for (const u of users.values()) if (u.email === email) return { ...u };
      return null;
    },
    async getUserById(id) { const u = users.get(id); return u ? { ...u } : null; },
    async listUsers() { return [...users.values()].map((u) => ({ ...u })); },
    async updateUser(id, f) { const u = users.get(id); if (u) Object.assign(u, f); },
    async bumpSv(id) { const u = users.get(id); if (u) u.sv += 1; },

    async addConnection(c) {
      const row = { id: uid(), status: 'active', created_at: now(), last_check: now(), ...c };
      conns.set(row.id, row);
      return { ...row };
    },
    async listConnections(user_id) {
      return [...conns.values()].filter((c) => c.user_id === user_id)
        .map(({ secret_enc, ...rest }) => ({ ...rest }));
    },
    async getConnection(user_id, id) {
      const c = conns.get(id);
      return c && c.user_id === user_id ? { ...c } : null;
    },
    async deleteConnection(user_id, id) {
      const c = conns.get(id);
      if (c && c.user_id === user_id) { conns.delete(id); return true; }
      return false;
    },
    async countConnectionsByExchange() {
      const out = {};
      for (const c of conns.values()) out[c.exchange] = (out[c.exchange] || 0) + 1;
      return out;
    },

    async getBot(user_id) { const b = bots.get(user_id); return b ? { ...b, cfg: { ...b.cfg } } : null; },
    async saveBot(user_id, cfg) {
      const prev = bots.get(user_id);
      bots.set(user_id, { user_id, cfg, updated_at: now(), last_run: prev ? prev.last_run : 0,
        errors: prev ? prev.errors : 0 });
    },
    async patchBot(user_id, f) { const b = bots.get(user_id); if (b) Object.assign(b, f); },
    async listBots() { return [...bots.values()].map((b) => ({ ...b, cfg: { ...b.cfg } })); },

    async addOrder(o) { const row = { id: uid(), created_at: now(), ...o }; orders.push(row); return { ...row }; },
    async listOrders(user_id, limit = 100) {
      return orders.filter((o) => o.user_id === user_id).sort((a, b) => b.created_at - a.created_at)
        .slice(0, limit).map((o) => ({ ...o }));
    },
    async listAllOrdersSince(ts) { return orders.filter((o) => o.created_at >= ts).map((o) => ({ ...o })); },
    async liveUsdSince(user_id, ts) {
      return orders.filter((o) => o.user_id === user_id && o.mode === 'live' && o.status === 'ok'
        && o.side === 'buy' && o.created_at >= ts).reduce((s, o) => s + o.usd, 0);
    },

    async addAudit({ user_id = null, actor = null, action, ip = null, detail = '' }) {
      audit.push({ id: ++auditSeq, user_id, actor, action, ip, detail, created_at: now() });
    },
    async listAudit(limit = 200) { return audit.slice(-limit).reverse(); },
    async listAuditSince(ts) { return audit.filter((a) => a.created_at >= ts); },

    async getSetting(k, d = null) { return settings.has(k) ? settings.get(k) : d; },
    async setSetting(k, v) { settings.set(k, String(v)); },
  };
}

// ============================ POSTGRES ============================
export async function pgStore(connectionString, { ssl = false } = {}) {
  const pg = (await import('pg')).default;
  const pool = new pg.Pool({ connectionString, ssl: ssl ? { rejectUnauthorized: false } : false, max: 8 });
  pool.on('error', (e) => console.error('pg pool error:', e.message));
  const q = (sql, params = []) => pool.query(sql, params);
  const num = (r) => r && { ...r };
  const asNum = (x) => (x === null || x === undefined ? x : Number(x));
  const fixUser = (r) => r && { ...r, created_at: asNum(r.created_at), last_login: asNum(r.last_login),
    tos_at: asNum(r.tos_at), locked_until: asNum(r.locked_until) };
  const fixOrder = (r) => ({ ...r, usd: asNum(r.usd), qty: asNum(r.qty), price: asNum(r.price),
    created_at: asNum(r.created_at) });

  return {
    kind: 'postgres',
    async init() {
      // Elimina las tablas de datos de demostración de la v1 (solo tenían datos falsos).
      await q('DROP TABLE IF EXISTS incidents, automation_rules, positions, trades');
      await q(`
        CREATE TABLE IF NOT EXISTS users (
          id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, pass_hash TEXT NOT NULL,
          role TEXT NOT NULL DEFAULT 'client', status TEXT NOT NULL DEFAULT 'active',
          sv INTEGER NOT NULL DEFAULT 0, totp_secret TEXT, tos_version TEXT, tos_at BIGINT,
          created_at BIGINT NOT NULL, last_login BIGINT, failed INTEGER NOT NULL DEFAULT 0,
          locked_until BIGINT NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS connections (
          id TEXT PRIMARY KEY, user_id TEXT NOT NULL, exchange TEXT NOT NULL, label TEXT,
          key_id TEXT, secret_enc TEXT NOT NULL, can_trade BOOLEAN, can_transfer BOOLEAN,
          status TEXT NOT NULL DEFAULT 'active', created_at BIGINT NOT NULL, last_check BIGINT);
        CREATE INDEX IF NOT EXISTS connections_user ON connections(user_id);
        CREATE TABLE IF NOT EXISTS bots (
          user_id TEXT PRIMARY KEY, cfg TEXT NOT NULL, updated_at BIGINT NOT NULL,
          last_run BIGINT NOT NULL DEFAULT 0, errors INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS orders (
          id TEXT PRIMARY KEY, user_id TEXT NOT NULL, mode TEXT NOT NULL, exchange TEXT,
          symbol TEXT NOT NULL, side TEXT NOT NULL, usd DOUBLE PRECISION, qty DOUBLE PRECISION,
          price DOUBLE PRECISION, status TEXT NOT NULL, note TEXT, ext_id TEXT, created_at BIGINT NOT NULL);
        CREATE INDEX IF NOT EXISTS orders_user ON orders(user_id, created_at);
        CREATE TABLE IF NOT EXISTS audit (
          id BIGSERIAL PRIMARY KEY, user_id TEXT, actor TEXT, action TEXT NOT NULL, ip TEXT,
          detail TEXT, created_at BIGINT NOT NULL);
        CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT NOT NULL);
      `);
    },

    async createUser({ email, pass_hash, role = 'client', tos_version = null }) {
      const id = uid();
      const t = now();
      await q(`INSERT INTO users (id,email,pass_hash,role,tos_version,tos_at,created_at)
               VALUES ($1,$2,$3,$4,$5,$6,$7)`, [id, email, pass_hash, role, tos_version, tos_version ? t : null, t]);
      return this.getUserById(id);
    },
    async getUserByEmail(email) { return fixUser((await q('SELECT * FROM users WHERE email=$1', [email])).rows[0] || null); },
    async getUserById(id) { return fixUser((await q('SELECT * FROM users WHERE id=$1', [id])).rows[0] || null); },
    async listUsers() { return (await q('SELECT * FROM users ORDER BY created_at DESC')).rows.map(fixUser); },
    async updateUser(id, f) {
      const allowed = ['pass_hash', 'role', 'status', 'totp_secret', 'last_login', 'failed', 'locked_until', 'tos_version', 'tos_at'];
      const keys = Object.keys(f).filter((k) => allowed.includes(k));
      if (!keys.length) return;
      await q(`UPDATE users SET ${keys.map((k, i) => `${k}=$${i + 2}`).join(',')} WHERE id=$1`,
        [id, ...keys.map((k) => f[k])]);
    },
    async bumpSv(id) { await q('UPDATE users SET sv=sv+1 WHERE id=$1', [id]); },

    async addConnection(c) {
      const id = uid();
      const t = now();
      await q(`INSERT INTO connections (id,user_id,exchange,label,key_id,secret_enc,can_trade,can_transfer,status,created_at,last_check)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'active',$9,$9)`,
        [id, c.user_id, c.exchange, c.label, c.key_id, c.secret_enc, c.can_trade, c.can_transfer, t]);
      return this.getConnection(c.user_id, id);
    },
    async listConnections(user_id) {
      return (await q(`SELECT id,user_id,exchange,label,key_id,can_trade,can_transfer,status,created_at,last_check
                       FROM connections WHERE user_id=$1 ORDER BY created_at`, [user_id])).rows
        .map((r) => ({ ...r, created_at: asNum(r.created_at), last_check: asNum(r.last_check) }));
    },
    async getConnection(user_id, id) {
      const r = (await q('SELECT * FROM connections WHERE id=$1 AND user_id=$2', [id, user_id])).rows[0];
      return r ? { ...r, created_at: asNum(r.created_at), last_check: asNum(r.last_check) } : null;
    },
    async deleteConnection(user_id, id) {
      return (await q('DELETE FROM connections WHERE id=$1 AND user_id=$2', [id, user_id])).rowCount > 0;
    },
    async countConnectionsByExchange() {
      const out = {};
      for (const r of (await q('SELECT exchange, COUNT(*)::int AS n FROM connections GROUP BY exchange')).rows) out[r.exchange] = r.n;
      return out;
    },

    async getBot(user_id) {
      const r = (await q('SELECT * FROM bots WHERE user_id=$1', [user_id])).rows[0];
      return r ? { user_id, cfg: JSON.parse(r.cfg), updated_at: asNum(r.updated_at), last_run: asNum(r.last_run), errors: r.errors } : null;
    },
    async saveBot(user_id, cfg) {
      await q(`INSERT INTO bots (user_id,cfg,updated_at) VALUES ($1,$2,$3)
               ON CONFLICT (user_id) DO UPDATE SET cfg=EXCLUDED.cfg, updated_at=EXCLUDED.updated_at`,
        [user_id, JSON.stringify(cfg), now()]);
    },
    async patchBot(user_id, f) {
      if ('last_run' in f) await q('UPDATE bots SET last_run=$2 WHERE user_id=$1', [user_id, f.last_run]);
      if ('errors' in f) await q('UPDATE bots SET errors=$2 WHERE user_id=$1', [user_id, f.errors]);
      if ('cfg' in f) await q('UPDATE bots SET cfg=$2 WHERE user_id=$1', [user_id, JSON.stringify(f.cfg)]);
    },
    async listBots() {
      return (await q('SELECT * FROM bots')).rows.map((r) => ({ user_id: r.user_id, cfg: JSON.parse(r.cfg),
        updated_at: asNum(r.updated_at), last_run: asNum(r.last_run), errors: r.errors }));
    },

    async addOrder(o) {
      const id = uid();
      const t = now();
      await q(`INSERT INTO orders (id,user_id,mode,exchange,symbol,side,usd,qty,price,status,note,ext_id,created_at)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [id, o.user_id, o.mode, o.exchange || null, o.symbol, o.side, o.usd ?? null, o.qty ?? null,
          o.price ?? null, o.status, o.note || null, o.ext_id || null, t]);
      return { id, created_at: t, ...o };
    },
    async listOrders(user_id, limit = 100) {
      return (await q('SELECT * FROM orders WHERE user_id=$1 ORDER BY created_at DESC LIMIT $2', [user_id, limit])).rows.map(fixOrder);
    },
    async listAllOrdersSince(ts) {
      return (await q('SELECT * FROM orders WHERE created_at>=$1', [ts])).rows.map(fixOrder);
    },
    async liveUsdSince(user_id, ts) {
      const r = (await q(`SELECT COALESCE(SUM(usd),0) AS s FROM orders WHERE user_id=$1 AND mode='live'
                          AND status='ok' AND side='buy' AND created_at>=$2`, [user_id, ts])).rows[0];
      return Number(r.s);
    },

    async addAudit({ user_id = null, actor = null, action, ip = null, detail = '' }) {
      await q('INSERT INTO audit (user_id,actor,action,ip,detail,created_at) VALUES ($1,$2,$3,$4,$5,$6)',
        [user_id, actor, action, ip, String(detail).slice(0, 500), now()]);
    },
    async listAudit(limit = 200) {
      return (await q('SELECT * FROM audit ORDER BY id DESC LIMIT $1', [limit])).rows
        .map((r) => ({ ...r, id: Number(r.id), created_at: asNum(r.created_at) }));
    },
    async listAuditSince(ts) {
      return (await q('SELECT * FROM audit WHERE created_at>=$1', [ts])).rows
        .map((r) => ({ ...r, id: Number(r.id), created_at: asNum(r.created_at) }));
    },

    async getSetting(k, d = null) {
      const r = (await q('SELECT v FROM settings WHERE k=$1', [k])).rows[0];
      return r ? r.v : d;
    },
    async setSetting(k, v) {
      await q('INSERT INTO settings (k,v) VALUES ($1,$2) ON CONFLICT (k) DO UPDATE SET v=EXCLUDED.v', [k, String(v)]);
    },
  };
}
