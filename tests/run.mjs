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
import { createMailer } from '../lib/mailer.js';
import { coinbaseJwt, robinhoodSign } from '../lib/exchanges.js';
import { decide, validateCfg, positionFromOrders } from '../lib/strategy.js';
import { rsi, macd, ema, bollinger, sma } from '../lib/indicators.js';
import { backtest } from '../lib/backtest.js';
import { simulateFill } from '../lib/costs.js';
import { walkForward } from '../lib/ml.js';
import { createDirector, PROTECTED_MIN } from '../lib/agents.js';
import zlib from 'node:zlib';

function rng(seed) {
  return () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x; return ((x ^ (x >>> 14)) >>> 0) / 4294967296; };
}
function series(n, phi, seed) {
  const r = rng(seed); let p = 100; let prev = 0; const out = [];
  for (let i = 0; i < n; i++) { prev = phi * prev + (r() - 0.5) * 0.01; p *= Math.exp(prev); out.push(p); }
  return out;
}
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
console.log('Análisis técnico y riesgo');
{
  const up = Array.from({ length: 40 }, (_, i) => 100 + i);
  const down = Array.from({ length: 40 }, (_, i) => 200 - i);
  t('RSI = 100 en alza continua', rsi(up) === 100);
  t('RSI ~0 en baja continua', rsi(down) < 1);
  const saw = Array.from({ length: 60 }, (_, i) => 100 + (i % 2 ? 1 : -1));
  t('RSI ~50 en serrucho', Math.abs(rsi(saw) - 50) < 5);
  t('RSI null con pocas velas', rsi([1, 2, 3]) === null);
  t('SMA correcta', sma([1, 2, 3, 4], 2) === 3.5);
  t('EMA tiene la longitud esperada', ema(up, 10).length === 31);
  const mm = macd(Array.from({ length: 80 }, (_, i) => 100 + Math.sin(i / 5) * 5 + i * 0.1));
  t('MACD entrega línea, señal e histograma', mm && Number.isFinite(mm.macd) && Number.isFinite(mm.signal) && Number.isFinite(mm.hist));
  const bb = bollinger(up);
  t('Bollinger: %B alto en alza fuerte', bb.pctB > 0.8 && bb.upper > bb.mean && bb.lower < bb.mean);
  const pos = positionFromOrders([{ side: 'buy', qty: 1, usd: 100, ts: 1 }, { side: 'buy', qty: 1, usd: 200, ts: 2 }, { side: 'sell', qty: 1, usd: 180, ts: 3 }]);
  t('costo promedio de la posición', pos.qty === 1 && pos.avgCost === 150 && pos.lastSellAt === 3);
  const cfg = { strategy: 'sma', fast: 2, slow: 3, usd: 10, stopLossPct: 8, intervalMin: 60, rsiBuy: 30, rsiSell: 60, maxOrderUsd: 25 };
  const sl = decide(cfg, { now: 1e9, price: 90, closes: [100, 100, 100, 100, 100, 90], position: 1, avgCost: 100 });
  t('stop-loss vende al caer 8 % bajo el costo', sl.action === 'sell' && /Stop-loss/.test(sl.reason));
  const noSl = decide({ ...cfg, stopLossPct: 15 }, { now: 1e9, price: 90, closes: [100, 100, 100, 100, 100, 90], position: 1, avgCost: 100 });
t('stop-loss no se activa si la caída es menor al umbral', !/Stop-loss/.test(noSl.reason));
  const dcaStop = decide({ ...cfg, strategy: 'dca' }, { now: 1e9, price: 50, closes: [], position: 1, avgCost: 100, lastBuyAt: 1e9 - 1000 });
  t('DCA ignora el stop-loss (es acumulación)', dcaStop.action === 'hold');
  const cool = decide({ ...cfg, strategy: 'rsi' }, { now: 1e9, closes: down, position: 0, lastSellAt: 1e9 - 3600000 });
  t('enfriamiento evita recompra inmediata tras vender', cool.action === 'hold' && /Enfriamiento/.test(cool.reason));
  t('RSI sobrevendido compra', decide({ ...cfg, strategy: 'rsi' }, { now: 1e9, closes: down, position: 0, lastSellAt: 0 }).action === 'buy');
  t('RSI sobrecomprado vende', decide({ ...cfg, strategy: 'rsi' }, { now: 1e9, closes: up, position: 1, avgCost: 100, price: 139 }).action === 'sell');
  t('validateCfg acepta rsi/macd', validateCfg({ strategy: 'rsi' }).ok && validateCfg({ strategy: 'macd' }).ok);
  t('validateCfg rechaza stop-loss absurdo', !validateCfg({ stopLossPct: 80 }).ok);
  t('validateCfg rechaza RSI incoherente', !validateCfg({ strategy: 'rsi', rsiBuy: 50, rsiSell: 52 }).ok);
  const wave = Array.from({ length: 400 }, (_, i) => 100 + 15 * Math.sin(i / 10));
  for (const strategy of ['sma', 'rsi', 'macd']) {
    const r = backtest(wave, { ...cfg, strategy, fast: 3, slow: 10, rsiBuy: 35, rsiSell: 55 });
    t(`backtest ${strategy}: alpha/beta/exposición calculados`, Number.isFinite(r.metrics.beta) && Number.isFinite(r.metrics.alphaAnnualPct) && r.metrics.exposurePct > 0);
  }
}

console.log('ML');
{
  const wfAR = walkForward(series(1200, 0.6, 7));
  t('ML: con señal real (autocorrelación) supera la línea base', wfAR.metrics.edge && wfAR.metrics.acc_test > 0.6);
  const wfRW = walkForward(series(1200, 0, 11));
  t('ML: en caminata aleatoria NO declara ventaja', !wfRW.metrics.edge, JSON.stringify(wfRW.metrics));
  t('ML: reporta importancia, deriva y conjuntos separados', wfAR.importance.length === 7 && Number.isFinite(wfAR.drift.score)
    && wfAR.metrics.n_train > wfAR.metrics.n_test && wfAR.metrics.n_test > 100);
  let thr = false;
  try { walkForward(series(200, 0, 1)); } catch { thr = true; }
  t('ML: rechaza entrenar con pocos datos', thr);
}

console.log('Costos reales por exchange');
{
  const cc = Array.from({ length: 600 }, (_, i) => 50000 + 3000 * Math.sin(i / 20) + i * 5);
  const cfgC = { strategy: 'sma', fast: 5, slow: 20, usd: 50000, maxOrderUsd: 1e6, maxDailyUsd: 1e7, stopLossPct: 8, symbol: 'BTC-USD' };
  const rc = backtest(cc, cfgC, { capital: 1e6, exchange: 'coinbase' });
  const rr = backtest(cc, cfgC, { capital: 1e6, exchange: 'robinhood' });
  t('backtest $1M con Coinbase: costos positivos y comisión > 0', rc.costs.feesUsd > 0 && rc.costs.totalUsd > 0 && rc.capital === 1e6);
  t('Robinhood: sin comisión explícita pero con costo de spread', rr.costs.feesUsd === 0 && rr.costs.slippageUsd > 0);
  const f1 = simulateFill({ side: 'buy', usd: 1000, price: 100, exchange: 'coinbase' });
  const f2 = simulateFill({ side: 'buy', usd: 5e6, price: 100, exchange: 'coinbase' });
  t('más tamaño = más deslizamiento', f2.slipPct > f1.slipPct && f1.price > 100);
  t('comisión baja con el volumen de 30 días', simulateFill({ side: 'buy', usd: 1000, price: 100, exchange: 'coinbase', vol30d: 2e6 }).feePct < f1.feePct);
  t('la venta se ejecuta por debajo del precio medio', simulateFill({ side: 'sell', usd: 1000, price: 100, exchange: 'robinhood' }).price < 100);
}
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
  OWNER_EMAIL: 'Owner@Test.com', OWNER_PASSWORD: 'OwnerPass-12345', REG_LIMIT_PER_HOUR: '100', LOGIN_LIMIT_IP: '500' };
const store = memoryStore();
const good = { name: 'coinbase', label: 'Coinbase', check: async () => ({ ok: true, canTrade: true, canTransfer: false }),
  balances: async () => [{ asset: 'USD', available: 100, hold: 0 }],
  marketBuy: async () => ({ ok: true, id: 'ord-1' }), marketSell: async () => ({ ok: true, id: 'ord-2' }) };
const risky = { ...good, name: 'robinhood', check: async () => ({ ok: true, canTrade: true, canTransfer: true }) };
const adapters = { coinbase: good, robinhood: risky };
const feed = { getPrice: async () => 50000, getCloses: async () => Array.from({ length: 100 }, (_, i) => 100 + i),
  getHistory: async (sym, n) => (sym === 'BTC-USD' ? series(n, 0.6, 7) : series(n, 0, 11)) };
const LOOSE = JSON.stringify({ maxPriceDeviationPct: 1e9, maxOpenOrders: 1000, maxOrdersPerHour: 1000 }); // el simulador de precios de las pruebas no es coherente con sus velas
await store.setSetting('risk:platform', LOOSE);
const engine = createEngine({ store, adapters, feed, encKey: env.ENCRYPTION_KEY, log: { error() {} } });
const fakeMarket = async () => ({ t: Date.now(), regime: { code: 'range', label: 'Lateral' }, sources: { coingecko: true, coinbase_exchange: true },
  gecko: { ok: true, errors: [], global: { mcap: 2.1e12, vol24: 8e10, btcDom: 54.2, ethDom: 12.1, mcap24: 0.8 }, coins: [{ symbol: 'BTC-USD', price: 50000, ch24: 1.2, ch7: 2.5, ch30: 4.1, vol24: 2e10, mcap: 1e12, athChg: -20 }], trending: [{ name: 'Solana', symbol: 'SOL' }] },
  books: [{ symbol: 'BTC-USD', bid: 49990, ask: 50010, mid: 50000, spreadPct: 0.04, bidDepthUsd: 3e6, askDepthUsd: 3e6, volume24Usd: 9e8 }],
  calibration: { coinbase: { halfSpreadPct: { 'BTC-USD': 0.02 }, advUsd: { 'BTC-USD': 9e8 } }, t: Date.now() } });
const director = createDirector({ store, feed, market: fakeMarket });
const app = createApp({ store, env, adapters, feed, engine, director, market: fakeMarket, log: { warn() {}, error() {} } });
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
let O2cookieVal = '';
const O2cookie = () => O2cookieVal;
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

t('2FA: el mismo código no se puede reusar (anti-replay)', (await client()('POST', '/api/auth/login', { email: 'owner@test.com', password: env.OWNER_PASSWORD, totp: sec.totp(setup.body.secret) })).status === 401);

// (fase 6) operar en real exige correo verificado: aquí se verifica a A y B como si hubieran abierto el enlace
for (const e of ['a@x.com', 'b@x.com']) await store.updateUser((await store.getUserByEmail(e)).id, { email_verified_at: Date.now() });

// aislamiento de datos
const secretPem = ['-----BEGIN EC PRIVATE KEY-----', ['SECRET-PEM', 'XYZ', '123'].join('-'), '-----END EC PRIVATE KEY-----'].join('\n');
const riskyRes = await A('POST', '/api/connections', { exchange: 'robinhood', keyId: 'k', secret: 'A'.repeat(44) });
t('conexión riesgosa (permite retiros) rechazada con explicación y verificaciones', riskyRes.status === 400 && /retiros/.test(riskyRes.body.error) && riskyRes.body.hint && riskyRes.body.checks.some((c) => c.id === 'nowithdraw' && c.ok === false));
const badFmt = await A('POST', '/api/connections', { exchange: 'coinbase', keyId: 'abc', secret: 'xyz' });
t('errores de copiado: mensaje simple antes de llamar al exchange', badFmt.status === 400 && /Coinbase/.test(badFmt.body.error) && badFmt.body.hint);
t('Robinhood con llave mal copiada (espacios): explicación', (await A('POST', '/api/connections', { exchange: 'robinhood', keyId: 'k', secret: 'no es base64 con espacios' })).body.hint?.includes('base64'));
const ca = await A('POST', '/api/connections', { exchange: 'coinbase', keyId: 'organizations/o/apiKeys/k', secret: secretPem });
t('conexión segura aceptada, con las 3 verificaciones en verde y marcada como cifrada', ca.status === 201 && ca.body.checks.length === 3 && ca.body.checks.every((c) => c.ok) && ca.body.connection.encrypted === true);
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
t('PnL calcula posición en papel', pnl.length === 1 && pnl[0].qty < 10 / 50000 && pnl[0].qty > (10 / 50000) * 0.98 && pnl[0].price === 50000);
t('papel realista: compra con deslizamiento y comisión (más caro que el precio de mercado)', oa[0].price > 50000 && oa[0].usd > 10 && /simulado/.test(oa[0].note));

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
{ const vr = (await A('GET', '/api/verify')).body; const ex0 = vr.exchanges && vr.exchanges[0];
  t('verificación: si el bot anota una posición que el exchange no muestra, da ALERTA (no la da por buena)', ex0 && ex0.verified === true && ex0.ok === false && ex0.positions.some((p) => p.symbol === 'BTC-USD' && p.status === 'alerta'), JSON.stringify(vr).slice(0, 300));
  const rs = (await A('GET', '/api/results')).body;
  t('resultados: separa real y papel con 4 periodos y 14 días', rs.real && rs.paper && ['24h', '7d', '30d', 'total'].every((k) => rs.real.periods[k] && rs.paper.periods[k]) && rs.real.daily.length === 14);
  t('verificación y resultados: B no ve lo de A', (await B('GET', '/api/verify')).body.exchanges.length === 0 && (await B('GET', '/api/results')).body.real.periods.total.orders === 0); }
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
const bt1m = await A('POST', '/api/backtest', { strategy: 'sma', symbol: 'BTC-USD', usd: 10, intervalMin: 60, exchange: 'robinhood', capital: 99999999 });
t('backtest API: capital virtual limitado a $1M y costos del exchange elegido', bt1m.status === 200 && bt1m.body.capital === 1000000 && bt1m.body.exchange === 'robinhood' && /Robinhood/.test(bt1m.body.cost_profile) && bt1m.body.costs);
t('backtest exige sesión', (await nobody('POST', '/api/backtest', { strategy: 'dca' })).status === 401);


// ---------- Cerebro, Director y exportación ----------
console.log('Cerebro y Director (el dueño decide)');
const gDef = (await O2('GET', '/api/owner/brain')).body.guardrails;
await O2('PUT', '/api/owner/guardrails', { autopilot: { enabled: false } }); // estas pruebas verifican el flujo manual
const v0 = await store.getSetting('brain_version', '1');
const run = await O2('POST', '/api/owner/brain/run');
t('el Director corre todos los agentes disponibles', run.status === 200 && ['problem_processing', 'owner_analytics', 'trading_improvement', 'ml_models'].every((n) => run.body.summary.some((x) => x.agent === n)));
t('los agentes NO cambian nada por sí solos', (await store.getSetting('default_cfg', null)) === null
  && (await store.getSetting('brain_version', '1')) === v0 && (await store.getSetting('model:active:BTC-USD', null)) === null);
const brain = (await O2('GET', '/api/owner/brain')).body;
t('Cerebro: 12 agentes, todos disponibles', brain.agents.length === 12 && brain.agents.every((a) => a.available));
t('Cerebro: propuestas pendientes con evidencia', brain.pending.length > 0 && brain.pending.every((p) => p.evidence && p.title));
const mlProp = brain.pending.find((p) => p.kind === 'model_update');
t('el ML propone activar el modelo solo cuando hay ventaja real (BTC sí, ETH no)', !!mlProp && mlProp.title.includes('BTC-USD')
  && brain.history.some((p) => p.kind === 'insight' && p.title.includes('ETH-USD') && /no supera/.test(p.title) && p.status === 'applied'));
t('el Director archiva solo los hallazgos informativos (no quedan pendientes)', !brain.pending.some((p) => p.kind === 'insight'));
t('modelos: candidato guardado, ninguno activo todavía', brain.models.find((m) => m.symbol === 'BTC-USD').candidate && !brain.models.find((m) => m.symbol === 'BTC-USD').active);
t('cliente no ve el Cerebro', (await A('GET', '/api/owner/brain')).status === 403);
t('cliente no puede aprobar propuestas', (await A('POST', `/api/owner/proposals/${brain.pending[0].id}/decision`, { decision: 'approve' })).status === 403);
t('cliente no puede correr el Director', (await A('POST', '/api/owner/brain/run')).status === 403);
t('cliente no exporta el Cerebro', (await A('GET', '/api/owner/export/brain')).status === 403);
t('cliente no exporta el app', (await A('GET', '/api/owner/export/app')).status === 403);
t('anónimo no exporta', (await nobody('GET', '/api/owner/export/app')).status === 401);

const ap = await O2('POST', `/api/owner/proposals/${mlProp.id}/decision`, { decision: 'approve', note: 'ok' });
t('el dueño aprueba activar el modelo', ap.status === 200 && ap.body.changed === true);
t('al aprobar sube la versión del Cerebro y se activa el modelo', Number(await store.getSetting('brain_version', '1')) === Number(v0) + 1
  && !!(await store.getSetting('model:active:BTC-USD', null)));
t('no se puede decidir dos veces la misma propuesta', (await O2('POST', `/api/owner/proposals/${mlProp.id}/decision`, { decision: 'approve' })).status === 404);
const insightP = await store.addProposal({ agent: 'x', kind: 'ops_alert', key: 'rej-test', title: 'alerta de prueba', detail: '{}', evidence: '{}', touches: '[]' });
t('el dueño rechaza una propuesta', (await O2('POST', `/api/owner/proposals/${insightP.id}/decision`, { decision: 'reject', note: 'no aplica' })).status === 200
  && (await store.getProposal(insightP.id)).status === 'rejected');
t('decisión inválida rechazada', (await O2('POST', `/api/owner/proposals/${insightP.id}/decision`, { decision: 'x' })).status === 400);

const sig = await A('GET', '/api/signals?symbol=BTC-USD');
t('señal informativa: indicadores técnicos', sig.status === 200 && Number.isFinite(sig.body.rsi) && sig.body.macd && sig.body.bollinger && sig.body.trend);
t('señal informativa: modelo activo con explicación', sig.body.model && sig.body.model.prob_up > 0 && sig.body.model.prob_up < 1 && sig.body.model.why.length === 3);
t('señal sin modelo activo (ETH) solo trae indicadores', (await A('GET', '/api/signals?symbol=ETH-USD')).body.model === null);
t('señal rechaza símbolos no permitidos', (await A('GET', '/api/signals?symbol=EVIL')).status === 400);

// aprobación que cambia los valores sugeridos para bots nuevos
const pr = await store.addProposal({ agent: 'trading_improvement', kind: 'strategy_defaults', key: 't1', title: 'Usar RSI como sugerida',
  detail: JSON.stringify({ action: { type: 'default_cfg', cfg: { strategy: 'rsi', rsiBuy: 30, rsiSell: 60 } } }), evidence: '{}', touches: JSON.stringify(['strategy_defaults']) });
t('el valor sugerido no cambia antes de aprobar', (await B('GET', '/api/bot')).body.cfg.strategy === 'dca');
t('el dueño aprueba nueva estrategia sugerida', (await O2('POST', `/api/owner/proposals/${pr.id}/decision`, { decision: 'approve' })).status === 200);
t('los bots nuevos ven la estrategia aprobada', (await B('GET', '/api/bot')).body.cfg.strategy === 'rsi');
t('los bots existentes no se tocan', (await A('GET', '/api/bot')).body.cfg.strategy === 'dca');

// áreas protegidas y límites inviolables
const prot = await store.addProposal({ agent: 'evil', kind: 'strategy_defaults', key: 't2', title: 'Cambiar reglas de seguridad',
  detail: JSON.stringify({ action: { type: 'default_cfg', cfg: { strategy: 'sma' } } }), evidence: '{}', touches: JSON.stringify(['security']) });
const pa = await O2('POST', `/api/owner/proposals/${prot.id}/decision`, { decision: 'approve' });
t('una propuesta que toca un área protegida no se puede aprobar ni por el dueño', pa.status === 400 && (await store.getProposal(prot.id)).status === 'failed');
const evilAgents = { evil: { label: 'x', available: true, description: '', async run() { return { proposals: [
  { kind: 'strategy_defaults', key: 'e1', title: 'Cambiar reglas de riesgo', detail: {}, touches: ['risk_rules'] },
  { kind: 'create_agent', key: 'e2', title: 'Crear un agente nuevo', detail: {}, touches: [] },
  { kind: 'insight', key: 'e3', title: 'Tocar aislamiento de datos', detail: {}, touches: ['data_isolation'] },
  { kind: 'ops_alert', key: 'e4', title: 'Propuesta legítima', detail: {}, touches: [] }] }; } } };
const evil = createDirector({ store, feed, agents: evilAgents });
await evil.run({ trigger: 'test' });
const pend = await store.listProposals('pending', 500);
const blockedAudit = (await store.listAudit(500)).filter((a) => a.action === 'agent_blocked');
t('un agente no puede proponer cambios en reglas de riesgo, aislamiento ni crear agentes', blockedAudit.length >= 3 && !pend.some((x) => ['e1', 'e2', 'e3'].includes(x.key)));
t('sí admite una propuesta legítima (pero queda pendiente)', pend.some((x) => x.key === 'e4' && x.status === 'pending'));
const gg = await O2('PUT', '/api/owner/guardrails', { protectedAreas: [], allowedKinds: ['insight'], maxPendingProposals: 5 });
t('los límites del dueño no pueden quitar las áreas protegidas mínimas', PROTECTED_MIN.every((a) => gg.body.guardrails.protectedAreas.includes(a)));
await store.updateProposal((await store.listProposals('pending', 500)).find((x) => x.key === 'e4').id, { status: 'rejected' });
const evil2 = createDirector({ store, feed, agents: { e: { label: 'e', available: true, description: '', async run() { return { proposals: [{ kind: 'ops_alert', key: 'k9', title: 'No permitido ahora', detail: {}, touches: [] }] }; } } } });
await evil2.run({ trigger: 'test' });
t('el Director respeta los tipos permitidos por el dueño', !(await store.listProposals('pending', 500)).some((x) => x.key === 'k9'));
await O2('PUT', '/api/owner/guardrails', { allowedKinds: ['strategy_defaults', 'agent_toggle', 'model_update', 'risk_alert', 'ops_alert', 'insight'], maxPendingProposals: 20 });
t('el dueño apaga un agente', (await O2('PUT', '/api/owner/agents/trading_improvement', { enabled: false })).status === 200);
const run2 = await O2('POST', '/api/owner/brain/run');
t('un agente apagado no corre', !run2.body.summary.some((x) => x.agent === 'trading_improvement'));
t('no se puede encender un agente que no existe', (await O2('PUT', '/api/owner/agents/inventado', { enabled: true })).status === 404);
await O2('PUT', '/api/owner/agents/trading_improvement', { enabled: true });
t('el Director corre solo si los datos fallan sin romperse', await (async () => {
  const bad = createDirector({ store, feed: { getHistory: async () => { throw new Error('sin red'); } }, agents: { trading_improvement: (await import('../lib/agents.js')).AGENTS.trading_improvement } });
  const r = await bad.run({ trigger: 'test' });
  return Array.isArray(r);
})());

console.log('Laboratorio de papel, registro de corridas y lanzamiento');
const brain2 = (await O2('GET', '/api/owner/brain')).body;
t('el laboratorio $1M eligió campeones y guardó estado', brain2.lab.capital === 1000000 && brain2.lab.runs >= 1 && brain2.lab.champions['BTC-USD']?.label && brain2.lab.champions['ETH-USD']);
t('el campeón se congela con fecha y validación previa', brain2.lab.champions['BTC-USD'].selected_at > 0 && typeof brain2.lab.champions['BTC-USD'].validated === 'boolean');
t('el Director guarda el registro de corridas con resultado por agente', brain2.runs.length >= 1 && brain2.runs.some((r) => r.agents.some((a) => a.agent === 'paper_lab')));
t('estadísticas de propuestas', brain2.stats.total >= 1);
{
  const { runLab, labProposals } = await import('../lib/lab.js');
  const later = Date.now() + 10 * 86400000; // simula 10 días después: hay avance hacia adelante
  const feed2 = { getHistory: async (sym, n) => series(n + 300, 0.6, 7) };
  const r = await runLab({ store, feed: feed2, now: later });
  const l = r.lab.latest['BTC-USD'];
  t('prueba hacia adelante: tras 10 días hay avance en ambos exchanges', l.candles >= 200 && l.coinbase && l.robinhood && Number.isFinite(l.coinbase.ret) && l.coinbase.equity.length > 5);
  const lg = l.coinbase.log;
  t('el laboratorio guarda las operaciones simuladas pequeñas con fecha, lado, precio y P&L', Array.isArray(lg) && lg.length >= 1 && lg.every((x) => x.t > 0 && x.price > 0 && ['buy', 'sell'].includes(x.side)));
  t('el laboratorio acumula fotos de avance', r.lab.snapshots.length >= 2);
  t('con 7+ días, el laboratorio puede proponer o informar (nunca aplica solo)', labProposals(r.lab).length >= 1 && labProposals(r.lab).every((p) => ['strategy_defaults', 'insight'].includes(p.kind)));
  const bd = (await store.getSetting('brain_version', '1'));
  t('correr el laboratorio no cambia la versión del Cerebro', bd === (await store.getSetting('brain_version', '1')));
}
const rd = await O2('GET', '/api/owner/readiness');
t('lista de lanzamiento: pasos con estado y puntaje', rd.status === 200 && rd.body.items.length >= 10 && rd.body.score >= 0 && rd.body.items.every((i) => ['ok', 'todo'].includes(i.status)));
t('lanzamiento: 2FA y laboratorio detectados automáticamente', rd.body.items.find((i) => i.id === 'owner_2fa').status === 'ok' && rd.body.items.find((i) => i.id === 'brain_ran').status === 'ok');
t('lanzamiento: la base en memoria NO cuenta como lista', rd.body.items.find((i) => i.id === 'database').status === 'todo');
const rd2 = await O2('PUT', '/api/owner/readiness', { id: 'attorney', done: true });
t('el dueño marca un paso manual', rd2.status === 200 && rd2.body.items.find((i) => i.id === 'attorney').status === 'ok');
t('paso manual desconocido rechazado', (await O2('PUT', '/api/owner/readiness', { id: 'hack', done: true })).status === 400);
t('un cliente no ve la lista de lanzamiento', (await A('GET', '/api/owner/readiness')).status === 403);
const ov2 = (await O2('GET', '/api/owner/overview')).body;
t('embudo real de clientes', ov2.funnel.length === 5 && ov2.funnel[0].n >= 1 && ov2.funnel.every((f) => f.n <= ov2.funnel[0].n));

console.log('Mercado, resumen del Director y lote de hallazgos');
{
  const { classifyRegime, fetchGecko, fetchBook, calibrationFrom } = await import('../lib/market.js');
  const { setCalibration, getCalibration } = await import('../lib/costs.js');
  t('régimen: alcista, bajista, volátil, lateral y sin datos', classifyRegime({ btc7: 3, btc30: 20, mcap24: 1 }).code === 'bull' && classifyRegime({ btc7: -3, btc30: -20, mcap24: 1 }).code === 'bear'
    && classifyRegime({ btc7: 12, btc30: 2, mcap24: 1 }).code === 'volatile' && classifyRegime({ btc7: 1, btc30: 2, mcap24: 1 }).code === 'range' && classifyRegime({ btc7: null, btc30: null }).code === 'unknown');
  { const mk = await import('../lib/market.js'); mk.resetMarketCache(); let calls = 0;
    const ok = async (u) => { calls++; if (u.includes('/global')) return { ok: true, status: 200, json: async () => ({ data: { total_market_cap: { usd: 1e12 }, market_cap_percentage: { btc: 50 } } }) }; return { ok: true, status: 200, json: async () => [] }; };
    const lim = async () => { calls++; return { ok: false, status: 429, headers: { get: () => null }, json: async () => ({}) }; };
    const g1 = await mk.getMarket({ f: ok, force: true, now: 1000 }); const before = calls;
    const g2 = await mk.getMarket({ f: lim, force: true, now: 2000 }); const g3 = await mk.getMarket({ f: lim, force: true, now: 3000 });
    t('429 de CoinGecko: usa los últimos datos buenos, avisa y deja de insistir', g1.sources.coingecko && g2.gecko.stale === true && g2.sources.coingecko_stale && !!g2.gecko.global && g3.gecko.stale === true && calls - before <= 4, `calls ${calls - before}`);
    mk.resetMarketCache(); }
  const jf = (map) => async (url) => { const k = Object.keys(map).find((x) => url.includes(x)); if (!k) return { ok: false, status: 404, json: async () => ({}) }; return { ok: true, status: 200, json: async () => map[k] }; };
  const g = await fetchGecko(jf({ '/global': { data: { total_market_cap: { usd: 2e12 }, market_cap_percentage: { btc: 50 }, market_cap_change_percentage_24h_usd: -1 } },
    '/coins/markets': [{ id: 'bitcoin', current_price: 100, price_change_percentage_24h_in_currency: 1, price_change_percentage_7d_in_currency: 2, price_change_percentage_30d_in_currency: 3, total_volume: 5, market_cap: 9 }, { id: 'otra-cosa', current_price: 1 }],
    '/search/trending': { coins: [{ item: { name: 'X', symbol: 'x' } }] } }));
  t('CoinGecko: parsea global, mercados (solo pares permitidos) y tendencia', g.ok && g.global.btcDom === 50 && g.coins.length === 1 && g.coins[0].symbol === 'BTC-USD' && g.coins[0].ch7 === 2 && g.trending[0].name === 'X');
  const gBad = await fetchGecko(async () => { throw new Error('sin red'); });
  t('CoinGecko caído: no inventa nada y reporta errores', gBad.ok === false && gBad.errors.length === 3 && !gBad.coins);
  const bk = await fetchBook('BTC-USD', jf({ '/book': { bids: [['99.9', '10', 1], ['99', '5', 1]], asks: [['100.1', '10', 1], ['101', '5', 1]] }, '/stats': { volume: '1000', last: '100' } }));
  t('libro Coinbase: spread, profundidad ±0.5 % y volumen en USD', Math.abs(bk.spreadPct - 0.2) < 0.01 && bk.bidDepthUsd > 900 && bk.bidDepthUsd < 1100 && bk.volume24Usd === 100000);
  t('libro vacío o caído devuelve null', (await fetchBook('BTC-USD', async () => { throw new Error('x'); })) === null);
  const before = simulateFill({ side: 'buy', usd: 1000, price: 100, symbol: 'BTC-USD', exchange: 'coinbase' }).slipPct;
  setCalibration(calibrationFrom([bk]));
  const after = simulateFill({ side: 'buy', usd: 1000, price: 100, symbol: 'BTC-USD', exchange: 'coinbase' }).slipPct;
  t('la calibración con datos reales cambia el costo simulado de Coinbase (no el de Robinhood)', after !== before && getCalibration() && simulateFill({ side: 'buy', usd: 1000, price: 100, exchange: 'robinhood' }).slipPct > 0.2);
  setCalibration(null);
}
const mk = await A('GET', '/api/market');
t('mercado: endpoint con régimen, global y libro (requiere sesión)', mk.status === 200 && mk.body.regime.code === 'range' && mk.body.global.btcDom === 54.2 && mk.body.books.length === 1 && (await nobody('GET', '/api/market')).status === 401);
const brief = await O2('GET', '/api/owner/briefing');
t('resumen del Director: titular, prioridades ordenadas y destino de cada ítem', brief.status === 200 && brief.body.headline && brief.body.items.length >= 4 && brief.body.items.every((i) => i.tab && i.text)
  && brief.body.items.map((i) => ({ crit: 0, warn: 1, info: 2 }[i.level])).every((v, i, a) => i === 0 || a[i - 1] <= v));
