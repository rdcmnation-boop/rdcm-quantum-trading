// Bot descargable: corre en TU computadora con TUS llaves. No envía tus llaves a ningún servidor
// de Quantum Trading; solo habla con el exchange y con el precio público de Coinbase.
// Por defecto opera en modo PAPEL (simulado). Para dinero real: --live y I_ACCEPT_RISK=yes.
import fs from 'node:fs';

const BOT_VERSION = '1.0.0';

function loadDotEnv() {
  try {
    for (const line of fs.readFileSync('.env', 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch { /* sin .env */ }
}

function readState(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { orders: [] }; }
}

async function botMain() {
  const args = process.argv.slice(2);
  if (args.includes('--version')) { console.log(BOT_VERSION); return; }
  if (args.includes('--help')) {
    console.log(`Quantum Bot ${BOT_VERSION}
Uso: node quantum-bot.mjs [--live] [--once]
Configura con variables de entorno o un archivo .env:
  EXCHANGE=coinbase|robinhood   KEY_ID=...   SECRET=...  (o SECRET_FILE=ruta)
  SYMBOL=BTC-USD  STRATEGY=dca|sma  USD=10  INTERVAL_MIN=1440  FAST=20  SLOW=50
  MAX_ORDER_USD=25  MAX_DAILY_USD=100
Modo papel por defecto. Dinero real: --live y I_ACCEPT_RISK=yes.
Usa llaves de SOLO trading (sin retiros). Esto no es asesoría financiera.`);
    return;
  }
  loadDotEnv();
  const e = process.env;
  const live = args.includes('--live');
  if (live && e.I_ACCEPT_RISK !== 'yes') {
    console.error('Para operar con dinero real define I_ACCEPT_RISK=yes (confirmas que entiendes el riesgo de perder dinero).');
    process.exit(1);
  }
  const cfgIn = {
    mode: live ? 'live' : 'paper', symbol: e.SYMBOL || 'BTC-USD', strategy: e.STRATEGY || 'dca',
    usd: e.USD || 10, intervalMin: e.INTERVAL_MIN || 1440, fast: e.FAST || 20, slow: e.SLOW || 50,
    maxOrderUsd: e.MAX_ORDER_USD || 25, maxDailyUsd: e.MAX_DAILY_USD || 100, enabled: true, liveAck: live,
  };
  const v = validateCfg(cfgIn, { symbols: SYMBOLS });
  if (!v.ok) { console.error('Configuración inválida:', v.error); process.exit(1); }
  const cfg = v.cfg;

  let adapter = null;
  let creds = null;
  if (live) {
    adapter = ADAPTERS[e.EXCHANGE];
    if (!adapter) { console.error('EXCHANGE debe ser coinbase o robinhood'); process.exit(1); }
    const secret = e.SECRET_FILE ? fs.readFileSync(e.SECRET_FILE, 'utf8') : e.SECRET;
    if (!e.KEY_ID || !secret) { console.error('Faltan KEY_ID y SECRET (o SECRET_FILE)'); process.exit(1); }
    creds = { keyId: e.KEY_ID, secret };
    const chk = await adapter.check(creds);
    if (!chk.ok) { console.error(chk.error); process.exit(1); }
    if (!chk.canTrade || chk.canTransfer) {
      console.error('La llave debe permitir trading y NO permitir retiros/transferencias. Crea una llave nueva solo-trading.');
      process.exit(1);
    }
  }

  const stateFile = `quantum-bot-state-${cfg.mode}.json`;
  const state = readState(stateFile);
  console.log(`Quantum Bot ${BOT_VERSION} | modo ${cfg.mode.toUpperCase()} | ${cfg.symbol} | ${cfg.strategy}`);

  async function step() {
    const now = Date.now();
    const price = await getPrice(cfg.symbol);
    const closes = cfg.strategy === 'sma' ? await getCloses(cfg.symbol) : [];
    const mine = state.orders.filter((o) => o.symbol === cfg.symbol && o.status === 'ok');
    const lastBuy = mine.filter((o) => o.side === 'buy').sort((a, b) => b.t - a.t)[0];
    const position = mine.reduce((s, o) => s + (o.side === 'buy' ? o.qty : -o.qty), 0);
    const d = decide(cfg, { closes, now, lastBuyAt: lastBuy ? lastBuy.t : 0, position });
    if (d.action === 'hold') { console.log(new Date().toISOString(), 'mantener:', d.reason); return; }

    let usd = d.action === 'buy' ? Math.min(d.usd, cfg.maxOrderUsd) : 0;
    let qty = d.action === 'buy' ? usd / price : Math.min(d.qty, position);
    if (d.action === 'sell') usd = qty * price;
    if (live && d.action === 'buy') {
      const spent = state.orders.filter((o) => o.side === 'buy' && o.status === 'ok' && o.t > now - 86400000)
        .reduce((s, o) => s + o.usd, 0);
      if (spent + usd > cfg.maxDailyUsd) { console.log('Tope diario alcanzado, no se compra.'); return; }
    }
    let status = 'ok';
    let note = d.reason;
    if (live) {
      const r = d.action === 'buy'
        ? await adapter.marketBuy(creds, { symbol: cfg.symbol, usd })
        : await adapter.marketSell(creds, { symbol: cfg.symbol, qty });
      if (!r.ok) { status = 'error'; note = r.error; }
    }
    state.orders.push({ t: now, symbol: cfg.symbol, side: d.action, usd, qty, price, status, note });
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
    console.log(new Date().toISOString(), d.action, cfg.symbol, `~$${usd.toFixed(2)}`, status, note);
  }

  const once = args.includes('--once');
  for (;;) {
    try { await step(); } catch (err) { console.error('Error:', err.message); }
    if (once) break;
    await new Promise((r) => setTimeout(r, 60000));
  }
}

botMain();
