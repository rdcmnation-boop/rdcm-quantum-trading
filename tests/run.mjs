// Pruebas: node tests/run.mjs  (sin dependencias, sin red)
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createApp, buildBotBundle } from '../lib/app.js';
import { createEngine } from '../lib/engine.js';
import { memoryStore } from '../lib/store.js';
import * as sec from '../lib/security.js';
import { coinbaseJwt, robinhoodSign } from '../lib/exchanges.js';
import { decide, validateCfg } from '../lib/strategy.js';
import { backtest } from '../lib/backtest.js';

let pass = 0;
let fail = 0;
const t = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); } else { fail++; console.log(`  FAIL ${name} ${extra}`); }
};

// ---------- unidades ----------
console.log('Cripto y firmas');
{
  const secret = sec.b32enc(Buffer.from('12345678901234567890'));
  t('TOTP RFC6238 (t=59s)', sec.totp(secret, 59000, 8) === '94287082');
  t('TOTP verifica código actual', sec.verifyTotp(secret, sec.totp(secret)));
  t('TOTP rechaza código malo', !sec.verifyTotp(secret, '000000') || sec.totp(secret) === '000000');
  const blob = sec.encrypt('k'.repeat(40), 'mi-llave-secreta');
  t('AES-GCM ida y vuelta', sec.decrypt('k'.repeat(40), blob) === 'mi-llave-secreta');
  t('AES-GCM no contiene el texto plano', !blob.includes('mi-llave'));
  let threw = false;
  try { sec.decrypt('otra'.repeat(10), blob); } catch { threw = true; }
  t('AES-GCM falla con llave incorrecta', threw);
  const tampered = blob.slice(0, -2) + (blob.endsWith('A') ? 'B' : 'A');
  threw = false;
  try { sec.decrypt('k'.repeat(40), tampered); } catch { threw = true; }
  t('AES-GCM detecta alteración', threw);
  const h = await sec.hashPassword('Password-1234');
  t('scrypt verifica correcta', await sec.verifyPassword('Password-1234', h));
  t('scrypt rechaza incorrecta', !(await sec.verifyPassword('password-1234', h)));
  const tok = sec.signSession('s'.repeat(40), { uid: 'u', exp: Date.now() + 1000 });
  t('sesión firmada válida', !!sec.readSession('s'.repeat(40), tok));
  t('sesión alterada rechazada', !sec.readSession('s'.repeat(40), tok.replace(/^./, 'Z')));
  t('sesión expirada rechazada', !sec.readSession('s'.repeat(40), sec.signSession('s'.repeat(40), { uid: 'u', exp: Date.now() - 1 })));

  const ec = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const pem = ec.privateKey.export({ type: 'sec1', format: 'pem' });
  const jwt = coinbaseJwt('organizations/o/apiKeys/k', pem, 'GET', 'api.coinbase.com', '/api/v3/brokerage/accounts');
  const [h64, p64, s64] = jwt.split('.');
  t('Coinbase JWT: firma ES256 válida', crypto.verify('sha256', Buffer.from(`${h64}.${p64}`),
    { key: ec.publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(s64, 'base64url')));
  const pl = JSON.parse(Buffer.from(p64, 'base64url').toString());
  t('Coinbase JWT: uri e iss correctos', pl.uri === 'GET api.coinbase.com/api/v3/brokerage/accounts' && pl.iss === 'cdp');

  const ed = crypto.generateKeyPairSync('ed25519');
  const seed = ed.privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(-32).toString('base64');
  const sig = robinhoodSign('rh-key', seed, '1700000000', '/api/v1/crypto/trading/accounts/', 'GET', '');
  t('Robinhood: firma Ed25519 válida', crypto.verify(null, Buffer.from('rh-key1700000000/api/v1/crypto/trading/accounts/GET'),
    ed.publicKey, Buffer.from(sig, 'base64')));
}

console.log('Estrategias');
{
  const base = { strategy: 'dca', usd: 10, intervalMin: 60, fast: 2, slow: 3 };
  t('DCA compra la primera vez', decide(base, { now: 1e9, lastBuyAt: 0, position: 0, closes: [] }).action === 'buy');
  t('DCA espera el intervalo', decide(base, { now: 1e9, lastBuyAt: 1e9 - 1000, position: 0, closes: [] }).action === 'hold');
  const sma = { ...base, strategy: 'sma' };
  t('SMA cruce alcista compra', decide(sma, { now: 1, position: 0, closes: [10, 10, 10, 9, 9, 14] }).action === 'buy');
  t('SMA cruce bajista vende', decide(sma, { now: 1, position: 1, closes: [10, 10, 12, 14, 14, 8] }).action === 'sell');
  t('SMA sin cruce mantiene', decide(sma, { now: 1, position: 0, closes: [10, 10, 10, 10, 10, 10] }).action === 'hold');
  t('validateCfg rechaza tope sobre el máximo', !validateCfg({ usd: 10, maxOrderUsd: 999 }, { hardMaxOrder: 250 }).ok);
  t('validateCfg ignora campos desconocidos', !('admin' in validateCfg({ admin: true }).cfg));
}

// ---------- integración HTTP ----------
console.log('Backtest');
{
  const up = Array.from({ length: 300 }, (_, i) => 100 + i * 0.5);
  const flat = Array.from({ length: 300 }, () => 100);
  const cfg = { strategy: 'dca', usd: 10, intervalMin: 60, fast: 20, slow: 50, maxOrderUsd: 25 };
  const r1 = backtest(up, cfg);
  t('backtest DCA en tendencia alcista gana (y respeta el capital)', r1.metrics.totalReturnPct > 0 && r1.metrics.buys > 50 && r1.metrics.buys <= 100);
  const r2 = backtest(flat, cfg);
  t('backtest en mercado plano pierde por comisiones', r2.metrics.totalReturnPct < 0);
  const wave = Array.from({ length: 300 }, (_, i) => 100 + 10 * Math.sin(i / 8));
  const r3 = backtest(wave, { ...cfg, strategy: 'sma', fast: 3, slow: 10 });
  t('backtest SMA entrega métricas institucionales', r3.metrics.closedTrades > 0 && Number.isFinite(r3.metrics.maxDrawdownPct)
    && Number.isFinite(r3.metrics.sharpe) && r3.metrics.winRatePct !== null);
  t('backtest devuelve curva de capital acotada', r3.equity.length <= 150);
  let thr = false;
  try { backtest([1, 2, 3], cfg); } catch { thr = true; }
  t('backtest rechaza historial insuficiente', thr);
}

console.log('API (aislamiento, roles, seguridad)');
const env = { NODE_ENV: 'test', SESSION_SECRET: 's'.repeat(40), ENCRYPTION_KEY: 'e'.repeat(40),
  OWNER_EMAIL: 'Owner@Test.com', OWNER_PASSWORD: 'OwnerPass-12345', REG_LIMIT_PER_HOUR: '100' };
const store = memoryStore();
const good = { name: 'coinbase', label: 'Coinbase', check: async () => ({ ok: true, canTrade: true, canTransfer: false }),
  balances: async () => [{ asset: 'USD', available: 100, hold: 0 }],
  marketBuy: async () => ({ ok: true, id: 'ord-1' }), marketSell: async () => ({ ok: true, id: 'ord-2' }) };
const risky = { ...good, name: 'robinhood', check: async () => ({ ok: true, canTrade: true, canTransfer: true }) };
const adapters = { coinbase: good, robinhood: risky };
const feed = { getPrice: async () => 50000, getCloses: async () => Array.from({ length: 60 }, (_, i) => 100 + i) };
const engine = createEngine({ store, adapters, feed, encKey: env.ENCRYPTION_KEY, log: { error() {} } });
const app = createApp({ store, env, adapters, feed, engine, log: { warn() {}, error() {} } });
await app.bootstrap();
const server = http.createServer(app.handler);
await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;

function client() {
  let cookie = '';
  return async (method, p, body, extra = {}) => {
    const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'qt',
      ...(cookie ? { Cookie: cookie } : {}), ...extra }, body: body ? JSON.stringify(body) : undefined });
    for (const c of r.headers.getSetCookie()) { const kv = c.split(';')[0]; cookie = kv.endsWith('=') ? '' : kv; }
    const txt = await r.text();
    let j; try { j = JSON.parse(txt); } catch { j = txt; }
    return { status: r.status, body: j, text: txt, headers: r.headers, get cookie() { return cookie; }, set cookie(v) { cookie = v; } };
  };
}
const A = client(); const B = client(); const O = client(); const anon = client(); const nobody = client();
const pw = 'Cliente-Pass-1234';

