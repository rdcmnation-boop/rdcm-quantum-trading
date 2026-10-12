// Conectores de exchanges (Coinbase Advanced Trade y Robinhood Crypto) + precios públicos.
// Este archivo se incluye tal cual dentro del bot descargable: no importes nada más que node:crypto.
import crypto from 'node:crypto';

export const SYMBOLS = ['BTC-USD', 'ETH-USD', 'SOL-USD', 'LTC-USD', 'DOGE-USD', 'AVAX-USD', 'LINK-USD'];

async function http(url, opts = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 15000);
  try {
    const r = await fetch(url, { ...opts, signal: ctl.signal });
    const txt = await r.text();
    let body;
    try { body = JSON.parse(txt); } catch { body = txt; }
    return { ok: r.ok, status: r.status, body };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------- Precios públicos (sin llaves) ----------------
export async function getPrice(symbol) {
  const r = await http(`https://api.exchange.coinbase.com/products/${symbol}/ticker`,
    { headers: { 'User-Agent': 'quantum-trading' } });
  const p = r.ok ? Number(r.body.price) : NaN;
  if (!(p > 0)) throw new Error(`No se pudo obtener el precio de ${symbol}`);
  return p;
}

// Cierres horarios, del más viejo al más nuevo (se descarta la vela en curso).
export async function getCloses(symbol, granularity = 3600) {
  const r = await http(`https://api.exchange.coinbase.com/products/${symbol}/candles?granularity=${granularity}`,
    { headers: { 'User-Agent': 'quantum-trading' } });
  if (!r.ok || !Array.isArray(r.body)) throw new Error(`No se pudieron obtener velas de ${symbol}`);
  const sorted = r.body.slice().sort((a, b) => a[0] - b[0]);
  return sorted.slice(0, -1).map((c) => Number(c[4]));
}

// Historial largo (hasta ~1200 velas) paginando de a 300; devuelve cierres del más viejo al más nuevo.
export async function getHistory(symbol, candles = 1200, granularity = 3600) {
  const byTime = new Map();
  let end = Math.floor(Date.now() / 1000 / granularity) * granularity + granularity;
  for (let page = 0; page < 8 && byTime.size < candles; page++) {
    const start = end - 300 * granularity;
    const r = await http(`https://api.exchange.coinbase.com/products/${symbol}/candles?granularity=${granularity}`
      + `&start=${new Date(start * 1000).toISOString()}&end=${new Date(end * 1000).toISOString()}`,
    { headers: { 'User-Agent': 'quantum-trading' } });
    if (!r.ok || !Array.isArray(r.body)) throw new Error(`No se pudo obtener historial de ${symbol}`);
    if (!r.body.length) break;
    for (const c of r.body) byTime.set(c[0], Number(c[4]));
    end = start;
  }
  const times = [...byTime.keys()].sort((a, b) => a - b);
  const closes = times.map((t) => byTime.get(t));
  return closes.slice(0, -1).slice(-candles); // sin la vela en curso
}

// ---------------- Coinbase Advanced Trade (llaves CDP, JWT ES256) ----------------
export function coinbaseJwt(keyName, pem, method, host, path) {
  const privateKey = String(pem).replace(/\\n/g, '\n').trim();
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'ES256', kid: keyName, nonce: crypto.randomBytes(16).toString('hex'), typ: 'JWT' };
  const payload = { sub: keyName, iss: 'cdp', nbf: now, exp: now + 120, uri: `${method} ${host}${path}` };
  const input = `${enc(header)}.${enc(payload)}`;
  const sig = crypto.sign('sha256', Buffer.from(input), { key: privateKey, dsaEncoding: 'ieee-p1363' });
  return `${input}.${sig.toString('base64url')}`;
}

