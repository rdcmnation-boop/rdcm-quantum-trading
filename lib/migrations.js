// Migraciones versionadas. Reglas: SOLO aditivas (CREATE ... IF NOT EXISTS / ADD COLUMN IF NOT EXISTS), nunca borran ni renombran datos,
// y se pueden aplicar más de una vez. Se registran en `schema_migrations`. Para añadir un cambio: agrega una entrada con el siguiente `id`.
// Reversión: no hay «down». Para volver atrás se despliega la versión anterior del código: las columnas/tablas nuevas simplemente se ignoran.
export const MIGRATIONS = [
  { id: 1, name: 'base: usuarios, conexiones, bots, órdenes, auditoría, ajustes, propuestas', sql: `
    DROP TABLE IF EXISTS incidents, automation_rules, positions, trades;

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
        CREATE TABLE IF NOT EXISTS proposals (
          id TEXT PRIMARY KEY, agent TEXT NOT NULL, kind TEXT NOT NULL, dkey TEXT, title TEXT NOT NULL,
          detail TEXT, evidence TEXT, touches TEXT, status TEXT NOT NULL DEFAULT 'pending',
          created_at BIGINT NOT NULL, decided_at BIGINT, decided_note TEXT, applied_at BIGINT);
        CREATE INDEX IF NOT EXISTS proposals_status ON proposals(status, created_at);
        ` },
  { id: 2, name: 'libro de órdenes: ciclo de vida, ID idempotente, eventos', sql: `
        ALTER TABLE orders ADD COLUMN IF NOT EXISTS client_order_id TEXT;
        ALTER TABLE orders ADD COLUMN IF NOT EXISTS lifecycle TEXT;
        ALTER TABLE orders ADD COLUMN IF NOT EXISTS filled_qty DOUBLE PRECISION;
        ALTER TABLE orders ADD COLUMN IF NOT EXISTS fee_usd DOUBLE PRECISION;
        ALTER TABLE orders ADD COLUMN IF NOT EXISTS updated_at BIGINT;
        CREATE UNIQUE INDEX IF NOT EXISTS orders_client_uq ON orders(user_id, client_order_id) WHERE client_order_id IS NOT NULL;
        CREATE INDEX IF NOT EXISTS orders_lifecycle ON orders(lifecycle, updated_at);
        CREATE TABLE IF NOT EXISTS order_events (
          id BIGSERIAL PRIMARY KEY, order_id TEXT NOT NULL, user_id TEXT NOT NULL, from_state TEXT, to_state TEXT NOT NULL,
          detail TEXT, created_at BIGINT NOT NULL);
        CREATE INDEX IF NOT EXISTS order_events_order ON order_events(order_id, id);
  ` },
  { id: 3, name: 'bots: estados persistidos, eventos y candados de líder', sql: `
        ALTER TABLE bots ADD COLUMN IF NOT EXISTS state TEXT;
        ALTER TABLE bots ADD COLUMN IF NOT EXISTS state_reason TEXT;
        ALTER TABLE bots ADD COLUMN IF NOT EXISTS state_at BIGINT;
        ALTER TABLE bots ADD COLUMN IF NOT EXISTS strategy_version TEXT;
        CREATE TABLE IF NOT EXISTS bot_events (
          id BIGSERIAL PRIMARY KEY, user_id TEXT NOT NULL, from_state TEXT, to_state TEXT NOT NULL, reason TEXT, created_at BIGINT NOT NULL);
        CREATE INDEX IF NOT EXISTS bot_events_user ON bot_events(user_id, id);
        CREATE TABLE IF NOT EXISTS leases (name TEXT PRIMARY KEY, holder TEXT NOT NULL, expires_at BIGINT NOT NULL);
  ` },
  { id: 4, name: 'cuentas: correo verificado, tokens de un solo uso, sesiones/dispositivos, códigos de recuperación 2FA', sql: `
        ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at BIGINT;
        ALTER TABLE users ADD COLUMN IF NOT EXISTS recovery_codes TEXT;
        CREATE TABLE IF NOT EXISTS auth_tokens (
          hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, kind TEXT NOT NULL, expires_at BIGINT NOT NULL, used_at BIGINT, created_at BIGINT NOT NULL);
        CREATE INDEX IF NOT EXISTS auth_tokens_user ON auth_tokens(user_id, kind);
        CREATE TABLE IF NOT EXISTS sessions (
          id TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at BIGINT NOT NULL, last_seen BIGINT NOT NULL, expires_at BIGINT NOT NULL,
          ip TEXT, ua TEXT, revoked_at BIGINT);
        CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id, revoked_at);
  ` },
  { id: 5, name: 'facturación: suscripciones y eventos de webhook (idempotencia)', sql: `
        CREATE TABLE IF NOT EXISTS subscriptions (
          user_id TEXT PRIMARY KEY, plan TEXT NOT NULL, status TEXT NOT NULL, provider TEXT, provider_customer TEXT, provider_sub TEXT,
          current_period_end BIGINT, cancel_at_period_end BOOLEAN NOT NULL DEFAULT FALSE, event_at BIGINT, updated_at BIGINT NOT NULL);
        CREATE INDEX IF NOT EXISTS subscriptions_customer ON subscriptions(provider_customer);
        CREATE TABLE IF NOT EXISTS webhook_events (
          id TEXT PRIMARY KEY, type TEXT NOT NULL, status TEXT NOT NULL, detail TEXT, attempts INTEGER NOT NULL DEFAULT 1, received_at BIGINT NOT NULL, finished_at BIGINT);
  ` },
];