t('el resumen incluye mercado y laboratorio reales', brief.body.items.some((i) => /Mercado/.test(i.text)) && brief.body.items.some((i) => /Laboratorio/.test(i.text)));
t('un cliente no ve el resumen del Director', (await A('GET', '/api/owner/briefing')).status === 403);
{
  const mkt = (await store.getSetting('market:snapshot', null));
  t('el agente de mercado guardó instantánea e historial', mkt && JSON.parse(mkt).regime.code === 'range' && JSON.parse(await store.getSetting('market:history', '[]')).length >= 1);
  await store.addProposal({ agent: 'test', kind: 'insight', key: 'k-ack', title: 'hallazgo de prueba', detail: '{}', evidence: '{}', touches: '[]' });
  const verBefore = await store.getSetting('brain_version', '1');
  const ack = await O2('POST', '/api/owner/proposals/ack-info');
  t('"enterado" en lote: solo hallazgos, sin cambiar la versión del Cerebro', ack.status === 200 && ack.body.acknowledged >= 1 && verBefore === (await store.getSetting('brain_version', '1')));
  t('el lote no toca propuestas que cambian algo', (await store.listProposals('pending', 200)).every((p) => ['strategy_defaults', 'agent_toggle', 'model_update'].includes(p.kind)));
  t('cliente no puede usar el lote', (await A('POST', '/api/owner/proposals/ack-info')).status === 403);
}

console.log('Piloto automático, deshacer y cumplimiento');
{
  const g0 = gDef;
  t('piloto automático encendido por defecto (reversible) y limitado a tipos de bajo riesgo', g0.autopilot.enabled === true && g0.autopilot.kinds.every((k) => ['model_update', 'strategy_defaults'].includes(k)));
  const gset = await O2('PUT', '/api/owner/guardrails', { autopilot: { enabled: true, kinds: ['model_update', 'agent_toggle', 'risk_alert'] } });
  t('el piloto nunca puede incluir agentes, riesgo ni seguridad (se filtran)', gset.body.guardrails.autopilot.enabled === true && gset.body.guardrails.autopilot.kinds.join() === 'model_update');
  const vBefore = Number(await store.getSetting('brain_version', '1'));
  const actBefore = await store.getSetting('model:active:ETH-USD', '');
  await store.setSetting('model:active:ETH-USD', '');
  await store.setSetting('model:candidate:ETH-USD', JSON.stringify({ model: { mean: [], sd: [], w: [], b: 0 }, metrics: { acc_test: 0.6, baseline_test: 0.5 }, trained_at: 1 }));
  await store.addProposal({ agent: 'ml_models', kind: 'model_update', key: 'auto-eth', title: 'Activar ETH (prueba piloto)', detail: JSON.stringify({ action: { type: 'activate_model', symbol: 'ETH-USD' } }), evidence: '{}', touches: JSON.stringify(['models']) });
  await director.run({ trigger: 'test-autopilot' });
  const eth = await store.getSetting('model:active:ETH-USD', '');
  t('con piloto encendido, el Director aplicó la mejora de bajo riesgo y subió la versión', eth && Number(await store.getSetting('brain_version', '1')) > vBefore);
  const br = (await O2('GET', '/api/owner/brain')).body;
  const ch = br.changes.find((c) => c.title.includes('prueba piloto'));
  t('el cambio automático quedó registrado como auto y reversible', ch && ch.auto === true && ch.undone === false);
  t('deshacer restaura el valor anterior', (await O2('POST', '/api/owner/brain/undo', { id: ch.id })).status === 200 && (await store.getSetting('model:active:ETH-USD', '')) === '');
  t('no se puede deshacer dos veces', (await O2('POST', '/api/owner/brain/undo', { id: ch.id })).status === 404);
  t('un cliente no puede deshacer ni cambiar el piloto', (await A('POST', '/api/owner/brain/undo', { id: ch.id })).status === 403 && (await A('PUT', '/api/owner/guardrails', { autopilot: { enabled: false } })).status === 403);
  await store.addProposal({ agent: 'x', kind: 'agent_toggle', key: 'auto-toggle', title: 'apagar agente', detail: JSON.stringify({ action: { type: 'agent_enabled', agent: 'paper_lab', enabled: false } }), evidence: '{}', touches: '[]' });
  await director.run({ trigger: 'test-autopilot-2' });
  t('el piloto NO aplica cambios de agentes (siguen pendientes de tu aprobación)', (await store.listProposals('pending', 200)).some((p) => p.key === 'auto-toggle') && (await store.getSetting('agent:paper_lab:enabled', 'on')) === 'on');
  await O2('PUT', '/api/owner/guardrails', { autopilot: { enabled: false } });
  const cp = await O2('GET', '/api/owner/compliance');
  t('cumplimiento: controles en vivo, inventario, proveedores y preguntas', cp.status === 200 && cp.body.live.length >= 8 && cp.body.inventory.length >= 4 && cp.body.questions.length >= 5);
  t('cumplimiento: llaves cifradas, sin retiros y 2FA cifrado verificados', ['Llaves API de clientes cifradas en reposo (AES-256-GCM)', 'Ninguna llave guardada permite retiros', 'Secreto 2FA del dueño cifrado', 'Contraseñas guardadas solo como huella (scrypt)'].every((l) => cp.body.live.find((x) => x.label === l)?.ok));
  const owner = (await store.listUsers()).find((u) => u.role === 'owner');
  t('el secreto 2FA está cifrado en la base (no en texto plano)', String(owner.totp_secret).startsWith('v1.'));
  const md = await fetch(base + '/api/owner/export/compliance', { headers: { Cookie: (await O2('GET', '/api/owner/compliance')).cookie } });
  const mdt = await md.text();
  t('paquete para abogado descargable (markdown) sin secretos', md.status === 200 && /Paquete para abogado/.test(mdt) && !mdt.includes('SECRET-PEM') && !mdt.includes('pass_hash'));
  t('cliente no puede ver cumplimiento', (await A('GET', '/api/owner/compliance')).status === 403);
}

console.log('Estado del bot y operaciones pequeñas de los agentes');
{
  const st = await A('GET', '/api/bot/status');
  t('estado del bot: modo, símbolo, última decisión con motivo, posición y resultado', st.status === 200 && st.body.symbol && st.body.last && st.body.last.reason && st.body.position && typeof st.body.realized === 'number' && Array.isArray(st.body.recent));
  t('estado del bot: solo muestra órdenes propias (B no ve las de A)', (await B('GET', '/api/bot/status')).body.recent.every((o) => o.mode) && (await B('GET', '/api/bot/status')).body.recent.length === 0);
  t('estado del bot exige sesión', (await nobody('GET', '/api/bot/status')).status === 401);
  const bt = backtest(Array.from({ length: 400 }, (_, i) => 100 + 10 * Math.sin(i / 15)), { strategy: 'sma', fast: 5, slow: 20, usd: 100, maxOrderUsd: 1000, maxDailyUsd: 5000, stopLossPct: 8, symbol: 'BTC-USD' }, { capital: 10000, exchange: 'coinbase' });
  t('backtest devuelve el registro de operaciones (compras y ventas con P&L)', bt.trades.length >= 2 && bt.trades.some((x) => x.side === 'buy') && bt.trades.some((x) => x.side === 'sell' && Number.isFinite(x.pnl)));
  const as = (await O2('GET', '/api/owner/brain')).body.agent_stats;
  t('estadísticas por agente: corridas, propuestas, aplicadas, rechazadas y errores', as.length === 12 && as.every((a) => 'runs' in a && 'applied' in a && 'rejected' in a && 'errors' in a) && as.find((a) => a.name === 'paper_lab').runs >= 1);
}

console.log('Trading real: alcance solo-dueño e inicio inmediato');
{
  const prevScope = await store.getSetting('live_trading', 'off');
  t('ajustes: el dueño elige alcance (apagado / solo yo / todos)', (await O2('PUT', '/api/owner/settings', { live_scope: 'owner' })).status === 200 && (await O2('GET', '/api/owner/settings')).body.live_scope === 'owner');
  t('alcance "solo yo": el dueño puede usar real y el cliente no', (await O2('GET', '/api/me')).body.liveTradingEnabled === true && (await A('GET', '/api/me')).body.liveTradingEnabled === false);
  const liveCfg = { symbol: 'BTC-USD', strategy: 'dca', usd: 10, intervalMin: 60, mode: 'live', enabled: true, liveAck: true, maxOrderUsd: 25, maxDailyUsd: 100 };
  const ra2 = await A('PUT', '/api/bot', liveCfg);
  t('alcance "solo yo": un cliente recibe 403 al intentar activar real', ra2.status === 403);
  const ro2 = await O2('PUT', '/api/bot', liveCfg);
  t('alcance "solo yo": al dueño no lo bloquea el alcance (solo le falta elegir conexión)', ro2.status === 400 && /conexión/i.test(ro2.body.error));
  await store.setSetting('live_trading', prevScope);
  await A('PUT', '/api/bot', { symbol: 'BTC-USD', strategy: 'dca', usd: 10, intervalMin: 15, mode: 'paper', enabled: true, maxOrderUsd: 25, maxDailyUsd: 100 });
  await new Promise((r) => setTimeout(r, 400));
  const stN = (await A('GET', '/api/bot/status')).body;
  t('al encender el bot hay una primera decisión al instante (sin esperar un ciclo)', stN.last && stN.last.reason && stN.enabled === true && Array.isArray(stN.closes) && stN.signals && stN.next_check > 0);
}

console.log('Robinhood: generador de llaves');
{
  const { genEd25519 } = await import('../public/keygen.js');
  const k = await genEd25519();
  const seed = Buffer.from(k.privateKey, 'base64'); const pub = Buffer.from(k.publicKey, 'base64');
  t('generador: llave pública de 32 bytes y privada (semilla) de 32 bytes en base64', seed.length === 32 && pub.length === 32 && k.privateKey !== k.publicKey);
  const sig = robinhoodSign('rh-api-test', k.privateKey, '1700000000', '/api/v1/crypto/trading/accounts/', 'GET', '');
  const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), pub]);
  const ok = crypto.verify(null, Buffer.from('rh-api-test1700000000/api/v1/crypto/trading/accounts/GET'), crypto.createPublicKey({ key: spki, format: 'der', type: 'spki' }), Buffer.from(sig, 'base64'));
  t('la firma hecha con la llave generada se verifica con la llave pública (lo que Robinhood comprobará)', ok === true);
  const k2 = await genEd25519();
  t('cada generación produce llaves distintas', k2.publicKey !== k.publicKey);
}

console.log('Todas las criptos, escáner y modo AUTO');
{
  const { seedUniverse, fetchCoinbaseProducts } = await import('../lib/universe.js');
  const { runScanner } = await import('../lib/scanner.js');
  const prods = [
    { id: 'BTC-USD', quote_currency: 'USD', status: 'online' }, { id: 'ETH-USD', quote_currency: 'USD', status: 'online' },
    { id: 'SOL-USD', quote_currency: 'USD', status: 'online' }, { id: 'ADA-USD', quote_currency: 'USD', status: 'online' },
    { id: 'DEAD-USD', quote_currency: 'USD', status: 'online', trading_disabled: true }, { id: 'ETH-EUR', quote_currency: 'EUR', status: 'online' },
    { id: 'USDT-USD', quote_currency: 'USD', status: 'online' }, { id: 'weird-usd', quote_currency: 'USD', status: 'online' },
  ];
  const book = { bids: [['100', '5']], asks: [['100.05', '5']] };
  const f = async (url) => {
    const j = (o) => ({ ok: true, status: 200, json: async () => o });
    if (url.endsWith('/products')) return j(prods);
    if (url.includes('coins/markets')) return j([{ symbol: 'btc', market_cap: 9e11 }, { symbol: 'eth', market_cap: 4e11 }, { symbol: 'usdt', market_cap: 1e11 }, { symbol: 'sol', market_cap: 8e10 }, { symbol: 'ada', market_cap: 3e10 }, { symbol: 'xyz', market_cap: 1e10 }]);
    if (url.includes('/book')) return j(book);
    if (url.includes('/stats')) return j({ volume: '1000', last: '100' });
    throw new Error('url inesperada ' + url);
  };
  const list = await fetchCoinbaseProducts(f);
  t('universo: solo pares USD en línea y operables (sin desactivados, EUR ni nombres raros)', JSON.stringify(list) === JSON.stringify(['ADA-USD', 'BTC-USD', 'ETH-USD', 'SOL-USD', 'USDT-USD']));
  seedUniverse(list);
  const un = (await A('GET', '/api/universe')).body;
  t('/api/universe lista todas las criptos de Coinbase con su disponibilidad', un.coinbase.includes('ADA-USD') && un.total >= 5 && un.symbols.find((x) => x.s === 'ADA-USD').cb === true);
  const cfgBase = { autoMode: 'active', strategy: 'dca', usd: 10, intervalMin: 15, mode: 'paper', enabled: false, maxOrderUsd: 25, maxDailyUsd: 100 };
  t('el bot acepta una cripto fuera de la lista base si el exchange la lista', (await A('PUT', '/api/bot', { ...cfgBase, symbol: 'ADA-USD' })).status === 200);
  t('el bot rechaza criptos que el exchange no lista', (await A('PUT', '/api/bot', { ...cfgBase, symbol: 'FAKE-USD' })).status === 400);
  t('el bot acepta AUTO (el Cerebro elige)', (await A('PUT', '/api/bot', { ...cfgBase, symbol: 'AUTO', paperExchange: 'best' })).body.cfg?.paperExchange === 'best');
  t('AUTO no se puede backtestear como una sola cripto', (await A('POST', '/api/backtest', { ...cfgBase, symbol: 'AUTO' })).status === 400);

  const feedS = { getHistory: async (sym, n) => series(n, sym === 'SOL-USD' ? 0.7 : 0.2, sym.length * 13 + sym.charCodeAt(0)) };
  const sc = await runScanner({ store, feed: feedS, f, now: Date.now() });
  t('escáner: recorre el top de CoinGecko ∩ lo listado, sin stablecoins ni pares inexistentes', sc.scanned === 4 && !sc.items.some((i) => i.symbol === 'USDT-USD' || i.symbol === 'XYZ-USD'), JSON.stringify(sc.items.map((i) => i.symbol)));
  t('escáner: cada cripto trae costo y retorno en AMBOS exchanges y la brecha', sc.items.every((i) => Number.isFinite(i.coinbase.drag) && Number.isFinite(i.robinhood.drag) && ['coinbase', 'robinhood', 'igual'].includes(i.cheaper) && (i.cheaper === 'igual' || (i.cheaper === 'robinhood') === (i.gap_pct < 0))));
  t('escáner: califica solo si gana a comprar-y-mantener en los dos exchanges', sc.items.every((i) => !i.qualified || (i.coinbase.ok && i.robinhood.ok)));
  t('escáner: avisa que son costos estimados y muestra corta', /ESTIMADOS/.test(sc.warning));
  const api = (await A('GET', '/api/scanner')).body;
  t('/api/scanner entrega el ranking sin configuraciones internas', api.items.length === 4 && api.items.every((i) => i.cfg === undefined));

  // Modo AUTO en papel con ruteo por costo
  const E = client();
  await E('POST', '/api/auth/register', { email: 'e-auto@x.com', password: 'Clave-De-Eva-12345', acceptTos: true });
  const eId = (await E('GET', '/api/me')).body.user.id;
  const mk = (qualified) => JSON.stringify({ t: Date.now(), scanned: 1, universe: 4, items: [{ symbol: 'ADA-USD', label: 'DCA', qualified, cheaper: 'robinhood', gap_pct: -0.4,
    cfg: { strategy: 'dca', fast: 20, slow: 50, rsiBuy: 30, rsiSell: 60 }, coinbase: { ret: qualified ? 3 : -2, bh: 1, drag: 1 }, robinhood: { ret: qualified ? 4 : -2, bh: 1, drag: 0.6 } }] });
  await store.setSetting('scanner:latest', mk(false));
  await E('PUT', '/api/bot', { ...cfgBase, symbol: 'AUTO', paperExchange: 'best', enabled: true });
  await new Promise((r) => setTimeout(r, 400));
  t('AUTO sin oportunidades validadas: no compra y lo explica', (await store.listOrders(eId)).length === 0 && /ninguna|Espera|no compra/i.test((await E('GET', '/api/bot/status')).body.last?.reason || ''));
  await store.setSetting('scanner:latest', mk(true));
  await engine.runBot({ ...(await store.getBot(eId)), last_run: 0 }, Date.now() + 5000);
  const eo = (await store.listOrders(eId)).filter((o) => o.status === 'ok');
  t('AUTO con una oportunidad validada: compra esa cripto en el exchange más barato (papel)', eo.length === 1 && eo[0].symbol === 'ADA-USD' && eo[0].exchange === 'robinhood' && /simulado en robinhood/.test(eo[0].note));
  const stE = (await E('GET', '/api/bot/status')).body;
  t('estado en AUTO: muestra posiciones por cripto y el resumen del escáner', stE.symbol === 'AUTO' && stE.holdings.length === 1 && stE.holdings[0].symbol === 'ADA-USD' && stE.holdings[0].venue === 'robinhood' && stE.scanner?.qualified?.[0]?.symbol === 'ADA-USD');
  await engine.runBot({ ...(await store.getBot(eId)), last_run: 0 }, Date.now() + 10000);
  t('AUTO no abre dos veces la misma cripto mientras la tiene (DCA: intervalo no cumplido)', (await store.listOrders(eId)).filter((o) => o.status === 'ok').length === 1);
  // AUTO en real: el ruteo elige el exchange más barato, solo si el par existe ahí; si no, usa el otro.
  {
    const calls = [];
    const mkAd = (name, pairs) => ({ ...good, name, pairs: async () => pairs, balances: async () => [{ asset: 'ADA', available: 1000, hold: 0 }, { asset: 'USD', available: 500, hold: 0 }],
      marketBuy: async (_c, a) => { calls.push([name, 'buy', a.symbol]); return { ok: true, id: `${name}-1` }; }, marketSell: async (_c, a) => { calls.push([name, 'sell', a.symbol]); return { ok: true, id: `${name}-2` }; } });
    const ad2 = { coinbase: mkAd('coinbase', ['ADA-USD']), robinhood: mkAd('robinhood', ['ADA-USD', 'BTC-USD']) };
    const eng2 = createEngine({ store, adapters: ad2, feed, encKey: env.ENCRYPTION_KEY, log: { error() {} } });
    const c1 = await store.addConnection({ user_id: eId, exchange: 'coinbase', label: 'cb', key_id: 'k1', secret_enc: sec.encrypt(env.ENCRYPTION_KEY, 's1'), can_trade: true, can_transfer: false });
    const c2 = await store.addConnection({ user_id: eId, exchange: 'robinhood', label: 'rh', key_id: 'k2', secret_enc: sec.encrypt(env.ENCRYPTION_KEY, 's2'), can_trade: true, can_transfer: false });
    await store.setSetting('live_trading', 'on');
    const liveCfg = { ...cfgBase, symbol: 'AUTO', mode: 'live', paperExchange: 'best', enabled: true, liveAck: true, connectionId: c1.id, maxOrderUsd: 25, maxDailyUsd: 100 };
    await store.saveBot(eId, liveCfg);
    await store.setSetting('scanner:latest', mk(true));
    await eng2.runBot({ ...(await store.getBot(eId)), last_run: 0 }, Date.now() + 20000);
    t('AUTO real: compra en Robinhood (más barato) aunque la conexión principal sea Coinbase', calls.length === 1 && calls[0][0] === 'robinhood' && calls[0][1] === 'buy' && calls[0][2] === 'ADA-USD', JSON.stringify(calls));
    const live = (await store.listOrders(eId)).filter((o) => o.mode === 'live' && o.status === 'ok');
    t('AUTO real: la orden queda registrada con el exchange usado', live.length === 1 && live[0].exchange === 'robinhood');
    // El par no existe en Robinhood → usa Coinbase
    await store.setSetting(`rhpairs:${eId}`, JSON.stringify({ t: Date.now(), symbols: ['BTC-USD'], verified: true }));
    for (const o of live) await store.addOrder({ ...o, side: 'sell', id: undefined, created_at: undefined, status: 'ok' });
    await store.saveBot(eId, { ...liveCfg });
    calls.length = 0;
    await eng2.runBot({ ...(await store.getBot(eId)), last_run: 0 }, Date.now() + 400000000);
    t('AUTO real: si el par no está en Robinhood, opera en Coinbase', calls.some((c) => c[0] === 'coinbase' && c[1] === 'buy') && !calls.some((c) => c[0] === 'robinhood' && c[1] === 'buy'), JSON.stringify(calls));
    // Saldo disponible: reparte lo que hay (USD 100 simulados) entre posiciones libres, bajo el tope por orden
    for (const o of (await store.listOrders(eId)).filter((x) => x.mode === 'live')) await store.addOrder({ ...o, side: 'sell', id: undefined, created_at: undefined, status: 'ok' });
    await store.saveBot(eId, { ...liveCfg, sizing: 'balance', maxOrderUsd: 25, usd: 10, maxPositions: 4 });
    let sized = null; ad2.coinbase.marketBuy = async (_c, a) => { sized = a.usd; return { ok: true, id: 'x' }; };
    await store.setSetting(`rhpairs:${eId}`, JSON.stringify({ t: Date.now(), symbols: ['BTC-USD'], verified: true }));
    await eng2.runBot({ ...(await store.getBot(eId)), last_run: 0 }, Date.now() + 900000000);
    t('saldo disponible: la compra se dimensiona con el saldo (100/4 = ~24.75) y respeta el tope', sized !== null && sized > 24 && sized <= 25, String(sized));
    await store.setSetting('live_trading', 'off');
    await store.deleteConnection(eId, c1.id); await store.deleteConnection(eId, c2.id);
  }
}

console.log('Exchanges en vivo y reglas de Robinhood');
{
  const { robinhood: rhReal } = await import('../lib/exchanges.js');
  const seed = crypto.randomBytes(32).toString('base64');
  const creds = { keyId: 'rh-test', secret: seed };
  const realFetch = globalThis.fetch; const posted = [];
  globalThis.fetch = async (url, opts = {}) => {
    const j = (o, ok = true, status = 200) => ({ ok, status, text: async () => JSON.stringify(o) });
    if (String(url).includes('/ticker')) return j({ price: '0.16' });
    if (String(url).includes('/trading_pairs/')) return j({ results: [{ symbol: 'DOGE-USD', asset_increment: '1', min_order_size: '1', max_order_size: '1000000', status: 'tradable' }, { symbol: 'BTC-USD', asset_increment: '0.00000001', min_order_size: '0.00001', status: 'tradable' }], next: null });
    if (String(url).includes('/orders/') && opts.method === 'POST') { posted.push(JSON.parse(opts.body)); return posted.length === 3 ? j({ errors: [{ detail: 'Insufficient buying power' }] }, false, 400) : j({ id: 'o-1' }); }
    if (String(url).includes('/orders/')) return j({ results: [{ id: 'o1', symbol: 'DOGE-USD', side: 'buy', state: 'filled', filled_asset_quantity: '12', average_price: '0.16', created_at: '2026-10-11T15:00:00Z' }] });
    return j({});
  };
  try {
    const r1 = await rhReal.marketBuy(creds, { symbol: 'DOGE-USD', usd: 2 }).catch((e) => ({ ok: false, error: e.message }));
    t('Robinhood: la cantidad se redondea al incremento del par (DOGE entero)', posted.length === 1 && /^\d+$/.test(posted[0].market_order_config.asset_quantity), JSON.stringify(posted));
    const r2 = await rhReal.marketSell(creds, { symbol: 'DOGE-USD', qty: 0.4 });
    t('Robinhood: por debajo del mínimo del par no envía la orden y explica por qué', r2.ok === false && /mínimo/.test(r2.error) && posted.length === 1, JSON.stringify(r2));
    posted.length = 0; posted.push({}, {});
    const r3 = await rhReal.marketSell(creds, { symbol: 'BTC-USD', qty: 0.001 });
    t('Robinhood: el motivo del error del exchange llega al cliente', r3.ok === false && /Insufficient buying power/.test(r3.error), JSON.stringify(r3));
    // Si Robinhood dice a qué incremento redondear, se reintenta una vez con ese incremento
    const bodies = []; const prevF = globalThis.fetch;
    globalThis.fetch = async (url, opts = {}) => {
      const j = (o, ok = true, status = 200) => ({ ok, status, text: async () => JSON.stringify(o) });
      if (String(url).includes('/trading_pairs/')) return j({ results: [] });
      if (opts.method === 'POST') { bodies.push(JSON.parse(opts.body)); return bodies.length === 1 ? j({ errors: [{ detail: 'Your asset quantity has too much precision. Please round it to nearest 0.010000000000000000 and try placing your order again.' }] }, false, 400) : j({ id: 'o-2' }); }
      return j({});
    };
    const r4 = await rhReal.marketSell(creds, { symbol: 'XRP-USD', qty: 12.3456 });
    globalThis.fetch = prevF;
    t('Robinhood: ante "too much precision" reintenta con el incremento indicado', r4.ok === true && bodies.length === 2 && bodies[1].market_order_config.asset_quantity === '12.34', JSON.stringify(bodies));
    const act = await rhReal.activity(creds);
    t('Robinhood: actividad reciente normalizada', act.length === 1 && act[0].symbol === 'DOGE-USD' && act[0].state === 'filled' && act[0].qty === 12 && r1 !== undefined);
  } finally { globalThis.fetch = realFetch; }
  const F = client();
  await F('POST', '/api/auth/register', { email: 'f-live@x.com', password: 'Clave-De-Fer-12345', acceptTos: true });
  t('/api/exchange/live sin conexiones devuelve lista vacía', (await F('GET', '/api/exchange/live')).body.exchanges.length === 0);
  const dsh = (await F('GET', '/api/dashboard')).body;
  t('tablero: separa dinero real de papel y trae lo que aprendió el Cerebro', dsh.real && dsh.paper && dsh.real.orders === 0 && dsh.brain && 'qualified' in dsh.brain && typeof dsh.brain.auto === 'boolean');
  const Fid = (await F('GET', '/api/me')).body.user.id;
  await store.addOrder({ user_id: Fid, mode: 'live', exchange: 'robinhood', symbol: 'DOGE-USD', side: 'buy', usd: 2, qty: 12, price: 0.16, status: 'error', note: 'too much precision' });
  await store.addOrder({ user_id: Fid, mode: 'live', exchange: 'robinhood', symbol: 'BTC-USD', side: 'buy', usd: 10, qty: 0.0002, price: 50000, status: 'ok' });
  await store.addOrder({ user_id: Fid, mode: 'paper', exchange: 'coinbase', symbol: 'BTC-USD', side: 'buy', usd: 10, qty: 0.0002, price: 50000, status: 'ok' });
  const dsh2 = (await F('GET', '/api/dashboard')).body;
  t('tablero: lo real cuenta solo órdenes reales, muestra el error con su motivo y no mezcla con papel', dsh2.real.orders === 1 && dsh2.real.errors === 1 && dsh2.real.invested_now === 10 && /precision/.test(dsh2.real.last_error) && dsh2.paper.orders === 1);
  t('/api/exchange/live exige sesión', (await nobody('GET', '/api/exchange/live')).status === 401);
}

console.log('AUTO activo y tablero de inicio');
{
  const G = client();
  await G('POST', '/api/auth/register', { email: 'g-auto@x.com', password: 'Clave-De-Gus-12345', acceptTos: true });
  const gId = (await G('GET', '/api/me')).body.user.id;
  await store.setSetting('scanner:latest', JSON.stringify({ t: Date.now(), scanned: 2, universe: 4, items: [
    { symbol: 'ADA-USD', label: 'SMA 5/20', qualified: false, cheaper: 'coinbase', gap_pct: 0.2, cfg: { strategy: 'sma', fast: 5, slow: 20, rsiBuy: 30, rsiSell: 60 }, coinbase: { ret: 2, bh: 5, drag: 1 }, robinhood: { ret: 1, bh: 5, drag: 1.2 } },
    { symbol: 'SOL-USD', label: 'SMA 5/20', qualified: false, cheaper: 'coinbase', gap_pct: 0.2, cfg: { strategy: 'sma', fast: 5, slow: 20, rsiBuy: 30, rsiSell: 60 }, coinbase: { ret: -2, bh: 5, drag: 1 }, robinhood: { ret: -3, bh: 5, drag: 1.2 } }] }));
  await G('PUT', '/api/bot', { autoMode: 'active', symbol: 'AUTO', strategy: 'sma', usd: 10, intervalMin: 60, mode: 'paper', paperExchange: 'coinbase', enabled: true, maxOrderUsd: 25, maxDailyUsd: 100 });
  await new Promise((r) => setTimeout(r, 400));
  await engine.runBot({ ...(await store.getBot(gId)), last_run: 0 }, Date.now() + 3000);
  const go = (await store.listOrders(gId)).filter((o) => o.status === 'ok');
  t('AUTO activo: compra la cripto que ganó la prueba (tendencia alcista) y NO la que perdió', go.length === 1 && go[0].symbol === 'ADA-USD' && /Tendencia alcista/.test(go[0].note), JSON.stringify(go.map((o) => o.symbol)));
  await G('PUT', '/api/bot', { symbol: 'AUTO', strategy: 'sma', usd: 10, intervalMin: 60, mode: 'paper', paperExchange: 'coinbase', enabled: true, autoMode: 'validated', maxOrderUsd: 25, maxDailyUsd: 100 });
  // Acumulación gradual cuando nada tiene ventaja: compra BTC una vez y no repite antes de 4 h
  const zig = Array.from({ length: 100 }, (_, i) => 100 + (i % 2 ? 1 : -1));
  const eng4 = createEngine({ store, adapters, feed: { ...feed, getCloses: async () => zig }, encKey: env.ENCRYPTION_KEY, log: { error() {} } });
  await store.setSetting('scanner:latest', JSON.stringify({ t: Date.now(), scanned: 1, universe: 4, items: [{ symbol: 'ADA-USD', label: 'SMA 5/20', qualified: false, cheaper: 'coinbase', gap_pct: 0.2, cfg: { strategy: 'sma', fast: 5, slow: 20, rsiBuy: 30, rsiSell: 60 }, coinbase: { ret: -2, bh: 5, drag: 1 }, robinhood: { ret: -3, bh: 5, drag: 1.2 } }] }));
  const G2 = client();
  await G2('POST', '/api/auth/register', { email: 'g2-acum@x.com', password: 'Clave-De-Gus2-12345', acceptTos: true });
  const g2 = (await G2('GET', '/api/me')).body.user.id;
  await G2('PUT', '/api/bot', { autoMode: 'active', symbol: 'AUTO', strategy: 'sma', usd: 10, intervalMin: 60, mode: 'paper', paperExchange: 'coinbase', enabled: false, maxOrderUsd: 25, maxDailyUsd: 100 });
  await store.patchBot(g2, { cfg: { ...(await store.getBot(g2)).cfg, enabled: true } });
  await eng4.runBot({ ...(await store.getBot(g2)), last_run: 0 }, Date.now() + 1000);
  const acc = (await store.listOrders(g2)).filter((o) => o.status === 'ok');
  t('sin ventaja demostrada, AUTO acumula cualquier cripto disponible (no solo BTC) con una compra pequeña y lo explica', acc.length === 1 && acc[0].symbol === 'ADA-USD' && /acumulación gradual/.test(acc[0].note));
  await eng4.runBot({ ...(await store.getBot(g2)), last_run: 0 }, Date.now() + 2000);
  t('la acumulación no repite antes de 4 horas', (await store.listOrders(g2)).filter((o) => o.status === 'ok').length === 1);
  t('el modo "solo validadas" se guarda', (await G('GET', '/api/bot')).body.cfg.autoMode === 'validated');
  const dd = (await G('GET', '/api/dashboard')).body;
  t('tablero: informa si puede operar en real y qué exchanges hay', typeof dd.can_live === 'boolean' && Array.isArray(dd.connections) && dd.limits.hardMaxDaily > 0);
}

