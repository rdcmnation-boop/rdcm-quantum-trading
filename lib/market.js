// Inteligencia de mercado con fuentes públicas (sin llaves): CoinGecko (visión global del mercado) y
// Coinbase Exchange / "Coinbase Pro" (libro de órdenes y estadísticas reales del par).
// Todo se parsea de forma defensiva y falla con elegancia: si una fuente no responde, se muestra "sin datos", nunca se inventa.
// Los formatos de respuesta están escritos de memoria de la documentación pública y se validan en vivo la primera vez.
import { COST_PROFILES } from './costs.js';

const GECKO = 'https://api.coingecko.com/api/v3';
const CB = 'https://api.exchange.coinbase.com';
const IDS = { 'BTC-USD': 'bitcoin', 'ETH-USD': 'ethereum', 'SOL-USD': 'solana', 'LTC-USD': 'litecoin', 'DOGE-USD': 'dogecoin', 'AVAX-USD': 'avalanche-2', 'LINK-USD': 'chainlink' };
const num = (x) => (Number.isFinite(Number(x)) && x !== null && x !== '' ? Number(x) : null);

async function getJson(url, f = fetch, ms = 8000) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await f(url, { signal: ctl.signal, headers: { Accept: 'application/json', 'User-Agent': 'quantum-trading/14' } });
    if (!r.ok) throw new Error(`${new URL(url).host} respondió ${r.status}`);
    return await r.json();
  } finally { clearTimeout(t); }
}

// Régimen de mercado simple y explicable (no es una predicción).
export function classifyRegime({ btc7, btc30, mcap24 }) {
  if ([btc7, btc30].some((x) => x === null || x === undefined)) return { code: 'unknown', label: 'Sin datos' };
  if (btc30 > 10 && btc7 > 0) return { code: 'bull', label: 'Alcista' };
  if (btc30 < -10 && btc7 < 0) return { code: 'bear', label: 'Bajista' };
  if (Math.abs(btc7) > 8 || Math.abs(mcap24 ?? 0) > 5) return { code: 'volatile', label: 'Volátil' };
  return { code: 'range', label: 'Lateral' };
}

export async function fetchGecko(f = fetch) {
  const ids = Object.values(IDS).join(',');
  const [g, m, tr] = await Promise.allSettled([
    getJson(`${GECKO}/global`, f),
    getJson(`${GECKO}/coins/markets?vs_currency=usd&ids=${ids}&price_change_percentage=24h,7d,30d&sparkline=false`, f),
    getJson(`${GECKO}/search/trending`, f),
  ]);
  const out = { ok: false, errors: [] };
  if (g.status === 'fulfilled' && g.value && g.value.data) {
    const d = g.value.data;
    out.global = { mcap: num(d.total_market_cap?.usd), vol24: num(d.total_volume?.usd), btcDom: num(d.market_cap_percentage?.btc), ethDom: num(d.market_cap_percentage?.eth), mcap24: num(d.market_cap_change_percentage_24h_usd) };
  } else out.errors.push(`global: ${g.reason?.message || 'sin datos'}`);
  if (m.status === 'fulfilled' && Array.isArray(m.value)) {
    const byId = Object.fromEntries(Object.entries(IDS).map(([s, id]) => [id, s]));
    out.coins = m.value.filter((c) => byId[c.id]).map((c) => ({ symbol: byId[c.id], price: num(c.current_price), ch24: num(c.price_change_percentage_24h_in_currency ?? c.price_change_percentage_24h),
      ch7: num(c.price_change_percentage_7d_in_currency), ch30: num(c.price_change_percentage_30d_in_currency), vol24: num(c.total_volume), mcap: num(c.market_cap), athChg: num(c.ath_change_percentage) }));
  } else out.errors.push(`mercados: ${m.reason?.message || 'sin datos'}`);
  if (tr.status === 'fulfilled' && Array.isArray(tr.value?.coins)) out.trending = tr.value.coins.slice(0, 7).map((c) => ({ name: String(c.item?.name || ''), symbol: String(c.item?.symbol || '') }));
  else out.errors.push(`tendencia: ${tr.reason?.message || 'sin datos'}`);
  out.ok = !!(out.global || out.coins);
  return out;
}

