// Pruebas de CONTRATO del conector de Coinbase Advanced Trade.
// Un «fetch» falso imita las reglas documentadas de la API (JWT ES256, rutas, forma de pedidos y respuestas) y verifica que
// el conector las cumple. NO habla con Coinbase: no prueba que Coinbase siga igual hoy. Para eso hay que correr una orden mínima real.
import crypto from 'node:crypto';
import { coinbase, coinbaseJwt } from '../lib/exchanges.js';

let pass = 0; let fail = 0;
const t = (name, ok, extra = '') => { if (ok) { pass++; console.log(`  ok   ${name}`); } else { fail++; console.log(`  FAIL ${name} ${extra}`); } };
const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const pem = privateKey.export({ type: 'sec1', format: 'pem' });
const KEY = 'organizations/o1/apiKeys/k1';
const creds = { keyId: KEY, secret: pem };
const b64 = (s) => JSON.parse(Buffer.from(s, 'base64url').toString());

// Servidor falso: valida cada pedido como lo haría Coinbase y responde con una forma configurable.
const calls = []; let script = {};
globalThis.fetch = async (url, opts = {}) => {
  const u = new URL(url); const method = opts.method || 'GET';
  const rec = { url: String(url), host: u.host, path: u.pathname, method, body: opts.body ? JSON.parse(opts.body) : null, problems: [] };
  calls.push(rec);
  const auth = (opts.headers || {}).Authorization || '';
  const m = /^Bearer (.+)\.(.+)\.(.+)$/.exec(auth);
  if (!m) rec.problems.push('sin Bearer JWT');
  else {
    const head = b64(m[1]); const pay = b64(m[2]);
    if (head.alg !== 'ES256') rec.problems.push('alg');
    if (head.kid !== KEY) rec.problems.push('kid');
    if (!head.nonce) rec.problems.push('nonce');
    if (pay.iss !== 'cdp' || pay.sub !== KEY) rec.problems.push('iss/sub');
    if (pay.exp - pay.nbf > 120) rec.problems.push('exp>120s');
    if (pay.uri !== `${method} ${u.host}${u.pathname}`) rec.problems.push(`uri ${pay.uri}`);
    const ok = crypto.verify('sha256', Buffer.from(`${m[1]}.${m[2]}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(m[3], 'base64url'));
    if (!ok) rec.problems.push('firma inválida');
  }
  if (u.host !== 'api.coinbase.com') rec.problems.push('host');
  if (opts.body && (opts.headers || {})['Content-Type'] !== 'application/json') rec.problems.push('content-type');
  const r = script[`${method} ${u.pathname}`] || { status: 404, body: {} };
  return { ok: r.status >= 200 && r.status < 300, status: r.status, text: async () => (typeof r.body === 'string' ? r.body : JSON.stringify(r.body)) };
};
const last = () => calls[calls.length - 1];

console.log('Coinbase: contrato de firma (JWT)');
{
  const jwt = coinbaseJwt(KEY, pem, 'GET', 'api.coinbase.com', '/api/v3/brokerage/accounts');
  const [h, p, s] = jwt.split('.');
  t('JWT ES256 con kid, nonce, iss=cdp y vigencia ≤ 120 s', b64(h).alg === 'ES256' && b64(h).kid === KEY && !!b64(h).nonce && b64(p).iss === 'cdp' && b64(p).exp - b64(p).nbf <= 120);
  t('JWT: la firma verifica con la llave pública (formato r||s)', crypto.verify('sha256', Buffer.from(`${h}.${p}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url')));
  t('JWT: el «uri» es MÉTODO host+ruta sin query', b64(p).uri === 'GET api.coinbase.com/api/v3/brokerage/accounts');
  t('JWT: acepta la llave con «\\n» literales (como la entrega el JSON de Coinbase)', (() => { try { coinbaseJwt(KEY, pem.replace(/\n/g, '\\n'), 'GET', 'api.coinbase.com', '/x'); return true; } catch { return false; } })());
  t('JWT: cada llamada usa un nonce distinto', coinbaseJwt(KEY, pem, 'GET', 'h', '/x') !== coinbaseJwt(KEY, pem, 'GET', 'h', '/x'));
}

console.log('Coinbase: permisos de la llave');
{
  script['GET /api/v3/brokerage/key_permissions'] = { status: 200, body: { can_view: true, can_trade: true, can_transfer: false, portfolio_uuid: 'x', portfolio_type: 'DEFAULT' } };
  const r = await coinbase.check(creds);
  t('check: ruta, método y firma correctos', last().path === '/api/v3/brokerage/key_permissions' && last().method === 'GET' && last().problems.length === 0, JSON.stringify(last().problems));
  t('check: lee can_trade / can_transfer / can_view', r.ok && r.canTrade === true && r.canTransfer === false && r.canView === true);
  script['GET /api/v3/brokerage/key_permissions'] = { status: 200, body: { can_view: true, can_trade: true, can_transfer: true } };
  t('check: una llave que puede transferir se reporta (la app la rechaza)', (await coinbase.check(creds)).canTransfer === true);
  script['GET /api/v3/brokerage/key_permissions'] = { status: 401, body: { error: 'UNAUTHENTICATED', message: 'invalid jwt' } };
  const bad = await coinbase.check(creds);
  t('check: 401 → ok=false con el HTTP, sin lanzar', bad.ok === false && /401/.test(bad.error));
}

console.log('Coinbase: saldos');
{
  script['GET /api/v3/brokerage/accounts'] = { status: 200, body: { accounts: [
    { currency: 'USD', available_balance: { value: '125.50', currency: 'USD' }, hold: { value: '0', currency: 'USD' } },
    { currency: 'BTC', available_balance: { value: '0.0012', currency: 'BTC' }, hold: { value: '0.0001', currency: 'BTC' } },
    { currency: 'ETH', available_balance: { value: '0', currency: 'ETH' }, hold: { value: '0', currency: 'ETH' } },
    { currency: 'XRP' }], has_next: false } };
  const b = await coinbase.balances(creds);
  t('balances: pide hasta 250 cuentas con firma válida', /limit=250/.test(last().url) && last().problems.length === 0, JSON.stringify(last().problems));
  t('balances: convierte texto a número, suma hold aparte y omite saldos en cero o cuentas incompletas', b.length === 2 && b[0].asset === 'USD' && b[0].available === 125.5 && b[1].hold === 0.0001);
  script['GET /api/v3/brokerage/accounts'] = { status: 429, body: { message: 'rate limit' } };
  let msg = ''; try { await coinbase.balances(creds); } catch (e) { msg = e.message; }
  t('balances: 429 lanza un error claro con el HTTP', /429/.test(msg));
  script['GET /api/v3/brokerage/accounts'] = { status: 200, body: {} };
  t('balances: respuesta sin «accounts» → lista vacía (no revienta)', (await coinbase.balances(creds)).length === 0);
}

console.log('Coinbase: órdenes (forma del pedido)');
{
  script['POST /api/v3/brokerage/orders'] = { status: 200, body: { success: true, success_response: { order_id: 'ord-1', product_id: 'BTC-USD', side: 'BUY', client_order_id: 'c1' }, order_configuration: {} } };
  const r = await coinbase.marketBuy(creds, { symbol: 'BTC-USD', usd: 12.3456, clientOrderId: 'cid-buy-1' });
  const b = last().body;
  t('compra: POST /orders firmado, JSON', last().method === 'POST' && last().path === '/api/v3/brokerage/orders' && last().problems.length === 0, JSON.stringify(last().problems));
  t('compra: product_id, side BUY y client_order_id idempotente tal cual', b.product_id === 'BTC-USD' && b.side === 'BUY' && b.client_order_id === 'cid-buy-1');
  t('compra: market_market_ioc con quote_size en TEXTO y 2 decimales', b.order_configuration.market_market_ioc.quote_size === '12.35' && typeof b.order_configuration.market_market_ioc.quote_size === 'string');
  t('compra: devuelve el order_id del broker', r.ok === true && r.id === 'ord-1');
  const sr = await coinbase.marketSell(creds, { symbol: 'ETH-USD', qty: 0.123456789, clientOrderId: 'cid-sell-1' });
  const sb = last().body;
  t('venta: side SELL con base_size en TEXTO y 8 decimales', sb.side === 'SELL' && sb.order_configuration.market_market_ioc.base_size === '0.12345679' && sb.client_order_id === 'cid-sell-1' && sr.ok);
  await coinbase.marketBuy(creds, { symbol: 'BTC-USD', usd: 5 });
  t('sin client_order_id propio genera uno único', /^[0-9a-f-]{36}$/.test(last().body.client_order_id));
}

console.log('Coinbase: órdenes (respuestas de error)');
{
  script['POST /api/v3/brokerage/orders'] = { status: 200, body: { success: false, error_response: { error: 'INSUFFICIENT_FUND', message: 'Insufficient balance in source account', error_details: '', preview_failure_reason: 'PREVIEW_INSUFFICIENT_FUND' } } };
  const r = await coinbase.marketBuy(creds, { symbol: 'BTC-USD', usd: 5000, clientOrderId: 'c2' });
  t('fondos insuficientes (HTTP 200, success=false): NO es éxito y trae el motivo', r.ok === false && /Insufficient/.test(r.error));
  script['POST /api/v3/brokerage/orders'] = { status: 400, body: { error: 'INVALID_ARGUMENT', message: 'bad size' } };
  const r2 = await coinbase.marketSell(creds, { symbol: 'BTC-USD', qty: 1, clientOrderId: 'c3' });
  t('HTTP 400 sin error_response: ok=false con el código HTTP', r2.ok === false && /400/.test(r2.error));
  script['POST /api/v3/brokerage/orders'] = { status: 503, body: 'upstream unavailable' };
  const r3 = await coinbase.marketBuy(creds, { symbol: 'BTC-USD', usd: 5, clientOrderId: 'c4' });
  t('HTTP 503 con cuerpo no-JSON: ok=false, sin lanzar y sin afirmar éxito', r3.ok === false && /503/.test(r3.error));
  script['POST /api/v3/brokerage/orders'] = { status: 200, body: { success: true } };
  const r4 = await coinbase.marketBuy(creds, { symbol: 'BTC-USD', usd: 5, clientOrderId: 'c5' });
  t('éxito sin order_id: no se inventa un ID', r4.ok === true && !r4.id);
  globalThis.fetch = async () => { throw new Error('socket hang up'); };
  let thrown = ''; try { await coinbase.marketBuy(creds, { symbol: 'BTC-USD', usd: 5, clientOrderId: 'c6' }); } catch (e) { thrown = e.message; }
  t('caída de red: se propaga el error (la app lo marca «resultado desconocido» y reconcilia)', /socket hang up/.test(thrown));
}

console.log(`\n${pass} ok, ${fail} fallos`);
process.exit(fail ? 1 : 0);