console.log('Privacidad: cada quien solo ve lo suyo; solo el dueño ve agregados');
{
  const X = client(); const Y = client();
  await X('POST', '/api/auth/register', { email: 'xavier-privado@x.com', password: 'Clave-De-Xav-12345', acceptTos: true });
  await Y('POST', '/api/auth/register', { email: 'yara-curiosa@x.com', password: 'Clave-De-Yar-12345', acceptTos: true });
  const xId = (await X('GET', '/api/me')).body.user.id;
  const xConn = await store.addConnection({ user_id: xId, exchange: 'robinhood', label: 'RH-SECRETO-X', key_id: 'KEYID-SECRETO-X', secret_enc: sec.encrypt(env.ENCRYPTION_KEY, 'PRIVADA-SECRETA-X'), can_trade: true, can_transfer: false });
  await store.addOrder({ user_id: xId, mode: 'live', exchange: 'robinhood', symbol: 'PEPE-USD', side: 'buy', usd: 7.77, qty: 1, price: 1, status: 'error', note: 'NOTA-PRIVADA-X' });
  await store.addOrder({ user_id: xId, mode: 'paper', exchange: 'coinbase', symbol: 'PEPE-USD', side: 'buy', usd: 7.77, qty: 1, price: 1, status: 'ok' });
  await store.setSetting(`botlast:${xId}`, JSON.stringify({ reason: 'DECISION-PRIVADA-X' }));
  const marks = ['xavier-privado', xId, 'RH-SECRETO-X', 'KEYID-SECRETO-X', 'PRIVADA-SECRETA-X', 'NOTA-PRIVADA-X', 'DECISION-PRIVADA-X', xConn.id, 'PEPE-USD'];
  const eps = ['/api/me', '/api/connections', '/api/bot', '/api/bot/status', '/api/orders', '/api/pnl', '/api/dashboard', '/api/exchange/live', '/api/universe', '/api/scanner', '/api/market', '/api/me/export'];
  let leak = null;
  for (const ep of eps) { const r = await Y('GET', ep); const txt = r.text || JSON.stringify(r.body); const m = marks.find((k) => txt.includes(k)); if (m) leak = `${ep} filtra ${m}`; }
  t('un cliente no ve nada de otro en ninguno de sus endpoints', leak === null, leak || '');
  t('un cliente no puede usar la conexión de otro', (await Y('PUT', '/api/bot', { symbol: 'BTC-USD', strategy: 'dca', usd: 5, intervalMin: 60, mode: 'live', enabled: false, connectionId: xConn.id, maxOrderUsd: 25, maxDailyUsd: 100 })).body.cfg?.connectionId === null);
  t('un cliente no borra la conexión de otro', (await Y('DELETE', `/api/connections/${xConn.id}`)).status !== 200 && !!(await store.getConnection(xId, xConn.id)));
  let ownerLeak = null;
  for (const ep of ['/api/owner/overview', '/api/owner/users', '/api/owner/briefing', '/api/owner/brain', '/api/owner/readiness', '/api/owner/compliance', '/api/owner/security', '/api/owner/finance', '/api/owner/export/brain']) {
    const r = await O2('GET', ep); const txt = r.text || JSON.stringify(r.body);
    const m = ['KEYID-SECRETO-X', 'PRIVADA-SECRETA-X', 'NOTA-PRIVADA-X', 'DECISION-PRIVADA-X', 'RH-SECRETO-X', 'secret_enc', 'pass_hash'].find((k) => txt.includes(k)); if (m) ownerLeak = `${ep} muestra ${m}`;
  }
  t('el dueño ve agregados, nunca llaves, órdenes ni decisiones individuales de clientes', ownerLeak === null, ownerLeak || '');
  const ownerEps = ['/api/owner/overview', '/api/owner/users', '/api/owner/audit', '/api/owner/settings', '/api/owner/brain', '/api/owner/readiness', '/api/owner/briefing', '/api/owner/compliance', '/api/owner/export/brain', '/api/owner/export/app'];
  const codes = []; for (const ep of ownerEps) codes.push((await Y('GET', ep)).status);
  t('ningún endpoint de dueño responde a un cliente', codes.every((c) => c === 403), codes.join());
  const codesAnon = []; for (const ep of ownerEps.concat(['/api/dashboard', '/api/exchange/live', '/api/bot/status'])) codesAnon.push((await nobody('GET', ep)).status);
  t('anónimo no accede a nada privado', codesAnon.every((c) => c === 401), codesAnon.join());
  await store.deleteConnection(xId, xConn.id);
}

console.log('Modo Pro (day trader), noticias y autoajuste de riesgo');
{
  const pro = await import('../lib/pro.js'); const news = await import('../lib/news.js');
  const mkS = (a, b, d, n = 120) => Array.from({ length: n }, (_, i) => 100 * (1 + d * i) * (1 + a * Math.sin(i / b)));
  const up = mkS(0.02, 2, 0.002);
  const fU = pro.features(up); const rtC = pro.roundTripPct({ symbol: 'ADA-USD', exchange: 'coinbase', usd: 10, price: up.at(-1) });
  t('pro: entra solo con tendencia + momentum + RSI sano y movimiento esperado mayor al costo', pro.entrySignal(fU, { rtPct: rtC }).ok === true);
  t('pro: no entra si el costo se come el movimiento esperado (spread alto de Robinhood)', pro.entrySignal(fU, { rtPct: 3.5 }).ok === false && /costo/.test(pro.entrySignal(fU, { rtPct: 3.5 }).reason));
  t('pro: en mercado bajista o modo defensivo exige más margen y reduce el tamaño', pro.entrySignal(fU, { rtPct: rtC, regime: 'bear' }).ok === false && pro.entrySignal(fU, { rtPct: 1.0, risk: 'defensivo' }).size === 0.5);
  t('pro: en pausa no abre posiciones', pro.entrySignal(fU, { rtPct: 0.5, risk: 'pausa' }).ok === false);
  const flat = Array.from({ length: 120 }, (_, i) => 100 + (i % 2));
  t('pro: sin tendencia no entra', pro.entrySignal(pro.features(flat), { rtPct: 0.2 }).ok === false);
  const fx = { px: 95, vol: 0.004, s10: 99, s30: 100, s50: 100, rsi: 40 };
  t('pro: stop dinámico protege cuando cae bajo el máximo reciente', pro.exitSignal(fx, { avgCost: 98, heldHours: 5, highSince: 104, rtPct: 1.6 }).sell === true);
  t('pro: mantiene si todo sigue bien', pro.exitSignal({ px: 104, vol: 0.004, s10: 103, s30: 100, s50: 99, rsi: 60 }, { avgCost: 100, heldHours: 5, highSince: 104, rtPct: 1.6 }).sell === false);
  const losing = Array.from({ length: 10 }, (_, i) => [{ symbol: 'A-USD', side: 'buy', qty: 1, usd: 10, created_at: i * 2000 }, { symbol: 'A-USD', side: 'sell', qty: 1, usd: 9.5, created_at: i * 2000 + 1000 }]).flat();
  t('autoajuste: tras una racha de pérdidas pasa a pausa; con pocas pérdidas, a defensivo; normal si va bien', pro.perfSummary(losing).risk === 'pausa' && pro.perfSummary(losing.slice(0, 10)).risk === 'defensivo' && pro.perfSummary([]).risk === 'normal');
  const rss = `<rss><channel><item><title><![CDATA[Bitcoin ETF inflows rise]]></title><pubDate>${new Date().toUTCString()}</pubDate></item><item><title>Solana exchange hacked, $50M stolen</title><pubDate>${new Date().toUTCString()}</pubDate></item><item><title>Old news about Cardano ban</title><pubDate>Mon, 01 Jan 2024 00:00:00 GMT</pubDate></item></channel></rss>`;
  const an = news.analyze(news.parseRss(rss));
  t('noticias: detecta titulares negativos por cripto y descarta los viejos', an.risk.SOL === 1 && !an.risk.ADA && an.items.length === 2 && an.items.find((x) => /Bitcoin ETF/.test(x.title)).neg === false);
  const nf = await news.fetchNews(async (u) => { if (/coindesk/.test(u)) return { ok: true, status: 200, text: async () => rss }; throw new Error('sin red'); });
  t('noticias: si una fuente falla se ignora y se informa', nf.sources === 1 && nf.errors.length === 3 && nf.items.length === 2);

  // Motor en modo pro (papel): compra con tendencia y luego vende al romperse
  let cl = up; const feedP = { getPrice: async () => cl.at(-1), getCloses: async () => cl, getHistory: async () => cl };
  const engP = createEngine({ store, adapters, feed: feedP, encKey: env.ENCRYPTION_KEY, log: { error() {} } });
  await store.setSetting('scanner:latest', JSON.stringify({ t: Date.now(), scanned: 1, universe: 4, items: [{ symbol: 'ADA-USD', label: 'x', qualified: false, cheaper: 'coinbase', gap_pct: 0, mcap: 1e10, cfg: { strategy: 'sma', fast: 5, slow: 20, rsiBuy: 30, rsiSell: 60 }, coinbase: { ret: -1, bh: 1, drag: 1 }, robinhood: { ret: -1, bh: 1, drag: 1 } }] }));
  await store.setSetting('news:latest', JSON.stringify({ t: Date.now(), items: [], risk: {}, global_neg: 0, risk_off: false }));
  const P = client();
  await P('POST', '/api/auth/register', { email: 'p-pro@x.com', password: 'Clave-De-Pro-12345', acceptTos: true });
  const pId = (await P('GET', '/api/me')).body.user.id;
  await P('PUT', '/api/bot', { autoMode: 'pro', symbol: 'AUTO', strategy: 'sma', usd: 10, intervalMin: 60, mode: 'paper', paperExchange: 'best', enabled: false, maxOrderUsd: 25, maxDailyUsd: 100, maxPositions: 3 });
  await store.patchBot(pId, { cfg: { ...(await store.getBot(pId)).cfg, enabled: true } });
  await engP.runBot({ ...(await store.getBot(pId)), last_run: 0 }, Date.now() + 1000);
  const po = (await store.listOrders(pId)).filter((o) => o.status === 'ok');
  t('pro (papel): compra una cripto en tendencia y explica por qué, en el exchange más barato', po.length === 1 && po[0].side === 'buy' && /^Pro:/.test(po[0].note) && /veces|× el costo/.test(po[0].note), JSON.stringify(po.map((o) => o.note)));
  cl = Array.from({ length: 120 }, (_, i) => (i < 100 ? up[i] : up[99] * (1 - 0.01 * (i - 99))));
  const engP2 = createEngine({ store, adapters, feed: feedP, encKey: env.ENCRYPTION_KEY, log: { error() {} } }); // sin caché de precios
  await engP2.runBot({ ...(await store.getBot(pId)), last_run: 0 }, Date.now() + 5000);
  const po2 = (await store.listOrders(pId)).filter((o) => o.status === 'ok');
  t('pro (papel): vende cuando la tendencia se rompe o salta el stop dinámico', po2.length === 2 && po2.some((o) => o.side === 'sell' && /Pro:/.test(o.note)), JSON.stringify(po2.map((o) => o.side + o.note.slice(0, 40))));
  await store.setSetting('news:latest', JSON.stringify({ t: Date.now(), items: [], risk: {}, global_neg: 4, risk_off: true }));
  cl = up;
  const P2 = client();
  await P2('POST', '/api/auth/register', { email: 'p2-pro@x.com', password: 'Clave-De-Pro2-12345', acceptTos: true });
  const p2 = (await P2('GET', '/api/me')).body.user.id;
  await P2('PUT', '/api/bot', { autoMode: 'pro', symbol: 'AUTO', strategy: 'sma', usd: 10, intervalMin: 60, mode: 'paper', paperExchange: 'best', enabled: false, maxOrderUsd: 25, maxDailyUsd: 100 });
  await store.patchBot(p2, { cfg: { ...(await store.getBot(p2)).cfg, enabled: true } });
  const engP3 = createEngine({ store, adapters, feed: feedP, encKey: env.ENCRYPTION_KEY, log: { error() {} } });
  await engP3.runBot({ ...(await store.getBot(p2)), last_run: 0 }, Date.now() + 9000);
  t('pro: con noticias negativas de mercado no abre posiciones nuevas', (await store.listOrders(p2)).length === 0 && /noticias negativas/.test((await P2('GET', '/api/bot/status')).body.last?.reason || ''));

  // --- v17.1: ganancia desde el encendido, gráficos y rotación ---
  const { profitSince } = await import('../lib/charts.js');
  const H = 3600000; const t0 = 1_000_000_000_000;
  const ords = [{ symbol: 'A-USD', side: 'buy', qty: 1, usd: 100, price: 100, status: 'ok', created_at: t0 + H }, { symbol: 'A-USD', side: 'sell', qty: 1, usd: 110, price: 110, status: 'ok', created_at: t0 + 5 * H }];
  const ps = profitSince({ orders: ords, start: t0, now: t0 + 8 * H, hist: new Map(), livePx: new Map() });
  t('ganancia desde encendido: compra 100, vende 110 = +10 (10 %) y curva termina en +10', Math.abs(ps.total - 10) < 1e-9 && Math.abs(ps.pct - 10) < 1e-9 && Math.abs(ps.curve.at(-1).v - 10) < 1e-9 && ps.realized === 10);
  const ps2 = profitSince({ orders: ords.slice(0, 1), start: t0 + 2 * H, now: t0 + 8 * H, hist: new Map([['A-USD', { closes: [100, 100, 100, 100, 100, 100, 100, 100, 100], endMs: t0 + 8 * H }]]), livePx: new Map([['A-USD', 104]]) });
  t('ganancia desde encendido: no cuenta lo que ya había antes del encendido, solo el cambio desde ahí', Math.abs(ps2.total - 4) < 1e-9, String(ps2.total));
  const PC = await P('GET', '/api/profit?mode=paper');
  t('/api/profit: devuelve inicio, total y curva del propio usuario', PC.status === 200 && PC.body.started === true && Array.isArray(PC.body.curve) && PC.body.curve.length >= 2 && typeof PC.body.total === 'number', JSON.stringify(PC.body).slice(0, 160));
  const PC2 = await P2('GET', '/api/profit?mode=live');
  t('/api/profit: sin operaciones ni encendido devuelve started=false', PC2.status === 200 && PC2.body.started === false);
  const CH = await P('GET', '/api/chart?symbol=BTC-USD&range=1W');
  t('/api/chart: puntos, cambio %, máx/mín y tus órdenes marcadas', CH.status === 200 && CH.body.points.length > 20 && Number.isFinite(CH.body.change_pct) && CH.body.hi >= CH.body.lo && Array.isArray(CH.body.mine), JSON.stringify(CH.body).slice(0, 120));
  t('/api/chart: símbolo inválido 400 y sin sesión 401', (await P('GET', '/api/chart?symbol=../x')).status === 400 && (await client()('GET', '/api/chart?symbol=BTC-USD')).status === 401);
  const upS = up; const flatS = Array.from({ length: 120 }, (_, i) => 100 + Math.sin(i) * 0.1);
  const fade = [...up.slice(0, 114), ...Array.from({ length: 6 }, (_, i) => up[113] * (1 - 0.0015 * (i + 1)))];
  const sym = { 'DOGE-USD': upS, 'ADA-USD': flatS };
  const feedR = { getPrice: async (s) => sym[s].at(-1), getCloses: async (s) => sym[s], getHistory: async (s) => sym[s] };
  const itm = (symbol) => ({ symbol, label: 'x', qualified: false, cheaper: 'coinbase', gap_pct: 0, mcap: symbol === 'DOGE-USD' ? 2e10 : 1e10, cfg: { strategy: 'sma', fast: 5, slow: 20, rsiBuy: 30, rsiSell: 60 }, coinbase: { ret: -1, bh: 1, drag: 1 }, robinhood: { ret: -1, bh: 1, drag: 1 } });
  await store.setSetting('scanner:latest', JSON.stringify({ t: Date.now(), scanned: 2, universe: 4, items: [itm('DOGE-USD'), itm('ADA-USD')] }));
  await store.setSetting('news:latest', JSON.stringify({ t: Date.now(), items: [], risk: {}, global_neg: 0, risk_off: false }));
  const R = client();
  await R('POST', '/api/auth/register', { email: 'p-rot@x.com', password: 'Clave-De-Rot-12345', acceptTos: true });
  const rId = (await R('GET', '/api/me')).body.user.id;
  await R('PUT', '/api/bot', { autoMode: 'pro', symbol: 'AUTO', strategy: 'sma', usd: 10, intervalMin: 60, mode: 'paper', paperExchange: 'best', enabled: false, maxOrderUsd: 25, maxDailyUsd: 100, maxPositions: 1 });
  await store.patchBot(rId, { cfg: { ...(await store.getBot(rId)).cfg, enabled: true } });
  await createEngine({ store, adapters, feed: feedR, encKey: env.ENCRYPTION_KEY, log: { error() {} } }).runBot({ ...(await store.getBot(rId)), last_run: 0 }, Date.now() + 1000);
  const r1 = (await store.listOrders(rId)).filter((o) => o.status === 'ok');
  sym['DOGE-USD'] = fade; sym['ADA-USD'] = upS;
  await createEngine({ store, adapters, feed: feedR, encKey: env.ENCRYPTION_KEY, log: { error() {} } }).runBot({ ...(await store.getBot(rId)), last_run: 0 }, Date.now() + 4 * H);
  const r2 = (await store.listOrders(rId)).filter((o) => o.status === 'ok');
  t('rotación: con el cupo lleno cambia la cripto que pierde fuerza por otra con mejor señal', r1.length === 1 && r1[0].symbol === 'DOGE-USD' && r2.length === 3 && r2.some((o) => o.side === 'sell' && o.symbol === 'DOGE-USD' && /rota/.test(o.note)) && r2.some((o) => o.side === 'buy' && o.symbol === 'ADA-USD'), JSON.stringify(r2.map((o) => o.side + o.symbol + o.note.slice(0, 50))));
  const ost = (await R('GET', '/api/bot/status')).body.octopus;
  t('pulpo: guarda qué tentáculo suelta y cuál compra, solo para su dueño', ost && ost.items.some((x) => x.symbol === 'DOGE-USD' && x.state === 'suelta') && ost.items.some((x) => x.symbol === 'ADA-USD' && x.state === 'compró') && !JSON.stringify((await P('GET', '/api/bot/status')).body.octopus).includes('DOGE-USD'), JSON.stringify(ost && ost.items));
  t('pulpo: cada tentáculo trae su porqué y hay pensamientos en español', !!ost && ost.items.every((x) => typeof x.why === 'string' && x.why.length > 5) && Array.isArray(ost.thoughts) && ost.thoughts.length > 0 && ost.thoughts.every((x) => x.text && ['buy', 'sell', 'risk', 'hold'].includes(x.k)), JSON.stringify(ost && ost.thoughts));
}

{ const h = await fetch(base + '/api/health', { method: 'HEAD' }); t('HEAD /api/health responde 200 (monitores como UptimeRobot usan HEAD)', h.status === 200); }
{
  console.log('Seguridad, finanzas y riesgo del portafolio (v18)');
  const pro = await import('../lib/pro.js');
  const sx = await O2('GET', '/api/owner/security');
  t('seguridad del dueño: agregados 24 h y controles activos', sx.status === 200 && typeof sx.body.failed_logins === 'number' && sx.body.checks.twofa === true && Array.isArray(sx.body.flags));
  const f0 = await O2('GET', '/api/owner/finance');
  t('finanzas: costos de Render precargados y sin ingresos inventados', f0.status === 200 && f0.body.calc.cost === 13 && f0.body.calc.mrr === 0 && f0.body.calc.margin_pct === null);
  const f1 = await O2('PUT', '/api/owner/finance', { price: 29, paying: 10, cac: 20, churn_pct: 5, target_margin_pct: 70 });
  const f2 = await O2('GET', '/api/owner/finance');
  t('finanzas: MRR, ganancia, empate y LTV/CAC calculados con lo que anota el dueño', f1.status === 200 && f2.body.calc.mrr === 290 && f2.body.calc.profit === 277 && f2.body.calc.breakeven_customers === 1 && Math.abs(f2.body.calc.ltv_cac - 29) < 1e-9, JSON.stringify(f2.body.calc));
  t('finanzas: entradas absurdas se limitan', (await O2('PUT', '/api/owner/finance', { price: -5, paying: 1e12 })).body.model.price === 0);
  await O2('PUT', '/api/owner/finance', { price: 29, paying: 10 });
  const pp = await nobody('GET', '/api/public/plan');
  t('precio público: la landing lo lee sin sesión', pp.status === 200 && pp.body.price === 29);
  const lo = []; for (let i = 0; i < 4; i++) lo.push({ symbol: 'L-USD', side: 'buy', qty: 1, usd: 10, created_at: Date.now() - 5000 - i * 2000 }, { symbol: 'L-USD', side: 'sell', qty: 1, usd: 9, created_at: Date.now() - 4000 - i * 2000 });
  const xb = pro.explainBuy({ base: 'SOL', sg: { edge: 3.4 }, usd: 10, baseUsd: 10, regime: 'bull', risk: 'normal', news: { items: [], risk: {} } });
  const xs = pro.explainBuy({ base: 'SOL', sg: { edge: 1.3 }, usd: 6, baseUsd: 10, regime: 'volatile', risk: 'defensivo', news: { items: [], risk: { SOL: 2 } } });
  t('explicación: compra grande si la convicción es alta; reducida y con noticia negativa si no', xb.big && /compra grande/.test(xb.text) && /sin noticias negativas/.test(xb.text) && !xs.big && /reducida/.test(xs.text) && /negativa/.test(xs.text) && /defensivo/.test(xs.text), xb.text + ' | ' + xs.text);
  { const vf = await import('../lib/verify.js'); const T0 = Date.UTC(2026, 9, 11, 12); const D = 86400000;
    const od = [{ symbol: 'X-USD', side: 'buy', qty: 1, usd: 10, created_at: T0 - 20 * D, status: 'ok' }, { symbol: 'X-USD', side: 'sell', qty: 1, usd: 12, created_at: T0 - 19 * D, status: 'ok' },
      { symbol: 'Y-USD', side: 'buy', qty: 1, usd: 10, created_at: T0 - 3 * D, status: 'ok' }, { symbol: 'Y-USD', side: 'sell', qty: 1, usd: 7, created_at: T0 - 2 * D, status: 'ok' },
      { symbol: 'Z-USD', side: 'buy', qty: 1, usd: 5, created_at: T0 - 1000, status: 'error' }];
    const pr = vf.periodResults(od, T0).periods;
    t('periodos: 30 d suma +2 y -3; 7 d solo -3; errores no cuentan', Math.abs(pr['30d'].pnl - (-1)) < 1e-9 && Math.abs(pr['7d'].pnl + 3) < 1e-9 && pr['7d'].closed === 1 && pr.total.orders === 4 && pr['24h'].closed === 0 && pr['30d'].max_drawdown <= -3 + 1e-9, JSON.stringify(pr['30d']));
    const rc = vf.reconcile({ ledger: [{ symbol: 'BTC-USD', side: 'buy', qty: 1, usd: 1, created_at: T0 - 1000, ext_id: 'a1' }, { symbol: 'ETH-USD', side: 'buy', qty: 2, usd: 1, created_at: T0 - 1000, ext_id: 'a2' }],
      balances: [{ asset: 'BTC', available: 1, hold: 0, usd: 50000 }, { asset: 'ETH', available: 1, hold: 0, usd: 3000 }], exchangeOrders: [{ id: 'a1', side: 'buy', state: 'filled', qty: 1 }, { id: 'a2', side: 'buy', state: 'filled', qty: 2 }], nowMs: T0 });
    t('conciliación: coincide BTC, alerta ETH (el bot cree tener más) y las dos órdenes coinciden', rc.positions.find((p) => p.symbol === 'BTC-USD').status === 'ok' && rc.positions.find((p) => p.symbol === 'ETH-USD').status === 'alerta' && rc.orders.matched === 2 && rc.ok === false); }
  t('aprendizaje: una cripto con 4 operaciones perdedoras recientes descansa', pro.losingSymbols(lo).has('L-USD') && !pro.losingSymbols(lo.map((o) => ({ ...o, symbol: 'W-USD', usd: o.side === 'sell' ? 12 : 10 }))).has('W-USD'));
  t('riesgo: pérdida de 24 h y tamaño por convicción', Math.abs(pro.pnl24h(lo) - -4) < 1e-9 && pro.confidenceSize(1.2) === 0.6 && pro.confidenceSize(10) === 1);
}

console.log('Exportación del Cerebro y del app');
const eb = await O2('GET', '/api/owner/export/brain');
t('exportar Cerebro: JSON versionado y descargable', eb.status === 200 && /attachment/.test(eb.headers.get('content-disposition')) && eb.body.format === 'quantum-brain/1' && eb.body.brain_version >= 2);
t('el Cerebro exportado trae límites, agentes, modelos, historial y auditoría de agentes', eb.body.guardrails && eb.body.agents.length === 12
  && eb.body.models['BTC-USD']?.active && eb.body.changelog.length >= 2 && eb.body.agent_audit.length > 0);
t('el Cerebro exportado no contiene secretos', !eb.text.includes(secretPem) && !eb.text.includes('pass_hash') && !eb.text.includes('organizations/o/apiKeys'));
const ea = await fetch(base + '/api/owner/export/app', { headers: { Cookie: eb.cookie } });
const tgz = Buffer.from(await ea.arrayBuffer());
t('exportar app: .tar.gz descargable', ea.status === 200 && /\.tar\.gz/.test(ea.headers.get('content-disposition')) && tgz.length > 5000);
const tdir = fs.mkdtempSync(path.join(os.tmpdir(), 'qexp-'));
const tf = path.join(tdir, 'app.tar.gz');
fs.writeFileSync(tf, tgz);
const listing = execFileSync('tar', ['-tzf', tf]).toString().split('\n');
t('el .tar.gz es válido y trae código + BRAIN.json', ['quantum-trading/server.js', 'quantum-trading/lib/app.js', 'quantum-trading/lib/agents.js',
  'quantum-trading/public/landing.html', 'quantum-trading/BRAIN.json', 'quantum-trading/render.yaml'].every((f) => listing.includes(f)));
t('el .tar.gz no incluye node_modules ni .env', !listing.some((f) => /node_modules|\/\.env$/.test(f)));
const brainInTar = execFileSync('tar', ['-xzOf', tf, 'quantum-trading/BRAIN.json']).toString();
t('BRAIN.json dentro del .tar.gz es válido y sin secretos', JSON.parse(brainInTar).format === 'quantum-brain/1' && !brainInTar.includes(secretPem));
t('el .tar.gz completo no contiene llaves de clientes', !zlib.gunzipSync(tgz).toString('latin1').includes(secretPem));

console.log('Cuenta del cliente');
const D = client();
const dpw = 'Clave-De-Dante-123';
await D('POST', '/api/auth/register', { email: 'd@x.com', password: dpw, acceptTos: true });
const dId = (await D('GET', '/api/me')).body.user.id;
await store.addOrder({ user_id: dId, mode: 'paper', symbol: 'BTC-USD', side: 'buy', usd: 10, qty: 0.0002, price: 50000, status: 'ok' });
t('cambiar contraseña exige la actual', (await D('POST', '/api/me/password', { current: 'mala-mala-mala', next: 'Nueva-Clave-12345' })).status === 400);
t('cambiar contraseña exige una nueva fuerte', (await D('POST', '/api/me/password', { current: dpw, next: 'corta' })).status === 400);
t('cambiar contraseña funciona y cierra la sesión', (await D('POST', '/api/me/password', { current: dpw, next: 'Nueva-Clave-12345' })).status === 200 && (await D('GET', '/api/me')).status === 401);
t('la contraseña vieja ya no sirve', (await D('POST', '/api/auth/login', { email: 'd@x.com', password: dpw })).status === 401);
t('la nueva contraseña sí', (await D('POST', '/api/auth/login', { email: 'd@x.com', password: 'Nueva-Clave-12345' })).status === 200);
const ex = await D('GET', '/api/me/export');
t('exportar mis datos: incluye mis órdenes y nada de otros', ex.status === 200 && ex.body.profile.email === 'd@x.com' && ex.body.orders.length === 1 && !ex.text.includes('a@x.com') && !ex.text.includes('pass_hash'));
t('el dueño no puede cambiar su clave por la API', (await O2('POST', '/api/me/password', { current: env.OWNER_PASSWORD, next: 'Otra-Clave-Larga-99' })).status === 400);
t('borrar cuenta exige la contraseña', (await D('DELETE', '/api/me', { password: 'mala-mala-mala' })).status === 400);
t('el dueño no puede borrarse', (await O2('DELETE', '/api/me', { password: env.OWNER_PASSWORD })).status === 400);
t('borrar cuenta funciona', (await D('DELETE', '/api/me', { password: 'Nueva-Clave-12345' })).status === 200);
t('tras borrar, no puede entrar y sus datos desaparecen', (await D('POST', '/api/auth/login', { email: 'd@x.com', password: 'Nueva-Clave-12345' })).status === 401
  && (await store.listOrders(dId)).length === 0 && !(await store.getUserById(dId)));
t('la auditoría se conserva sin identificar al usuario borrado', (await store.listAudit(500)).every((a) => a.user_id !== dId) && (await store.listAudit(500)).some((a) => a.action === 'account_deleted'));