t('health responde', (await anon('GET', '/api/health')).status === 200);
t('sin sesión: /api/me 401', (await anon('GET', '/api/me')).status === 401);
t('CSRF: POST sin encabezado 403', (await fetch(base + '/api/auth/login', { method: 'POST', body: '{}' })).status === 403);
t('registro exige aceptar términos', (await A('POST', '/api/auth/register', { email: 'a@x.com', password: pw })).status === 400);
t('registro rechaza contraseña corta', (await A('POST', '/api/auth/register', { email: 'a@x.com', password: 'corta', acceptTos: true })).status === 400);
const ra = await A('POST', '/api/auth/register', { email: 'a@x.com', password: pw, acceptTos: true });
t('registro cliente A', ra.status === 201 && ra.body.user.role === 'client');
t('cookie httpOnly + SameSite=Strict', /HttpOnly/.test(ra.headers.getSetCookie()[0]) && /SameSite=Strict/.test(ra.headers.getSetCookie()[0]));
t('registro cliente B', (await B('POST', '/api/auth/register', { email: 'b@x.com', password: pw, acceptTos: true })).status === 201);
t('no se puede registrar con el correo del dueño', (await anon('POST', '/api/auth/register', { email: 'owner@test.com', password: pw, acceptTos: true })).status === 409);
const sneaky = await anon('POST', '/api/auth/register', { email: 'c@x.com', password: pw, acceptTos: true, role: 'owner' });
t('el rol enviado por el cliente se ignora', sneaky.body.user.role === 'client');

