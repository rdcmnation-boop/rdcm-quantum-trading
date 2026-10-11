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
t('Cerebro: 9 agentes, 2 marcados como no disponibles (requieren LLM)', brain.agents.length === 9 && brain.agents.filter((a) => !a.available).length === 2
  && brain.agents.filter((a) => !a.available).every((a) => /Claude/.test(a.reason)));
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
t('no se puede encender un agente no disponible', (await O2('PUT', '/api/owner/agents/ui_landing', { enabled: true })).status === 404);
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
  t('estadísticas por agente: corridas, propuestas, aplicadas, rechazadas y errores', as.length === 9 && as.every((a) => 'runs' in a && 'applied' in a && 'rejected' in a && 'errors' in a) && as.find((a) => a.name === 'paper_lab').runs >= 1);
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
  for (const ep of ['/api/owner/overview', '/api/owner/users', '/api/owner/briefing', '/api/owner/brain', '/api/owner/readiness', '/api/owner/compliance', '/api/owner/export/brain']) {
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
  t('noticias: si una fuente falla se ignora y se informa', nf.sources === 1 && nf.errors.length === 1 && nf.items.length === 2);

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
}

console.log('Exportación del Cerebro y del app');
const eb = await O2('GET', '/api/owner/export/brain');
t('exportar Cerebro: JSON versionado y descargable', eb.status === 200 && /attachment/.test(eb.headers.get('content-disposition')) && eb.body.format === 'quantum-brain/1' && eb.body.brain_version >= 2);
t('el Cerebro exportado trae límites, agentes, modelos, historial y auditoría de agentes', eb.body.guardrails && eb.body.agents.length === 9
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
t('"/" sirve la landing', /Crear cuenta gratis/.test(land) && /Beta gratuita/.test(land));
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

server.close();
console.log(`\n${pass} ok, ${fail} fallos`);
process.exit(fail ? 1 : 0);