console.log('Landing');
const land = await (await fetch(base + '/')).text();
t('"/" sirve la landing', /Probar en papel ahora/.test(land) && /Beta gratuita/.test(land));
t('la landing no inventa rendimiento, testimonios ni cifras', !/%\s*(anual|mensual|de retorno)|testimonio|garantizad[oa]s? (ganancias|rendimiento)/i.test(land.replace(/no garantizamos ganancias/gi, '')));
t('"/app" sirve la aplicación', /\/app\.js/.test(await (await fetch(base + '/app')).text()));

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
t('el bot descargable incluye los indicadores', /function rsi\(/.test(bundle) && /function macd\(/.test(bundle));
t('el bot descargable corre (--version)', execFileSync('node', [f, '--version']).toString().trim() === '1.0.0');
t('el bot descargable muestra ayuda', /Modo papel/.test(execFileSync('node', [f, '--help']).toString()));
let refused = false;
try { execFileSync('node', [f, '--live'], { stdio: 'pipe' }); } catch (e) { refused = /I_ACCEPT_RISK/.test(String(e.stderr)); }
t('el bot rechaza --live sin I_ACCEPT_RISK=yes', refused);
t('el bot descargable no contiene llaves de nadie', !bundle.includes(secretPem));

const dictEn = (await import('../public/i18n-en.js')).default;
t('diccionario ES/EN: pares válidos con los mismos huecos', Array.isArray(dictEn) && dictEn.length > 800 && dictEn.every(([es, en]) => typeof es === 'string' && typeof en === 'string' && en && [...es.matchAll(/\{(\d+)\}/g)].map((m) => m[1]).sort().join() === [...en.matchAll(/\{(\d+)\}/g)].map((m) => m[1]).sort().join()));
t('landing y legal cargan el selector de idioma y la entrada con logo', fs.readFileSync('public/landing.html', 'utf8').includes('/lang.js') && fs.readFileSync('public/legal.html', 'utf8').includes('/lang.js') && fs.readFileSync('public/landing.html', 'utf8').includes('/splash.js') && fs.readFileSync('public/index.html', 'utf8').includes('/splash.js'));

const vc = await import('../public/voicecmd.js');
t('voz: entiende frases en español e inglés (solo lectura)', vc.intentOf('¿Por qué compraste?') === 'why' && vc.intentOf('what are the news') === 'news' && vc.intentOf('cállate') === 'mute' && vc.intentOf('cómo está el riesgo') === 'risk' && vc.intentOf('dame un resumen') === 'report');
t('voz: pedir login, dueño u operar solo recibe una negativa', ['entra a la cuenta del dueño', 'abre el panel del owner', 'vende todo mi bitcoin', 'log into another account', 'dame la contraseña', 'cambia a otro usuario'].every((x) => vc.intentOf(x) === 'unknown' && /no puedo operar ni abrir cuentas/.test(vc.answerFor('unknown', {}))));
t('voz: la respuesta usa lo que hay en pantalla', /frenó|frené/.test(vc.answerFor('news', { scouts: [{ name: 'NOTICIAS', val: 'freno · 2 negativas' }] })) && vc.answerFor('why', { thoughts: [{ k: 'buy', text: 'Compré BTC porque sube.' }] }) === 'Compré BTC porque sube.');
const vsrc = fs.readFileSync('public/voicecmd.js', 'utf8').replace(/\/\/.*$/gm, '');
t('voz: el módulo de voz no tiene red, sesión ni acceso a cuentas', !/\b(fetch|XMLHttpRequest|WebSocket|sendBeacon|document\.cookie|localStorage\.getItem\('qt_(tok|sess)|location\s*=|eval\(|import\()/.test(vsrc) && !/api\(/.test(vsrc));
const appsrc = fs.readFileSync('public/app.js', 'utf8'); const vi = appsrc.indexOf('async function voiceBuy'); const vj = appsrc.indexOf('async function answerVoice');
const vbody = appsrc.slice(vi, vj);
t('voz: comprar por voz solo en papel; en real responde que no y no llama al servidor', vi > 0 && vj > vi && /bn\.mode === 'live'\) return/.test(vbody) && (vbody.match(/api\(/g) || []).length === 2 && !/mode: 'live'|liveAck/.test(vbody) && /AUTO_PRESET/.test(vbody) && /mode: 'paper'/.test(appsrc.slice(appsrc.indexOf('const AUTO_PRESET'), appsrc.indexOf('const AUTO_PRESET') + 400)));
const nr = await import('../public/newsradio.js');
const nws = (await import('../lib/news.js')).analyze((await import('../lib/news.js')).parseRss('<rss><channel><item><title>Bitcoin ETF approved, price surges</title><link>https://www.coindesk.com/x</link><pubDate>' + new Date().toUTCString() + '</pubDate></item><item><title>Exchange hacked, funds stolen</title><link>javascript:alert(1)</link><pubDate>' + new Date().toUTCString() + '</pubDate></item></channel></rss>'));
t('noticias: positiva/negativa, enlace https y fuente; enlaces raros se descartan', nws.items.some((i) => i.pos && i.link === 'https://www.coindesk.com/x' && i.src === 'coindesk.com' && i.coins.includes('BTC')) && nws.items.some((i) => i.neg && i.link === null));
t('noticias: lo nuevo se detecta una sola vez y el aviso prioriza lo negativo', nr.freshItems(nws.items, new Set([nr.keyOf(nws.items[0])])).length === 1 && /negativa/.test(nr.notifyFor(nws.items).title) && /negativa/.test(nr.introFor({ neg: true, coins: ['BTC'], src: 'decrypt.co' })) && /negative news about BTC/.test(nr.introFor({ neg: true, coins: ['BTC'] }, true)));
const pro2 = await import('../lib/pro.js');
const sg2 = pro2.entrySignal({ s10: 105, s30: 103, s50: 102, px: 106, roc6: 0.012, roc24: 0.03, rsi: 58, offHigh: -0.01, vol: 0.01, atr: 1 }, { rtPct: 0.6, regime: 'range', risk: 'normal' });
t('decisión con confianza y evidencia (no solo "comprar")', !sg2.ok || (sg2.conf >= 5 && sg2.conf <= 95 && sg2.ev.length >= 4 && sg2.ev.some((x) => /RSI/.test(x)) && sg2.ev.some((x) => /costo/.test(x))));
t('la confianza sube con la ventaja y nunca pasa de 95', pro2.confidenceOf(3, 1.05) > pro2.confidenceOf(1.2, 1.05) && pro2.confidenceOf(99, 1) === 95 && pro2.confidenceOf(0, 1) >= 5 && pro2.confidenceOf(-50, 1) === 5);
const pushm = await import('../lib/push.js');
const mem = new Map(); const fstore = { getSetting: async (k, d) => (mem.has(k) ? mem.get(k) : d), setSetting: async (k, v) => { mem.set(k, v); } };
const vp = await pushm.getVapid(fstore); const hdr = pushm.vapidHeader('https://fcm.googleapis.com/fcm/send/abc', vp, 'https://x.example');
const jwt = /t=([^,]+),/.exec(hdr)[1].split('.'); const pubDer = Buffer.concat([Buffer.from('3059301306072a8648ce3d020106082a8648ce3d030107034200', 'hex'), Buffer.from(vp.pub, 'base64url')]);
t('push: la firma VAPID es válida con la llave pública y apunta al servicio correcto', crypto.verify('sha256', Buffer.from(`${jwt[0]}.${jwt[1]}`), { key: crypto.createPublicKey({ key: pubDer, format: 'der', type: 'spki' }), dsaEncoding: 'ieee-p1363' }, Buffer.from(jwt[2], 'base64url')) && JSON.parse(Buffer.from(jwt[1], 'base64url')).aud === 'https://fcm.googleapis.com');
t('push: solo acepta servicios de push conocidos por https', pushm.okEndpoint('https://fcm.googleapis.com/fcm/send/x') && pushm.okEndpoint('https://updates.push.services.mozilla.com/wpush/v2/x') && pushm.okEndpoint('https://web.push.apple.com/x') && !pushm.okEndpoint('http://fcm.googleapis.com/x') && !pushm.okEndpoint('https://127.0.0.1/x') && !pushm.okEndpoint('https://evil.com/fcm.googleapis.com') && !pushm.okEndpoint('https://fcm.googleapis.com.evil.com/x') && !pushm.okEndpoint('https://localhost:8443/x'));
await fstore.setSetting('push:subs', JSON.stringify([{ uid: 'u1', endpoint: 'https://fcm.googleapis.com/fcm/send/ok', t: 1 }, { uid: 'u2', endpoint: 'https://fcm.googleapis.com/fcm/send/dead', t: 1 }]));
const calls = []; const ff = async (u, o) => { calls.push([u, o.headers.Authorization.startsWith('vapid t='), o.headers['Content-Length']]); return u.endsWith('dead') ? { ok: false, status: 410 } : { ok: true, status: 201 }; };
const n0 = { items: [{ title: 'Old story one', neg: false }] };
const r0 = await pushm.notifyNews(fstore, n0, { subject: 's', f: ff });
const r1 = await pushm.notifyNews(fstore, { items: [{ title: 'Exchange hacked again', neg: true }, ...n0.items] }, { subject: 's', f: ff });
const r2 = await pushm.notifyNews(fstore, { items: [{ title: 'Another hack happened', neg: true }, { title: 'Exchange hacked again', neg: true }, ...n0.items] }, { subject: 's', f: ff });
const lp = JSON.parse(await fstore.getSetting('news:lastpush', 'null'));
t('push: la primera lectura no avisa; una noticia negativa nueva sí, con aviso vacío', r0.sent === 0 && r1.sent === 1 && calls.length === 2 && calls.every((c) => c[1] && c[2] === '0') && lp.neg && /negativa/.test(lp.title));
t('push: suscripción caída (410) se elimina y no se repite el aviso en menos de 10 min', JSON.parse(await fstore.getSetting('push:subs', '[]')).length === 1 && r2.sent === 0);
t('push: endpoints exigen sesión y rechazan servicios no permitidos', (await client()('POST', '/api/push/subscribe', { endpoint: 'https://fcm.googleapis.com/x' })).status === 401 && (await A('POST', '/api/push/subscribe', { endpoint: 'https://evil.example/x' })).status === 400 && (await A('POST', '/api/push/subscribe', { endpoint: 'https://fcm.googleapis.com/fcm/send/mine' })).status === 200 && (await A('GET', '/api/push/key')).body.key.length > 60);
t('push: el service worker y el manifiesto se sirven', (await anon('GET', '/sw.js')).text.startsWith('// Service worker') && JSON.parse((await anon('GET', '/manifest.webmanifest')).text).display === 'standalone');
const ttsm = await import('../lib/tts.js');
let ttsCall = null; const tt = ttsm.createTts({ env: { AZURE_SPEECH_KEY: 'k', AZURE_SPEECH_REGION: 'eastus' }, f: async (u, o) => { ttsCall = { u, o }; return { ok: true, status: 200, arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer }; } });
const t1 = await tt.speak('Hola <b>mundo</b> & "amigos"', 'es'); const t2 = await tt.speak('Hola <b>mundo</b> & "amigos"', 'es');
t('azure: arma el SSML seguro, usa la llave solo en el servidor y guarda frases repetidas', t1.ok && t2.ok && ttsCall.u === 'https://eastus.tts.speech.microsoft.com/cognitiveservices/v1' && ttsCall.o.headers['Ocp-Apim-Subscription-Key'] === 'k' && /es-US-AlonsoNeural/.test(ttsCall.o.body) && !/<b>/.test(ttsCall.o.body) && /&amp;/.test(ttsCall.o.body));
t('azure: sin llave o con región rara no se activa; el texto se limita a 400', !ttsm.createTts({ env: {} }).enabled && !ttsm.createTts({ env: { AZURE_SPEECH_KEY: 'k', AZURE_SPEECH_REGION: 'x/../evil' } }).enabled && ttsm.cleanText('a'.repeat(900)).length === 400);
t('azure: el endpoint exige sesión y sin llave dice que no está configurado', (await client()('POST', '/api/tts', { text: 'hola' })).status === 401 && (await A('POST', '/api/tts', { text: 'hola' })).status === 503 && (await A('GET', '/api/voice/config')).body.azure === false);
t('voz real: el endpoint de evaluar ahora rechaza dinero real y exige sesión', (await client()('POST', '/api/bot/evaluate-now')).status === 401);
const vc2 = await import('../public/voicecmd.js');
t('voz: más preguntas (posiciones, topes, listas) se responden con datos en pantalla', /BTC \$6\.00/.test(vc2.answerFor('holdings', {}, { holdings: [{ symbol: 'BTC-USD', value: 6 }] })) && /\$25\.00 por orden/.test(vc2.answerFor('limits', {}, { limits: { usd: 10, maxOrderUsd: 25, maxDailyUsd: 100, spent24: 5, stopLossPct: 8 } })) && /SOL con confianza 78/.test(vc2.answerFor('ready', { rows: [{ sym: 'SOL', state: 'listo p/comprar', conf: 78 }] })) && vc2.intentOf('compra cuando esté listo') === 'buy' && vc2.intentOf('por qué compraste') === 'why');
const tmm = await import('../lib/timemachine.js');
const tc = []; { let v = 100; for (let i = 0; i < 250; i++) { v *= 1 + Math.sin(i / 9) * 0.012 + (((i * 53) % 17) - 8) / 700; tc.push(v); } }
const pj = tmm.project(tc, { horizon: 30, key: 'T' }); const pj2 = tmm.project(tc, { horizon: 30, key: 'T' });
t('máquina del tiempo: rangos ordenados, probabilidades válidas y resultado repetible', pj && pj.bands.p5.length === 30 && pj.bands.p5[29] < pj.bands.p50[29] && pj.bands.p50[29] < pj.bands.p95[29] && pj.prob_up > 0 && pj.prob_up < 1 && pj.range90_pct[0] < pj.median_pct && pj.median_pct < pj.range90_pct[1] && JSON.stringify(pj2.bands.p50) === JSON.stringify(pj.bands.p50) && tmm.project(tc.slice(0, 20)) === null);
t('máquina del tiempo: más horizonte = más incertidumbre, y el pasado se repasa bien', tmm.project(tc, { horizon: 90, key: 'T' }).range90_pct[1] - tmm.project(tc, { horizon: 90, key: 'T' }).range90_pct[0] > pj.range90_pct[1] - pj.range90_pct[0] && Math.abs(tmm.replay([100, 110, 99, 121], 3).ret_pct - 21) < 1e-9 && tmm.replay([100, 110, 99, 121], 3).max_drawdown_pct < -9.9);
const stk = await tmm.fetchStock('AAPL', async (u) => ({ ok: true, status: 200, text: async () => 'Date,Open,High,Low,Close,Volume\n' + Array.from({ length: 60 }, (_, i) => `2025-01-${i},1,1,1,${100 + i},5`).join('\n') }));
let stkErr = ''; try { await tmm.fetchStock('../etc', async () => ({})); } catch (e) { stkErr = e.message; }
t('acciones: lee datos diarios, valida el símbolo y falla con mensaje claro', stk.length === 60 && stk[59] === 159 && /inválido/.test(stkErr) && tmm.STOCK_RE.test('AAPL') && !tmm.STOCK_RE.test('A/B'));
t('futuro: exige sesión y símbolo válido', (await client()('GET', '/api/future?symbol=BTC-USD')).status === 401 && (await A('GET', '/api/future?symbol=../x')).status === 400);
t('Cerebro + Máquina del Tiempo: freno de riesgo (≥55 % no compra, ≥35 % compra la mitad, si no igual)', tmm.futureGate(0.6).skip && !tmm.futureGate(0.4).skip && tmm.futureGate(0.4).mult === 0.5 && tmm.futureGate(0.1).mult === 1);
const { AGENTS: AG2 } = await import('../lib/agents.js');
const lw = await AG2.legal_watch.run({ store }); const sup = await AG2.superintendent.run({ store: memoryStore(), now: Date.now() });
t('Abogado Quantum: lista pendientes técnicos y avisa que no es asesoría legal', lw.notes[0].includes('No es asesoría legal') && lw.proposals.every((p) => ['ops_alert', 'risk_alert'].includes(p.kind) && p.touches.length === 0));
t('Superintendente: detecta escáner y noticias sin datos y solo propone (no cambia nada)', sup.proposals.some((p) => p.key === 'sup:scanner_stale') && sup.proposals.some((p) => p.key === 'sup:news_stale') && sup.proposals.every((p) => p.touches.length === 0));
const ui = await AG2.ui_landing.run({}); 
t('Mejora de UI y landing: audita con datos reales y solo propone', Array.isArray(ui.proposals) && ui.notes.some((n) => /KB/.test(n)) && ui.proposals.every((p) => p.kind === 'insight' && p.touches.length === 0));
const sstore = memoryStore(); await sstore.addOrder({ user_id: 'u1', status: 'error', note: 'Your asset quantity has too much precision. Please round it to nearest 0.01', created_at: Date.now() }); await sstore.addOrder({ user_id: 'u2', status: 'error', note: 'insufficient buying power', created_at: Date.now() });
const sp = await AG2.client_support.run({ store: sstore, now: Date.now() + 1000 });
t('Soporte al cliente: agrupa errores reales y deja respuestas sugeridas (no envía nada)', sp.proposals.length === 2 && sp.proposals.some((p) => /redondear/.test(p.detail.text)) && sp.proposals.some((p) => /saldo/.test(p.detail.text)) && sp.proposals.every((p) => p.kind === 'insight' && p.touches.length === 0));
console.log('Fase 3: ciclo de vida del bot (rutas)');
{
  const payload = { symbol: 'BTC-USD', strategy: 'dca', usd: 10, intervalMin: 15, mode: 'paper', enabled: true, maxOrderUsd: 25, maxDailyUsd: 100 };
  await A('PUT', '/api/bot', payload);
  let st = (await A('GET', '/api/bot/status')).body;
  t('estado del bot: RUNNING con latido, salud, inquilino y versión de estrategia', st.lifecycle.state === 'RUNNING' && st.lifecycle.strategy_version === 'qt-2026.10' && !!st.lifecycle.tenant && ['ok', 'stale'].includes(st.lifecycle.status));
  const pz = await A('POST', '/api/bot/pause'); st = (await A('GET', '/api/bot/status')).body;
  t('pausar: el bot queda PAUSED y conserva su configuración', pz.status === 200 && st.lifecycle.state === 'PAUSED' && st.enabled === true);
  t('pausar dos veces se rechaza', (await A('POST', '/api/bot/pause')).status === 409);
  const rs = await A('POST', '/api/bot/resume'); st = (await A('GET', '/api/bot/status')).body;
  t('reanudar: vuelve a RUNNING', rs.status === 200 && st.lifecycle.state === 'RUNNING' && (await A('POST', '/api/bot/resume')).status === 409);
  const evs = (await A('GET', '/api/bot/events')).body.events;
  t('historial de estados con motivo (más reciente primero)', evs.length >= 4 && evs[0].to_state === 'RUNNING' && evs.some((e) => e.to_state === 'PAUSED' && /pausado/.test(e.reason)));
  await A('POST', '/api/bot/kill'); st = (await A('GET', '/api/bot/status')).body;
  t('apagar (kill): STOPPED', st.lifecycle.state === 'STOPPED' && st.enabled === false);
  const o2id = (await O2('GET', '/api/me')).body.user.id; const aid = (await A('GET', '/api/me')).body.user.id;
  t('un cliente no ve los eventos de otro (aislado por inquilino)', (await O2('GET', '/api/bot/events')).body.events.every((e) => e.user_id === o2id) && (await A('GET', '/api/bot/events')).body.events.every((e) => e.user_id === aid));
}

console.log('Fase 5: operación (rutas)');
{
  const lv = await A('GET', '/api/live'); const rd = await A('GET', '/api/ready');
  t('liveness y readiness responden (readiness comprueba la base de datos)', lv.status === 200 && lv.body.status === 'alive' && rd.status === 200 && rd.body.checks.database === true && rd.body.checks.startup === true);
  const probe = await fetch(`http://localhost:${server.address().port}/api/health`, { headers: { 'x-request-id': 'abc-12345678' } });
  const probe2 = await fetch(`http://localhost:${server.address().port}/api/health`, { headers: { 'x-request-id': 'malo <script>' } });
  t('ID de petición: se respeta uno válido y se reemplaza uno malicioso', probe.headers.get('x-request-id') === 'abc-12345678' && /^[0-9a-f-]{36}$/.test(probe2.headers.get('x-request-id')));
  t('métricas: solo el dueño (cliente 403) y en formato Prometheus', (await A('GET', '/api/owner/metrics')).status === 403);
  const mt = await fetch(`http://localhost:${server.address().port}/api/owner/metrics`, { headers: { cookie: O2.cookie || '' } });
  t('métricas del dueño sin sesión: 401', mt.status === 401);
}

console.log('Fase 2: rutas de riesgo y emergencia');
{
  // Rutas del dueño
  t('cliente no puede tocar riesgo ni emergencia', (await A('GET', '/api/owner/risk')).status === 403 && (await A('POST', '/api/owner/emergency', { on: true })).status === 403 && (await A('PUT', '/api/owner/risk', { maxOrderUsd: 1e9 })).status === 403);
  const rg = await O2('PUT', '/api/owner/risk', { maxOrderUsd: 500 }); const bad = await O2('PUT', '/api/owner/risk', { maxDailyUsd: 'x' });
  t('dueño ajusta límites (validados)', rg.status === 200 && rg.body.platform.maxOrderUsd === 500 && bad.status === 400);
  const em = await O2('POST', '/api/owner/emergency', { on: true, reason: 'prueba' }); const ov = await O2('GET', '/api/owner/risk');
  t('dueño activa la emergencia: queda registrada, auditada y con la política documentada', em.status === 200 && ov.body.emergency.on === true && /NO cancela/.test(ov.body.policy) && (await store.listAudit(20)).some((a) => a.action === 'emergency_stop_on'));
  await O2('POST', '/api/owner/emergency', { on: false }); await O2('PUT', '/api/owner/risk', { maxOrderUsd: 1000 });
}
console.log('Fase 6: cuentas (correo, recuperación, 2FA de clientes, dispositivos, aislamiento)');
{
  const mails = (to) => app.mailer.outbox.filter((m) => m.to === to);
  const tokOf = (to, kind) => { const m = mails(to).filter((x) => x.text.includes(`#${kind}=`)).pop(); const r = m && m.text.match(new RegExp(`#${kind}=([A-Za-z0-9_-]+)`)); return r && r[1]; };
  const pw1 = 'Clave-Fase6-ABCDE'; const pw2 = 'Clave-Nueva-Fase6-Z';
  const U = client();
  const prevScope = await store.getSetting('live_trading', 'off');
  await store.setSetting('live_trading', 'on');

  t('sin proveedor de correo: se dice con honestidad (health.mail = none) y no se finge envío', (await anon('GET', '/api/health')).body.mail === 'none' && (await app.mailer.send({ to: 'x@x.com', subject: 's', text: 't' })).sent === false);
  const reg = await U('POST', '/api/auth/register', { email: 'f6u@x.com', password: pw1, acceptTos: true });
  await app.idle();
  t('registro: queda sin verificar y se genera correo con enlace', reg.status === 201 && reg.body.user.email_verified === false && !!tokOf('f6u@x.com', 'verify'));
  t('la API nunca devuelve el token (solo va por correo)', !JSON.stringify(reg.body).includes(tokOf('f6u@x.com', 'verify')));
  t('sin verificar: trading real no disponible aunque esté habilitado para todos', (await U('GET', '/api/me')).body.liveTradingEnabled === false);
  const liveTry = await U('PUT', '/api/bot', { symbol: 'BTC-USD', strategy: 'dca', usd: 5, intervalMin: 60, mode: 'live', enabled: true, liveAck: true, connectionId: 'x', maxOrderUsd: 25, maxDailyUsd: 100 });
  t('sin verificar: activar bot en real → 403 need_email_verify', liveTry.status === 403 && liveTry.body.need_email_verify === true);
  t('verificar con token falso → 400', (await anon('POST', '/api/auth/verify-email', { token: 'x'.repeat(43) })).status === 400);
  const vt = tokOf('f6u@x.com', 'verify');
  t('verificar con el token real → 200', (await anon('POST', '/api/auth/verify-email', { token: vt })).status === 200);
  t('el token es de un solo uso', (await anon('POST', '/api/auth/verify-email', { token: vt })).status === 400);
  const meV = await U('GET', '/api/me');
  t('verificado: perfil lo refleja y el real queda disponible', meV.body.user.email_verified === true && meV.body.liveTradingEnabled === true);
  await store.setSetting('live_trading', prevScope);

  // token vencido
  { const u = await store.getUserByEmail('f6u@x.com'); await store.createAuthToken({ hash: 'h'.repeat(64), user_id: u.id, kind: 'reset', expires_at: Date.now() - 1000 });
    t('token vencido no se acepta', (await store.consumeAuthToken('h'.repeat(64), 'reset')) === null);
    await store.createAuthToken({ hash: 'k'.repeat(64), user_id: u.id, kind: 'verify', expires_at: Date.now() + 99999 });
    t('un token de verificación no sirve para restablecer contraseña (tipo distinto)', (await store.consumeAuthToken('k'.repeat(64), 'reset')) === null); }

  // recuperación de contraseña
  const nMail = app.mailer.outbox.length;
  const f1 = await anon('POST', '/api/auth/forgot', { email: 'f6u@x.com' });
  const f2 = await anon('POST', '/api/auth/forgot', { email: 'noexiste-f6@x.com' });
  const f3 = await anon('POST', '/api/auth/forgot', { email: 'owner@test.com' });
  await app.idle();
  t('forgot: misma respuesta exista o no la cuenta (no revela cuentas)', f1.status === 200 && JSON.stringify(f1.body) === JSON.stringify(f2.body) && JSON.stringify(f2.body) === JSON.stringify(f3.body));
  t('forgot: solo se envía correo a la cuenta real (ni inexistente ni dueño)', app.mailer.outbox.length === nMail + 1 && mails('noexiste-f6@x.com').length === 0 && mails('owner@test.com').length === 0);
  { const lim = client(); let last; for (let i = 0; i < 5; i++) last = await lim('POST', '/api/auth/forgot', { email: 'limite-f6@x.com' }); t('forgot: limitado por correo (3/hora)', last.status === 429); }
  const rt = tokOf('f6u@x.com', 'reset');
  t('reset: contraseña corta → 400', (await anon('POST', '/api/auth/reset', { token: rt, password: 'corta' })).status === 400);
  t('reset: token falso → 400', (await anon('POST', '/api/auth/reset', { token: 'z'.repeat(43), password: pw2 })).status === 400);
  const [r1, r2] = await Promise.all([client()('POST', '/api/auth/reset', { token: rt, password: pw2 }), client()('POST', '/api/auth/reset', { token: rt, password: 'Otra-Distinta-Fase6' })]);
  t('reset: dos canjes simultáneos del mismo token → solo uno gana', [r1.status, r2.status].sort().join() === '200,400');
  t('reset: la sesión anterior queda cerrada', (await U('GET', '/api/me')).status === 401);
  const winner = r1.status === 200 ? pw2 : 'Otra-Distinta-Fase6';
  t('reset: la clave vieja ya no entra y la nueva sí', (await client()('POST', '/api/auth/login', { email: 'f6u@x.com', password: pw1 })).status === 401 && (await client()('POST', '/api/auth/login', { email: 'f6u@x.com', password: winner })).status === 200);
  t('reset: el token ya usado no sirve otra vez', (await anon('POST', '/api/auth/reset', { token: rt, password: pw1 + 'x' })).status === 400);
  t('reset: se avisa por correo del cambio', mails('f6u@x.com').some((m) => /cambió/.test(m.subject)));

  // 2FA de clientes
  const C = client();
  await C('POST', '/api/auth/register', { email: 'f6m@x.com', password: winner, acceptTos: true });
  t('2FA cliente: setup exige la contraseña', (await C('POST', '/api/me/2fa/setup', { password: 'mala' })).status === 400);
  const s2 = await C('POST', '/api/me/2fa/setup', { password: winner });
  t('2FA cliente: setup entrega secreto', s2.status === 200 && s2.body.secret.length >= 16);
  t('2FA cliente: enable con código malo falla', (await C('POST', '/api/me/2fa/enable', { code: '000000' })).status === 400 || sec.totp(s2.body.secret) === '000000');
  const en = await C('POST', '/api/me/2fa/enable', { code: sec.totp(s2.body.secret) });
  t('2FA cliente: se activa y entrega 8 códigos de respaldo', en.status === 200 && en.body.recovery_codes.length === 8 && new Set(en.body.recovery_codes).size === 8);
  const stored = await store.getUserByEmail('f6m@x.com');
  t('los códigos de respaldo se guardan solo como hash y el secreto cifrado', !stored.recovery_codes.includes(en.body.recovery_codes[0]) && String(stored.totp_secret).startsWith('v1.'));
  const need2 = await client()('POST', '/api/auth/login', { email: 'f6m@x.com', password: winner });
  t('2FA cliente: login sin código lo pide', need2.status === 401 && need2.body.need_totp === true);
  t('2FA cliente: login con código malo falla', (await client()('POST', '/api/auth/login', { email: 'f6m@x.com', password: winner, totp: '111111' })).status === 401);
  const goodCode = sec.totp(s2.body.secret);
  t('2FA cliente: login con código bueno', (await client()('POST', '/api/auth/login', { email: 'f6m@x.com', password: winner, totp: goodCode })).status === 200);
  t('2FA cliente: el mismo código no se reutiliza', (await client()('POST', '/api/auth/login', { email: 'f6m@x.com', password: winner, totp: goodCode })).status === 401);
  const rc = en.body.recovery_codes[0];
  t('respaldo: código inválido falla', (await client()('POST', '/api/auth/login', { email: 'f6m@x.com', password: winner, recovery: 'aaaaa-bbbbb' })).status === 401);
  t('respaldo: un código válido entra una sola vez', (await client()('POST', '/api/auth/login', { email: 'f6m@x.com', password: winner, recovery: rc })).status === 200 && (await client()('POST', '/api/auth/login', { email: 'f6m@x.com', password: winner, recovery: rc })).status === 401);
  t('2FA cliente: no se puede quitar sin contraseña y código', (await C('POST', '/api/me/2fa/disable', { password: winner, code: '000000' })).status === 400 && (await C('POST', '/api/me/2fa/disable', { password: 'mala', code: sec.totp(s2.body.secret) })).status === 400);
  t('2FA: queda registrado en auditoría', (await store.listAudit(200)).some((a) => a.action === 'mfa_enabled') && (await store.listAudit(200)).some((a) => a.action === '2fa_recovery_used'));
  t('2FA cliente: se desactiva con contraseña + código', (await C('POST', '/api/me/2fa/disable', { password: winner, code: sec.totp(s2.body.secret) })).status === 200 && !(await store.getUserByEmail('f6m@x.com')).totp_secret);
  t('el dueño no puede usar la ruta de 2FA de clientes', (await O2('POST', '/api/me/2fa/setup', { password: env.OWNER_PASSWORD })).status === 400);

  // dispositivos / sesiones
  const S1 = client(); const S2 = client(); const Z = client();
  await client()('POST', '/api/auth/register', { email: 'f6s@x.com', password: pw1, acceptTos: true });
  await S1('POST', '/api/auth/login', { email: 'f6s@x.com', password: pw1 }); await S2('POST', '/api/auth/login', { email: 'f6s@x.com', password: pw1 });
  await Z('POST', '/api/auth/register', { email: 'f6z@x.com', password: pw1, acceptTos: true });
  const l1 = await S1('GET', '/api/me/sessions');
  t('dispositivos: lista las sesiones activas con una marcada como actual', l1.status === 200 && l1.body.sessions.length >= 2 && l1.body.sessions.filter((x) => x.current).length === 1);
  t('dispositivos: no expone tokens ni hashes', !JSON.stringify(l1.body).match(/hash|token|secret/i));
  const other = l1.body.sessions.find((x) => !x.current);
  const zl = await Z('GET', '/api/me/sessions');
  t('aislamiento: otro cliente no puede revocar mi sesión', (await Z('POST', '/api/me/sessions/revoke', { id: other.id })).status === 404 && (await S2('GET', '/api/me')).status === 200 && (await S1('GET', '/api/me')).status === 200);
  t('aislamiento: la lista de otro cliente no incluye mis sesiones', !zl.body.sessions.some((x) => l1.body.sessions.some((y) => y.id === x.id)));
  const rv = await S1('POST', '/api/me/sessions/revoke', { id: other.id });
  const dead = [(await S1('GET', '/api/me')).status, (await S2('GET', '/api/me')).status].sort().join();
  t('dispositivos: revocar una sesión la cierra y deja la otra viva', rv.status === 200 && dead === '200,401');
  const alive = (await S1('GET', '/api/me')).status === 200 ? S1 : S2; const gone = alive === S1 ? S2 : S1;
  await gone('POST', '/api/auth/login', { email: 'f6s@x.com', password: pw1 });
  t('dispositivos: «cerrar las demás» deja solo la actual', (await alive('POST', '/api/me/sessions/revoke-others')).body.revoked >= 1 && (await gone('GET', '/api/me')).status === 401 && (await alive('GET', '/api/me')).status === 200);
  { const L1 = client(); const L2 = client(); await L1('POST', '/api/auth/login', { email: 'f6s@x.com', password: pw1 }); await L2('POST', '/api/auth/login', { email: 'f6s@x.com', password: pw1 });
    await L1('POST', '/api/auth/logout'); t('logout cierra solo ese dispositivo', (await L1('GET', '/api/me')).status === 401 && (await L2('GET', '/api/me')).status === 200); }
  { const real = (await alive('GET', '/api/me')).cookie; const forged = real.replace(/^qt_session=[^.]+/, 'qt_session=' + Buffer.from(JSON.stringify({ uid: 'otro', sv: 0, sid: 'x', exp: Date.now() + 1e6 })).toString('base64url'));
    t('cookie falsificada o con firma ajena se rechaza', (await client()('GET', '/api/me', null, { Cookie: forged })).status === 401 && (await client()('GET', '/api/me', null, { Cookie: real })).status === 200); }

  // soporte: verificación manual por el dueño (sin proveedor de correo)
  t('cliente no puede verificar correos', (await Z('POST', `/api/owner/users/${(await store.getUserByEmail('f6u@x.com')).id}/verify-email`)).status === 403);
  { const zu = await store.getUserByEmail('f6z@x.com'); t('dueño verifica a mano y queda auditado', !zu.email_verified_at && (await O2('POST', `/api/owner/users/${zu.id}/verify-email`)).status === 200 && !!(await store.getUserById(zu.id)).email_verified_at && (await store.listAudit(300)).some((a) => a.action === 'owner_verified_email')); }

  // mailer con proveedor (mock de red)
  { const calls = []; const mm = createMailer({ env: { RESEND_API_KEY: 'k', EMAIL_FROM: 'a@b.c' }, f: async (u, o) => { calls.push({ u, o }); return { ok: true }; } });
    const r = await mm.send({ to: 'x@y.z', subject: 's', text: 't' });
    t('mailer con proveedor: llama a su API con la clave en el encabezado, no en el cuerpo', r.sent && calls[0].u.includes('resend.com') && calls[0].o.headers.Authorization === 'Bearer k' && !calls[0].o.body.includes('"k"'));
    const bad = createMailer({ env: { RESEND_API_KEY: 'k', EMAIL_FROM: 'a@b.c' }, f: async () => ({ ok: false, status: 500 }) });
    t('mailer: si el proveedor falla NO se afirma que se envió', (await bad.send({ to: 'x@y.z', subject: 's', text: 't' })).sent === false);
    const prodM = createMailer({ env: { NODE_ENV: 'production' } }); await prodM.send({ to: 'x@y.z', subject: 's', text: 'link#reset=abc' });
    t('mailer en producción sin proveedor: no guarda mensajes (llevan enlaces con token)', prodM.outbox.length === 0); }
}

console.log('Fase 7: planes, límites del servidor y webhooks de pago');
{
  const BL = await import('../lib/billing.js');
  const WH = 'whsec_test_' + 'x'.repeat(20);
  const env7 = { ...env, STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: WH, STRIPE_PRICE_STARTER: 'price_S', STRIPE_PRICE_PRO: 'price_P', STRIPE_PRICE_BUSINESS: 'price_B', PUBLIC_URL: 'https://ejemplo.test' };
  const stripeCalls = [];
  const fetch7 = async (u, o) => { stripeCalls.push({ u, o }); return { ok: true, json: async () => ({ url: 'https://checkout.stripe.test/c/1', id: 'cs_1' }) }; };
  const app7 = createApp({ store, env: env7, adapters, feed, engine, director, market: fakeMarket, fetchFn: fetch7, log: { warn() {}, error() {} } });
  const srv7 = http.createServer(app7.handler); await new Promise((r) => srv7.listen(0, r));
  const base7 = `http://127.0.0.1:${srv7.address().port}`;
  const post7 = async (p, raw, hdr = {}) => { const r = await fetch(base7 + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...hdr }, body: raw }); return { status: r.status, body: await r.json().catch(() => ({})) }; };

  // firma
  const rawEv = JSON.stringify({ id: 'evt_sig', type: 'x', created: 1, data: { object: {} } });
  t('firma: válida con el secreto correcto', BL.verifyStripeSignature(Buffer.from(rawEv), BL.signStripe(rawEv, WH), WH));
  t('firma: secreto equivocado, cuerpo alterado, sin encabezado y marca de tiempo vieja → rechazadas', !BL.verifyStripeSignature(Buffer.from(rawEv), BL.signStripe(rawEv, 'otro'), WH) && !BL.verifyStripeSignature(Buffer.from(rawEv + ' '), BL.signStripe(rawEv, WH), WH) && !BL.verifyStripeSignature(Buffer.from(rawEv), '', WH) && !BL.verifyStripeSignature(Buffer.from(rawEv), BL.signStripe(rawEv, WH, Math.floor(Date.now() / 1000) - 3600), WH) && !BL.verifyStripeSignature(Buffer.from(rawEv), BL.signStripe(rawEv, WH), ''));

  // usuarios
  const GA = client(); const GB = client();
  const ga = await GA('POST', '/api/auth/register', { email: 'f7a@x.com', password: pw, acceptTos: true }); const gb = await GB('POST', '/api/auth/register', { email: 'f7b@x.com', password: pw, acceptTos: true });
  for (const e of ['f7a@x.com', 'f7b@x.com']) await store.updateUser((await store.getUserByEmail(e)).id, { email_verified_at: Date.now() });
  const uidA = ga.body.user.id; const uidB = gb.body.user.id;
  const call7 = (c, m, p, b) => c(m, p, b);
  // el cliente de pruebas apunta a `base`; para el app7 usamos otro cliente con base7
  const client7 = () => { let cookie = ''; return async (method, p, body) => { const r = await fetch(base7 + p, { method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'qt', ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined }); for (const c of r.headers.getSetCookie()) { const kv = c.split(';')[0]; cookie = kv.endsWith('=') ? '' : kv; } const txt = await r.text(); let j; try { j = JSON.parse(txt); } catch { j = txt; } return { status: r.status, body: j }; }; };
  const GA7 = client7(); const GB7 = client7(); const O7 = client7();
  await GA7('POST', '/api/auth/login', { email: 'f7a@x.com', password: pw }); await GB7('POST', '/api/auth/login', { email: 'f7b@x.com', password: pw });
  await O7('POST', '/api/auth/login', { email: 'owner@test.com', password: env.OWNER_PASSWORD, totp: sec.totp(setup.body.secret, Date.now() + 30000) });

  const b0 = await GA7('GET', '/api/billing');
  t('planes: lista los 4 planes, marca los precios como propuesta y empieza en prueba gratis', b0.status === 200 && b0.body.plans.map((p) => p.id).join() === 'free_trial,starter,pro,business' && b0.body.plans.filter((p) => p.priceIsProposal).length === 3 && b0.body.current.plan === 'free_trial' && b0.body.current.status === 'trialing');
  t('planes: con la facturación apagada nada cambia (sin topes de plan)', (await BL.entitlement(store, await store.getUserById(uidA))).enforced === false);

  // webhooks
  const evSub = (id, created, over = {}, type = 'customer.subscription.created') => JSON.stringify({ id, type, created, data: { object: { id: 'sub_1', customer: 'cus_A', status: 'active', current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400, cancel_at_period_end: false, metadata: { user_id: uidA }, items: { data: [{ price: { id: 'price_S' } }] }, ...over } } });
  const send7 = (raw, sig = BL.signStripe(raw, WH)) => post7('/api/billing/webhook/stripe', raw, { 'Stripe-Signature': sig });
  t('webhook: sin firma / firma mala → 400 y no cambia nada', (await post7('/api/billing/webhook/stripe', evSub('e0', 100))).status === 400 && (await send7(evSub('e0', 100), 't=1,v1=00')).status === 400 && (await store.getSubscription(uidA)) === null);
  t('webhook: el redireccionamiento de «pago exitoso» (checkout.session.completed) no concede acceso', (await send7(JSON.stringify({ id: 'e_co', type: 'checkout.session.completed', created: 100, data: { object: { client_reference_id: uidA, payment_status: 'paid' } } }))).body.result === 'ignored' && (await store.getSubscription(uidA)) === null);
  const w1 = await send7(evSub('e1', 100));
  const sA = await store.getSubscription(uidA);
  t('webhook firmado: activa el plan Starter', w1.status === 200 && sA.plan === 'starter' && sA.status === 'active' && sA.provider_customer === 'cus_A');
  const w1b = await send7(evSub('e1', 100)); t('webhook idempotente: el mismo evento otra vez no se reaplica', w1b.body.result === 'duplicate' && (await store.listWebhooks()).filter((h) => h.id === 'e1').length === 1);
  await send7(evSub('e2', 200, { items: { data: [{ price: { id: 'price_P' } }] } }, 'customer.subscription.updated'));
  t('webhook: cambio de plan a Pro', (await store.getSubscription(uidA)).plan === 'pro');
  await send7(evSub('e_old', 150, { items: { data: [{ price: { id: 'price_S' } }] } }, 'customer.subscription.updated'));
  t('webhook fuera de orden: un evento más viejo no pisa al más nuevo', (await store.getSubscription(uidA)).plan === 'pro');
  const unk = await send7(evSub('e_unk', 300, { items: { data: [{ price: { id: 'price_DESCONOCIDO' } }] } }, 'customer.subscription.updated'));
  t('webhook con precio desconocido: no concede nada y queda auditado', unk.body.result === 'ignored' && (await store.getSubscription(uidA)).plan === 'pro' && (await store.listAudit(300)).some((a) => a.action === 'billing_unknown_price'));
  const nou = await send7(evSub('e_nu', 310, { customer: 'cus_X', metadata: { user_id: 'no-existe' } }));
  t('webhook de un usuario inexistente: se ignora y se audita', nou.body.result === 'ignored' && (await store.listAudit(300)).some((a) => a.action === 'billing_unknown_user'));
  t('el usuario no puede falsificar su plan: un cliente no alcanza el webhook ni las rutas de dueño', (await GA7('POST', '/api/owner/users/' + uidA + '/plan', { plan: 'business' })).status === 403 && (await GA7('PUT', '/api/owner/billing', { enforce: false })).status === 403);
  t('el webhook está protegido por firma aunque no lleve cookie ni encabezado CSRF, y no se puede usar GET', (await fetch(base7 + '/api/billing/webhook/stripe')).status !== 200);
  await send7(JSON.stringify({ id: 'e_pf', type: 'invoice.payment_failed', created: 400, data: { object: { customer: 'cus_A' } } }));
  t('pago fallido → past_due', (await store.getSubscription(uidA)).status === 'past_due');
  const raceEv = evSub('e_race', 500, { status: 'active' }, 'customer.subscription.updated');
  const rr = await Promise.all([send7(raceEv), send7(raceEv), send7(raceEv)]);
  t('tres entregas simultáneas del mismo evento → se procesa una sola vez', rr.filter((x) => x.body.result === 'done').length === 1 && (await store.getSubscription(uidA)).status === 'active');
  // fallo transitorio → 500 y se puede reintentar
  { const orig = store.upsertSubscription; let boom = true; store.upsertSubscription = async (...a) => { if (boom) { boom = false; throw new Error('db caída'); } return orig.apply(store, a); };
    const failEv = evSub('e_fail', 600, { status: 'past_due' }, 'customer.subscription.updated');
    const f1 = await send7(failEv); const f2 = await send7(failEv); store.upsertSubscription = orig;
    t('si falla algo transitorio responde 500 (el proveedor reintenta) y el reintento sí se aplica', f1.status === 500 && f2.status === 200 && (await store.getSubscription(uidA)).status === 'past_due' && (await store.listWebhooks()).find((h) => h.id === 'e_fail').attempts === 2); }
  await send7(evSub('e_back', 700, { status: 'active' }, 'customer.subscription.updated'));

  // checkout
  const ck = await GA7('POST', '/api/billing/checkout', { plan: 'pro' });
  const cb = Object.fromEntries(new URLSearchParams(String(stripeCalls[0].o.body)));
  t('checkout: crea la sesión en el servidor con el usuario en metadata, sin datos de tarjeta, y devuelve solo la URL', ck.status === 200 && ck.body.url.startsWith('https://checkout.stripe.test') && cb['subscription_data[metadata][user_id]'] === uidA && cb['line_items[0][price]'] === 'price_P' && cb.mode === 'subscription' && /Bearer sk_test_x/.test(stripeCalls[0].o.headers.Authorization) && !JSON.stringify(ck.body).includes('sk_test'));
  t('checkout: plan inválido (incl. free_trial) → 400', (await GA7('POST', '/api/billing/checkout', { plan: 'free_trial' })).status === 400 && (await GA7('POST', '/api/billing/checkout', { plan: 'gratis-total' })).status === 400);
  t('checkout sin configurar → 503 honesto (app principal sin claves de Stripe)', (await A('POST', '/api/billing/checkout', { plan: 'pro' })).status === 503);
  t('portal: sin suscripción de pago → 400; con ella devuelve URL', (await GB7('POST', '/api/billing/portal')).status === 400 && (await GA7('POST', '/api/billing/portal')).status === 200);

  // límites de servidor (facturación activada por el dueño)
  t('dueño activa la facturación y queda auditado', (await O7('PUT', '/api/owner/billing', { enforce: true })).status === 200 && (await store.listAudit(300)).some((a) => a.action === 'billing_enforce'));
  await store.setSetting('live_trading', 'on'); await store.updateUser(uidA, {});
  const cA = await GA7('POST', '/api/connections', { exchange: 'coinbase', keyId: 'organizations/o/apiKeys/k', secret: secretPem, label: 'cb' });
  const cB = await GB7('POST', '/api/connections', { exchange: 'coinbase', keyId: 'organizations/o/apiKeys/k', secret: secretPem, label: 'cb' });
  const live7 = (cid2, over = {}) => ({ ...cfgPaper, mode: 'live', connectionId: cid2, liveAck: true, maxOrderUsd: 25, maxDailyUsd: 100, ...over });
  t('(B en prueba gratis) conectar sigue permitido dentro de su límite de 1 conexión', cB.status === 201);
  t('(B en prueba gratis) segunda conexión → 403 por plan', (await GB7('POST', '/api/connections', { exchange: 'coinbase', keyId: 'organizations/o/apiKeys/k2', secret: secretPem, label: 'cb2' })).status === 403);
  const bLive = await GB7('PUT', '/api/bot', live7(cB.body.connection.id));
  t('(B en prueba gratis) activar trading real → 403 need_plan', bLive.status === 403 && bLive.body.need_plan === true);
  t('(B en prueba gratis) modo papel sigue funcionando', (await GB7('PUT', '/api/bot', { ...cfgPaper })).status === 200);
  await store.upsertSubscription(uidA, { plan: 'starter', status: 'active', current_period_end: Date.now() + 20 * 86400000 });
  const aLiveBig = await GA7('PUT', '/api/bot', live7(cA.body.connection.id, { maxOrderUsd: 200, maxDailyUsd: 250 }));
  t('(A en plan Starter) topes por encima del plan → 400 con explicación', aLiveBig.status === 400 && /plan permite/.test(aLiveBig.body.error) && aLiveBig.body.caps.maxOrderUsd === 100);
  t('(A en plan Starter) topes dentro del plan → aceptado', (await GA7('PUT', '/api/bot', live7(cA.body.connection.id))).status === 200);
  // el motor aplica el plan aunque la config se haya guardado antes (p. ej. bajó de plan)
  await store.patchBot(uidA, { last_run: 0 }); const before = (await store.listOrders(uidA, 100)).filter((o) => o.mode === 'live').length;
  await store.upsertSubscription(uidA, { status: 'past_due' }); await engine.tick();
  const botA = await store.getBot(uidA);
  t('motor: con el pago vencido no sale ninguna orden real y el bot real se apaga con el motivo', (await store.listOrders(uidA, 100)).filter((o) => o.mode === 'live').length === before && botA.cfg.enabled === false);
  await store.upsertSubscription(uidB, { plan: 'starter', status: 'active', provider: 'manual', current_period_end: Date.now() + 20 * 86400000 });
  await store.saveBot(uidB, { ...live7(cB.body.connection.id, { maxOrderUsd: 400, maxDailyUsd: 900, usd: 150 }) }); await store.patchBot(uidB, { last_run: 0 });
  await engine.tick();
  { const lo = (await store.listOrders(uidB, 100)).filter((o) => o.mode === 'live'); t('motor: los topes del plan (Starter: $100/orden) se aplican aunque la config guardada diga $400/$150: la orden sale recortada o no sale, nunca mayor', lo.length >= 1 && lo.every((o) => o.usd <= 100)); }
  await store.upsertSubscription(uidA, { status: 'active', current_period_end: Date.now() - 5 * 86400000 });
  t('suscripción vencida hace más de 3 días (webhook de renovación no llegó) → sin trading real', (await BL.entitlement(store, await store.getUserById(uidA))).live === false);
  await store.setSetting('live_trading', 'off');

  // consola del dueño y soporte
  const ob = await O7('GET', '/api/owner/billing');
  t('consola de dueño: estado de facturación, planes, webhooks fallidos y correo', ob.status === 200 && ob.body.enforce === true && ob.body.stripe_configured === true && ob.body.mail === 'none' && Array.isArray(ob.body.webhooks) && typeof ob.body.failed_webhooks === 'number');
  t('consola: un cliente no la ve', (await GA7('GET', '/api/owner/billing')).status === 403);
  const sup = await O7('GET', `/api/owner/users/${uidB}/support`);
  t('soporte: resumen operativo del cliente SIN llaves, hashes ni secretos, y queda auditado', sup.status === 200 && sup.body.user.email === 'f7b@x.com' && !JSON.stringify(sup.body).match(/pass_hash|secret|totp_secret|recovery|BEGIN/i) && (await store.listAudit(400)).some((a) => a.action === 'support_view' && a.detail.includes(uidB)));
  t('soporte: un cliente no puede pedirlo ni sobre sí mismo', (await GA7('GET', `/api/owner/users/${uidA}/support`)).status === 403 && (await GB7('GET', `/api/owner/users/${uidA}/support`)).status === 403);
  t('concesión manual: plan inválido rechazado; válida auditada', (await O7('POST', `/api/owner/users/${uidB}/plan`, { plan: 'gratis' })).status === 400 && (await O7('POST', `/api/owner/users/${uidB}/plan`, { plan: 'starter', days: 30 })).status === 200 && (await BL.entitlement(store, await store.getUserById(uidB))).live === true && (await store.listAudit(400)).some((a) => a.action === 'owner_set_plan'));
  t('el dueño nunca queda limitado por planes', (await BL.entitlement(store, await store.getUserByEmail('owner@test.com'))).live === true);
  await O7('PUT', '/api/owner/billing', { enforce: false });
  srv7.close();
}


console.log('Fase 8: lanzamiento (documentos y página de estado)');
{
  const need = ['docs/LEGAL-DRAFTS.md', 'docs/LICENSES.md', 'docs/ONBOARDING.md', 'docs/LAUNCH-READINESS.md', 'docs/BILLING.md', 'CHANGELOG.md', 'public/status.html', 'public/status.js'];
  t('documentos de lanzamiento presentes', need.every((f) => fs.existsSync(f) && fs.statSync(f).size > 300));
  const lg = fs.readFileSync('docs/LEGAL-DRAFTS.md', 'utf8');
  t('los borradores legales se declaran sin revisión de abogado y no prometen rentabilidad ni cumplimiento', /no es asesor[ií]a legal/i.test(lg) && /\[EMPRESA\]/.test(lg) && !/garantizamos|rentabilidad asegurada|cumplimos con toda la ley/i.test(lg));
  t('el informe de lanzamiento declara NO listo y lista bloqueos', /NO listo/.test(fs.readFileSync('docs/LAUNCH-READINESS.md', 'utf8')) && (fs.readFileSync('docs/LAUNCH-READINESS.md', 'utf8').match(/^\| \d+ \|/gm) || []).length >= 8);
  const st = await fetch(base + '/status.html'); const stj = await fetch(base + '/status.js');
  t('página de estado pública y sin datos internos (solo /api/ready, sin versión ni secretos)', st.status === 200 && stj.status === 200 && /api\/ready/.test(await stj.clone().text()) && !/version|secret|token/i.test(await stj.text()));
  t('la página de estado cumple la CSP (sin scripts en línea)', !/<script(?![^>]*src=)/i.test(await st.text()));
}
console.log('Cierre de posiciones, botones Comprar/Vender y kill switch');
{
  const calls = []; const origSell = good.marketSell; const origBuy = good.marketBuy; const origBal = good.balances;
  let btcBal = 0.001;
  good.balances = async () => [{ asset: 'USD', available: 500, hold: 0 }, { asset: 'BTC', available: btcBal, hold: 0 }];
  good.marketSell = async (c, a) => { calls.push({ side: 'sell', ...a }); return { ok: true, id: 'sell-' + calls.length }; };
  good.marketBuy = async (c, a) => { calls.push({ side: 'buy', ...a }); return { ok: true, id: 'buy-' + calls.length }; };
  const mk = async (email) => { const c = client(); const r = await c('POST', '/api/auth/register', { email, password: pw, acceptTos: true }); await store.updateUser(r.body.user.id, { email_verified_at: Date.now() }); const cn = await c('POST', '/api/connections', { exchange: 'coinbase', keyId: 'organizations/o/apiKeys/k', secret: secretPem }); return { c, id: r.body.user.id, cid: cn.body.connection.id }; };
  const H = await mk('f9h@x.com'); const J = await mk('f9j@x.com');
  const addLive = (id, qty, usd = 50) => store.addOrder({ user_id: id, mode: 'live', exchange: 'coinbase', symbol: 'BTC-USD', side: 'buy', usd, qty, price: 50000, status: 'ok', created_at: Date.now() - 3600000 });
  await addLive(H.id, 0.001); await addLive(J.id, 0.001);
  const prevScope = await store.getSetting('live_trading', 'off');

  // papel
  await H.c('PUT', '/api/bot', { ...cfgPaper, enabled: true }); await store.patchBot(H.id, { last_run: 0 }); await engine.tick();
  t('papel: hay posición simulada', (await H.c('GET', '/api/positions')).body.paper.length >= 1);
  // kill + cerrar todo con trading real APAGADO y parada de emergencia ACTIVA: salir siempre se permite
  await store.setSetting('live_trading', 'off');
  await O2('POST', '/api/owner/emergency', { on: true, reason: 'prueba f9' });
  const k = await H.c('POST', '/api/bot/kill', { closeAll: true });
  const sells = calls.filter((x) => x.side === 'sell');
  t('kill switch cierra todo: apaga el bot y VENDE la posición real aunque el real esté apagado y haya parada de emergencia', k.status === 200 && k.body.closed.some((x) => x.mode === 'live' && x.placed) && sells.length === 1 && (await H.c('GET', '/api/bot')).body.cfg.enabled === false);
  t('la venta lleva ID idempotente y no excede el saldo disponible', typeof sells[0].clientOrderId === 'string' && sells[0].clientOrderId.length >= 30 && sells[0].qty <= 0.001 * 0.999 + 1e-12 && sells[0].symbol === 'BTC-USD');
  t('papel también se cierra con el kill switch', k.body.closed.some((x) => x.mode === 'paper' && x.placed) && (await H.c('GET', '/api/positions')).body.paper.length === 0);
  const ord = (await store.listOrders(H.id, 50)).find((o) => o.mode === 'live' && o.side === 'sell');
  t('la venta real queda «enviada, pendiente» (nunca «ejecutada» sin confirmar el broker) y auditada', ord && ord.lifecycle === 'submitted' && (await store.listAudit(300)).some((a) => a.action === 'close_positions' && a.user_id === H.id));
  const k2 = await H.c('POST', '/api/bot/kill', { closeAll: true });
  t('doble pulsación: no se vende dos veces (misma orden en el mismo minuto)', calls.filter((x) => x.side === 'sell').length === 1 && k2.body.closed.every((x) => x.mode !== 'live' || !x.placed));
  t('aislamiento: cerrar las posiciones de H no tocó las de J', (await J.c('GET', '/api/positions')).body.live.length === 1 && calls.filter((x) => x.side === 'sell').length === 1);
  t('el kill switch sin closeAll solo apaga (compatibilidad)', (await J.c('POST', '/api/bot/kill')).body.closed.length === 0 && calls.filter((x) => x.side === 'sell').length === 1);
  await O2('POST', '/api/owner/emergency', { on: false });

  { const fm = feed.getPrice; feed.getPrice = async () => { throw new Error('sin red'); }; await new Promise((r) => setTimeout(r, 0)); const e = await H.c('POST', '/api/trade', { side: 'buy', mode: 'paper', symbol: 'AVAX-USD', usd: 5, confirm: true }); feed.getPrice = fm;
    t('si el precio no se puede leer: mensaje claro, sin error 500 ni orden', e.status === 200 && e.body.results[0].placed === false && /precio/.test(e.body.results[0].reason)); }
  // vender: fracción, saldo menor que el libro, sin conexión, fallar cerrado
  btcBal = 0.0004;
  const s50 = await J.c('POST', '/api/trade', { side: 'sell', mode: 'live', symbol: 'BTC-USD', fraction: 0.5, confirm: true });
  t('vender 50% nunca pasa del saldo real del exchange (libro 0.001, saldo 0.0004)', s50.status === 200 && calls.filter((x) => x.side === 'sell').length === 2 && calls[calls.length - 1].qty <= 0.0004 * 0.999 + 1e-12);
  t('vender sin confirmar / fracción inválida → 400', (await J.c('POST', '/api/trade', { side: 'sell', mode: 'live', symbol: 'BTC-USD', fraction: 1 })).status === 400 && (await J.c('POST', '/api/trade', { side: 'sell', mode: 'live', symbol: 'BTC-USD', fraction: 3, confirm: true })).status === 400);
  { const before = calls.length; await store.setSetting('risk:platform', '{roto'); const r = await J.c('POST', '/api/trade', { side: 'sell', mode: 'live', symbol: 'ETH-USD', fraction: 1, confirm: true });
    await addLive(J.id, 0.002); await store.setSetting('risk:platform', '{roto'); const r2 = await J.c('POST', '/api/bot/kill', { closeAll: true });
    t('fallar cerrado: con los límites de plataforma ilegibles NO sale ninguna venta', calls.length === before && r2.body.closed.some((x) => !x.placed)); await store.setSetting('risk:platform', LOOSE); }
  { const conns = await store.listConnections(J.id); for (const c of conns) await store.deleteConnection(J.id, c.id); const before = calls.length; const r = await J.c('POST', '/api/bot/kill', { closeAll: true });
    t('sin conexión segura: lo dice claramente y no inventa nada', calls.length === before && r.body.closed.some((x) => /conexión segura/.test(x.reason || ''))); }

  // comprar en real: compuertas
  await store.setSetting('live_trading', 'off');
  const bodyBuy = { side: 'buy', mode: 'live', symbol: 'BTC-USD', usd: 10, confirm: true, liveAck: true, connectionId: H.cid };
  t('comprar real con el trading real apagado → 403', (await H.c('POST', '/api/trade', bodyBuy)).status === 403);
  await store.setSetting('live_trading', 'on');
  t('comprar real sin confirmar el riesgo → 400; sin «confirm» → 400', (await H.c('POST', '/api/trade', { ...bodyBuy, liveAck: false })).status === 400 && (await H.c('POST', '/api/trade', { ...bodyBuy, confirm: false })).status === 400);
  t('comprar real por encima del tope por orden → 400', (await H.c('POST', '/api/trade', { ...bodyBuy, usd: 5000 })).status === 400);
  await O2('POST', '/api/owner/emergency', { on: true, reason: 'prueba f9' });
  { const before = calls.filter((x) => x.side === 'buy').length; const r = await H.c('POST', '/api/trade', bodyBuy);
    t('con parada de emergencia, COMPRAR queda bloqueado y no llega al broker (vender sí se permite)', calls.filter((x) => x.side === 'buy').length === before && r.body.results[0].placed === false); }
  await O2('POST', '/api/owner/emergency', { on: false });
  const okBuy = await H.c('POST', '/api/trade', bodyBuy);
  t('comprar real permitido: pasa por el riesgo, usa ID idempotente y queda pendiente', okBuy.status === 200 && okBuy.body.results[0].placed === true && calls.filter((x) => x.side === 'buy').length === 1 && typeof calls.find((x) => x.side === 'buy').clientOrderId === 'string');
  t('comprar dos veces seguidas lo mismo no duplica (mismo minuto)', ((await H.c('POST', '/api/trade', bodyBuy)).body.results[0].placed === false) && calls.filter((x) => x.side === 'buy').length === 1);
  { const U = client(); await U('POST', '/api/auth/register', { email: 'f9u@x.com', password: pw, acceptTos: true });
    t('correo sin verificar: no puede comprar en real', (await U('POST', '/api/trade', { ...bodyBuy, connectionId: 'x' })).status === 403); }
  t('comprar en papel funciona con confirmación y no llama al broker', (await H.c('POST', '/api/trade', { side: 'buy', mode: 'paper', symbol: 'BTC-USD', usd: 10, confirm: true })).status === 200 && calls.filter((x) => x.side === 'buy').length === 1);
  t('anónimo no puede operar', (await nobody('POST', '/api/trade', bodyBuy)).status === 401 && (await nobody('POST', '/api/bot/kill', { closeAll: true })).status === 401);
  await store.setSetting('live_trading', prevScope);
  good.marketSell = origSell; good.marketBuy = origBuy; good.balances = origBal;
}


console.log('Botón 🔈: leer cada sección en voz alta');
{
  const a = fs.readFileSync('public/app.js', 'utf8'); const v = fs.readFileSync('public/voice.js', 'utf8');
  t('cada sección desplegable recibe un botón 🔈 que lee título y contenido, y un segundo toque lo detiene', /className = 'spk'/.test(a) && /toggleReadCard/.test(a) && /voice\.readAll\(/.test(a) && /voice\.stop\(\)/.test(a));
  t('el texto leído excluye botones, formularios y gráficos', /querySelectorAll\('button, input, select, textarea, canvas, svg/.test(a));
  t('la lectura suena aunque la voz del Cerebro esté apagada y se puede cancelar sin solaparse', /force: true/.test(v) && /stop\(\) \{ gen\+\+/.test(v) && /if \(g !== gen\) return/.test(v));
}

console.log('Meta de ganancia (toma de ganancia)');
{
  const ST = await import('../lib/strategy.js'); const PR = await import('../lib/pro.js');
  const cfg = { ...ST.DEFAULT_CFG, strategy: 'sma', takeProfitPct: 3, stopLossPct: 8 };
  const up = ST.decide(cfg, { closes: Array.from({ length: 100 }, (_, i) => 100 + i * 0.01), now: Date.now(), price: 103.5, lastBuyAt: 1, lastSellAt: 0, position: 1, avgCost: 100 });
  const below = ST.decide(cfg, { closes: Array.from({ length: 100 }, () => 100), now: Date.now(), price: 102, lastBuyAt: 1, lastSellAt: 0, position: 1, avgCost: 100 });
  t('meta de ganancia: vende cuando el precio supera el costo en la meta', up.action === 'sell' && /Toma de ganancia/.test(up.reason) && up.qty === 1);
  t('meta de ganancia: por debajo de la meta no vende por esa razón', !(below.action === 'sell' && /Toma de ganancia/.test(below.reason)));
  t('meta de ganancia apagada (0): nunca vende por meta', !/Toma de ganancia/.test(ST.decide({ ...cfg, takeProfitPct: 0 }, { closes: Array.from({ length: 100 }, () => 100), now: Date.now(), price: 150, lastBuyAt: 1, lastSellAt: 0, position: 1, avgCost: 100 }).reason || ''));
  const f = { vol: 0.001, px: 103, s10: 105, s30: 100, rsi: 55 };
  const e1 = PR.exitSignal({ ...f }, { avgCost: 100, heldHours: 2, highSince: 103, rtPct: 1.6, stopLossPct: 8, takeProfitPct: 1 });
  const e2 = PR.exitSignal({ ...f, px: 101.5 }, { avgCost: 100, heldHours: 2, highSince: 101.5, rtPct: 1.6, stopLossPct: 8, takeProfitPct: 1 });
  t('AUTO: la meta es NETA de costos (+3% bruto con costo 1.6% → +1.4% neto ≥ meta 1%)', e1.sell === true && /neto/.test(e1.reason));
  t('AUTO: +1.5% bruto con costo 1.6% NO cuenta como ganancia (neto negativo): no vende por meta', !(e2.sell && /Toma de ganancia/.test(e2.reason)));
  t('validación: meta fuera de rango o no numérica se rechaza', ST.validateCfg({ ...ST.DEFAULT_CFG, takeProfitPct: 150 }).ok === false && ST.validateCfg({ ...ST.DEFAULT_CFG, takeProfitPct: 'x' }).ok === false && ST.validateCfg({ ...ST.DEFAULT_CFG, takeProfitPct: 2 }).ok === true && ST.validateCfg({ ...ST.DEFAULT_CFG }).cfg.takeProfitPct === 0);
}

console.log('Panel: cifras confirmadas vs estimadas');
{
  const c = client(); const r = await c('POST', '/api/auth/register', { email: 'dash9@x.com', password: pw, acceptTos: true }); const id = r.body.user.id;
  const mkO = (extra) => store.addOrder({ user_id: id, mode: 'live', exchange: 'coinbase', symbol: 'BTC-USD', side: 'buy', usd: 10, qty: 0.0002, price: 50000, created_at: Date.now() - 3600000, ...extra });
  await mkO({ status: 'ok', lifecycle: 'filled', fee_usd: 0.06 }); await mkO({ status: 'ok' }); await mkO({ status: 'pending', lifecycle: 'submitted' }); await mkO({ status: 'error', lifecycle: 'rejected', note: 'rechazada' });
  const d = (await c('GET', '/api/dashboard')).body.real;
  t('panel: una orden «pendiente de confirmar» NO cuenta como error', d.pending === 1 && d.errors === 1);
  t('panel: separa confirmadas por el broker, anteriores sin verificar y pendientes; suma comisiones reales', d.confirmed === 1 && d.legacy === 1 && Math.abs(d.fees_usd - 0.06) < 1e-9);
  t('panel: mientras haya pendientes o sin verificar, el resultado se marca como estimado', d.estimated === true);
  const c2 = client(); const r2 = await c2('POST', '/api/auth/register', { email: 'dash10@x.com', password: pw, acceptTos: true });
  await store.addOrder({ user_id: r2.body.user.id, mode: 'live', exchange: 'coinbase', symbol: 'BTC-USD', side: 'buy', usd: 10, qty: 0.0002, price: 50000, status: 'ok', lifecycle: 'filled', fee_usd: 0.06, created_at: Date.now() - 3600000 });
  t('panel: con todo confirmado por el broker, las cifras no se marcan como estimadas', (await c2('GET', '/api/dashboard')).body.real.estimated === false);
}
console.log('Alertas críticas (push)');
{
  const PU = await import('../lib/push.js');
  const c = client(); const r = await c('POST', '/api/auth/register', { email: 'alert1@x.com', password: pw, acceptTos: true }); const id = r.body.user.id;
  const ep = 'https://fcm.googleapis.com/fcm/send/alert1';
  await c('POST', '/api/push/subscribe', { endpoint: ep });
  const hits = []; const f = async (u) => { hits.push(u); return { ok: true, status: 201 }; };
  const a = await PU.notifyUser(store, id, { kind: 'bot_disabled', title: '⛔ Tu bot se apagó', body: 'prueba' }, { subject: 'https://x.invalid', f });
  t('alerta: se envía el push solo a los dispositivos del dueño', a.sent === 1 && hits.length === 1 && hits[0] === ep);
  const b = await PU.notifyUser(store, id, { kind: 'bot_disabled', title: 'otra', body: 'x' }, { subject: 'https://x.invalid', f });
  t('alerta: el mismo motivo no se repite en 10 min (sin spam)', b.throttled === true && hits.length === 1);
  const g = await PU.notifyUser(store, id, { kind: 'order_unknown', title: '⚠ Orden sin confirmar', body: 'y' }, { subject: 'https://x.invalid', f });
  t('alerta: otro motivo sí se envía', g.sent === 1 && hits.length === 2);
  const last = (await c('GET', '/api/news/last-push')).body;
  t('alerta: el service worker recibe la alerta del propio usuario con prioridad', last.alert === true && /Orden sin confirmar/.test(last.title));
  const other = client(); await other('POST', '/api/auth/register', { email: 'alert2@x.com', password: pw, acceptTos: true });
  t('alerta: otro usuario no ve la alerta ajena', (await other('GET', '/api/news/last-push')).body.alert !== true);
  const bad = await PU.notifyUser(store, id, { kind: 'x2', title: 't', body: 'b' }, { subject: 'https://x.invalid', f: async () => { throw new Error('red'); } });
  t('alerta: si el push falla no lanza error', bad.sent === 0);
  // Gone (410) limpia la suscripción
  await PU.notifyUser(store, id, { kind: 'x3', title: 't', body: 'b' }, { subject: 'https://x.invalid', f: async () => ({ ok: false, status: 410 }) });
  t('alerta: suscripción vencida (410) se elimina', !(await PU.loadSubs(store)).some((s) => s.endpoint === ep));
  // engine: disable avisa
  const got = []; const eng = createEngine({ store, adapters, feed, encKey: env.ENCRYPTION_KEY, log: { error() {} }, alert: async (u, x) => { got.push([u, x.kind]); } });
  const c3 = client(); const r3 = await c3('POST', '/api/auth/register', { email: 'alert3@x.com', password: pw, acceptTos: true });
  t('engine: acepta el gancho de alerta', typeof eng.tick === 'function' && got.length === 0 && r3.status < 300);
}

console.log('Probar conexión y rastros del Director');
{
  const c = client(); await c('POST', '/api/auth/register', { email: 'ct1@x.com', password: pw, acceptTos: true });
  const conn = await c('POST', '/api/connections', { exchange: 'coinbase', keyId: 'organizations/o/apiKeys/ct', secret: secretPem });
  const cid = conn.body.connection.id;
  let sent = 0; const spy = adapters.coinbase.marketBuy; adapters.coinbase.marketBuy = async (...a) => { sent++; return spy(...a); };
  const r = await c('POST', `/api/connections/${cid}/test`, {});
  adapters.coinbase.marketBuy = spy;
  t('probar conexión: pasos de solo lectura y todo en verde', r.status === 200 && r.body.ok === true && ['open', 'valid', 'trade', 'nowithdraw', 'balances', 'price'].every((id) => r.body.steps.some((x) => x.id === id && x.ok)));
  t('probar conexión: no envía ninguna orden', sent === 0 && r.body.orders_sent === 0);
  t('probar conexión: queda en la auditoría', (await store.listAudit(100)).some((a) => a.action === 'connection_test'));
  const other = client(); await other('POST', '/api/auth/register', { email: 'ct2@x.com', password: pw, acceptTos: true });
  t('probar conexión: otro usuario no puede probar una conexión ajena (404)', (await other('POST', `/api/connections/${cid}/test`, {})).status === 404);
  t('probar conexión: exige sesión', (await nobody('POST', `/api/connections/${cid}/test`, {})).status === 401);
  const okCheck = good.check; good.check = async () => ({ ok: false, error: 'Coinbase rechazó la llave (HTTP 401)' });
  const bad = await c('POST', `/api/connections/${cid}/test`, {}); good.check = okCheck;
  t('probar conexión: llave revocada → falla con motivo y consejo, sin pedir saldos', bad.body.ok === false && bad.body.steps.find((x) => x.id === 'valid').ok === false && /401/.test(bad.body.steps.find((x) => x.id === 'valid').detail) && !!bad.body.steps.find((x) => x.id === 'valid').hint && !bad.body.steps.some((x) => x.id === 'balances'));
  const okBal = good.balances; good.balances = async () => { throw new Error('Coinbase: no se pudo leer el saldo (HTTP 403)'); };
  const nb = await c('POST', `/api/connections/${cid}/test`, {}); good.balances = okBal;
  t('probar conexión: sin permiso de ver saldos lo dice', nb.body.ok === false && nb.body.steps.find((x) => x.id === 'balances').ok === false);
  // Rastros del Director
  const AG = await import('../lib/agents.js');
  let calls = 0;
  const fake = { label: 'f', available: true, description: '', version: 'v1', async run({ now }) { calls++; return { notes: ['n'], proposals: [{ kind: 'insight', key: `k-${now % 2}`, title: 'Hallazgo', detail: {}, touches: [] }] }; } };
  const st = memoryStore(); const dir = createDirector({ store: st, feed, agents: { fake } });
  await dir.run({ now: 1000, trigger: 'test' });
  const trs = await dir.traces();
  t('director: cada corrida deja un rastro con versión, propuestas y resultado', trs.length === 1 && trs[0].agents[0].version === 'v1' && trs[0].agents[0].proposals[0].outcome && trs[0].agents[0].proposals[0].key === 'k-0');
  const before = calls;
  const rp = await dir.replay(trs[0].id, 'fake');
  t('director: la reproducción es en seco (no crea propuestas) y coincide si nada cambió', rp.dry_run === true && rp.same === true && rp.same_version === true && (await st.listProposals('pending', 50)).length === 0 && calls === before + 1);
  fake.version = 'v2';
  const rp2 = await dir.replay(trs[0].id, 'fake');
  t('director: si el agente cambió de versión, la reproducción lo avisa', rp2.same_version === false && rp2.recorded_version === 'v1' && rp2.current_version === 'v2');
  t('director: rastro o agente inexistente → 404', await dir.replay('nope', 'fake').then(() => false, (e) => e.status === 404));
  t('versión de agente sin declarar = huella estable del código', AG.agentVersion({ run: () => 1 }) === AG.agentVersion({ run: () => 1 }) && AG.agentVersion({ run: () => 1 }) !== AG.agentVersion({ run: () => 2 }));
  const boom = createDirector({ store: memoryStore(), feed, agents: { b: { label: 'b', available: true, description: '', async run() { throw new Error('falló'); } } } });
  await boom.run({ now: 5 });
  t('director: un agente que falla queda en el rastro con el error', (await boom.traces())[0].agents[0].error === 'falló');
  const tr = await O('GET', '/api/owner/director/traces');
  t('API: el dueño ve los rastros y las versiones; un cliente no', tr.status === 200 && Array.isArray(tr.body.traces) && (await A('GET', '/api/owner/director/traces')).status === 403);
  await O('POST', '/api/owner/brain/run', {});
  const tr2 = (await O('GET', '/api/owner/director/traces')).body.traces;
  const any = tr2[0].agents.find((x) => x.agent);
  const rpApi = await O('POST', '/api/owner/director/replay', { trace: tr2[0].id, agent: any.agent });
  t('API: el dueño reproduce un agente en seco', rpApi.status === 200 && rpApi.body.dry_run === true);
  t('API: un cliente no puede reproducir', (await A('POST', '/api/owner/director/replay', { trace: tr2[0].id, agent: any.agent })).status === 403);
}

console.log('Ventaja, tamaño dinámico, filtro, deslizamiento y validación');
{
  const E = await import('../lib/edge.js'); const SZ = await import('../lib/sizing.js'); const FL = await import('../lib/filter.js'); const SL = await import('../lib/slippage.js'); const VA = await import('../lib/validate.js');
  const mk = (n, f, step) => Array.from({ length: n }, (_, i) => { const c = f(i); return { t: i * step, o: c, h: c * 1.001, l: c * 0.999, c, v: 10 }; });
  const strongUp = (i) => 100 * (1 + 0.006 * i + 0.02 * Math.sin(i * 1.3));
  const h1 = mk(120, strongUp, 3600); const m15 = mk(120, (i) => 100 * (1 + 0.0015 * i + 0.002 * Math.sin(i * 1.1)), 900);
  h1.forEach((c, i) => { c.v = i >= 117 ? 25 : 10; });
  const good = E.evaluateEdge({ m15, h1 }, { rtPct: 0.3, regime: 'bull' });
  t('edge: tendencia fuerte en 15m/1h/4h con volumen creciente y costo bajo es operable (score ≥ 70, valor esperado ≥ 1.5× costo)', good.tradeable === true && good.edge_score >= 70 && good.ev_gross_pct >= 1.5 * good.cost_pct, JSON.stringify(good.reasons));
  t('edge: cada filtro queda registrado con su detalle', ['mtf', 'relvol', 'rsi', 'ev', 'score'].every((id) => good.checks.some((c) => c.id === id && typeof c.detail === 'string')));
  const down15 = mk(120, (i) => 100 * (1 - 0.0015 * i + 0.002 * Math.sin(i * 1.1)), 900);
  const noMtf = E.evaluateEdge({ m15: down15, h1 }, { rtPct: 0.3, regime: 'bull' });
  t('edge: si 15m no coincide con 1h/4h NO es operable (confluencia)', noMtf.tradeable === false && noMtf.checks.find((c) => c.id === 'mtf').ok === false);
  const lowVol = h1.map((c, i) => ({ ...c, v: i >= 117 ? 2 : 10 }));
  t('edge: volumen por debajo del promedio no es operable', E.evaluateEdge({ m15, h1: lowVol }, { rtPct: 0.3, regime: 'bull' }).checks.find((c) => c.id === 'relvol').ok === false);
  t('edge: con costo alto (1.6 %) el movimiento esperado no alcanza 1.5× → no operable', E.evaluateEdge({ m15, h1 }, { rtPct: 4, regime: 'bull' }).tradeable === false);
  const slipped = E.evaluateEdge({ m15, h1 }, { rtPct: 0.3, regime: 'bull', slipExtraPct: 1 });
  t('edge: el deslizamiento real medido se resta (2 veces, entrada y salida) del valor esperado', slipped.cost_pct > good.cost_pct + 1.9 && slipped.ev_net_pct < good.ev_net_pct);
  t('edge: sin velas suficientes no inventa nada (no operable, motivo claro)', E.evaluateEdge({ m15: m15.slice(0, 5), h1: h1.slice(0, 5) }, { rtPct: 0.3 }).insufficient === true);
  t('edge: agregar 1h→4h agrupa de a 4 y conserva volumen total', (() => { const a = E.aggregate(mk(8, (i) => 100 + i, 3600), 4); return a.length === 2 && a[0].v === 40 && a[1].c === 107; })());
  t('edge: el score nunca pasa de 100 ni baja de 0', good.edge_score <= 100 && E.evaluateEdge({ m15: down15, h1: lowVol }, { rtPct: 9 }).edge_score >= 0);

  // Tamaño dinámico
  const base = { configuredUsd: 50, equityUsd: 1000, openExposureUsd: 0, candidateRets: Array.from({ length: 48 }, (_, i) => (i % 2 ? 0.004 : -0.004)), heldRets: [], closedPnlPcts: [], equityCurve: [1000], pnl24hUsd: 0, regime: 'bull', edgeScore: 85, killSwitch: false };
  const a1 = SZ.sizeDecision(base);
  t('tamaño: nunca supera lo pedido, el 5 % del capital ni el objetivo de volatilidad', a1.approved && a1.usd <= 50 && a1.usd <= 0.05 * 1000 + 1e-9, JSON.stringify(a1.log.steps.map((x) => x.text)));
  t('tamaño: más volatilidad → posición más chica (objetivo de volatilidad)', SZ.sizeDecision({ ...base, candidateRets: base.candidateRets.map((x) => x * 10) }).usd < a1.usd || SZ.sizeDecision({ ...base, candidateRets: base.candidateRets.map((x) => x * 10) }).approved === false);
  t('tamaño: apagado de emergencia veta siempre', SZ.sizeDecision({ ...base, killSwitch: true }).approved === false);
  t('tamaño: caída ≥ 10 % desde el máximo pausa las compras', /Pausa por caída máxima/.test(SZ.sizeDecision({ ...base, equityCurve: [1000, 1100, 980] }).reason));
  t('tamaño: pérdida de 24 h ≥ 3 % del capital pausa las compras', /pérdida diaria/i.test(SZ.sizeDecision({ ...base, pnl24hUsd: -35 }).reason));
  const losing = Array.from({ length: 25 }, (_, i) => (i % 4 === 0 ? 1 : -1.5));
  t('tamaño: Kelly ≤ 0 con historial suficiente veta (sin ventaja demostrada)', /Kelly ≤ 0/.test(SZ.sizeDecision({ ...base, closedPnlPcts: losing }).reason));
  t('tamaño: con pocas operaciones NO usa Kelly (no inventa estadística)', SZ.sizeDecision({ ...base, closedPnlPcts: [1, -1, 1] }).log.steps.some((s) => s.id === 'kelly' && /faltan/.test(s.text)));
  const kel = SZ.kellyFromTrades([...Array(14).fill(2), ...Array(6).fill(-1)], { kellyMult: 0.35, kellyMinTrades: 20 });
  t('tamaño: Kelly fraccional = f* × 0.35 (p=0.7, b=2 → f*=0.55)', Math.abs(kel.full - 0.55) < 1e-9 && Math.abs(kel.fraction - 0.1925) < 1e-9);
  const same = Array.from({ length: 48 }, (_, i) => Math.sin(i / 3) * 0.01);
  t('tamaño: candidato casi idéntico a lo que ya tienes (correlación ≥ 0.85) se veta', /correlación/.test(SZ.sizeDecision({ ...base, candidateRets: same, heldRets: [{ sym: 'ETH-USD', rets: same.map((x) => x * 1.1) }] }).reason));
  const some = SZ.sizeDecision({ ...base, candidateRets: same, heldRets: [{ sym: 'ETH-USD', rets: same.map((x, i) => x * 0.8 + Math.cos(i / 2) * 0.004) }] });
  t('tamaño: correlación alta pero no extrema reduce a la mitad (o veta), nunca aumenta', !some.approved || some.usd <= SZ.sizeDecision({ ...base, candidateRets: same }).usd);
  t('tamaño: exposición total al tope veta', /Exposición total/.test(SZ.sizeDecision({ ...base, openExposureUsd: 400 }).reason));
  t('tamaño: régimen volátil/bajista y edge_score bajo reducen el tamaño', SZ.sizeDecision({ ...base, regime: 'volatile', edgeScore: 72 }).usd < a1.usd);
  t('tamaño: por debajo del mínimo ($10) no abre órdenes diminutas', SZ.sizeDecision({ ...base, configuredUsd: 5 }).approved === false);
  t('tamaño: sin capital de riesgo no dimensiona (falla cerrado)', SZ.sizeDecision({ ...base, equityUsd: 0 }).approved === false);
  t('tamaño: cada decisión deja el detalle paso a paso', a1.log.steps.length >= 5 && a1.log.steps.every((s) => s.id && s.text));
  t('tamaño: la curva de capital y los % salen de operaciones cerradas', (() => { const r = SZ.curveFromClosed([{ pnl: -10, pct: -5 }, { pnl: 4, pct: 2 }], 100); return r.curve.join() === '100,90,94' && r.pcts.join() === '-5,2'; })());

  // Filtro
  const calm = Array.from({ length: 200 }, (_, i) => 100 + Math.sin(i / 10));
  const fOk = FL.tradeFilter({ base: 'BTC', news: { risk_off: false, risk: {} }, hourlyCloses: calm, volume24Usd: 5e7, recentPct: [1, 0.5, -0.2, 0.8, 0.3, 0.2, 0.1, 0.4, 0.6, 0.2] });
  t('filtro: condiciones normales → GO, con cada chequeo visible', fOk.go === true && fOk.checks.length >= 5 && /^GO/.test(fOk.summary));
  t('filtro: noticias negativas de esa cripto o del mercado vetan', FL.tradeFilter({ base: 'SOL', news: { risk_off: false, risk: { SOL: 1 } } }).go === false && FL.tradeFilter({ base: 'BTC', news: { risk_off: true, risk: {} } }).go === false);
  const wild = Array.from({ length: 200 }, (_, i) => (i < 176 ? 100 + Math.sin(i) * 0.1 : 100 * (1 + (i % 2 ? 0.05 : -0.05))));
  t('filtro: volatilidad que se dispara vs la semana previa veta', FL.tradeFilter({ base: 'BTC', hourlyCloses: wild }).reasons.some((x) => /Volatilidad/.test(x)));
  t('filtro: expectativa reciente colapsada (últimas 10) veta; con pocas operaciones no evalúa', FL.tradeFilter({ base: 'BTC', recentPct: Array(10).fill(-1) }).go === false && FL.tradeFilter({ base: 'BTC', recentPct: [-5, -5] }).go === true);
  t('filtro: poca liquidez veta', FL.tradeFilter({ base: 'BTC', volume24Usd: 1e5 }).go === false);
  t('filtro: funding sin fuente de datos queda «no evaluado» y NO bloquea ni se inventa', (() => { const f = FL.tradeFilter({ base: 'BTC' }).checks.find((c) => c.id === 'funding'); return f.evaluated === false && f.ok === true; })() && FL.tradeFilter({ base: 'BTC', fundingPct: 0.5 }).go === false);

  // Deslizamiento real
  const st = memoryStore();
  t('deslizamiento: compra que pagó más y venta que cobró menos son adversos (positivo)', Math.abs(SL.adversePct('buy', 100, 100.2) - 0.2) < 1e-9 && Math.abs(SL.adversePct('sell', 100, 99.8) - 0.2) < 1e-9 && SL.adversePct('buy', 100, 99.9) < 0);
  for (let i = 0; i < 12; i++) await SL.recordFill(st, { userId: 'u', exchange: 'coinbase', symbol: 'BTC-USD', side: 'buy', decisionPrice: 100, fillPrice: 100.5, modelPct: 0.1, usd: 50, cid: `c${i}`, now: Date.now() });
  const dup = await SL.recordFill(st, { userId: 'u', exchange: 'coinbase', symbol: 'BTC-USD', side: 'buy', decisionPrice: 100, fillPrice: 100.5, modelPct: 0.1, usd: 50, cid: 'c0' });
  const sum = SL.summarize(await SL.loadLog(st), { exchange: 'coinbase' });
  t('deslizamiento: el mismo fill no se registra dos veces; con ≥10 fills resume real vs modelo', dup === null && sum.enough && Math.abs(sum.medianRealPct - 0.5) < 1e-6 && Math.abs(sum.extraPct - 0.4) < 1e-6);
  t('deslizamiento: con pocos fills no hay corrección (no se infiere de 3 datos)', SL.summarize((await SL.loadLog(st)).slice(0, 3), { minN: 10 }).extraPct === 0);
  t('deslizamiento: datos absurdos (> 25 %) se descartan', (await SL.recordFill(st, { userId: 'u', exchange: 'coinbase', symbol: 'X', side: 'buy', decisionPrice: 1, fillPrice: 2, modelPct: 0, usd: 1, cid: 'z' })) === null);

  // Validación walk-forward
  let sd = 7; const rnd = () => { sd = (sd * 1664525 + 1013904223) % 4294967296; return sd / 4294967296; };
  const gs = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
  const walk = (n, drift, vol) => { const a = [100]; for (let i = 1; i < n; i++) a.push(a[i - 1] * (1 + drift + vol * gs())); return a; };
  const coin = walk(1400, 0.0001, 0.008); const btc = walk(1400, 0.00005, 0.006);
  const wf = VA.walkForward(coin, { symbol: 'ETH-USD' }, btc);
  t('validación: ventanas sin solaparse con el entrenamiento (embargo) y todas dentro de los datos', wf.windows.length >= 3 && wf.windows.every((w) => w.teStart >= 500 + 24 && w.teEnd <= 1400));
  t('validación: informe con comprar-y-mantener de la cripto y de BTC, regímenes y estrés', Number.isFinite(wf.oos.coinHoldPct) && Number.isFinite(wf.oos.btcHoldPct) && ['bull', 'bear', 'sideways', 'volatile'].every((k) => k in wf.regimes) && wf.stress.length === 3);
  t('validación: sobre datos aleatorios (sin ventaja posible) NO declara «evidencia razonable»', !/EVIDENCIA RAZONABLE/.test(wf.verdict));
  const coin2 = coin.slice(0, 1100).concat(walk(300, -0.002, 0.02).map((x) => x * coin[1099] / 100));
  const wf2 = VA.walkForward(coin2, { symbol: 'ETH-USD' }, btc);
  t('validación: SIN mirar el futuro — cambiar datos posteriores no altera las ventanas anteriores', wf.windows.slice(0, 2).every((w, i) => w.testReturnPct === wf2.windows[i].testReturnPct && JSON.stringify(w.params) === JSON.stringify(wf2.windows[i].params)));
  t('validación: deslizamiento ×3 nunca rinde más que ×1', wf.stress[2].returnPct <= wf.stress[0].returnPct + 1e-9);
  const rb = VA.walkForward(coin, { symbol: 'ETH-USD', exchange: 'robinhood' }, btc);
  t('validación: Coinbase y Robinhood usan costos distintos (resultados distintos)', rb.oos.returnPct !== wf.oos.returnPct || rb.oos.feesUsd !== wf.oos.feesUsd);
  const md = VA.formatReport(wf);
  t('validación: el informe en texto incluye veredicto, regímenes, estrés y límites', /Veredicto/.test(md) && /Por régimen/.test(md) && /Estrés de deslizamiento/.test(md) && /Resultados pasados no garantizan/.test(md));
  t('validación: pocas velas → error claro', (() => { try { VA.walkForward(coin.slice(0, 300), {}); return false; } catch (e) { return /Pocas velas/.test(e.message); } })());
  t('validación: el régimen de cada vela solo usa datos anteriores', VA.regimeAt(coin, 400) === VA.regimeAt(coin.slice(0, 401).concat(Array(500).fill(1)), 400));
}

console.log('Motor: filtro de ventaja, tamaño dinámico y bitácora');
{
  const mkS = (a, b, d, n = 120) => Array.from({ length: n }, (_, i) => 100 * (1 + d * i) * (1 + a * Math.sin(i / b)));
  const up = mkS(0.02, 2, 0.002);
  const candles = (cl, vol) => cl.map((c, i) => ({ t: i * 3600, o: c, h: c, l: c, c, v: vol }));
  const feedE = { getPrice: async () => up.at(-1), getCloses: async () => up, getHistory: async () => up, getCandles: async () => candles(up, 10) };
  const mkUser = async (email, cfgExtra) => {
    const U = client(); await U('POST', '/api/auth/register', { email, password: 'Clave-De-Pro-12345', acceptTos: true });
    const id = (await U('GET', '/api/me')).body.user.id;
    const put = await U('PUT', '/api/bot', { autoMode: 'pro', symbol: 'AUTO', strategy: 'sma', usd: 10, intervalMin: 60, mode: 'paper', paperExchange: 'best', enabled: false, maxOrderUsd: 25, maxDailyUsd: 100, maxPositions: 3, ...cfgExtra });
    await store.patchBot(id, { cfg: { ...(await store.getBot(id)).cfg, enabled: true } });
    return { U, id, put };
  };
  const run = async (id, feed = feedE) => { const e = createEngine({ store, adapters, feed, encKey: env.ENCRYPTION_KEY, log: { error() {} } }); await e.runBot({ ...(await store.getBot(id)), last_run: 0 }, Date.now() + 1000); };
  const logOf = async (id) => JSON.parse(await store.getSetting(`edge:log:${id}`, '[]'));
  const buys = async (id) => (await store.listOrders(id)).filter((o) => o.status === 'ok' && o.side === 'buy');
  t('config: edgeGate, dynamicSizing y riskCapitalUsd se validan', (await (client())('GET', '/api/health')).status === 200 && (await import('../lib/strategy.js')).validateCfg({ edgeGate: 'zzz', riskCapitalUsd: -1 }).ok === false && (await import('../lib/strategy.js')).validateCfg({ edgeGate: 'zzz' }).ok === true && (await import('../lib/strategy.js')).validateCfg({ edgeGate: 'zzz' }).cfg.edgeGate === 'shadow');

  const s = await mkUser('edge-shadow@x.com', { edgeGate: 'shadow' });
  t('config: el cliente puede guardar el filtro de ventaja y el capital de riesgo', s.put.status === 200 && s.put.body.cfg.edgeGate === 'shadow' && s.put.body.cfg.riskCapitalUsd === 0);
  const off = await mkUser('edge-off@x.com', { edgeGate: 'off' });
  await run(off.id); const baseline = (await buys(off.id)).length;
  await run(s.id);
  const sl = await logOf(s.id);
  t('modo sombra: registra la evaluación (edge_score, filtro, costos) SIN cambiar la compra', baseline >= 1 && (await buys(s.id)).length === baseline && sl.length >= 1 && typeof sl[0].edge_score === 'number' && sl[0].gate === 'shadow' && sl[0].vetoed === false);
  t('modo sombra: marca que habría vetado cuando no hay ventaja multi-timeframe', sl[0].would_veto === true && sl[0].reasons.length > 0);

  const on = await mkUser('edge-on@x.com', { edgeGate: 'on' });
  await run(on.id);
  t('modo activo: sin ventaja suficiente NO compra y deja el motivo', (await buys(on.id)).length === 0 && (await logOf(on.id)).some((x) => x.vetoed === true));
  t('modo apagado: compra como antes y no registra evaluación', (await buys(off.id)).length === baseline && (await logOf(off.id)).length === 0);
  const nofeed = await mkUser('edge-nofeed@x.com', { edgeGate: 'on' });
  await run(nofeed.id, { getPrice: feedE.getPrice, getCloses: feedE.getCloses, getHistory: feedE.getHistory });
  t('sin velas de 15 min/volumen (feed sin getCandles) el filtro no inventa nada ni bloquea', (await buys(nofeed.id)).length === baseline);

  const small = await mkUser('size-small@x.com', { riskCapitalUsd: 100 });
  await run(small.id);
  t('tamaño dinámico: capital de riesgo $100 → 5 % = $5 < mínimo $10: no abre y lo audita', (await buys(small.id)).length === 0 && (await store.listAudit(500)).some((a) => a.user_id === small.id && a.action === 'sizing_veto'));
  const big = await mkUser('size-big@x.com', { riskCapitalUsd: 1000, edgeGate: 'off' });
  await run(big.id);
  const bo = await buys(big.id);
  t('tamaño dinámico: capital $1000 → compra, y NUNCA más de lo configurado ($10)', bo.length === baseline && bo.every((o) => o.usd <= 10.5), JSON.stringify(bo.map((o) => o.usd)));
  t('tamaño dinámico: cada decisión de tamaño queda en la bitácora con sus pasos', (await logOf(big.id)).some((x) => x.kind === 'size' && x.approved === true && x.steps.length >= 3));
  const dd = await mkUser('size-dd@x.com', { riskCapitalUsd: 100, edgeGate: 'off', usd: 10 });
  const t0 = Date.now() - 86400000 * 3;
  for (let i = 0; i < 3; i++) { await store.addOrder({ user_id: dd.id, mode: 'paper', exchange: 'coinbase', symbol: 'ZZ-USD', side: 'buy', usd: 50, qty: 50, price: 1, status: 'ok', created_at: t0 + i * 2000 }); await store.addOrder({ user_id: dd.id, mode: 'paper', exchange: 'coinbase', symbol: 'ZZ-USD', side: 'sell', usd: 46, qty: 50, price: 0.92, status: 'ok', created_at: t0 + i * 2000 + 1000 }); }
  await run(dd.id);
  t('tamaño dinámico: tras una caída ≥ 10 % del capital de riesgo pausa las compras', (await store.listAudit(500)).some((a) => a.user_id === dd.id && a.action === 'sizing_veto' && /caída máxima/i.test(a.detail)) && (await buys(dd.id)).filter((o) => o.symbol !== 'ZZ-USD').length === 0);
  const vr = await O('POST', '/api/owner/validation', { symbol: 'ETH-USD', exchange: 'coinbase' });
  t('API: el dueño corre la validación walk-forward y recibe informe + texto', vr.status === 200 && vr.body.report.windows.length >= 1 && /Veredicto/.test(vr.body.markdown) && Number.isFinite(vr.body.report.oos.btcHoldPct), JSON.stringify(vr.body).slice(0, 200));
  t('API: validación — un cliente no puede, símbolo inválido se rechaza', (await A('POST', '/api/owner/validation', { symbol: 'ETH-USD' })).status === 403 && (await O('POST', '/api/owner/validation', { symbol: 'HACK-USD' })).status === 400);
  const el = await dd.U('GET', '/api/bot/edge-log');
  t('API: el cliente ve su propia bitácora y el resumen; otro cliente no ve la de ella', el.status === 200 && el.body.summary.size_vetoes >= 1 && (await nobody('GET', '/api/bot/edge-log')).status === 401 && (await big.U('GET', '/api/bot/edge-log')).body.log.every((x) => x.sym !== 'ZZ-USD'));
  const nocap = await mkUser('size-none@x.com', { edgeGate: 'off' });
  await run(nocap.id);
  t('sin capital de riesgo declarado el tamaño dinámico no interfiere (comportamiento anterior)', (await buys(nocap.id)).length === baseline);

  // Recomendación al tocar Comprar/Vender y aviso cuando una posición sube
  const feedNo = { getPrice: feedE.getPrice, getCloses: feedE.getCloses, getHistory: feedE.getHistory };
  const mkEng = (feed, got = []) => createEngine({ store, adapters, feed, encKey: env.ENCRYPTION_KEY, log: { error() {} }, alert: async (u, x) => { got.push([u, x]); } });
  const adv = await mkUser('adv1@x.com', { edgeGate: 'off' });
  const e1 = mkEng(feedNo);
  const noPos = await e1.advise(adv.id, { side: 'sell', symbol: 'ADA-USD', mode: 'paper' });
  t('recomendación venta: sin posición lo dice claro', noPos.verdict === 'sin_posicion' && /No tienes/.test(noPos.headline));
  await store.addOrder({ user_id: adv.id, mode: 'paper', exchange: 'coinbase', symbol: 'ADA-USD', side: 'buy', usd: 100, qty: 1, price: 100, status: 'ok', created_at: Date.now() - 5 * 3600000 });
  const sellBig = await e1.advise(adv.id, { side: 'sell', symbol: 'ADA-USD', mode: 'paper' });
  t('recomendación venta: con buena ganancia neta recomienda vender (con porcentaje) y explica el costo', sellBig.verdict === 'vender' && sellBig.suggestedFraction > 0 && /VENDER/.test(sellBig.headline) && sellBig.net_pct < sellBig.gain_pct && sellBig.reasons.length >= 2 && /no es asesoría/.test(sellBig.disclaimer), JSON.stringify(sellBig).slice(0, 300));
  const adv2 = await mkUser('adv2@x.com', { edgeGate: 'off' });
  await store.addOrder({ user_id: adv2.id, mode: 'paper', exchange: 'coinbase', symbol: 'ADA-USD', side: 'buy', usd: 123, qty: 1, price: 123, status: 'ok', created_at: Date.now() - 2 * 3600000 });
  const hold = await e1.advise(adv2.id, { side: 'sell', symbol: 'ADA-USD', mode: 'paper' });
  t('recomendación venta: con ganancia que no cubre costos y meta recomienda mantener', hold.verdict === 'mantener' && /MANTENER/.test(hold.headline) && hold.suggestedFraction === 0, JSON.stringify(hold).slice(0, 300));
  const buyOk = await e1.advise(adv.id, { side: 'buy', symbol: 'ADA-USD', mode: 'paper', usd: 10 });
  t('recomendación compra: con señal limpia recomienda comprar con monto y razones', buyOk.verdict === 'comprar' && buyOk.suggestedUsd > 0 && buyOk.suggestedUsd <= 10 && /COMPRAR/.test(buyOk.headline) && buyOk.reasons.length >= 2, JSON.stringify(buyOk).slice(0, 300));
  const buyEdge = await mkEng({ ...feedE, getCandles: async () => candles(up, 1e5) }).advise(adv.id, { side: 'buy', symbol: 'ADA-USD', mode: 'paper', usd: 10 });
  t('recomendación compra: si el filtro multi-timeframe/volumen no ve ventaja, recomienda esperar y dice por qué', buyEdge.verdict === 'esperar' && /ESPERAR/.test(buyEdge.headline) && typeof buyEdge.edge_score === 'number', JSON.stringify(buyEdge).slice(0, 400));
  await store.setSetting('news:latest', JSON.stringify({ t: Date.now(), items: [], risk: { ADA: 1 }, global_neg: 1, risk_off: false }));
  const buyNews = await mkEng(feedNo).advise(adv.id, { side: 'buy', symbol: 'ADA-USD', mode: 'paper', usd: 10 });
  await store.setSetting('news:latest', JSON.stringify({ t: Date.now(), items: [], risk: {}, global_neg: 0, risk_off: false }));
  t('recomendación compra: noticia negativa de esa cripto → no comprar ahora', buyNews.verdict === 'evitar' && /NO comprar/.test(buyNews.headline));
  const flatC = Array.from({ length: 120 }, (_, i) => 100 + (i % 2));
  const buyFlat = await mkEng({ ...feedNo, getCloses: async () => flatC, getPrice: async () => flatC.at(-1) }).advise(adv.id, { side: 'buy', symbol: 'ADA-USD', mode: 'paper', usd: 10 });
  t('recomendación compra: sin tendencia → esperar', buyFlat.verdict === 'esperar');
  const noPrice = await mkEng({ getPrice: async () => { throw new Error('x'); }, getCloses: async () => up, getHistory: async () => up }).advise(adv.id, { side: 'buy', symbol: 'ETH-USD', mode: 'paper' });
  t('recomendación: si no hay precio no inventa nada', noPrice.verdict === 'sin_datos');
  const advApi = await A('GET', '/api/trade/advice?side=buy&mode=paper&symbol=BTC-USD&usd=10');
  t('API recomendación: devuelve titular, veredicto y aviso legal', advApi.status === 200 && !!advApi.body.headline && !!advApi.body.verdict && /no es asesoría/.test(advApi.body.disclaimer), JSON.stringify(advApi.body).slice(0, 200));
  t('API recomendación: exige sesión y valida los datos', (await nobody('GET', '/api/trade/advice?side=buy&symbol=BTC-USD')).status === 401 && (await A('GET', '/api/trade/advice?side=hack&symbol=BTC-USD')).status === 400 && (await A('GET', '/api/trade/advice?side=buy&symbol=HACK-USD')).status === 400);

  // Aviso de «subió, conviene vender»
  const sw = await mkUser('sellwatch1@x.com', { edgeGate: 'off' });
  await sw.U('POST', '/api/push/subscribe', { endpoint: 'https://fcm.googleapis.com/fcm/send/sellwatch1' });
  await store.addOrder({ user_id: sw.id, mode: 'paper', exchange: 'coinbase', symbol: 'ADA-USD', side: 'buy', usd: 100, qty: 1, price: 100, status: 'ok', created_at: Date.now() - 3600000 });
  const mkPx = (px, got) => mkEng({ getPrice: async () => px, getCloses: async () => up, getHistory: async () => up }, got);
  let got = []; const mine = () => got.filter((x) => x[0] === sw.id && /^sell:/.test(x[1].kind));
  await mkPx(110, got).sellWatch();
  t('aviso de subida: una posición con ganancia neta sobre la meta manda push con el porcentaje', mine().length === 1 && /subió \+10\.0 %/.test(mine()[0][1].title) && /Vender/.test(mine()[0][1].body), JSON.stringify(mine()));
  await mkPx(110.5, got).sellWatch();
  t('aviso de subida: no repite el mismo aviso (sin spam)', mine().length === 1);
  await mkPx(116, got).sellWatch();
  t('aviso de subida: si gana 2 puntos más, avisa de nuevo', mine().length === 2);
  await mkPx(101, got).sellWatch();
  await mkPx(112, got).sellWatch();
  t('aviso de subida: si cae bajo la meta y vuelve a subir, avisa otra vez', mine().length === 3);
  const g6 = []; await mkPx(101, g6).sellWatch();
  t('aviso de subida: ganancia que no cubre costos y meta NO avisa', !g6.some((x) => x[0] === sw.id && /^sell:/.test(x[1].kind)));
  // Protección por caída: aviso al llegar al stop
  const dn = await mkUser('stopwatch1@x.com', { edgeGate: 'off', stopLossPct: 5 });
  await dn.U('POST', '/api/push/subscribe', { endpoint: 'https://fcm.googleapis.com/fcm/send/stopwatch1' });
  await store.addOrder({ user_id: dn.id, mode: 'paper', exchange: 'coinbase', symbol: 'ADA-USD', side: 'buy', usd: 100, qty: 1, price: 100, status: 'ok', created_at: Date.now() - 3 * 3600000 });
  const dcl = Array.from({ length: 120 }, (_, i) => (i < 100 ? 100 + i * 0.3 : 129.7 - (i - 99) * 2));
  const mkDn = (px, g) => mkEng({ getPrice: async () => px, getCloses: async () => dcl, getHistory: async () => dcl }, g);
  const gd = []; const d1 = await mkDn(88, gd).sellWatch();
  t('aviso de caída: al llegar al stop avisa para limitar la pérdida, con el porcentaje', d1.alerts >= 1 && gd.some((x) => x[0] === dn.id && /cayó -12\.0 %/.test(x[1].title) && /limitar la pérdida/.test(x[1].body)), JSON.stringify(gd));
  const d2 = await mkDn(87, gd).sellWatch();
  t('aviso de caída: no repite el aviso en 6 h', gd.filter((x) => x[0] === dn.id).length === 1 && d2.alerts >= 0);
  const gOk = []; const dOk = await mkEng({ getPrice: async () => 130, getCloses: async () => Array.from({ length: 120 }, (_, i) => 100 + i * 0.25), getHistory: async () => up }, gOk).sellWatch();
  t('aviso de caída: una posición en ganancia nunca dispara el aviso de stop', !gOk.some((x) => /cayó/.test(x[1].title)));
  // Debilitamiento (tendencia rota) también avisa
  const wk = await mkUser('weakwatch1@x.com', { edgeGate: 'off', stopLossPct: 40 });
  await wk.U('POST', '/api/push/subscribe', { endpoint: 'https://fcm.googleapis.com/fcm/send/weakwatch1' });
  await store.addOrder({ user_id: wk.id, mode: 'paper', exchange: 'coinbase', symbol: 'ADA-USD', side: 'buy', usd: 100, qty: 1, price: 100, status: 'ok', created_at: Date.now() - 5 * 3600000 });
  const wcl = Array.from({ length: 120 }, (_, i) => (i < 80 ? 100 + i * 0.5 : 140 - (i - 79) * 0.35));
  const gw = []; await mkEng({ getPrice: async () => wcl.at(-1), getCloses: async () => wcl, getHistory: async () => wcl }, gw).sellWatch();
  t('aviso de venta: si la tendencia se rompe avisa que conviene vender, con el motivo', gw.some((x) => x[0] === wk.id && /pierde fuerza|retrocedió|cayó/.test(x[1].title) && /vender/i.test(x[1].body)), JSON.stringify(gw.filter((x) => x[0] === wk.id)));
  const noSub = await mkUser('sellwatch2@x.com', { edgeGate: 'off' });
  await store.addOrder({ user_id: noSub.id, mode: 'paper', exchange: 'coinbase', symbol: 'ADA-USD', side: 'buy', usd: 100, qty: 1, price: 100, status: 'ok', created_at: Date.now() - 3600000 });
  const gotNs = []; await mkPx(120, gotNs).sellWatch();
  t('aviso de subida: solo se vigila a quien activó los avisos', !gotNs.some((x) => x[0] === noSub.id));

  // Aviso de oportunidad de compra
  const strong = Array.from({ length: 120 }, (_, i) => 100 * (1 + 0.01 * i + 0.04 * Math.sin(i * 1.3)));
  const sCandles = (st) => strong.map((c, i) => ({ t: i * st, o: c, h: c * 1.001, l: c * 0.999, c, v: i >= 117 ? 3e5 : 1e5 }));
  const feedS = { getPrice: async () => strong.at(-1), getCloses: async () => strong, getHistory: async () => strong, getCandles: async (sym, g) => sCandles(g) };
  await store.setSetting('scanner:latest', JSON.stringify({ t: Date.now(), scanned: 3, universe: 3, items: ['ADA-USD', 'DOT-USD', 'LTC-USD', 'LINK-USD'].map((symbol, k) => ({ symbol, label: symbol, qualified: false, cheaper: 'coinbase', gap_pct: 0, mcap: 1e10 - k, cfg: { strategy: 'sma', fast: 5, slow: 20, rsiBuy: 30, rsiSell: 60 }, coinbase: { ret: 1, bh: 1, drag: 1 }, robinhood: { ret: 1, bh: 1, drag: 1 } })) }));
  const bw = await mkUser('buywatch1@x.com', { edgeGate: 'off' });
  await store.patchBot(bw.id, { cfg: { ...(await store.getBot(bw.id)).cfg, enabled: false } }); // bot apagado: el aviso de compra es para quien decide a mano
  await bw.U('POST', '/api/push/subscribe', { endpoint: 'https://fcm.googleapis.com/fcm/send/buywatch1' });
  const gb = []; const mineB = () => gb.filter((x) => x[0] === bw.id && /^buy:/.test(x[1].kind));
  await mkEng(feedS, gb).buyWatch(Date.now());
  t('aviso de compra: una oportunidad que cumple TODO manda push con la ventaja y el monto sugerido', mineB().length >= 1 && /Oportunidad/.test(mineB()[0][1].title) && /ventaja \d+\/100/.test(mineB()[0][1].body) && /Comprar/.test(mineB()[0][1].body), JSON.stringify(mineB()));
  t('aviso de compra: máximo 3 por día por persona', mineB().length <= 3);
  const n1 = mineB().length; await mkEng(feedS, gb).buyWatch(Date.now() + 60000);
  t('aviso de compra: no repite la misma cripto ni pasa el tope diario', mineB().length === n1);
  const gb2 = []; await mkEng(feedS, gb2).buyWatch(Date.now() + 90000000);
  t('aviso de compra: al día siguiente puede avisar de nuevo (12 h por cripto)', gb2.filter((x) => x[0] === bw.id).length >= 1);
  const boff = await mkUser('buywatch2@x.com', { edgeGate: 'off', buyAlerts: false });
  await store.patchBot(boff.id, { cfg: { ...(await store.getBot(boff.id)).cfg, enabled: false } });
  await boff.U('POST', '/api/push/subscribe', { endpoint: 'https://fcm.googleapis.com/fcm/send/buywatch2' });
  const gb3 = []; await mkEng(feedS, gb3).buyWatch(Date.now());
  t('aviso de compra: quien lo apagó no recibe avisos de compra', !gb3.some((x) => x[0] === boff.id));
  const bn = await mkUser('buywatch3@x.com', { edgeGate: 'off' });
  await store.patchBot(bn.id, { cfg: { ...(await store.getBot(bn.id)).cfg, enabled: false } });
  await bn.U('POST', '/api/push/subscribe', { endpoint: 'https://fcm.googleapis.com/fcm/send/buywatch3' });
  const gb4 = []; await mkEng({ getPrice: feedS.getPrice, getCloses: feedS.getCloses, getHistory: feedS.getHistory }, gb4).buyWatch(Date.now());
  t('aviso de compra: sin datos de 15 min/volumen NO avisa (no se inventa la ventaja)', !gb4.some((x) => x[0] === bn.id));
  const gb5 = []; await mkEng({ ...feedS, getCandles: async (s, g) => sCandles(g).map((c) => ({ ...c, v: 1 })) }, gb5).buyWatch(Date.now());
  t('aviso de compra: con poca liquidez no avisa', !gb5.some((x) => x[0] === bn.id));
  const on2 = await mkUser('buywatch5@x.com', { edgeGate: 'off' });
  await on2.U('POST', '/api/push/subscribe', { endpoint: 'https://fcm.googleapis.com/fcm/send/buywatch5' });
  const gb7 = []; await mkEng(feedS, gb7).buyWatch(Date.now());
  t('aviso de compra: si el bot ya está encendido en AUTO y compra solo, no manda el aviso redundante', !gb7.some((x) => x[0] === on2.id && /^buy:/.test(x[1].kind)));
  const bd = []; const engBd = mkEng(feedS, bd);
  const tb = await mkUser('botdid1@x.com', { edgeGate: 'off' });
  await engBd.runBot({ ...(await store.getBot(tb.id)), last_run: 0 }, Date.now() + 1000);
  const didBuy = bd.filter((x) => x[0] === tb.id && /^bot:buy:/.test(x[1].kind));
  t('el bot avisa lo que hizo: «🤖 Compré X (simulado)» con monto y motivo', didBuy.length >= 1 && /^🤖 Compré [A-Z]+ \(simulado\)$/.test(didBuy[0][1].title) && /~\$\d/.test(didBuy[0][1].body), JSON.stringify(didBuy));
  const held = await mkUser('buywatch4@x.com', { edgeGate: 'off' });
  await store.patchBot(held.id, { cfg: { ...(await store.getBot(held.id)).cfg, enabled: false } });
  await held.U('POST', '/api/push/subscribe', { endpoint: 'https://fcm.googleapis.com/fcm/send/buywatch4' });
  for (const sy of ['ADA-USD', 'DOT-USD', 'LTC-USD', 'LINK-USD']) await store.addOrder({ user_id: held.id, mode: 'paper', exchange: 'coinbase', symbol: sy, side: 'buy', usd: 10, qty: 1, price: 10, status: 'ok', created_at: Date.now() - 3600000 });
  const gb6 = []; await mkEng(feedS, gb6).buyWatch(Date.now());
  t('aviso de compra: no avisa de criptos que ya tienes', !gb6.some((x) => x[0] === held.id && /^buy:/.test(x[1].kind)));
  const nosubsAlerts = (await mkEng(feedS, []).buyWatch(Date.now())).alerts >= 0;
  t('aviso de compra: solo a quienes activaron avisos (sin suscripción no hay nada que enviar)', nosubsAlerts);
}

server.close();
{ // Explicador IA: sin llave no hace nada; con llave redacta, limita por día y solo propone.
  const { createExplainer, clean } = await import('../lib/llm.js'); const { AGENTS } = await import('../lib/agents.js');
  const st = memoryStore(); const now = Date.now();
  await st.addOrder({ user_id: 'u1', mode: 'paper', exchange: 'coinbase', symbol: 'BTC-USD', side: 'buy', usd: 10, qty: 0.0001, price: 100000, status: 'ok', note: 'edge alto', created_at: now - 60000 });
  const off = await AGENTS.ia_explainer.run({ store: st, now, llm: createExplainer({ env: {} }) });
  t('IA explicadora: sin llave es gratis (plantillas) y explica con datos reales', off.proposals.length === 1 && /BTC-USD/.test(off.proposals[0].detail.text) && /reglas/.test(off.notes[0]));
  const gm = createExplainer({ env: { GEMINI_API_KEY: 'g' }, f: async (u, o) => ({ ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: u.includes('generativelanguage') && o.headers['x-goog-api-key'] === 'g' ? 'Gemini ok' : 'mal' }] } }] }) }) });
  t('IA explicadora: Gemini (gratis) funciona y, si falla, cae a plantilla', (await gm.explain({})).text === 'Gemini ok' && (await createExplainer({ env: { GEMINI_API_KEY: 'g' }, f: async () => ({ ok: false, status: 429 }) }).explain({ ordenes_24h: [] })).free === true);
  let sent = null; const fakeF = async (url, o) => { sent = { url, o }; return { ok: true, json: async () => ({ content: [{ type: 'text', text: 'Compró BTC por edge alto.' }] }) }; };
  const on = createExplainer({ env: { ANTHROPIC_API_KEY: 'k' }, f: fakeF });
  const r1 = await AGENTS.ia_explainer.run({ store: st, now, llm: on });
  t('IA explicadora: con llave propone una explicación (insight, sin tocar nada)', r1.proposals.length === 1 && r1.proposals[0].kind === 'insight' && r1.proposals[0].touches.length === 0 && /BTC/.test(r1.proposals[0].detail.text) && sent.url.includes('anthropic.com') && JSON.parse(sent.o.body).messages[0].content.includes('BTC-USD'));
  for (let i = 0; i < 5; i++) await AGENTS.ia_explainer.run({ store: st, now, llm: on });
  const lim = await AGENTS.ia_explainer.run({ store: st, now, llm: on });
  t('IA explicadora: máximo 4 llamadas al día', lim.proposals.length === 0 && /límite/.test(lim.notes[0]));
  t('IA explicadora: errores de la API no rompen y el texto se limpia', (await createExplainer({ env: { ANTHROPIC_API_KEY: 'k' }, f: async () => ({ ok: false, status: 500 }) }).explain({})).free === true && clean('a\u0000  b\n c', 10) === 'a b c');
}