async function cb(creds, method, path, body) {
  const host = 'api.coinbase.com';
  const jwt = coinbaseJwt(creds.keyId, creds.secret, method, host, path.split('?')[0]);
  return http(`https://${host}${path}`, {
    method,
    headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
}

export const coinbase = {
  name: 'coinbase',
  label: 'Coinbase Advanced',
  async check(creds) {
    const r = await cb(creds, 'GET', '/api/v3/brokerage/key_permissions');
    if (!r.ok) return { ok: false, error: `Coinbase rechazó la llave (HTTP ${r.status})` };
    return { ok: true, canTrade: !!r.body.can_trade, canTransfer: !!r.body.can_transfer, canView: !!r.body.can_view };
  },
  async balances(creds) {
    const r = await cb(creds, 'GET', '/api/v3/brokerage/accounts?limit=250');
    if (!r.ok) throw new Error(`Coinbase: no se pudo leer el saldo (HTTP ${r.status})`);
    return (r.body.accounts || [])
      .map((a) => ({ asset: a.currency, available: Number(a.available_balance?.value || 0), hold: Number(a.hold?.value || 0) }))
      .filter((a) => a.available + a.hold > 0);
  },
  async marketBuy(creds, { symbol, usd, clientOrderId }) {
    const r = await cb(creds, 'POST', '/api/v3/brokerage/orders', {
      client_order_id: clientOrderId || crypto.randomUUID(), product_id: symbol, side: 'BUY',
      order_configuration: { market_market_ioc: { quote_size: usd.toFixed(2) } },
    });
    if (r.ok && r.body.success) return { ok: true, id: r.body.success_response?.order_id };
    return { ok: false, error: r.body?.error_response?.message || r.body?.error_response?.error || `HTTP ${r.status}` };
  },
  async marketSell(creds, { symbol, qty, clientOrderId }) {
    const r = await cb(creds, 'POST', '/api/v3/brokerage/orders', {
      client_order_id: clientOrderId || crypto.randomUUID(), product_id: symbol, side: 'SELL',
      order_configuration: { market_market_ioc: { base_size: qty.toFixed(8) } },
    });
    if (r.ok && r.body.success) return { ok: true, id: r.body.success_response?.order_id };
    return { ok: false, error: r.body?.error_response?.message || r.body?.error_response?.error || `HTTP ${r.status}` };
  },
};

// ---------------- Robinhood Crypto API (Ed25519) ----------------
export function robinhoodSign(apiKey, privateKeyB64, timestamp, path, method, body = '') {
  const seed = Buffer.from(String(privateKeyB64).trim(), 'base64').subarray(0, 32);
  if (seed.length !== 32) throw new Error('La llave privada de Robinhood debe ser base64 de 32 bytes');
  const der = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]);
  const key = crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
  return crypto.sign(null, Buffer.from(`${apiKey}${timestamp}${path}${method}${body}`), key).toString('base64');
}

async function rh(creds, method, path, bodyObj) {
  const body = bodyObj ? JSON.stringify(bodyObj) : '';
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = robinhoodSign(creds.keyId, creds.secret, ts, path, method, body);
  return http(`https://trading.robinhood.com${path}`, {
    method,
    headers: { 'x-api-key': creds.keyId, 'x-signature': sig, 'x-timestamp': ts, 'Content-Type': 'application/json' },
    body: body || undefined,
  });
}

export const robinhood = {
  name: 'robinhood',
  label: 'Robinhood Crypto',
  async check(creds) {
    const r = await rh(creds, 'GET', '/api/v1/crypto/trading/accounts/');
    if (!r.ok) return { ok: false, error: `Robinhood rechazó la llave (HTTP ${r.status})` };
    // La API de Robinhood Crypto no permite retiros: solo consulta y órdenes.
    return { ok: true, canTrade: true, canTransfer: false, canView: true };
  },
  async balances(creds) {
    const [h, a] = await Promise.all([
      rh(creds, 'GET', '/api/v1/crypto/trading/holdings/'),
      rh(creds, 'GET', '/api/v1/crypto/trading/accounts/'),
    ]);
    if (!h.ok) throw new Error(`Robinhood: no se pudo leer el saldo (HTTP ${h.status})`);
    const out = (h.body.results || []).map((x) => ({
      asset: x.asset_code, available: Number(x.quantity_available_for_trading || x.total_quantity || 0),
      hold: Math.max(0, Number(x.total_quantity || 0) - Number(x.quantity_available_for_trading || x.total_quantity || 0)),
    })).filter((x) => x.available + x.hold > 0);
    if (a.ok && a.body.buying_power) out.unshift({ asset: a.body.buying_power_currency || 'USD', available: Number(a.body.buying_power), hold: 0 });
    return out;
  },
  // Pares permitidos (formato de memoria de la doc pública; si no cuadra devolvemos [] y se usa la lista base).
  async pairs(creds) {
    const out = []; let path = '/api/v1/crypto/trading/trading_pairs/';
    for (let i = 0; i < 10 && path; i++) {
      const r = await rh(creds, 'GET', path);
      if (!r.ok) throw new Error(`Robinhood: no se pudieron leer los pares (HTTP ${r.status})`);
      for (const x of r.body.results || []) if (x && x.symbol && (x.status === undefined || x.status === 'tradable')) out.push(String(x.symbol));
      const nx = r.body.next; path = nx ? String(nx).replace(/^https?:\/\/[^/]+/, '') : null;
    }
    return out;
  },
  async marketBuy(creds, { symbol, usd, clientOrderId }) {
    const price = await getPrice(symbol);
    const qty = Math.floor((usd / price) * 1e8) / 1e8;
    return rhOrder(creds, symbol, 'buy', qty, clientOrderId);
  },
  async marketSell(creds, { symbol, qty, clientOrderId }) {
    return rhOrder(creds, symbol, 'sell', qty, clientOrderId);
  },
};

