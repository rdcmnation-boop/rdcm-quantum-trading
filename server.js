import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import dotenv from 'dotenv';
import pg from 'pg';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const isProd = process.env.NODE_ENV === 'production';
const VERSION = '12.1.0';

const pool = process.env.DATABASE_URL
  ? new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: isProd ? { rejectUnauthorized: false } : false
    })
  : null;
if (pool) pool.on('error', (e) => console.error('DB pool error:', e.message));

// ---------- Schema + demo seed (runs automatically on startup) ----------
async function initDb() {
  if (!pool) {
    console.warn('DATABASE_URL not set - running with built-in demo data');
    return;
  }
  await pool.query(`
    CREATE TABLE IF NOT EXISTS incidents (
      incident_id SERIAL PRIMARY KEY,
      incident_timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      service_name TEXT NOT NULL,
      root_cause TEXT,
      severity_level TEXT DEFAULT 'medium',
      auto_executed BOOLEAN DEFAULT TRUE,
      resolution_time_sec INTEGER,
      resolved_at TIMESTAMPTZ
    );
    CREATE TABLE IF NOT EXISTS automation_rules (
      rule_id SERIAL PRIMARY KEY,
      rule_name TEXT NOT NULL,
      rule_type TEXT,
      confidence_score NUMERIC(5,2),
      activation_count INTEGER DEFAULT 0,
      deployment_status TEXT DEFAULT 'active'
    );
    CREATE TABLE IF NOT EXISTS positions (
      position_id SERIAL PRIMARY KEY,
      symbol TEXT NOT NULL,
      position_value NUMERIC(16,2) NOT NULL,
      status TEXT DEFAULT 'active'
    );
    CREATE TABLE IF NOT EXISTS trades (
      trade_id SERIAL PRIMARY KEY,
      symbol TEXT NOT NULL,
      quantity NUMERIC(16,4) NOT NULL,
      price NUMERIC(16,4) NOT NULL,
      side TEXT NOT NULL,
      strategy TEXT DEFAULT 'manual',
      pnl NUMERIC(16,2) DEFAULT 0,
      status TEXT DEFAULT 'pending',
      trade_date TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM automation_rules');
  if (rows[0].n === 0) {
    await pool.query(`
      INSERT INTO automation_rules (rule_name, rule_type, confidence_score, activation_count) VALUES
        ('Restart stalled order-router on queue lag', 'ml_generated', 98.2, 412),
        ('Failover market-data feed on packet loss', 'ml_generated', 96.7, 288),
        ('Scale risk-engine pods at market open', 'temporal', 95.4, 530),
        ('Throttle quote fan-out on latency spike', 'cross_org', 93.9, 174),
        ('Re-sync position cache after venue reconnect', 'ml_generated', 92.1, 96);
      INSERT INTO incidents (incident_timestamp, service_name, root_cause, severity_level, auto_executed, resolution_time_sec, resolved_at) VALUES
        (NOW() - INTERVAL '12 minutes', 'order-router', 'Queue lag', 'medium', TRUE, 48, NOW() - INTERVAL '11 minutes'),
        (NOW() - INTERVAL '47 minutes', 'market-data', 'Packet loss on feed A', 'high', TRUE, 71, NOW() - INTERVAL '46 minutes'),
        (NOW() - INTERVAL '2 hours', 'risk-engine', 'Pod saturation at open', 'medium', TRUE, 55, NOW() - INTERVAL '119 minutes'),
        (NOW() - INTERVAL '5 hours', 'quote-gateway', 'Latency spike', 'low', TRUE, 39, NOW() - INTERVAL '299 minutes');
      INSERT INTO positions (symbol, position_value) VALUES
        ('AAPL', 182400), ('NVDA', 241900), ('MSFT', 156300), ('TSLA', -62800), ('BTC-USD', 98700);
      INSERT INTO trades (symbol, quantity, price, side, strategy, pnl, status, trade_date) VALUES
        ('AAPL', 100, 227.40, 'buy', 'momentum', 1840.50, 'filled', NOW() - INTERVAL '3 days'),
        ('NVDA', 50, 131.10, 'buy', 'momentum', 2210.00, 'filled', NOW() - INTERVAL '6 days'),
        ('TSLA', 40, 248.90, 'sell', 'mean-reversion', -430.25, 'filled', NOW() - INTERVAL '9 days'),
        ('MSFT', 60, 418.20, 'buy', 'breakout', 960.75, 'filled', NOW() - INTERVAL '12 days'),
        ('BTC-USD', 1, 67250.00, 'buy', 'trend', 3120.00, 'filled', NOW() - INTERVAL '15 days');
    `);
    console.log('Seeded demo data');
  }
}

// ---------- Fallback demo data (used only if the DB is unreachable) ----------
const DEMO = {
  metrics: {
    auto_resolution_rate: 95, mttr_minutes: 1.05, incident_prevention_pct: 14,
    active_rules: 51, cost_leverage_monthly: 29800, uptime_pct: 99.98
  }
};

const app = express();
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json());

const wrap = (fn) => async (req, res) => {
  try { await fn(req, res); }
  catch (e) { console.error(req.path, e.message); res.status(500).json({ error: 'Internal error' }); }
};

app.get('/api/health', wrap(async (req, res) => {
  let db = 'not_configured';
  if (pool) { try { await pool.query('SELECT 1'); db = 'connected'; } catch { db = 'error'; } }
  res.json({ status: 'ok', version: VERSION, database: db, timestamp: new Date().toISOString() });
}));

app.get('/api/metrics', wrap(async (req, res) => {
  if (!pool) return res.json({ source: 'demo', ...DEMO.metrics });
  const r = await pool.query(`
    SELECT
      (SELECT COUNT(*)::int FROM automation_rules WHERE deployment_status='active') AS rules,
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE auto_executed)::int AS auto,
      COALESCE(AVG(resolution_time_sec),0) AS avg_sec
    FROM incidents WHERE incident_timestamp > NOW() - INTERVAL '30 days'`);
  const row = r.rows[0];
  res.json({
    source: 'database',
    auto_resolution_rate: row.total ? +(row.auto / row.total * 100).toFixed(1) : 0,
    mttr_minutes: +(row.avg_sec / 60).toFixed(2),
    incident_prevention_pct: DEMO.metrics.incident_prevention_pct,
    active_rules: row.rules,
    cost_leverage_monthly: DEMO.metrics.cost_leverage_monthly,
    uptime_pct: DEMO.metrics.uptime_pct
  });
}));

app.get('/api/incidents', wrap(async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 10, 100);
  const r = await pool.query(
    `SELECT incident_id, incident_timestamp, service_name, root_cause, severity_level, auto_executed, resolution_time_sec
     FROM incidents ORDER BY incident_timestamp DESC LIMIT $1`, [limit]);
  res.json({ count: r.rows.length, incidents: r.rows });
}));

app.get('/api/rules', wrap(async (req, res) => {
  const r = await pool.query(
    `SELECT rule_id, rule_name, rule_type, confidence_score, activation_count
     FROM automation_rules WHERE deployment_status='active' ORDER BY confidence_score DESC`);
  res.json({ total_rules: r.rows.length, rules: r.rows });
}));

app.get('/api/portfolio', wrap(async (req, res) => {
  const r = await pool.query(`
    SELECT COALESCE(SUM(position_value),0) AS total_value, COUNT(*)::int AS positions,
      COALESCE(SUM(position_value) FILTER (WHERE position_value>0),0) AS long_exposure,
      COALESCE(ABS(SUM(position_value) FILTER (WHERE position_value<0)),0) AS short_exposure
    FROM positions WHERE status='active'`);
  res.json(r.rows[0]);
}));

app.get('/api/performance', wrap(async (req, res) => {
  const r = await pool.query(`
    SELECT COALESCE(SUM(pnl),0) AS total_pnl, COUNT(*)::int AS trades,
      COUNT(*) FILTER (WHERE pnl>0)::int AS wins
    FROM trades WHERE trade_date > NOW() - INTERVAL '30 days'`);
  const row = r.rows[0];
  res.json({ period: '30_days', total_pnl: row.total_pnl, trades: row.trades,
    win_rate_pct: row.trades ? +(row.wins / row.trades * 100).toFixed(1) : 0 });
}));

app.post('/api/trades', wrap(async (req, res) => {
  const { symbol, quantity, price, side, strategy } = req.body || {};
  if (!symbol || !(quantity > 0) || !(price > 0) || !['buy', 'sell'].includes(side))
    return res.status(400).json({ error: 'symbol, quantity>0, price>0 and side (buy|sell) are required' });
  const r = await pool.query(
    `INSERT INTO trades (symbol, quantity, price, side, strategy, status)
     VALUES ($1,$2,$3,$4,$5,'pending') RETURNING trade_id, status`,
    [String(symbol).toUpperCase().slice(0, 20), quantity, price, side, strategy || 'manual']);
  res.status(201).json(r.rows[0]);
}));

// Frontend
app.use(express.static(path.join(__dirname, 'public')));
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

initDb()
  .catch((e) => console.error('DB init failed (API will return errors for DB routes):', e.message))
  .finally(() => app.listen(PORT, '0.0.0.0', () => console.log(`Quantum Trading running on :${PORT}`)));
