// Titulares de noticias cripto de fuentes públicas (RSS). Se usan SOLO como freno de riesgo: si hay noticias negativas
// (hackeo, prohibición, demanda, quiebra…) sobre una cripto o sobre el mercado, el bot no abre posiciones nuevas.
// No predice precios. El formato RSS está escrito de memoria; si una fuente falla se ignora.
const FEEDS = ['https://www.coindesk.com/arc/outboundfeeds/rss/', 'https://cointelegraph.com/rss'];
const NEG = /\b(hack(ed|s)?|exploit(ed)?|stolen|theft|ban(s|ned)?|lawsuit|sues?|sued|fraud|ponzi|bankrupt(cy)?|insolven(t|cy)|delist(s|ed|ing)?|crash(es|ed)?|plunge(s|d)?|collapse[sd]?|rug ?pull|investigation|subpoena|halt(s|ed)?)\b/i;
const COINS = { bitcoin: 'BTC', btc: 'BTC', ethereum: 'ETH', ether: 'ETH', solana: 'SOL', xrp: 'XRP', ripple: 'XRP', cardano: 'ADA', dogecoin: 'DOGE', doge: 'DOGE', avalanche: 'AVAX', chainlink: 'LINK', polkadot: 'DOT', litecoin: 'LTC', stellar: 'XLM', cosmos: 'ATOM', uniswap: 'UNI', aave: 'AAVE', near: 'NEAR', shiba: 'SHIB', tether: 'USDT', binance: 'BNB', bnb: 'BNB' };

export function parseRss(xml) {
  const items = [];
  for (const m of String(xml).matchAll(/<item[\s>][\s\S]*?<\/item>/gi)) {
    const t = /<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i.exec(m[0]);
    const d = /<pubDate>([\s\S]*?)<\/pubDate>/i.exec(m[0]);
    if (t) items.push({ title: t[1].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').trim().slice(0, 160), t: d ? Date.parse(d[1]) || null : null });
  }
  return items;
}

export function analyze(items, now = Date.now()) {
  const risk = {}; let globalNeg = 0; const out = [];
  for (const it of items) {
    if (it.t && now - it.t > 12 * 3600000) continue; // solo últimas 12 h
    const neg = NEG.test(it.title);
    const low = it.title.toLowerCase();
    const coins = [...new Set(Object.entries(COINS).filter(([k]) => new RegExp(`\\b${k}\\b`, 'i').test(low)).map(([, v]) => v))];
    if (neg) { if (coins.length) coins.forEach((c) => { risk[c] = (risk[c] || 0) + 1; }); else globalNeg++; }
    out.push({ title: it.title, t: it.t, neg, coins });
  }
  const btcNeg = (risk.BTC || 0) + (risk.ETH || 0);
  return { t: now, items: out.slice(0, 20), risk, global_neg: globalNeg, risk_off: globalNeg >= 3 || btcNeg >= 3 };
}

export async function fetchNews(f = fetch, now = Date.now()) {
  const all = []; const errors = [];
  for (const url of FEEDS) {
    try {
      const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), 8000);
      try { const r = await f(url, { signal: ctl.signal, headers: { 'User-Agent': 'quantum-trading' } }); if (!r.ok) throw new Error(`HTTP ${r.status}`); all.push(...parseRss(await r.text())); } finally { clearTimeout(tm); }
    } catch (e) { errors.push(`${new URL(url).host}: ${e.message}`); }
  }
  const res = analyze(all, now); res.errors = errors; res.sources = FEEDS.length - errors.length;
  return res;
}