const decimals = (inc) => { const t = String(inc ?? ''); if (!t.includes('.')) return 0; return t.replace(/0+$/, '').split('.')[1]?.length || 0; };
const errText = (r) => {
  const b = r.body;
  const first = b?.errors?.[0];
  const msg = first?.detail || first?.attr || b?.detail || b?.message || (typeof b === 'string' ? b.slice(0, 120) : b ? JSON.stringify(b).slice(0, 160) : '');
  return `HTTP ${r.status}${msg ? `: ${msg}` : ''}`;
};

// Reglas por par de Robinhood (incremento y mínimos), cacheadas 1 h.
const rhInfo = new Map();
async function rhPairInfo(creds, symbol) {
  const c = rhInfo.get(creds.keyId);
  if (!c || Date.now() - c.t > 3600000) {
    const m = new Map(); let path = '/api/v1/crypto/trading/trading_pairs/';
    for (let i = 0; i < 10 && path; i++) {
      const r = await rh(creds, 'GET', path);
      if (!r.ok) break;
      for (const x of r.body.results || []) if (x && x.symbol) m.set(x.symbol, { inc: x.asset_increment, min: Number(x.min_order_size), max: Number(x.max_order_size), status: x.status });
      path = r.body.next ? String(r.body.next).replace(/^https?:\/\/[^/]+/, '') : null;
    }
    rhInfo.set(creds.keyId, { t: Date.now(), m });
  }
  return rhInfo.get(creds.keyId).m.get(symbol) || null;
}