// roles
t('cliente no entra a /api/owner/overview', (await A('GET', '/api/owner/overview')).status === 403);
t('cliente no entra a /api/owner/users', (await A('GET', '/api/owner/users')).status === 403);
t('cliente no cambia ajustes de dueño', (await A('PUT', '/api/owner/settings', { live_trading: true })).status === 403);
t('anónimo no entra a owner', (await nobody('GET', '/api/owner/overview')).status === 401);
t('login dueño con clave incorrecta falla', (await O('POST', '/api/auth/login', { email: 'owner@test.com', password: 'mala-mala-mala' })).status === 401);
const lo = await O('POST', '/api/auth/login', { email: 'OWNER@test.com', password: env.OWNER_PASSWORD });
t('login dueño correcto', lo.status === 200 && lo.body.user.role === 'owner');
const pre = await O('GET', '/api/owner/overview');
t('2FA obligatorio: sin 2FA el dueño no entra a la consola', pre.status === 403 && pre.body.need_2fa_setup === true);

// 2FA del dueño
const setup = await O('POST', '/api/owner/2fa/setup');
t('2FA: setup devuelve secreto', setup.status === 200 && setup.body.secret.length >= 16);
t('2FA: enable con código malo falla', (await O('POST', '/api/owner/2fa/enable', { code: '123456' })).status === 400 || sec.totp(setup.body.secret) === '123456');
t('2FA: enable con código bueno', (await O('POST', '/api/owner/2fa/enable', { code: sec.totp(setup.body.secret) })).status === 200);
t('con 2FA activo el dueño entra a overview', (await O('GET', '/api/owner/overview')).status === 200);
const O2 = client();
const need = await O2('POST', '/api/auth/login', { email: 'owner@test.com', password: env.OWNER_PASSWORD });
t('2FA: login sin código pide 2FA', need.status === 401 && need.body.need_totp === true);
t('2FA: login con código malo falla', (await O2('POST', '/api/auth/login', { email: 'owner@test.com', password: env.OWNER_PASSWORD, totp: '000001' })).status === 401);
t('2FA: login con código bueno', (await O2('POST', '/api/auth/login', { email: 'owner@test.com', password: env.OWNER_PASSWORD, totp: sec.totp(setup.body.secret) })).status === 200);

// aislamiento de datos
const secretPem = 'SECRET-PEM-XYZ-123';
t('conexión riesgosa (permite retiros) rechazada', (await A('POST', '/api/connections', { exchange: 'robinhood', keyId: 'k', secret: secretPem })).status === 400);
const ca = await A('POST', '/api/connections', { exchange: 'coinbase', keyId: 'organizations/o/apiKeys/k', secret: secretPem });
t('conexión segura aceptada', ca.status === 201);
t('la respuesta no devuelve la llave secreta', !ca.text.includes(secretPem));
t('la llave se guarda cifrada', !JSON.stringify((await store.getConnection(ra.body.user.id, ca.body.connection.id))).includes(secretPem));
const cid = ca.body.connection.id;
t('A ve su conexión', (await A('GET', '/api/connections')).body.connections.length === 1);
t('B no ve conexiones de A', (await B('GET', '/api/connections')).body.connections.length === 0);
t('B no lee saldos de la conexión de A', (await B('GET', `/api/connections/${cid}/balances`)).status === 404);
t('B no borra la conexión de A', (await B('DELETE', `/api/connections/${cid}`)).status === 404);
t('A sí lee saldos', (await A('GET', `/api/connections/${cid}/balances`)).body.balances[0].asset === 'USD');