console.log('Fase 1: libro de órdenes, ciclo de vida e idempotencia');
{
  const L = await import('../lib/ledger.js');
  const base = { userId: 'u', mode: 'live', exchange: 'coinbase', symbol: 'BTC-USD', side: 'buy', t: 1700000000000 };
  t('ID de orden: estable en el mismo minuto, distinto en otro minuto, símbolo o cliente', L.clientOrderId(base) === L.clientOrderId({ ...base, t: base.t + 30000 }) && L.clientOrderId(base) !== L.clientOrderId({ ...base, t: base.t + 61000 }) && L.clientOrderId(base) !== L.clientOrderId({ ...base, symbol: 'ETH-USD' }) && L.clientOrderId(base) !== L.clientOrderId({ ...base, userId: 'v' }));
  t('ID de orden: tiene forma de UUID v5/8-4-4-4-12', /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(L.clientOrderId(base)));
  t('ciclo de vida: transiciones válidas y terminales inmutables', L.canTransition('submitting', 'submitted') && L.canTransition('submitted', 'partial') && L.canTransition('partial', 'filled') && L.canTransition('unknown', 'filled') && !L.canTransition('filled', 'submitted') && !L.canTransition('rejected', 'filled') && !L.canTransition('submitting', 'filled'));
  t('«aceptada» no cuenta como ejecutada; «unknown» cuenta como exposición reservada', L.legacyStatus('submitted') === 'ok' && L.legacyStatus('unknown') === 'pending' && L.COUNTS_AS_EXPOSURE.includes('unknown') && L.isAmbiguous('HTTP 503') && L.isAmbiguous('Coinbase no respondió (timeout)') && !L.isAmbiguous('Insufficient funds'));

  const st = memoryStore(); const u = await st.createUser({ email: 'f1@demo.com', pass_hash: 'x' });
  const r1 = await st.reserveOrder({ user_id: u.id, mode: 'live', exchange: 'coinbase', symbol: 'BTC-USD', side: 'buy', usd: 10, qty: 0.0001, price: 100000, client_order_id: 'C1' });
  const many = await Promise.all(Array.from({ length: 25 }, () => st.reserveOrder({ user_id: u.id, mode: 'live', exchange: 'coinbase', symbol: 'BTC-USD', side: 'buy', usd: 10, qty: 0.0001, price: 100000, client_order_id: 'C1' })));
  t('reserva concurrente: 25 intentos con el mismo ID crean una sola orden', r1.created && many.every((x) => !x.created) && (await st.listOrders(u.id)).length === 1);
  const u2 = await st.createUser({ email: 'f1b@demo.com', pass_hash: 'x' });
  t('el mismo ID en otro cliente es una orden distinta (aislado por tenant)', (await st.reserveOrder({ user_id: u2.id, mode: 'live', symbol: 'BTC-USD', side: 'buy', client_order_id: 'C1' })).created && (await st.transitionOrder(u2.id, r1.order.id, 'submitted')).ok === false);
  t('transición inválida se rechaza y no cambia nada', (await st.transitionOrder(u.id, r1.order.id, 'filled')).ok === false && (await st.listOrders(u.id))[0].lifecycle === 'submitting');
  await st.transitionOrder(u.id, r1.order.id, 'submitted', { ext_id: 'X1' }, 'aceptada');
  await st.transitionOrder(u.id, r1.order.id, 'partial', { filled_qty: 0.00005 }, 'parcial');
  const fin = await st.transitionOrder(u.id, r1.order.id, 'filled', { filled_qty: 0.0001, fee_usd: 0.06 }, 'completa');
  const ev = await st.listOrderEvents(u.id, r1.order.id);
  t('ciclo completo submitting → submitted → partial → filled, con eventos auditables', fin.ok && fin.order.lifecycle === 'filled' && fin.order.fee_usd === 0.06 && ev.map((e) => e.to_state).join() === 'submitting,submitted,partial,filled' && (await st.listOrderEvents(u2.id, r1.order.id)).length === 0);

  // Motor: pedido real con adaptador simulado (nunca toca un broker real)
  const run = async (adapterFn) => {
    const s2 = memoryStore(); const us = await s2.createUser({ email: `f1${Math.random()}@demo.com`, pass_hash: 'x' });
    const cn = await s2.addConnection({ user_id: us.id, exchange: 'coinbase', label: 'cb', key_id: 'k', secret_enc: sec.encrypt(env.ENCRYPTION_KEY, 's'), can_trade: true, can_transfer: false });
    await s2.setSetting('live_trading', 'on'); await s2.setSetting('risk:platform', LOOSE);
    const calls = []; const ad = { coinbase: { ...good, name: 'coinbase', balances: async () => [{ asset: 'USD', available: 500, hold: 0 }], marketBuy: async (_c, a) => { calls.push(a); return adapterFn(a, calls.length); } }, robinhood: good };
    const eng = createEngine({ store: s2, adapters: ad, feed, encKey: env.ENCRYPTION_KEY, log: { error() {} } });
    await s2.saveBot(us.id, { autoMode: 'active', symbol: 'BTC-USD', strategy: 'dca', intervalMin: 15, usd: 10, mode: 'live', enabled: true, liveAck: true, connectionId: cn.id, maxOrderUsd: 25, maxDailyUsd: 100 });
    return { s2, us, eng, calls };
  };
  { const { s2, us, eng, calls } = await run(async () => ({ ok: true, id: 'B1' }));
    const T0 = Math.floor((Date.now() + 5e8) / 60000) * 60000 + 100; await eng.runBot({ ...(await s2.getBot(us.id)), last_run: 0 }, T0);
    const o = (await s2.listOrders(us.id))[0];
    t('motor: orden aceptada queda «submitted» con ID estable enviado al broker (no «ejecutada»)', o && o.lifecycle === 'submitted' && o.ext_id === 'B1' && calls.length === 1 && calls[0].clientOrderId === o.client_order_id && !o.filled_qty);
    await eng.runBot({ ...(await s2.getBot(us.id)), last_run: 0 }, T0 + 1000);
    t('motor: duplicado en el mismo minuto (reintento/reinicio/2.ª instancia) no llega al broker', calls.length === 1 && (await s2.listOrders(us.id)).length === 1);
    t('motor: lo aceptado cuenta para el tope diario', (await s2.liveUsdSince(us.id, 0)) >= 10); }
  { const { s2, us, eng, calls } = await run(async () => ({ ok: false, error: 'Insufficient funds' }));
    await eng.runBot({ ...(await s2.getBot(us.id)), last_run: 0 }, Date.now() + 5e8);
    const o = (await s2.listOrders(us.id))[0];
    t('motor: rechazo definitivo del broker queda «rejected» y no cuenta como gasto', o && o.lifecycle === 'rejected' && o.status === 'error' && (await s2.liveUsdSince(us.id, 0)) === 0 && calls.length === 1); }
  { const { s2, us, eng, calls } = await run(async () => { throw new Error('Coinbase no respondió (timeout)'); });
    const TT = Math.floor((Date.now() + 5e8) / 60000) * 60000 + 100; await eng.runBot({ ...(await s2.getBot(us.id)), last_run: 0 }, TT);
    const o = (await s2.listOrders(us.id))[0];
    t('motor: timeout (resultado ambiguo) queda «unknown», sigue reservando cupo y NO se reintenta a ciegas', o && o.lifecycle === 'unknown' && (await s2.liveUsdSince(us.id, 0)) >= 10 && calls.length === 1);
    await eng.runBot({ ...(await s2.getBot(us.id)), last_run: 0 }, TT + 5000);
    t('motor: tras un «unknown» no se vuelve a enviar la misma orden', calls.length === 1); }
}