const rhLearned = new Map(); // incrementos que el propio Robinhood nos indicó en un rechazo
const fmtQty = (q, d) => (d > 0 ? q.toFixed(d) : String(Math.floor(q)));
// ID derivado y determinista para el segundo intento (tras un rechazo definitivo por redondeo), sin perder la idempotencia.
const deriveId = (id, n) => { const h = crypto.createHash('sha256').update(`${id}:${n}`).digest(); h[6] = (h[6] & 0x0f) | 0x50; h[8] = (h[8] & 0x3f) | 0x80; const x = h.subarray(0, 16).toString('hex'); return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`; };
async function rhOrder(creds, symbol, side, qty, clientOrderId) {
  let attempt = 0;
  let inc = rhLearned.get(symbol) || null; let min = null;
  try {
    const info = await rhPairInfo(creds, symbol);
    if (info) {
      if (info.status && info.status !== 'tradable') return { ok: false, error: `${symbol} no está disponible para operar en Robinhood ahora (${info.status})` };
      inc = info.inc || inc; min = Number.isFinite(info.min) && info.min > 0 ? info.min : null;
    }
  } catch { /* sin reglas: se intenta igual */ }
  const place = async (q, d) => rh(creds, 'POST', '/api/v1/crypto/trading/orders/', {
    client_order_id: clientOrderId ? (attempt++ === 0 ? clientOrderId : deriveId(clientOrderId, attempt - 1)) : crypto.randomUUID(), side, type: 'market', symbol, market_order_config: { asset_quantity: fmtQty(q, d) } });
  let d = inc ? decimals(inc) : 8;
  let q = Math.floor(qty * 10 ** d + 1e-9) / 10 ** d;
  if (min && q < min) return { ok: false, error: `Cantidad ${q} menor al mínimo de Robinhood para ${symbol} (${min}); sube el monto` };
  if (!(q > 0)) return { ok: false, error: 'Cantidad calculada en cero; sube el monto' };
  let r = await place(q, d);
  if (r.ok && r.body.id) return { ok: true, id: r.body.id };
  // Si Robinhood dice a qué incremento redondear, se lo hacemos caso y se reintenta una vez (y se recuerda).
  const m = /nearest\s+([0-9]*\.?[0-9]+)/i.exec(JSON.stringify(r.body || ''));
  if (m) {
    rhLearned.set(symbol, m[1]);
    d = decimals(m[1]); q = Math.floor(qty * 10 ** d + 1e-9) / 10 ** d;
    if (q > 0) { r = await place(q, d); if (r.ok && r.body.id) return { ok: true, id: r.body.id }; }
  }
  return { ok: false, error: errText(r) };
}

// Actividad real en el exchange (órdenes recientes). Formatos de memoria de la doc pública; si algo no cuadra se muestra el error.
robinhood.activity = async function activity(creds) {
  const r = await rh(creds, 'GET', '/api/v1/crypto/trading/orders/');
  if (!r.ok) throw new Error(`Robinhood: ${errText(r)}`);
  return (r.body.results || []).slice(0, 15).map((o) => {
    const ex = o.executions && o.executions[0];
    return { id: o.id, symbol: o.symbol, side: o.side, state: o.state, qty: Number(o.filled_asset_quantity || ex?.quantity || 0) || null,
      price: Number(o.average_price || ex?.effective_price || 0) || null, t: Date.parse(o.created_at) || null };
  });
};
robinhood.quotes = async function quotes(creds, symbols) {
  const q = symbols.map((s) => `symbol=${encodeURIComponent(s)}`).join('&');
  const r = await rh(creds, 'GET', `/api/v1/crypto/marketdata/best_bid_ask/?${q}`);
  if (!r.ok) throw new Error(`Robinhood: ${errText(r)}`);
  return (r.body.results || []).map((x) => ({ symbol: x.symbol, bid: Number(x.bid_inclusive_of_sell_spread ?? x.bid_price), ask: Number(x.ask_inclusive_of_buy_spread ?? x.ask_price), price: Number(x.price) }))
    .filter((x) => x.bid > 0 && x.ask > 0);
};
coinbase.activity = async function activity(creds) {
  const r = await cb(creds, 'GET', '/api/v3/brokerage/orders/historical/batch?limit=15');
  if (!r.ok) throw new Error(`Coinbase: HTTP ${r.status}`);
  return (r.body.orders || []).slice(0, 15).map((o) => ({ id: o.order_id, symbol: o.product_id, side: String(o.side || '').toLowerCase(), state: String(o.status || '').toLowerCase(),
    qty: Number(o.filled_size) || null, price: Number(o.average_filled_price) || null, t: Date.parse(o.created_time) || null }));
};

// ---- Conciliación: estado real de UNA orden en el broker (solo lectura) ----
// Coinbase: GET /api/v3/brokerage/orders/historical/{order_id} -> { order: { status, filled_size, filled_value, average_filled_price, total_fees, client_order_id, reject_message, cancel_message } }
//   (campos y valores de status verificados en docs.cdp.coinbase.com, 'get order'). Para una orden sin order_id se busca por client_order_id en el listado reciente.
coinbase.getOrder = async function getOrder(creds, { extId, clientOrderId, symbol }) {
  if (extId) {
    const r = await cb(creds, 'GET', `/api/v3/brokerage/orders/historical/${encodeURIComponent(extId)}`);
    if (r.status === 404) return { found: false };
    if (!r.ok) throw new Error(`Coinbase: HTTP ${r.status}`);
    return r.body && r.body.order ? { found: true, raw: r.body.order } : { found: false };
  }
  const r = await cb(creds, 'GET', `/api/v3/brokerage/orders/historical/batch?limit=100${symbol ? `&product_ids=${encodeURIComponent(symbol)}` : ''}`);
  if (!r.ok) throw new Error(`Coinbase: HTTP ${r.status}`);
  const hit = (r.body.orders || []).find((o) => o.client_order_id === clientOrderId);
  return hit ? { found: true, raw: hit } : { found: false, listed: (r.body.orders || []).length };
};
// Robinhood Crypto: GET /api/v1/crypto/trading/orders/{id}/ y GET /api/v1/crypto/trading/orders/ (campos: id, client_order_id, state, average_price,
//   filled_asset_quantity, executions[]). Estados: open, canceled, partially_filled, filled, failed. Fuente: catálogo público del spec de Robinhood
//   (apis.io); la página oficial no se pudo abrir desde el entorno de desarrollo, por eso un estado desconocido nunca se trata como ejecutado.
robinhood.getOrder = async function getOrder(creds, { extId, clientOrderId }) {
  if (extId) {
    const r = await rh(creds, 'GET', `/api/v1/crypto/trading/orders/${encodeURIComponent(extId)}/`);
    if (r.status === 404) return { found: false };
    if (!r.ok) throw new Error(`Robinhood: ${errText(r)}`);
    return r.body && r.body.id ? { found: true, raw: r.body } : { found: false };
  }
  let path = '/api/v1/crypto/trading/orders/'; let seen = 0;
  for (let i = 0; i < 5 && path; i++) {
    const r = await rh(creds, 'GET', path);
    if (!r.ok) throw new Error(`Robinhood: ${errText(r)}`);
    const hit = (r.body.results || []).find((o) => o.client_order_id === clientOrderId); seen += (r.body.results || []).length;
    if (hit) return { found: true, raw: hit };
    const nx = r.body.next; path = nx ? (String(nx).startsWith('http') ? new URL(nx).pathname + new URL(nx).search : nx) : null;
  }
  return { found: false, listed: seen };
};

export const ADAPTERS = { coinbase, robinhood };
