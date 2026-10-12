// Capa de datos. Dos implementaciones con la misma interfaz:
//  - pgStore: PostgreSQL (producción)
//  - memoryStore: en memoria (solo pruebas locales)
// Todas las fechas son milisegundos (número).
import crypto from 'node:crypto';
import { canTransition, legacyStatus } from './ledger.js';
import { botPath, targetFor } from './botstate.js';
import { STRATEGY_VERSION } from './strategy.js';
import { MIGRATIONS } from './migrations.js';

const uid = () => crypto.randomUUID();
// Comprobaciones de riesgo que dependen de las órdenes ya guardadas (mismas reglas que el SQL de Postgres).
const OPEN = ['submitting', 'submitted', 'confirmed', 'partial', 'unknown'];
export function riskBlock(liveOrders, o, r) {
  const t = r.now || Date.now();
  if (o.side === 'buy') {
    const spent = liveOrders.filter((x) => x.side === 'buy' && x.created_at >= t - 86400000 && (x.status === 'ok' || x.status === 'pending')).reduce((a, x) => a + (x.usd || 0), 0);
    if (spent + (o.usd || 0) > r.maxDaily + 1e-9) return { code: 'daily_cap', reason: `tope diario: ya van $${spent.toFixed(2)} y esta orden suma $${(o.usd || 0).toFixed(2)} (máximo $${r.maxDaily})` };
    // «Abiertas» = sin resolver y recientes (30 min). Las más viejas las resuelve la reconciliación con el broker; no deben bloquear para siempre.
    if (liveOrders.filter((x) => OPEN.includes(x.lifecycle) && (x.updated_at || x.created_at) >= t - 1800000).length >= r.maxOpen) return { code: 'open_orders', reason: `ya hay ${r.maxOpen} órdenes abiertas o sin resolver` };
    const last = liveOrders.slice().sort((a, b) => b.created_at - a.created_at).slice(0, r.maxRejects);
    if (last.length >= r.maxRejects && last.every((x) => x.lifecycle === 'rejected')) return { code: 'repeated_rejections', reason: `${r.maxRejects} rechazos seguidos del broker` };
  }
  if (liveOrders.filter((x) => x.created_at >= t - 3600000).length >= r.maxPerHour) return { code: 'frequency', reason: `más de ${r.maxPerHour} órdenes en una hora` };
  return null;
}
const now = () => Date.now();

