// Universo de criptos operables: TODO lo que Coinbase lista en USD (público) + lo que Robinhood permite a cada conexión.
// Formatos escritos de memoria de la documentación pública; si una fuente falla se usa la lista base, nunca se inventa.
import { SYMBOLS } from './exchanges.js';

const CB = 'https://api.exchange.coinbase.com';
export const SYMBOL_RE = /^[A-Z0-9]{2,12}-USD$/;
let cache = { t: 0, v: null };

export async function fetchCoinbaseProducts(f = fetch) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 10000);
  try {
    const r = await f(`${CB}/products`, { signal: ctl.signal, headers: { Accept: 'application/json', 'User-Agent': 'quantum-trading' } });
    if (!r.ok) throw new Error(`Coinbase respondió ${r.status}`);
    const arr = await r.json();
    if (!Array.isArray(arr)) throw new Error('respuesta inesperada');
    return arr.filter((p) => p && p.quote_currency === 'USD' && (p.status === undefined || p.status === 'online')
      && !p.trading_disabled && !p.cancel_only && !p.post_only && !p.limit_only && SYMBOL_RE.test(String(p.id)))
      .map((p) => String(p.id)).sort();
  } finally { clearTimeout(t); }
}

export async function getUniverse({ f = fetch, ttl = 3600000, now = Date.now(), force = false } = {}) {
  if (!force && cache.v && now - cache.t < ttl) return cache.v;
  let coinbase = null; let error = null;
  try { coinbase = await fetchCoinbaseProducts(f); } catch (e) { error = e.message; }
  const live = !!(coinbase && coinbase.length);
  const v = { t: now, coinbase: live ? coinbase : [...SYMBOLS], live, error };
  if (live) cache = { t: now, v };
  return v;
}
export const resetUniverseCache = () => { cache = { t: 0, v: null }; };

// Pares de Robinhood por usuario (cache en settings, 6 h). Si no se pueden leer, se usa la lista base y se marca "estimado".
export async function robinhoodPairs({ store, adapters, userId, creds, now = Date.now() }) {
  const key = `rhpairs:${userId}`;
  try { const c = JSON.parse(await store.getSetting(key, 'null')); if (c && now - c.t < 6 * 3600000) return c; } catch { /* sin cache */ }
  let out;
  try {
    const list = await adapters.robinhood.pairs(creds);
    out = list.length ? { t: now, symbols: list, verified: true } : { t: now, symbols: [...SYMBOLS], verified: false };
  } catch { out = { t: now, symbols: [...SYMBOLS], verified: false }; }
  try { await store.setSetting(key, JSON.stringify(out)); } catch { /* informativo */ }
  return out;
}

export async function isAllowedSymbol(symbol, opts) {
  if (symbol === 'AUTO') return true;
  if (!SYMBOL_RE.test(String(symbol))) return false;
  if (SYMBOLS.includes(symbol)) return true;
  return (await getUniverse(opts)).coinbase.includes(symbol);
}

// Para pruebas y arranque: fija la lista en cache.
export function seedUniverse(coinbase, now = Date.now()) { cache = { t: now, v: { t: now, coinbase: [...coinbase], live: true, error: null } }; }