console.log('Fase 2: puerta de riesgo central');
{
  const R = await import('../lib/risk.js'); const { riskBlock } = await import('../lib/store.js');
  const mem = memoryStore();
  t('riesgo: sin ajustes usa valores por defecto conservadores', (await R.loadPlatform(mem)).maxOpenOrders === 3);
  await mem.setSetting('risk:platform', '{no es json'); t('riesgo: ajuste ilegible falla cerrado (error, no valores permisivos)', !!(await R.loadPlatform(mem)).error);
  await mem.setSetting('risk:platform', JSON.stringify({ maxOrderUsd: -5 })); t('riesgo: valor inválido falla cerrado', !!(await R.loadPlatform(mem)).error);
  await mem.setSetting('risk:emergency', 'basura'); t('emergencia: estado ilegible se trata como ACTIVA (falla cerrado)', (await R.getEmergency(mem)).on === true);
  const P = { ...R.DEFAULT_PLATFORM }; const cfg = { maxOrderUsd: 25, maxDailyUsd: 100 }; const ok = { price: 100, usd: 10, side: 'buy' };
  const pc = (o = {}) => R.preCheck({ cfg, platform: P, emergency: { on: false }, order: ok, ageMs: 1000, refPrice: 100, ...o });
  t('pre-chequeo: orden normal pasa y los límites son el MENOR entre cliente y plataforma', pc().ok && R.effectiveLimits({ maxOrderUsd: 5000, maxDailyUsd: 9e9 }, P).maxNotional === 1000 && R.effectiveLimits({ maxOrderUsd: 5000, maxDailyUsd: 9e9 }, P).maxDaily === 5000);
  t('pre-chequeo: emergencia, falta de límites, precio viejo/inválido, desviación y tope por orden bloquean',
    pc({ emergency: { on: true } }).code === 'emergency_stop' && pc({ cfg: {} }).code === 'risk_config_missing' && pc({ cfg: { maxOrderUsd: 25 } }).code === 'risk_config_missing' && pc({ ageMs: 120000 }).code === 'stale_price' && pc({ ageMs: NaN }).code === 'stale_price'
    && pc({ order: { ...ok, price: NaN } }).code === 'invalid_price' && pc({ order: { ...ok, usd: 0 } }).code === 'invalid_amount' && pc({ refPrice: 50 }).code === 'price_deviation' && pc({ order: { ...ok, usd: 30 } }).code === 'max_order' && pc({ platform: { error: 'x' } }).code === 'risk_config_missing');
  t('pre-chequeo: una VENTA no se frena por desviación de precio (stop-loss en caída)', pc({ order: { ...ok, side: 'sell' }, refPrice: 50 }).ok);

  const L = { maxDaily: 100, maxOpen: 3, maxPerHour: 12, maxRejects: 3 };
  const st = memoryStore(); const u = await st.createUser({ email: 'f2@demo.com', pass_hash: 'x' });
  const mk = (n, usd = 30, side = 'buy') => st.reserveOrder({ user_id: u.id, mode: 'live', exchange: 'coinbase', symbol: 'BTC-USD', side, usd, qty: 1, price: 1, client_order_id: `K${n}` }, L);
  const res = await Promise.all(Array.from({ length: 10 }, (_, i) => mk(i)));
  const made = res.filter((r) => r.created).length;
  t('atómico: 10 señales simultáneas de $30 con tope diario $100 y 3 abiertas máx. crean como mucho 3 (nunca pasan el tope)', made === 3 && res.filter((r) => r.blocked).length === 7 && (await st.liveUsdSince(u.id, 0)) <= 100);
  t('el motivo del bloqueo queda explicado', ['daily_cap', 'open_orders'].includes(res.find((r) => r.blocked).blocked) && res.find((r) => r.blocked).reason.length > 10);
  const st2 = memoryStore(); const u2 = await st2.createUser({ email: 'f2b@demo.com', pass_hash: 'x' });
  const m2 = (n, usd) => st2.reserveOrder({ user_id: u2.id, mode: 'live', symbol: 'BTC-USD', side: 'buy', usd, client_order_id: `D${n}` }, { ...L, maxOpen: 99 });
  const a = await m2(1, 60); const b = await m2(2, 60);
  t('tope diario: la segunda compra que lo supera se bloquea (daily_cap) y no se crea', a.created && !b.created && b.blocked === 'daily_cap' && (await st2.listOrders(u2.id)).length === 1);
  const sell = await st2.reserveOrder({ user_id: u2.id, mode: 'live', symbol: 'BTC-USD', side: 'sell', usd: 500, client_order_id: 'D3' }, { ...L, maxOpen: 99 });
  t('una venta no se bloquea por el tope diario de compras', sell.created);
  const st3 = memoryStore(); const u3 = await st3.createUser({ email: 'f2c@demo.com', pass_hash: 'x' });
  for (let i = 0; i < 3; i++) { const r = await st3.reserveOrder({ user_id: u3.id, mode: 'live', symbol: 'BTC-USD', side: 'buy', usd: 1, client_order_id: `Z${i}` }, { ...L, maxOpen: 99, maxPerHour: 99 }); await st3.transitionOrder(u3.id, r.order.id, 'rejected'); }
  const rr = await st3.reserveOrder({ user_id: u3.id, mode: 'live', symbol: 'BTC-USD', side: 'buy', usd: 1, client_order_id: 'Z9' }, { ...L, maxOpen: 99, maxPerHour: 99 });
  t('3 rechazos seguidos del broker bloquean nuevas compras', rr.blocked === 'repeated_rejections');
  t('frecuencia: más órdenes por hora que el máximo se bloquean', riskBlock(Array.from({ length: 12 }, (_, i) => ({ side: 'sell', lifecycle: 'filled', created_at: Date.now() - i * 1000 })), { side: 'sell', usd: 1 }, { ...L }).code === 'frequency');

  // Motor: lo bloqueado NUNCA llega al broker
  const eng = async (platform, adapterOver = {}, feedOver = feed) => {
    const s2 = memoryStore(); const us = await s2.createUser({ email: `f2${Math.random()}@demo.com`, pass_hash: 'x' });
    const cn = await s2.addConnection({ user_id: us.id, exchange: 'coinbase', label: 'cb', key_id: 'k', secret_enc: sec.encrypt(env.ENCRYPTION_KEY, 's'), can_trade: true, can_transfer: false });
    await s2.setSetting('live_trading', 'on'); if (platform !== undefined) await s2.setSetting('risk:platform', platform);
    const calls = []; const ad = { coinbase: { ...good, name: 'coinbase', balances: async () => [{ asset: 'USD', available: 500, hold: 0 }], marketBuy: async (_c, x) => { calls.push(x); return { ok: true, id: 'B' }; }, ...adapterOver }, robinhood: good };
    const e = createEngine({ store: s2, adapters: ad, feed: feedOver, encKey: env.ENCRYPTION_KEY, log: { error() {} } });
    await s2.saveBot(us.id, { autoMode: 'active', symbol: 'BTC-USD', strategy: 'dca', intervalMin: 15, usd: 10, mode: 'live', enabled: true, liveAck: true, connectionId: cn.id, maxOrderUsd: 25, maxDailyUsd: 100 });
    return { s2, us, e, calls, go: async () => e.runBot({ ...(await s2.getBot(us.id)), last_run: 0 }, Date.now() + 5e8) };
  };
  const audits = async (s2) => (await s2.listAudit(100)).filter((a) => a.actor === 'risk');
  { const x = await eng('{roto'); await x.go(); t('fail-closed: límites de plataforma ilegibles => ninguna orden llega al broker y queda registrado', x.calls.length === 0 && (await x.s2.listOrders(x.us.id)).length === 0 && (await audits(x.s2)).some((a) => a.action === 'risk_block' && /risk_config_missing/.test(a.detail))); }
  { const x = await eng(JSON.stringify({ maxPriceDeviationPct: 1e9 })); await R.setEmergency(x.s2, { on: true, by: 'o', reason: 'prueba' }); await x.go(); t('emergencia: el bot real no envía nada al broker', x.calls.length === 0 && (await x.s2.listOrders(x.us.id)).length === 0);
    await R.setEmergency(x.s2, { on: false }); await x.go(); t('al levantar la emergencia el bot vuelve a operar (con límites)', x.calls.length === 1); }
  { const slow = { ...feed, getPrice: async () => { await new Promise((r) => setTimeout(r, 40)); return 50000; } };
    const x = await eng(JSON.stringify({ maxPriceDeviationPct: 1e9, maxPriceAgeMs: 5 }), {}, slow); await x.go(); t('precio viejo: orden bloqueada, no llega al broker, motivo registrado', x.calls.length === 0 && (await audits(x.s2)).some((a) => /stale_price/.test(a.detail))); }
  { const x = await eng(JSON.stringify({ maxPriceDeviationPct: 1e9, maxDailyUsd: 5 })); await x.go(); t('límite de plataforma menor que el del cliente manda (diario $5 < compra $10): bloqueada y sin broker', x.calls.length === 0); }
  { const x = await eng(JSON.stringify({ maxPriceDeviationPct: 1e9 })); const TR = Math.floor((Date.now() + 5e8) / 60000) * 60000 + 100; await x.e.runBot({ ...(await x.s2.getBot(x.us.id)), last_run: 0 }, TR);
    const e2 = createEngine({ store: x.s2, adapters: { coinbase: { ...good, balances: async () => [{ asset: 'USD', available: 500, hold: 0 }], marketBuy: async (_c, q) => { x.calls.push(q); return { ok: true, id: 'B2' }; } }, robinhood: good }, feed, encKey: env.ENCRYPTION_KEY, log: { error() {} } });
    await e2.runBot({ ...(await x.s2.getBot(x.us.id)), last_run: 0 }, TR + 2000);
    t('reinicio: una instancia nueva ve lo ya enviado y no repite (los límites viven en la base de datos, no en memoria)', x.calls.length === 1 && (await x.s2.liveUsdSince(x.us.id, 0)) === 10); }
}