// ============================ MEMORIA ============================
export function memoryStore() {
  const users = new Map();
  const conns = new Map();
  const bots = new Map();
  const orders = [];
  const orderEvents = [];
  const botEvents = [];
  const leases = new Map();
  const audit = [];
  const proposals = [];
  const settings = new Map();
  let auditSeq = 0;

  return {
    kind: 'memory',
    async init() {},
    async ping() { return true; },
    async close() {},
    async migrationStatus() { return []; },
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
    // Auditoría de cifrado: cuenta cuántas llaves están cifradas SIN leer ni devolver ningún secreto.
    async encryptionAudit() { const all = [...conns.values()]; return { total: all.length, encrypted: all.filter((c) => String(c.secret_enc).startsWith('v1.')).length, withdraw: all.filter((c) => c.can_transfer).length }; },
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
    // Cambia el estado recorriendo los estados intermedios válidos (todos quedan en bot_events).
    async setBotState(user_id, to, reason = '') {
      const b = bots.get(user_id); if (!b) return { ok: false, error: 'no existe' };
      const path = botPath(b.state, to); if (path === null) return { ok: false, error: `transición inválida ${b.state} → ${to}` };
      for (const st of path) { botEvents.push({ id: botEvents.length + 1, user_id, from_state: b.state, to_state: st, reason: String(reason).slice(0, 200), created_at: now() }); b.state = st; }
      b.state_reason = String(reason).slice(0, 200); b.state_at = now(); return { ok: true, state: b.state };
    },
    async listBotEvents(user_id, limit = 50) { return botEvents.filter((e) => e.user_id === user_id).slice(-limit).reverse().map((e) => ({ ...e })); },
    async saveBot(user_id, cfg) {
      const prev = bots.get(user_id);
      bots.set(user_id, { user_id, cfg, updated_at: now(), last_run: prev ? prev.last_run : 0, errors: prev ? prev.errors : 0,
        state: prev ? prev.state : 'CREATED', state_reason: prev ? prev.state_reason : 'creado', state_at: prev ? prev.state_at : now(), strategy_version: STRATEGY_VERSION });
      if (!prev) botEvents.push({ id: botEvents.length + 1, user_id, from_state: null, to_state: 'CREATED', reason: 'creado', created_at: now() });
      await this.setBotState(user_id, targetFor(prev ? prev.state : 'CREATED', !!cfg.enabled), cfg.enabled ? 'configuración guardada: encendido' : 'configuración guardada');
    },
    async patchBot(user_id, f) {
      const b = bots.get(user_id); if (!b) return;
      const wasEnabled = !!b.cfg.enabled; const { state, state_reason, ...rest } = f; Object.assign(b, rest);
      if (state) await this.setBotState(user_id, state, state_reason || '');
      else if ('cfg' in f && !!f.cfg.enabled !== wasEnabled && targetFor(b.state, !!f.cfg.enabled) !== b.state) await this.setBotState(user_id, targetFor(b.state, !!f.cfg.enabled), f.cfg.enabled ? 'encendido' : 'apagado');
    },
    async listBots() { return [...bots.values()].map((b) => ({ ...b, cfg: { ...b.cfg } })); },
    // Candado de líder: solo una instancia ejecuta cada trabajo periódico (con caducidad por si se cae).
    async acquireLease(name, holder, ttlMs) {
      const t = now(); const l = leases.get(name);
      if (l && l.holder !== holder && l.expires_at > t) return false;
      leases.set(name, { holder, expires_at: t + ttlMs }); return true;
    },
    async releaseLease(name, holder) { const l = leases.get(name); if (l && l.holder === holder) leases.delete(name); },

    async addOrder(o) { const row = { id: uid(), created_at: now(), lifecycle: o.lifecycle || (o.mode === 'paper' ? 'simulated' : 'submitted'), ...o }; orders.push(row); return { ...row }; },
    // Reserva atómica de una orden: si ya existe el mismo client_order_id para ese cliente, NO crea otra (created:false).
    async reserveOrder(o, risk = null) {
      if (!o.client_order_id) throw new Error('client_order_id requerido');
      const prev = orders.find((x) => x.user_id === o.user_id && x.client_order_id === o.client_order_id);
      if (prev) return { created: false, order: { ...prev } };
      // Comprobación + inserción sin ningún await en medio: atómica en memoria.
      const blocked = risk && riskBlock(orders.filter((x) => x.user_id === o.user_id && x.mode === 'live'), o, risk);
      if (blocked) return { created: false, blocked: blocked.code, reason: blocked.reason };
      const row = { id: uid(), created_at: now(), updated_at: now(), lifecycle: 'submitting', status: 'pending', ...o }; orders.push(row);
      orderEvents.push({ id: orderEvents.length + 1, order_id: row.id, user_id: row.user_id, from_state: null, to_state: row.lifecycle, detail: 'reservada', created_at: now() });
      return { created: true, order: { ...row } };
    },
    async transitionOrder(user_id, id, to, patch = {}, detail = '') {
      const o = orders.find((x) => x.id === id && x.user_id === user_id); if (!o) return { ok: false, error: 'no existe' };
      if (!canTransition(o.lifecycle, to)) return { ok: false, error: `transición inválida ${o.lifecycle} → ${to}` };
      const from = o.lifecycle; Object.assign(o, patch, { lifecycle: to, status: legacyStatus(to), updated_at: now() });
      orderEvents.push({ id: orderEvents.length + 1, order_id: id, user_id, from_state: from, to_state: to, detail: String(detail).slice(0, 300), created_at: now() });
      return { ok: true, order: { ...o } };
    },
    async listOrdersByLifecycle(states, olderThanMs = 0) {
      const lim = now() - olderThanMs; return orders.filter((o) => states.includes(o.lifecycle) && (o.updated_at || o.created_at) <= lim).map((o) => ({ ...o }));
    },
    async listOrderEvents(user_id, order_id) { return orderEvents.filter((e) => e.user_id === user_id && e.order_id === order_id).map((e) => ({ ...e })); },
    async listOrders(user_id, limit = 100) {
      return orders.filter((o) => o.user_id === user_id).sort((a, b) => b.created_at - a.created_at)
        .slice(0, limit).map((o) => ({ ...o }));
    },
    async listAllOrdersSince(ts) { return orders.filter((o) => o.created_at >= ts).map((o) => ({ ...o })); },
    async liveUsdSince(user_id, ts) {
      return orders.filter((o) => o.user_id === user_id && o.mode === 'live' && (o.status === 'ok' || o.status === 'pending')
        && o.side === 'buy' && o.created_at >= ts).reduce((s, o) => s + o.usd, 0);
    },

    async addAudit({ user_id = null, actor = null, action, ip = null, detail = '' }) {
      audit.push({ id: ++auditSeq, user_id, actor, action, ip, detail, created_at: now() });
    },
    async listAudit(limit = 200) { return audit.slice(-limit).reverse(); },
    async listAuditSince(ts) { return audit.filter((a) => a.created_at >= ts); },

    async addProposal(p) {
      const row = { id: uid(), status: 'pending', created_at: now(), decided_at: null, decided_note: null, applied_at: null, ...p };
      proposals.push(row);
      return { ...row };
    },
    async listProposals(status = null, limit = 200) {
      return proposals.filter((p) => !status || p.status === status).sort((a, b) => b.created_at - a.created_at).slice(0, limit).map((p) => ({ ...p }));
    },
    async getProposal(id) { const p = proposals.find((x) => x.id === id); return p ? { ...p } : null; },
    async updateProposal(id, f) { const p = proposals.find((x) => x.id === id); if (p) Object.assign(p, f); },

    // Borra todos los datos de un usuario. La auditoría se conserva sin identificarlo.
    async deleteUserData(user_id) {
      for (const [id, c] of conns) if (c.user_id === user_id) conns.delete(id);
      bots.delete(user_id);
      for (let i = orders.length - 1; i >= 0; i--) if (orders[i].user_id === user_id) orders.splice(i, 1);
      for (let i = orderEvents.length - 1; i >= 0; i--) if (orderEvents[i].user_id === user_id) orderEvents.splice(i, 1);
      for (const a of audit) if (a.user_id === user_id) { a.user_id = null; a.actor = 'usuario-eliminado'; }
      users.delete(user_id);
    },

    async getSetting(k, d = null) { return settings.has(k) ? settings.get(k) : d; },
    async setSetting(k, v) { settings.set(k, String(v)); },
  };
}