// Top monedas por capitalización (CoinGecko) para elegir qué escanear. Devuelve [{symbol:'SOL-USD', mcap, vol24, ch24, ch7}].
export async function fetchTopCoins(n = 60, f = fetch) {
  const arr = await getJson(`${GECKO}/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=${n}&page=1&price_change_percentage=24h,7d&sparkline=false`, f);
  if (!Array.isArray(arr)) throw new Error('CoinGecko: respuesta inesperada');
  return arr.filter((c) => c && c.symbol).map((c) => ({ symbol: `${String(c.symbol).toUpperCase()}-USD`, mcap: num(c.market_cap), vol24: num(c.total_volume),
    ch24: num(c.price_change_percentage_24h_in_currency ?? c.price_change_percentage_24h), ch7: num(c.price_change_percentage_7d_in_currency) }));
}

// Libro de órdenes y estadísticas reales de Coinbase Exchange para un par: spread, profundidad y volumen en USD.
export async function fetchBook(symbol, f = fetch) {
  const [bk, st] = await Promise.allSettled([getJson(`${CB}/products/${symbol}/book?level=2`, f), getJson(`${CB}/products/${symbol}/stats`, f)]);
  if (bk.status !== 'fulfilled') return null;
  const bids = (bk.value.bids || []).map((r) => [num(r[0]), num(r[1])]).filter((r) => r[0] && r[1]);
  const asks = (bk.value.asks || []).map((r) => [num(r[0]), num(r[1])]).filter((r) => r[0] && r[1]);
  if (!bids.length || !asks.length) return null;
  const bid = bids[0][0]; const ask = asks[0][0]; const mid = (bid + ask) / 2;
  const depth = (rows, sign) => rows.filter((r) => sign * (r[0] - mid) / mid <= 0.005).reduce((s, r) => s + r[0] * r[1], 0); // USD a ±0.5 %
  const stats = st.status === 'fulfilled' ? st.value : {};
  const vol = num(stats.volume) !== null && num(stats.last) !== null ? num(stats.volume) * num(stats.last) : null;
  return { symbol, bid, ask, mid, spreadPct: ((ask - bid) / mid) * 100, bidDepthUsd: depth(bids, -1), askDepthUsd: depth(asks, 1), volume24Usd: vol };
}

// Calibra el modelo de costos con datos reales de Coinbase (spread y volumen del par). Robinhood no publica libro: se deja el supuesto.
export function calibrationFrom(books) {
  const cal = { coinbase: { halfSpreadPct: {}, advUsd: {} }, t: Date.now() };
  for (const b of books) {
    if (!b) continue;
    cal.coinbase.halfSpreadPct[b.symbol] = Math.min(1, Math.max(0.001, b.spreadPct / 2));
    if (b.volume24Usd) cal.coinbase.advUsd[b.symbol] = b.volume24Usd;
  }
  return cal;
}

let cache = { t: 0, v: null };
export async function getMarket({ f = fetch, ttl = 300000, now = Date.now(), force = false } = {}) {
  if (!force && cache.v && now - cache.t < ttl) return cache.v;
  const gecko = await fetchGecko(f);
  const books = [];
  for (const s of ['BTC-USD', 'ETH-USD']) books.push(await fetchBook(s, f).catch(() => null));
  const btc = gecko.coins?.find((c) => c.symbol === 'BTC-USD');
  const regime = classifyRegime({ btc7: btc?.ch7 ?? null, btc30: btc?.ch30 ?? null, mcap24: gecko.global?.mcap24 ?? null });
  const v = { t: now, gecko, books: books.filter(Boolean), regime, calibration: calibrationFrom(books), sources: { coingecko: gecko.ok, coinbase_exchange: books.some(Boolean) } };
  cache = { t: now, v };
  return v;
}
export const resetMarketCache = () => { cache = { t: 0, v: null }; };
export { COST_PROFILES };