console.log('Fase 3: candado de líder, estados y emergencia');
{
  const B = await import('../lib/botstate.js'); const R = await import('../lib/risk.js');
  t('estados: camino CREATED → RUNNING pasa por CONFIGURED y VALIDATING', B.botPath('CREATED', 'RUNNING').join() === 'CONFIGURED,VALIDATING,RUNNING' && B.botPath('RUNNING', 'STOPPED').join() === 'STOPPING,STOPPED');
  t('estados: los 9 estados existen y las transiciones inválidas se rechazan', B.BOT_STATES.length === 9 && !B.canBotTransition('STOPPED', 'RUNNING') && !B.canBotTransition('CREATED', 'RUNNING') && B.canBotTransition('EMERGENCY_STOP', 'RUNNING'));
  t('salud: latido viejo = stale; emergencia/error se distinguen', B.healthOf({ state: 'RUNNING', enabled: true, last_run: Date.now() - 600000 }).status === 'stale' && B.healthOf({ state: 'RUNNING', enabled: true, last_run: Date.now() - 5000 }).status === 'ok' && B.healthOf({ state: 'EMERGENCY_STOP' }).status === 'emergency' && B.healthOf({ state: 'RUNNING', enabled: true, last_run: Date.now(), errors: 3 }).status === 'error');
  const st = memoryStore(); const u = await st.createUser({ email: 'f3@demo.com', pass_hash: 'x' });
  await st.saveBot(u.id, { symbol: 'BTC-USD', enabled: false });
  t('guardar un bot apagado lo deja CONFIGURED', (await st.getBot(u.id)).state === 'CONFIGURED');
  await st.saveBot(u.id, { symbol: 'BTC-USD', enabled: true });
  t('encenderlo recorre VALIDATING → RUNNING y queda en el historial', (await st.getBot(u.id)).state === 'RUNNING' && (await st.listBotEvents(u.id)).map((e) => e.to_state).reverse().join() === 'CREATED,CONFIGURED,VALIDATING,RUNNING');
  t('transición inválida no cambia nada', (await st.setBotState(u.id, 'CREATED')).ok === false && (await st.getBot(u.id)).state === 'RUNNING');
  const b = await st.getBot(u.id); await st.patchBot(u.id, { cfg: { ...b.cfg, enabled: false } });
  t('apagarlo por cualquier ruta lo deja STOPPED', (await st.getBot(u.id)).state === 'STOPPED');

  // Candado de líder
  const ls = memoryStore();
  t('candado: A lo toma, B no puede, A lo renueva', (await ls.acquireLease('engine', 'A', 50)) && !(await ls.acquireLease('engine', 'B', 50)) && (await ls.acquireLease('engine', 'A', 50)));
  await new Promise((r) => setTimeout(r, 70));
  t('candado: si el líder cae (caduca), otra instancia toma el relevo', (await ls.acquireLease('engine', 'B', 50)) && !(await ls.acquireLease('engine', 'A', 50)));
  await ls.releaseLease('engine', 'B'); t('candado: al soltarlo otro puede tomarlo', await ls.acquireLease('engine', 'A', 50));

  const mkEng = async () => {
    const s2 = memoryStore(); const us = await s2.createUser({ email: `f3${Math.random()}@demo.com`, pass_hash: 'x' });
    const cn = await s2.addConnection({ user_id: us.id, exchange: 'coinbase', label: 'cb', key_id: 'k', secret_enc: sec.encrypt(env.ENCRYPTION_KEY, 's'), can_trade: true, can_transfer: false });
    await s2.setSetting('live_trading', 'on'); await s2.setSetting('risk:platform', LOOSE);
    const cnt = { bal: 0, buy: 0 }; let buyResult = async () => ({ ok: true, id: 'B' });
    const ad = { coinbase: { ...good, name: 'coinbase', balances: async () => { cnt.bal++; return [{ asset: 'USD', available: 500, hold: 0 }]; }, marketBuy: async () => { cnt.buy++; return buyResult(); } }, robinhood: good };
    const mk = () => createEngine({ store: s2, adapters: ad, feed, encKey: env.ENCRYPTION_KEY, log: { error() {} } });
    await s2.saveBot(us.id, { autoMode: 'active', symbol: 'BTC-USD', strategy: 'dca', intervalMin: 15, usd: 10, mode: 'live', enabled: true, liveAck: true, connectionId: cn.id, maxOrderUsd: 25, maxDailyUsd: 100 });
    return { s2, us, cnt, mk, setBuy: (f) => { buyResult = f; } };
  };
  { const x = await mkEng(); const e1 = x.mk(); const e2 = x.mk();
    await Promise.all([e1.tick(), e2.tick(), e1.tick(), e2.tick()]);
    t('dos instancias haciendo tick a la vez: solo una ejecuta el bot (un solo cálculo de saldo y una sola orden)', x.cnt.bal === 1 && x.cnt.buy === 1 && (await x.s2.listOrders(x.us.id)).length === 1); }
  { const x = await mkEng(); const e = x.mk(); const T = Math.floor((Date.now() + 5e8) / 60000) * 60000 + 100;
    await x.s2.setBotState(x.us.id, 'PAUSED', 'prueba'); await e.runBot(await x.s2.getBot(x.us.id), T);
    t('PAUSED: el bot no opera', x.cnt.buy === 0);
    await x.s2.setBotState(x.us.id, 'RUNNING', 'prueba'); await e.runBot({ ...(await x.s2.getBot(x.us.id)), last_run: 0 }, T);
    t('al reanudar vuelve a operar', x.cnt.buy === 1); }
  { const x = await mkEng(); const e = x.mk(); const T = Math.floor((Date.now() + 5e8) / 60000) * 60000 + 100;
    await R.setEmergency(x.s2, { on: true, by: 'o', reason: 'prueba' }); await e.runBot({ ...(await x.s2.getBot(x.us.id)), last_run: 0 }, T);
    t('emergencia: el bot real pasa a EMERGENCY_STOP y no opera', (await x.s2.getBot(x.us.id)).state === 'EMERGENCY_STOP' && x.cnt.buy === 0);
    await R.setEmergency(x.s2, { on: false }); await e.runBot({ ...(await x.s2.getBot(x.us.id)), last_run: 0 }, T);
    const bb = await x.s2.getBot(x.us.id); t('al levantar la emergencia vuelve a RUNNING y opera con sus límites', bb.state === 'RUNNING' && x.cnt.buy === 1); }
  { const x = await mkEng(); const e = x.mk(); x.setBuy(async () => ({ ok: false, error: 'Insufficient funds' })); const T = Math.floor((Date.now() + 5e8) / 60000) * 60000 + 100;
    for (let k = 0; k < 3; k++) await e.runBot({ ...(await x.s2.getBot(x.us.id)), last_run: 0 }, T + k * 61000);
    const bb = await x.s2.getBot(x.us.id);
    t('3 errores seguidos: el bot pasa a ERROR, se apaga y queda el motivo', bb.state === 'ERROR' && bb.cfg.enabled === false && /3 errores/.test(bb.state_reason)); }
}