// ============================ POSTGRES ============================
export async function pgStore(connectionString, { ssl = false, verify = false, max = 8 } = {}) {
  const pg = (await import('pg')).default;
  const pool = new pg.Pool({ connectionString, ssl: ssl ? { rejectUnauthorized: !!verify } : false, max, connectionTimeoutMillis: 10000, idleTimeoutMillis: 30000, statement_timeout: 15000 });
  pool.on('error', (e) => console.error('pg pool error:', e.message));
  const q = (sql, params = []) => pool.query(sql, params);
  const num = (r) => r && { ...r };
  const asNum = (x) => (x === null || x === undefined ? x : Number(x));
  const fixUser = (r) => r && { ...r, created_at: asNum(r.created_at), last_login: asNum(r.last_login),
    tos_at: asNum(r.tos_at), locked_until: asNum(r.locked_until) };
  const fixProposal = (r) => r && { id: r.id, agent: r.agent, kind: r.kind, key: r.dkey, title: r.title, detail: r.detail,
    evidence: r.evidence, touches: r.touches, status: r.status, created_at: asNum(r.created_at), decided_at: asNum(r.decided_at),
    decided_note: r.decided_note, applied_at: asNum(r.applied_at) };
  const fixBot = (r) => ({ user_id: r.user_id, cfg: JSON.parse(r.cfg), updated_at: asNum(r.updated_at), last_run: asNum(r.last_run), errors: r.errors,
    state: r.state || (JSON.parse(r.cfg).enabled ? 'RUNNING' : 'CONFIGURED'), state_reason: r.state_reason || null, state_at: asNum(r.state_at), strategy_version: r.strategy_version || null });
  const fixOrder = (r) => ({ ...r, usd: asNum(r.usd), qty: asNum(r.qty), price: asNum(r.price),
    filled_qty: asNum(r.filled_qty), fee_usd: asNum(r.fee_usd), updated_at: asNum(r.updated_at), created_at: asNum(r.created_at) });

  return {
    kind: 'postgres',
    async init() {
      // Migraciones versionadas, bajo un candado para que dos instancias que arrancan a la vez no choquen.
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        await c.query('SELECT pg_advisory_xact_lock(7771001)');
        await c.query('CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at BIGINT NOT NULL)');
        const done = new Set((await c.query('SELECT id FROM schema_migrations')).rows.map((r) => Number(r.id)));
        for (const m of MIGRATIONS) {
          if (done.has(m.id)) continue;
          await c.query(m.sql);
          await c.query('INSERT INTO schema_migrations (id,name,applied_at) VALUES ($1,$2,$3)', [m.id, m.name, now()]);
        }
        await c.query('COMMIT');
      } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
    },
    async migrationStatus() { return (await q('SELECT id, name, applied_at FROM schema_migrations ORDER BY id')).rows.map((r) => ({ id: Number(r.id), name: r.name, applied_at: asNum(r.applied_at) })); },
    async ping() { await q('SELECT 1'); return true; },
    async close() { await pool.end(); },
    async dropAllForTests() { await q('DROP TABLE IF EXISTS users, connections, bots, orders, order_events, bot_events, leases, audit, settings, proposals, schema_migrations CASCADE'); },

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
    async encryptionAudit() {
      const r = (await q("SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE secret_enc LIKE 'v1.%') AS encrypted, COUNT(*) FILTER (WHERE can_transfer) AS withdraw FROM connections")).rows[0];
      return { total: Number(r.total), encrypted: Number(r.encrypted), withdraw: Number(r.withdraw) };
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
      return r ? fixBot(r) : null;
    },
    async setBotState(user_id, to, reason = '') {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        const r = (await c.query('SELECT * FROM bots WHERE user_id=$1 FOR UPDATE', [user_id])).rows[0];
        if (!r) { await c.query('ROLLBACK'); return { ok: false, error: 'no existe' }; }
        const from = r.state || 'CREATED'; const path = botPath(from, to);
        if (path === null) { await c.query('ROLLBACK'); return { ok: false, error: `transición inválida ${from} → ${to}` }; }
        let cur = from; const t = now();
        for (const st of path) { await c.query('INSERT INTO bot_events (user_id,from_state,to_state,reason,created_at) VALUES ($1,$2,$3,$4,$5)', [user_id, cur, st, String(reason).slice(0, 200), t]); cur = st; }
        await c.query('UPDATE bots SET state=$2, state_reason=$3, state_at=$4 WHERE user_id=$1', [user_id, cur, String(reason).slice(0, 200), t]);
        await c.query('COMMIT'); return { ok: true, state: cur };
      } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
    },
    async listBotEvents(user_id, limit = 50) {
      return (await q('SELECT * FROM bot_events WHERE user_id=$1 ORDER BY id DESC LIMIT $2', [user_id, limit])).rows.map((r) => ({ ...r, id: Number(r.id), created_at: asNum(r.created_at) }));
    },
    async saveBot(user_id, cfg) {
      const prev = await this.getBot(user_id);
      await q(`INSERT INTO bots (user_id,cfg,updated_at,state,state_reason,state_at,strategy_version) VALUES ($1,$2,$3,'CREATED','creado',$3,$4)
               ON CONFLICT (user_id) DO UPDATE SET cfg=EXCLUDED.cfg, updated_at=EXCLUDED.updated_at, strategy_version=EXCLUDED.strategy_version`,
        [user_id, JSON.stringify(cfg), now(), STRATEGY_VERSION]);
      if (!prev) await q("INSERT INTO bot_events (user_id,from_state,to_state,reason,created_at) VALUES ($1,NULL,'CREATED','creado',$2)", [user_id, now()]);
      await this.setBotState(user_id, targetFor(prev ? (prev.state || 'CREATED') : 'CREATED', !!cfg.enabled), cfg.enabled ? 'configuración guardada: encendido' : 'configuración guardada');
    },
    async patchBot(user_id, f) {
      const prev = ('cfg' in f) ? await this.getBot(user_id) : null;
      if ('last_run' in f) await q('UPDATE bots SET last_run=$2 WHERE user_id=$1', [user_id, f.last_run]);
      if ('errors' in f) await q('UPDATE bots SET errors=$2 WHERE user_id=$1', [user_id, f.errors]);
      if ('cfg' in f) await q('UPDATE bots SET cfg=$2 WHERE user_id=$1', [user_id, JSON.stringify(f.cfg)]);
      if (f.state) await this.setBotState(user_id, f.state, f.state_reason || '');
      else if (prev && !!f.cfg.enabled !== !!prev.cfg.enabled && targetFor(prev.state, !!f.cfg.enabled) !== prev.state) await this.setBotState(user_id, targetFor(prev.state, !!f.cfg.enabled), f.cfg.enabled ? 'encendido' : 'apagado');
    },
    async listBots() {
      return (await q('SELECT * FROM bots')).rows.map(fixBot);
    },
    // Candado de líder atómico: lo toma quien lo tiene libre, ya lo es, o el anterior caducó.
    async acquireLease(name, holder, ttlMs) {
      const t = now();
      const r = await q(`INSERT INTO leases (name,holder,expires_at) VALUES ($1,$2,$3)
        ON CONFLICT (name) DO UPDATE SET holder=EXCLUDED.holder, expires_at=EXCLUDED.expires_at WHERE leases.holder=EXCLUDED.holder OR leases.expires_at < $4 RETURNING holder`, [name, holder, t + ttlMs, t]);
      return r.rowCount > 0;
    },
    async releaseLease(name, holder) { await q('DELETE FROM leases WHERE name=$1 AND holder=$2', [name, holder]); },

    async addOrder(o) {
      const id = uid();
      const t = now();
      const lifecycle = o.lifecycle || (o.mode === 'paper' ? 'simulated' : 'submitted');
      await q(`INSERT INTO orders (id,user_id,mode,exchange,symbol,side,usd,qty,price,status,note,ext_id,created_at,lifecycle,updated_at)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$13)`,
        [id, o.user_id, o.mode, o.exchange || null, o.symbol, o.side, o.usd ?? null, o.qty ?? null,
          o.price ?? null, o.status, o.note || null, o.ext_id || null, t, lifecycle]);
      return { id, created_at: t, lifecycle, ...o };
    },
    // Reserva atómica: el índice único (user_id, client_order_id) garantiza que la misma orden no se crea dos veces,
    // aunque haya dos instancias o un reinicio a mitad.
    async reserveOrder(o, risk = null) {
      if (!o.client_order_id) throw new Error('client_order_id requerido');
      const id = uid(); const t = now();
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        // Candado por cliente: dos señales simultáneas (aunque vengan de dos instancias) se atienden una tras otra.
        await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [o.user_id]);
        const dup = (await c.query('SELECT * FROM orders WHERE user_id=$1 AND client_order_id=$2', [o.user_id, o.client_order_id])).rows[0];
        if (dup) { await c.query('ROLLBACK'); return { created: false, order: fixOrder(dup) }; }
        if (risk) {
          // Misma función de reglas que usa la memoria: se le pasan las órdenes reales de 24 h + las abiertas + las últimas N (para rechazos seguidos).
          const cols = 'id, side, usd, status, lifecycle, created_at, updated_at';
          const recent = (await c.query(`SELECT ${cols} FROM orders WHERE user_id=$1 AND mode='live' AND (created_at >= $2 OR (lifecycle = ANY($3) AND COALESCE(updated_at, created_at) >= $2 + 84600000))`, [o.user_id, t - 86400000, ['submitting', 'submitted', 'confirmed', 'partial', 'unknown']])).rows;
          const lastN = (await c.query(`SELECT ${cols} FROM orders WHERE user_id=$1 AND mode='live' ORDER BY created_at DESC LIMIT $2`, [o.user_id, risk.maxRejects || 3])).rows;
          const byId = new Map(); for (const r of [...recent, ...lastN]) byId.set(r.id, { ...r, usd: asNum(r.usd), created_at: asNum(r.created_at), updated_at: asNum(r.updated_at) });
          const blocked = riskBlock([...byId.values()], o, { ...risk, now: t });
          if (blocked) { await c.query('ROLLBACK'); return { created: false, blocked: blocked.code, reason: blocked.reason }; }
        }
        await c.query(`INSERT INTO orders (id,user_id,mode,exchange,symbol,side,usd,qty,price,status,note,ext_id,created_at,lifecycle,updated_at,client_order_id)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending',$10,NULL,$11,'submitting',$11,$12)`,
          [id, o.user_id, o.mode, o.exchange || null, o.symbol, o.side, o.usd ?? null, o.qty ?? null, o.price ?? null, o.note || null, t, o.client_order_id]);
        await c.query('INSERT INTO order_events (order_id,user_id,from_state,to_state,detail,created_at) VALUES ($1,$2,NULL,$3,$4,$5)', [id, o.user_id, 'submitting', 'reservada', t]);
        await c.query('COMMIT');
        return { created: true, order: fixOrder((await q('SELECT * FROM orders WHERE id=$1', [id])).rows[0]) };
      } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
    },
    async transitionOrder(user_id, id, to, patch = {}, detail = '') {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        const cur = (await c.query('SELECT * FROM orders WHERE id=$1 AND user_id=$2 FOR UPDATE', [id, user_id])).rows[0];
        if (!cur) { await c.query('ROLLBACK'); return { ok: false, error: 'no existe' }; }
        if (!canTransition(cur.lifecycle, to)) { await c.query('ROLLBACK'); return { ok: false, error: `transición inválida ${cur.lifecycle} → ${to}` }; }
        const allowed = ['ext_id', 'note', 'qty', 'price', 'usd', 'filled_qty', 'fee_usd'];
        const keys = Object.keys(patch).filter((k) => allowed.includes(k)); const t = now();
        const sets = ['lifecycle=$3', 'status=$4', 'updated_at=$5', ...keys.map((k, i) => `${k}=$${i + 6}`)];
        await c.query(`UPDATE orders SET ${sets.join(',')} WHERE id=$1 AND user_id=$2`, [id, user_id, to, legacyStatus(to), t, ...keys.map((k) => patch[k])]);
        await c.query('INSERT INTO order_events (order_id,user_id,from_state,to_state,detail,created_at) VALUES ($1,$2,$3,$4,$5,$6)', [id, user_id, cur.lifecycle, to, String(detail).slice(0, 300), t]);
        await c.query('COMMIT');
        return { ok: true, order: fixOrder((await q('SELECT * FROM orders WHERE id=$1', [id])).rows[0]) };
      } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
    },
    async listOrdersByLifecycle(states, olderThanMs = 0) {
      return (await q('SELECT * FROM orders WHERE lifecycle = ANY($1) AND COALESCE(updated_at,created_at) <= $2', [states, now() - olderThanMs])).rows.map(fixOrder);
    },
    async listOrderEvents(user_id, order_id) {
      return (await q('SELECT * FROM order_events WHERE user_id=$1 AND order_id=$2 ORDER BY id', [user_id, order_id])).rows.map((r) => ({ ...r, id: Number(r.id), created_at: asNum(r.created_at) }));
    },
    async listOrders(user_id, limit = 100) {
      return (await q('SELECT * FROM orders WHERE user_id=$1 ORDER BY created_at DESC LIMIT $2', [user_id, limit])).rows.map(fixOrder);
    },
    async listAllOrdersSince(ts) {
      return (await q('SELECT * FROM orders WHERE created_at>=$1', [ts])).rows.map(fixOrder);
    },
    async liveUsdSince(user_id, ts) {
      const r = (await q(`SELECT COALESCE(SUM(usd),0) AS s FROM orders WHERE user_id=$1 AND mode='live'
                          AND status IN ('ok','pending') AND side='buy' AND created_at>=$2`, [user_id, ts])).rows[0];
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

    async addProposal(p) {
      const id = uid();
      await q(`INSERT INTO proposals (id,agent,kind,dkey,title,detail,evidence,touches,status,created_at)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending',$9)`,
      [id, p.agent, p.kind, p.key || null, p.title, p.detail || '{}', p.evidence || '{}', p.touches || '[]', now()]);
      return this.getProposal(id);
    },
    async listProposals(status = null, limit = 200) {
      const r = status
        ? await q('SELECT * FROM proposals WHERE status=$1 ORDER BY created_at DESC LIMIT $2', [status, limit])
        : await q('SELECT * FROM proposals ORDER BY created_at DESC LIMIT $1', [limit]);
      return r.rows.map(fixProposal);
    },
    async getProposal(id) { return fixProposal((await q('SELECT * FROM proposals WHERE id=$1', [id])).rows[0] || null); },
    async updateProposal(id, f) {
      const allowed = ['status', 'decided_at', 'decided_note', 'applied_at'];
      const keys = Object.keys(f).filter((k) => allowed.includes(k));
      if (!keys.length) return;
      await q(`UPDATE proposals SET ${keys.map((k, i) => `${k}=$${i + 2}`).join(',')} WHERE id=$1`, [id, ...keys.map((k) => f[k])]);
    },

    // Borra todos los datos de un usuario en una transacción. La auditoría se conserva sin identificarlo.
    async deleteUserData(user_id) {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        await c.query('DELETE FROM connections WHERE user_id=$1', [user_id]);
        await c.query('DELETE FROM bots WHERE user_id=$1', [user_id]);
        await c.query('DELETE FROM order_events WHERE user_id=$1', [user_id]);
        await c.query('DELETE FROM orders WHERE user_id=$1', [user_id]);
        await c.query("UPDATE audit SET user_id=NULL, actor='usuario-eliminado' WHERE user_id=$1", [user_id]);
        await c.query('DELETE FROM users WHERE id=$1', [user_id]);
        await c.query('COMMIT');
      } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
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