// bot en papel
const cfgPaper = { enabled: true, mode: 'paper', symbol: 'BTC-USD', strategy: 'dca', usd: 10, intervalMin: 60, maxOrderUsd: 25, maxDailyUsd: 100 };
t('A guarda bot en papel', (await A('PUT', '/api/bot', cfgPaper)).status === 200);
t('B tiene su propia config por defecto', (await B('GET', '/api/bot')).body.cfg.enabled === false);
await engine.tick();
const oa = (await A('GET', '/api/orders')).body.orders;
t('el motor creó una orden en papel para A', oa.length === 1 && oa[0].mode === 'paper' && oa[0].status === 'ok');
t('B no ve órdenes de A', (await B('GET', '/api/orders')).body.orders.length === 0);
await store.patchBot(ra.body.user.id, { last_run: 0 });
await engine.tick();
t('DCA no repite antes del intervalo', (await A('GET', '/api/orders')).body.orders.length === 1);
const pnl = (await A('GET', '/api/pnl')).body.positions;
t('PnL calcula posición en papel', pnl.length === 1 && Math.abs(pnl[0].qty - 10 / 50000) < 1e-9 && pnl[0].price === 50000);

// trading real: compuertas
t('live bloqueado si la plataforma no lo habilitó', (await A('PUT', '/api/bot', { ...cfgPaper, mode: 'live', connectionId: cid, liveAck: true })).status === 403);
t('cliente no puede habilitar live global', (await A('PUT', '/api/owner/settings', { live_trading: true })).status === 403);
t('dueño habilita live', (await O2('PUT', '/api/owner/settings', { live_trading: true })).status === 200);
t('live exige confirmar riesgo', (await A('PUT', '/api/bot', { ...cfgPaper, mode: 'live', connectionId: cid, liveAck: false })).status === 400);
t('live exige conexión propia', (await A('PUT', '/api/bot', { ...cfgPaper, mode: 'live', connectionId: 'ajena', liveAck: true })).status === 400);
t('B no puede usar la conexión de A', (await B('PUT', '/api/bot', { ...cfgPaper, mode: 'live', connectionId: cid, liveAck: true })).status === 400);
t('live rechaza tope por encima del máximo de plataforma', (await A('PUT', '/api/bot', { ...cfgPaper, mode: 'live', connectionId: cid, liveAck: true, maxOrderUsd: 5000 })).status === 400);
const liveCfg = { ...cfgPaper, mode: 'live', connectionId: cid, liveAck: true, maxOrderUsd: 25, maxDailyUsd: 30, intervalMin: 15 };
t('live aceptado con todas las compuertas', (await A('PUT', '/api/bot', liveCfg)).status === 200);
// una compra real previa de $20 hace 16 min: el tope diario ($30) bloquea otra de $10... no: 20+10=30 permitido; subimos a $15
await store.addOrder({ user_id: ra.body.user.id, mode: 'live', exchange: 'coinbase', symbol: 'BTC-USD', side: 'buy', usd: 20, qty: 0.0004, price: 50000, status: 'ok', created_at: Date.now() - 16 * 60000 });
await A('PUT', '/api/bot', { ...liveCfg, usd: 15 });
await store.patchBot(ra.body.user.id, { last_run: 0 });
await engine.tick();
t('tope diario impide la orden live', (await A('GET', '/api/orders')).body.orders.filter((o) => o.mode === 'live').length === 1);
await A('PUT', '/api/bot', { ...liveCfg, usd: 10, maxDailyUsd: 100 });
await store.patchBot(ra.body.user.id, { last_run: 0 });
await engine.tick();
const live = (await A('GET', '/api/orders')).body.orders.filter((o) => o.mode === 'live' && o.ext_id);
t('el motor ejecuta la orden live por el conector', live.length === 1 && live[0].ext_id === 'ord-1');
t('B no ve la orden live de A', (await B('GET', '/api/orders')).body.orders.length === 0);
t('el dueño apaga live global y el bot se desactiva', (await O2('PUT', '/api/owner/settings', { live_trading: false })).status === 200);
await store.patchBot(ra.body.user.id, { last_run: 0 });
await engine.tick();
t('bot live queda apagado', (await A('GET', '/api/bot')).body.cfg.enabled === false);
t('kill switch funciona', (await A('POST', '/api/bot/kill')).status === 200);