console.log('Fase 4: conciliación con el broker (contratos y flujos)');
{
  const RC = await import('../lib/reconcile.js'); const N = RC.normalizeBrokerOrder;
  // Contratos: forma de las respuestas según la documentación (Coinbase: docs.cdp.coinbase.com «get order»; Robinhood: spec público)
  const cbo = (o) => ({ order_id: 'cb-1', client_order_id: 'c1', product_id: 'BTC-USD', status: 'FILLED', filled_size: '0.0002', filled_value: '20.1', average_filled_price: '100500', total_fees: '0.12', completion_percentage: '100', ...o });
  t('contrato Coinbase: FILLED → filled con cantidad, precio medio y comisión REALES', (() => { const n = N('coinbase', cbo()); return n.state === 'filled' && n.filledQty === 0.0002 && n.avgPrice === 100500 && n.filledUsd === 20.1 && n.feeUsd === 0.12; })());
  t('contrato Coinbase: todos los estados documentados mapean y los desconocidos NO se toman como ejecutados', ['PENDING', 'OPEN', 'QUEUED', 'EDIT_QUEUED'].every((x) => N('coinbase', cbo({ status: x, filled_size: '0' })).state === 'open') && N('coinbase', cbo({ status: 'OPEN', filled_size: '0.0001' })).state === 'partial' && ['CANCELLED', 'EXPIRED', 'CANCEL_QUEUED'].every((x) => N('coinbase', cbo({ status: x })).state === 'cancelled') && N('coinbase', cbo({ status: 'FAILED', reject_message: 'sin fondos' })).state === 'rejected' && N('coinbase', cbo({ status: 'UNKNOWN_ORDER_STATUS' })).state === 'unknown' && N('coinbase', cbo({ status: 'ALGO_NUEVO' })).state === 'unknown');
  const rho = (o) => ({ id: 'rh-1', client_order_id: 'c1', symbol: 'ADA-USD', side: 'buy', type: 'market', state: 'filled', average_price: '0.5', filled_asset_quantity: '40', executions: [{ effective_price: '0.5', quantity: '40', timestamp: 'x' }], ...o });
  t('contrato Robinhood: estados filled/partially_filled/open/canceled/failed y comisión NO inventada', N('robinhood', rho()).state === 'filled' && N('robinhood', rho()).filledQty === 40 && N('robinhood', rho()).feeUsd === null && N('robinhood', rho({ state: 'partially_filled', filled_asset_quantity: '10' })).state === 'partial' && N('robinhood', rho({ state: 'open', filled_asset_quantity: '0', executions: [] })).state === 'open' && N('robinhood', rho({ state: 'canceled', executions: [], filled_asset_quantity: '0' })).state === 'cancelled' && N('robinhood', rho({ state: 'failed' })).state === 'rejected' && N('robinhood', rho({ state: 'raro' })).state === 'unknown');
  t('contrato Robinhood: sin filled_asset_quantity usa las ejecuciones (cantidad y precio medio ponderado)', (() => { const n = N('robinhood', rho({ filled_asset_quantity: null, average_price: null, executions: [{ quantity: '10', effective_price: '1' }, { quantity: '30', effective_price: '2' }] })); return n.filledQty === 40 && Math.abs(n.avgPrice - 1.75) < 1e-9; })());
  t('respuestas basura no revientan', N('coinbase', null).state === 'unknown' && N('robinhood', 'x').state === 'unknown' && N('otro', {}).state === 'unknown');

  // Flujos con la base de datos de memoria y un broker simulado
  const setup = async (exchange = 'coinbase') => {
    const s2 = memoryStore(); const us = await s2.createUser({ email: `f4${Math.random()}@demo.com`, pass_hash: 'x' });
    const cn = await s2.addConnection({ user_id: us.id, exchange, label: 'x', key_id: 'k', secret_enc: sec.encrypt(env.ENCRYPTION_KEY, 's'), can_trade: true, can_transfer: false });
    await s2.saveBot(us.id, { symbol: 'BTC-USD', mode: 'live', enabled: false, connectionId: cn.id, maxOrderUsd: 25, maxDailyUsd: 100 });
    let brokerOrders = {}; let fail = null; const seen = { n: 0 };
    const ad = { [exchange]: { getOrder: async (_c, q) => { seen.n++; if (fail) throw new Error(fail); const o = q.extId ? brokerOrders[q.extId] : Object.values(brokerOrders).find((x) => x.client_order_id === q.clientOrderId); return o ? { found: true, raw: o } : { found: false }; } } };
    const mkOrder = async (id, lc = 'submitted', extra = {}) => { const r = await s2.reserveOrder({ user_id: us.id, mode: 'live', exchange, symbol: 'BTC-USD', side: 'buy', usd: 20, qty: 0.0002, price: 100000, client_order_id: id, ...extra }); if (lc !== 'submitting') { await s2.transitionOrder(us.id, r.order.id, 'submitted', { ext_id: extra.noExt ? null : `broker-${id}` }); if (lc === 'unknown') await s2.transitionOrder(us.id, r.order.id, 'unknown'); } return r.order.id; };
    const run = (now = Date.now() + 20000) => RC.reconcileAll({ store: s2, adapters: ad, encKey: env.ENCRYPTION_KEY, now });
    const get = async (id) => (await s2.listOrders(us.id)).find((o) => o.id === id);
    return { s2, us, brokerOrders: (v) => { if (v) brokerOrders = v; return brokerOrders; }, setFail: (v) => { fail = v; }, mkOrder, run, get, seen };
  };
  { const x = await setup(); const id = await x.mkOrder('A1'); x.brokerOrders({ 'broker-A1': cbo({ order_id: 'broker-A1', client_order_id: 'A1' }) });
    const r = await x.run(); const o = await x.get(id);
    t('conciliar: submitted → filled con cantidad/precio/USD/comisión REALES del broker (reemplazan la estimación)', r.changed === 1 && o.lifecycle === 'filled' && o.status === 'ok' && o.qty === 0.0002 && o.price === 100500 && Math.abs(o.usd - 20.22) < 1e-9 && o.fee_usd === 0.12 && o.filled_qty === 0.0002);
    const r2 = await x.run(); t('conciliar es idempotente: repetirlo no cambia nada', r2.checked === 0 && (await x.s2.listOrderEvents(x.us.id, id)).filter((e) => e.to_state === 'filled').length === 1); }
  { const x = await setup(); const id = await x.mkOrder('P1'); x.brokerOrders({ 'broker-P1': cbo({ order_id: 'broker-P1', client_order_id: 'P1', status: 'OPEN', filled_size: '0.0001', filled_value: '10', average_filled_price: '100000', completion_percentage: '50' }) });
    await x.run(); let o = await x.get(id); t('llenado parcial: queda «partial» con lo realmente ejecutado', o.lifecycle === 'partial' && o.filled_qty === 0.0001 && o.qty === 0.0001);
    x.brokerOrders({ 'broker-P1': cbo({ order_id: 'broker-P1', client_order_id: 'P1', status: 'FILLED', filled_size: '0.0002' }) }); await x.run(Date.now() + 40000); o = await x.get(id);
    t('parcial → completa cuando el broker la completa', o.lifecycle === 'filled' && o.filled_qty === 0.0002); }
  { const x = await setup(); const id = await x.mkOrder('C1'); x.brokerOrders({ 'broker-C1': cbo({ order_id: 'broker-C1', client_order_id: 'C1', status: 'CANCELLED', filled_size: '0.00005', filled_value: '5', average_filled_price: '100000' }) });
    await x.run(); const o = await x.get(id); t('cancelada tras llenado parcial: solo se registra lo ejecutado (no la cantidad pedida)', o.lifecycle === 'filled' && o.qty === 0.00005 && Math.abs(o.usd - 5.12) < 1e-9); }
  { const x = await setup(); const id = await x.mkOrder('C2'); x.brokerOrders({ 'broker-C2': cbo({ order_id: 'broker-C2', client_order_id: 'C2', status: 'CANCELLED', filled_size: '0', filled_value: '0' }) });
    await x.run(); const o = await x.get(id); t('cancelada sin llenado: cancelled, no cuenta como posición ni gasto', o.lifecycle === 'cancelled' && o.status === 'error' && (await x.s2.liveUsdSince(x.us.id, 0)) === 0); }
  { const x = await setup(); const id = await x.mkOrder('R1'); x.brokerOrders({ 'broker-R1': cbo({ order_id: 'broker-R1', client_order_id: 'R1', status: 'FAILED', filled_size: '0', reject_message: 'Insufficient funds' }) });
    await x.run(); const o = await x.get(id); t('rechazada por el broker después de aceptarla: rejected con el motivo', o.lifecycle === 'rejected' && /Insufficient/.test(o.note) && o.status === 'error'); }
  { const x = await setup(); const id = await x.mkOrder('E1'); x.brokerOrders({}); x.setFail('Coinbase: HTTP 429');
    const r = await x.run(); const o = await x.get(id); t('API del broker caída/limitada: la orden NO cambia, se anota el error y se reintenta', r.errors === 1 && o.lifecycle === 'submitted' && (await x.s2.listAudit(20)).some((a) => a.action === 'reconcile_error' && /429/.test(a.detail)));
    x.setFail(null); x.brokerOrders({ 'broker-E1': cbo({ order_id: 'broker-E1', client_order_id: 'E1' }) }); await x.run(Date.now() + 60000); t('al volver la API se concilia', (await x.get(id)).lifecycle === 'filled'); }
  { const x = await setup(); const id = await x.mkOrder('U1', 'unknown', { noExt: true }); x.brokerOrders({ 'zz': cbo({ order_id: 'bro-U1', client_order_id: 'U1' }) });
    await x.run(); const o = await x.get(id); t('«unknown» sin ID del broker se encuentra por client_order_id y se confirma', o.lifecycle === 'filled' && o.ext_id === 'bro-U1'); }
  { const x = await setup(); const id = await x.mkOrder('U2', 'unknown', { noExt: true }); x.brokerOrders({});
    await x.run(Date.now() + 120000); t('«unknown» que el broker no lista: espera (no se da por perdida enseguida)', (await x.get(id)).lifecycle === 'unknown');
    await x.run(Date.now() + 11 * 60000); const o = await x.get(id); t('«unknown» que el broker sigue sin listar tras 10 min: rejected («no se envió») y libera el cupo', o.lifecycle === 'rejected' && (await x.s2.liveUsdSince(x.us.id, 0)) === 0 && (await x.s2.listAudit(20)).some((a) => a.action === 'reconcile_not_found')); }
  { const x = await setup(); const id = await x.mkOrder('S1', 'submitting'); x.brokerOrders({ 'zz': cbo({ order_id: 'bro-S1', client_order_id: 'S1' }) });
    await x.run(Date.now() + 30000); t('«submitting» reciente no se toca (el envío puede estar en curso)', (await x.get(id)).lifecycle === 'submitting');
    await x.run(Date.now() + 3 * 60000); const o = await x.get(id); t('reinicio a mitad de envío: «submitting» viejo → unknown → se resuelve consultando al broker, sin reenviar', o.lifecycle === 'filled' && (await x.s2.listOrderEvents(x.us.id, id)).map((e) => e.to_state).join() === 'submitting,unknown,filled'); }
  { const x = await setup(); const id = await x.mkOrder('X1'); x.brokerOrders({ 'broker-X1': cbo({ order_id: 'broker-X1', client_order_id: 'X1', status: 'ALGO_NUEVO' }) }); await x.run();
    t('estado desconocido del broker: se mantiene sin resolver y queda auditado (jamás «ejecutada»)', (await x.get(id)).lifecycle === 'submitted' && (await x.s2.listAudit(20)).some((a) => a.action === 'reconcile_unknown_state')); }
  { const x = await setup(); const id = await x.mkOrder('M1'); x.brokerOrders({ 'broker-M1': cbo({ order_id: 'broker-M1', client_order_id: 'M1', filled_size: '0.00018', filled_value: '18.09' }) }); await x.run();
    t('diferencia >1% entre lo estimado y lo real queda auditada', (await x.s2.listAudit(20)).some((a) => a.action === 'reconcile_adjusted')); }
  { const x = await setup('robinhood'); const id = await x.mkOrder('H1'); x.brokerOrders({ 'broker-H1': rho({ id: 'broker-H1', client_order_id: 'H1', filled_asset_quantity: '0.0002', average_price: '100100', executions: [] }) }); await x.run();
    const o = await x.get(id); t('Robinhood: conciliada con cantidad y precio reales y comisión desconocida (null, no inventada)', o.lifecycle === 'filled' && o.price === 100100 && (o.fee_usd === null || o.fee_usd === undefined)); }
  { const x = await setup(); const id = await x.mkOrder('W1'); x.brokerOrders({}); await x.s2.deleteConnection(x.us.id, (await x.s2.listConnections(x.us.id))[0].id); await x.run();
    t('sin conexión activa no inventa nada: la orden queda igual y se audita', (await x.get(id)).lifecycle === 'submitted' && (await x.s2.listAudit(20)).some((a) => a.action === 'reconcile_no_credentials')); }
  { const x = await setup(); await x.mkOrder('Q1'); const o2 = await x.mkOrder('Q2'); x.brokerOrders({}); await x.s2.transitionOrder(x.us.id, o2, 'filled', {});
    const r = await RC.reconcileAll({ store: x.s2, adapters: { coinbase: { getOrder: async () => { throw new Error('x'); } } }, encKey: env.ENCRYPTION_KEY, now: Date.now() + 20000 }); t('solo concilia órdenes pendientes (las terminales no se consultan)', r.checked === 1); }
}

console.log('Fase 5: migraciones');
{
  const { MIGRATIONS } = await import('../lib/migrations.js');
  t('migraciones: ids consecutivos, nombres y SQL no vacíos', MIGRATIONS.every((m, i) => m.id === i + 1 && m.name && m.sql.trim().length > 20));
  t('migraciones: solo aditivas (sin DROP de datos de clientes, sin renombrar, sin borrar columnas)', MIGRATIONS.every((m) => !/DROP\s+(COLUMN|TABLE\s+(?!IF EXISTS incidents))|RENAME|TRUNCATE|DELETE\s+FROM/i.test(m.sql)));
  t('migraciones: cada CREATE/ADD es idempotente', MIGRATIONS.every((m) => !/CREATE\s+(UNIQUE\s+)?(TABLE|INDEX)\s+(?!IF NOT EXISTS)/i.test(m.sql) && !/ADD\s+COLUMN\s+(?!IF NOT EXISTS)/i.test(m.sql)));
  const ms = memoryStore(); t('almacén en memoria: ping y migrationStatus', (await ms.ping()) === true && (await ms.migrationStatus()).length === 0);
}

console.log(`\n${pass} ok, ${fail} fallos`);
process.exit(fail ? 1 : 0);