// analíticas del dueño
const ov = (await O2('GET', '/api/owner/overview')).body;
t('overview: usuarios reales', ov.users.total === 3 && ov.users.active === 3);
t('overview: órdenes reales contadas', ov.orders.paper_count === 1 && ov.orders.live_count === 2);
t('overview: facturación marcada como pendiente (sin datos inventados)', ov.billing === 'pendiente');
const ou = await O2('GET', '/api/owner/users');
t('lista de clientes sin llaves ni secretos', !ou.text.includes(secretPem) && !ou.text.includes('organizations/o/apiKeys') && !ou.text.includes('pass_hash'));
t('el dueño no aparece en la lista de clientes', !ou.text.includes('owner@test.com'));
t('overview no expone órdenes individuales', !JSON.stringify(ov).includes('ord-1'));

// suspensión
const uidB = ra.body.user.id;
t('dueño suspende a A', (await O2('POST', `/api/owner/users/${uidB}/status`, { status: 'suspended' })).status === 200);
t('sesión de A cae al suspenderlo', (await A('GET', '/api/me')).status === 401);
t('A suspendido no puede iniciar sesión', (await anon('POST', '/api/auth/login', { email: 'a@x.com', password: pw })).status === 401);
t('dueño reactiva a A', (await O2('POST', `/api/owner/users/${uidB}/status`, { status: 'active' })).status === 200);
t('el dueño no se puede suspender a sí mismo vía API', (await O2('POST', `/api/owner/users/${lo.body.user.id}/status`, { status: 'suspended' })).status === 404);

// sesión alterada y límite de intentos
const forged = client();
t('cookie falsificada rechazada', (await forged('GET', '/api/me', null, { Cookie: 'qt_session=eyJ1aWQiOiJ4IiwiZXhwIjo5OTk5OTk5OTk5OTk5fQ.firmafalsa' })).status === 401);
let limited = false;
for (let i = 0; i < 12; i++) if ((await anon('POST', '/api/auth/login', { email: 'victima@x.com', password: 'mala-mala-mala' })).status === 429) limited = true;
t('límite de intentos de login (429)', limited);
t('rutas inexistentes dan 404 JSON', (await anon('GET', '/api/nada')).status === 404);
t('no se sirven archivos fuera de public', (await fetch(base + '/..%2fserver.js')).status !== 200);
t('encabezados de seguridad presentes', !!(await anon('GET', '/api/health')).headers.get('content-security-policy'));
t('auditoría registra eventos', (await store.listAudit(500)).some((e) => e.action === 'login_fail') && (await store.listAudit(500)).some((e) => e.action === 'owner_denied'));

await A('POST', '/api/auth/login', { email: 'a@x.com', password: pw });
const bt = await A('POST', '/api/backtest', { strategy: 'dca', symbol: 'BTC-USD', usd: 10, intervalMin: 60 });
t('endpoint de backtest devuelve métricas (con sesión)', bt.status === 200 && 'sharpe' in bt.body.metrics);
t('backtest exige sesión', (await nobody('POST', '/api/backtest', { strategy: 'dca' })).status === 401);

// bot descargable
console.log('Bot descargable');
const bundle = buildBotBundle();
await A('POST', '/api/auth/login', { email: 'a@x.com', password: pw });
const dl = await A('GET', '/api/bot/download');
t('descarga requiere sesión y entrega el archivo', dl.status === 200 && /attachment/.test(dl.headers.get('content-disposition')));
t('anónimo no descarga el bot', (await nobody('GET', '/api/bot/download')).status === 401);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qbot-'));
const f = path.join(dir, 'quantum-bot.mjs');
fs.writeFileSync(f, bundle);
let syntaxOk = true;
try { execFileSync('node', ['--check', f]); } catch { syntaxOk = false; }
t('el bot descargable tiene sintaxis válida', syntaxOk);
t('el bot descargable corre (--version)', execFileSync('node', [f, '--version']).toString().trim() === '1.0.0');
t('el bot descargable muestra ayuda', /Modo papel/.test(execFileSync('node', [f, '--help']).toString()));
let refused = false;
try { execFileSync('node', [f, '--live'], { stdio: 'pipe' }); } catch (e) { refused = /I_ACCEPT_RISK/.test(String(e.stderr)); }
t('el bot rechaza --live sin I_ACCEPT_RISK=yes', refused);
t('el bot descargable no contiene llaves de nadie', !bundle.includes(secretPem));

server.close();
console.log(`\n${pass} ok, ${fail} fallos`);
process.exit(fail ? 1 : 0);
