// Motor del bot hospedado: evalúa cada bot activo cada minuto.
// Modo "paper" = simulado con precio real. Modo "live" = órdenes reales con las llaves del cliente,
// solo si el dueño habilitó trading real, el cliente aceptó el riesgo y se respetan los topes.
import { decrypt } from './security.js';
import { entitlement } from './billing.js';
import { decide, positionFromOrders, DEFAULT_CFG } from './strategy.js';
import { sma, rsi, macd } from './indicators.js';
import { project, futureGate } from './timemachine.js';
import { features, roundTripPct, entrySignal, exitSignal, perfSummary, losingSymbols, closedTrades, pnl24h, confidenceSize, explainBuy, explainSell, newsNote, regimeEs } from './pro.js';
import { simulateFill } from './costs.js';
import { getUniverse, robinhoodPairs, newListings } from './universe.js';
import { getScanner } from './scanner.js';
import { evaluateEdge } from './edge.js';
import { tradeFilter } from './filter.js';
import { sizeDecision, curveFromClosed } from './sizing.js';
import { loadSubs } from './push.js';
import { loadLog as loadSlipLog, summarize as slipSummary } from './slippage.js';
import { clientOrderId, isAmbiguous } from './ledger.js';
import { loadPlatform, getEmergency, preCheck } from './risk.js';
import crypto from 'node:crypto';

const DAY = 86400000;

export function createEngine({ store, adapters, feed, encKey, log = console, alert = null }) {
  const warn = async (uid, a) => { if (alert) { try { await alert(uid, a); } catch { /* el aviso nunca debe frenar al bot */ } } };
  const cache = new Map();
  const skipLog = new Map();
  let running = false; let stopping = false;
  const instanceId = crypto.randomUUID(); // identifica a esta instancia en el candado de líder

  async function market(symbol) {
    // Precio fresco cada 15 s; las velas horarias (más pesadas y que casi no cambian) cada 5 min.
    const c = cache.get(symbol); const now = Date.now();
    if (c && now - c.t < 15000 && now - c.tc < 300000) return c;
    const price = await feed.getPrice(symbol);
    const reuse = c && now - c.tc < 300000;
    const closes = reuse ? c.closes : await feed.getCloses(symbol);
    const v = { t: now, tc: reuse ? c.tc : now, price, closes };
    cache.set(symbol, v);
    return v;
  }

  async function disable(userId, why, { error = false } = {}) {
    const b = await store.getBot(userId);
    if (b && error) await store.setBotState(userId, 'ERROR', why);
    if (b) await store.patchBot(userId, { cfg: { ...b.cfg, enabled: false } });
    await store.addAudit({ user_id: userId, actor: 'engine', action: 'bot_disabled', detail: why });
    await warn(userId, { kind: 'bot_disabled', title: '⛔ Tu bot se apagó', body: String(why).slice(0, 120) });
  }

  // Última decisión del bot por cliente (para que vea cómo va). Solo escribe si cambió o pasaron 10 min.
  const lastNote = new Map();
  async function noteDecision(userId, d) {
    const prev = lastNote.get(userId);
    if (prev && prev.action === d.action && prev.reason === d.reason && d.t - prev.t < 600000) return;
    lastNote.set(userId, d);
    try { await store.setSetting(`botlast:${userId}`, JSON.stringify(d)); } catch { /* informativo */ }
  }

  // Ejecuta UN símbolo con la config dada. Devuelve la decisión (para que AUTO sepa qué pasó).
  // venue: exchange del papel; conn: conexión para real.
  async function runSymbol(row, cfg, conn, venue, symbol, nowMs, { note = true, slots = 1, reason = null, force = null } = {}) {
    const userId = row.user_id;
    const m = await market(symbol);
    const orders = (await store.listOrders(userId, 1000))
      .filter((o) => o.mode === cfg.mode && o.symbol === symbol && o.status === 'ok');
    const pos = positionFromOrders(orders.map((o) => ({ side: o.side, qty: o.qty, usd: o.usd, ts: o.created_at })));
    const position = pos.qty;
    const d = force ? (force.action === 'sell' ? { action: position > 0 ? 'sell' : 'hold', qty: position, reason: force.reason } : { action: 'buy', usd: force.usd, reason: force.reason })
      : decide(cfg, { closes: m.closes, now: nowMs, price: m.price, lastBuyAt: pos.lastBuyAt,
      lastSellAt: pos.lastSellAt, position, avgCost: pos.avgCost });
    if (reason && d.action === 'buy') d.reason = reason;
    if (note) await noteDecision(userId, { t: nowMs, action: d.action, reason: d.reason || '', price: m.price });
    if (d.action === 'hold') return { d, price: m.price, placed: false };

    const base = { user_id: userId, mode: cfg.mode, exchange: conn ? conn.exchange : venue, symbol, side: d.action };

    if (d.action === 'buy') {
      let usd = Math.min(d.usd, cfg.maxOrderUsd);
      if (cfg.mode === 'live') {
        // Usa lo que hay disponible en el exchange, repartido entre las posiciones libres; nunca pasa el tope por orden.
        let avail = 0;
        try {
          const creds = { keyId: conn.key_id, secret: decrypt(encKey, conn.secret_enc) };
          avail = ((await adapters[conn.exchange].balances(creds)).find((b) => b.asset === 'USD' || b.asset === 'USDC') || {}).available || 0;
        } catch { avail = 0; }
        usd = cfg.sizing === 'balance' ? Math.min(cfg.maxOrderUsd, Math.floor((avail * 0.99 / Math.max(1, slots)) * 100) / 100) : Math.min(usd, Math.floor(avail * 0.99 * 100) / 100);
        if (!(usd >= 1)) {
          await noteDecision(userId, { t: nowMs, action: 'hold', reason: `Saldo disponible en ${conn.exchange} insuficiente (${avail.toFixed(2)} USD): deposita al menos $1 para que el bot opere`, price: m.price });
          return { d, price: m.price, placed: false };
        }
      }
      if (cfg.mode === 'live') {
        const spent = await store.liveUsdSince(userId, nowMs - DAY);
        if (spent + usd > cfg.maxDailyUsd) {
          const k = `${userId}:cap`;
          if (nowMs - (skipLog.get(k) || 0) > 3600000) {
            skipLog.set(k, nowMs);
            await store.addAudit({ user_id: userId, actor: 'engine', action: 'daily_cap_reached', detail: `Tope diario $${cfg.maxDailyUsd}` });
          }
          return { d, price: m.price, placed: false };
        }
      }
      if (cfg.mode === 'paper') {
        // Papel realista: mismo spread, impacto y comisión estimados del exchange (no es precio de mercado puro).
        const f = simulateFill({ side: 'buy', usd, price: m.price, symbol, exchange: venue });
        await store.addOrder({ ...base, usd: usd + f.feeUsd, qty: usd / f.price, price: f.price, status: 'ok',
          note: `${d.reason} (simulado en ${venue}: comisión ${f.feePct}% + deslizamiento ${f.slipPct.toFixed(3)}%)` });
        return { d, price: m.price, placed: true };
      }
      await placeLive(row, conn, base, 'marketBuy', { symbol, usd }, usd, m.price, d.reason, undefined, nowMs, { priceAgeMs: Date.now() - m.t, refPrice: m.closes && m.closes.length ? m.closes[m.closes.length - 1] : null, cfg });
      return { d, price: m.price, placed: true };
    }

    // sell
    const qty = Math.min(d.qty, position);
    if (!(qty > 0)) return { d, price: m.price, placed: false };
    if (cfg.mode === 'paper') {
      const f = simulateFill({ side: 'sell', usd: qty * m.price, price: m.price, symbol, exchange: venue });
      const gross = qty * f.price;
      await store.addOrder({ ...base, usd: gross - (gross * f.feePct) / 100, qty, price: f.price, status: 'ok',
        note: `${d.reason} (simulado en ${venue}: comisión ${f.feePct}% + deslizamiento ${f.slipPct.toFixed(3)}%)` });
      return { d, price: m.price, placed: true };
    }
    // En real, nunca vendemos más de lo que el exchange dice que hay disponible.
    let sellQty = qty;
    try {
      const creds = { keyId: conn.key_id, secret: decrypt(encKey, conn.secret_enc) };
      const bal = (await adapters[conn.exchange].balances(creds)).find((b) => b.asset === symbol.split('-')[0]);
      sellQty = Math.min(qty, bal ? bal.available * 0.999 : 0);
    } catch { sellQty = 0; }
    if (!(sellQty > 0)) return { d, price: m.price, placed: false };
    await placeLive(row, conn, base, 'marketSell', { symbol, qty: sellQty }, sellQty * m.price, m.price, d.reason, sellQty, nowMs, { priceAgeMs: Date.now() - m.t, refPrice: m.closes && m.closes.length ? m.closes[m.closes.length - 1] : null, cfg });
    return { d, price: m.price, placed: true };
  }

  // Disponibilidad de un símbolo en un exchange (Coinbase: lista pública; Robinhood: pares de la conexión, o lista base si no se pudo leer).
  async function availableOn(exchange, symbol, userId, conn) {
    if (exchange === 'coinbase') return (await getUniverse()).coinbase.includes(symbol);
    if (exchange === 'robinhood' && conn) {
      const creds = { keyId: conn.key_id, secret: decrypt(encKey, conn.secret_enc) };
      return (await robinhoodPairs({ store, adapters, userId, creds })).symbols.includes(symbol);
    }
    return false;
  }

  const STRAT_KEYS = ['strategy', 'fast', 'slow', 'rsiBuy', 'rsiSell'];

  // Modo AUTO: el Cerebro elige qué comprar (solo lo que el escáner validó neto de costos en ambos exchanges)
  // y dónde (el exchange más barato si el cliente tiene ambos). Gestiona las ventas de lo que ya tiene.
  async function runAuto(row, cfg, user, primary, nowMs) {
    const userId = row.user_id;
    const sc = await getScanner(store);
    const items = sc ? sc.items : [];
    const byS = new Map(items.map((i) => [i.symbol, i]));
    const active = cfg.autoMode !== 'validated';
    // Modo activo: además de las validadas, las que ganaron neto de costos en ambos exchanges aunque no superaran a comprar y mantener.
    const picks = [...items.filter((i) => i.qualified).slice(0, 6),
      ...(active ? items.filter((i) => !i.qualified && !i.warning && i.coinbase.ret > 0 && i.robinhood.ret > 0).slice(0, 6) : [])];
    const bullish = (it, closes) => {
      const c = it.cfg; const px = closes[closes.length - 1];
      if (c.strategy === 'sma') { const f = sma(closes, c.fast); const s = sma(closes, c.slow); return f !== null && s !== null && f > s && px > s; }
      if (c.strategy === 'macd') { const m = macd(closes); return !!m && m.macd > m.signal && m.hist > 0; }
      if (c.strategy === 'rsi') { const r = rsi(closes, 14); const a = sma(closes, 20); const b = sma(closes, 50); return r !== null && r < c.rsiSell && a !== null && b !== null && a > b; }
      return true;
    };
    const orders = (await store.listOrders(userId, 2000)).filter((o) => o.mode === cfg.mode && o.status === 'ok');
    const bySym = new Map();
    for (const o of orders) { if (!bySym.has(o.symbol)) bySym.set(o.symbol, []); bySym.get(o.symbol).push(o); }
    const held = [];
    for (const [sym, list] of bySym) {
      const p = positionFromOrders(list.map((o) => ({ side: o.side, qty: o.qty, usd: o.usd, ts: o.created_at })));
      if (p.qty > 0) held.push({ sym, lastEx: list.slice().sort((a, b) => a.created_at - b.created_at).filter((o) => o.side === 'buy').pop()?.exchange });
    }
    const conns = cfg.mode === 'live' ? (await store.listConnections(user.id)).filter((c) => c.can_trade && !c.can_transfer) : [];
    const symCfg = (sym) => { const it = byS.get(sym); const c = { ...cfg, symbol: sym }; if (it) for (const k of STRAT_KEYS) c[k] = it.cfg[k]; else c.strategy = 'sma'; return c; };
    let bought = false; const log = [];
    if (cfg.autoMode === 'pro') return runPro({ row, cfg, user, primary, nowMs, items, byS, bySym, held, conns, orders });

    // 1) Cuidar lo que ya tiene (ventas / stop-loss) en el mismo exchange donde compró.
    for (const h of held) {
      let conn = primary; let venue = paperVenue(cfg, byS.get(h.sym), primary);
      if (cfg.mode === 'live') {
        const ex = h.lastEx || primary.exchange;
        const c = conns.find((x) => x.exchange === ex);
        if (!c) { log.push(`${h.sym}: sin conexión de ${ex}`); continue; }
        conn = await store.getConnection(userId, c.id); venue = ex;
      } else if (h.lastEx) venue = h.lastEx;
      const r = await runSymbol(row, symCfg(h.sym), conn, venue, h.sym, nowMs, { note: false });
      log.push(`${h.sym}: ${r.d.action === 'hold' ? 'mantiene' : r.d.action === 'sell' ? 'vende' : r.d.action}`);
    }
    // 2) Buscar entradas nuevas entre las validadas.
    const maxPos = cfg.maxPositions || 3;
    if (held.length < maxPos) {
      for (const it of picks) {
        if (held.some((h) => h.sym === it.symbol)) continue;
        const mine = bySym.get(it.symbol) || [];
        const lastSell = mine.filter((o) => o.side === 'sell').reduce((x, o) => Math.max(x, o.created_at), 0);
        if (lastSell && nowMs - lastSell < 6 * 3600000) { log.push(`${it.symbol}: enfriamiento tras vender`); continue; }
        let entryCfg = symCfg(it.symbol); let why = null;
        if (active) {
          const mk = await market(it.symbol);
          if (!bullish(it, mk.closes)) { log.push(`${it.symbol}: tendencia aún no alcista`); continue; }
          entryCfg = { ...entryCfg, strategy: 'dca', intervalMin: 360 };
          why = `Tendencia alcista (${it.label}) en una cripto que ganó la prueba neta de costos; compra automática`;
        }
        let conn = primary; let venue = paperVenue(cfg, it, primary);
        if (cfg.mode === 'live') {
          // Ruteo por brecha de costo: el exchange más barato si el cliente lo tiene conectado y el par existe ahí.
          const order = cfg.paperExchange === 'best' && it.cheaper !== 'igual' ? [it.cheaper, it.cheaper === 'coinbase' ? 'robinhood' : 'coinbase'] : [primary.exchange];
          let chosen = null;
          for (const ex of order) {
            const c = conns.find((x) => x.exchange === ex); if (!c) continue;
            const full = await store.getConnection(userId, c.id);
            if (await availableOn(ex, it.symbol, userId, full).catch(() => false)) { chosen = full; break; }
          }
          if (!chosen) { log.push(`${it.symbol}: no disponible en tus exchanges`); continue; }
          conn = chosen; venue = chosen.exchange;
        }
        const r = await runSymbol(row, entryCfg, conn, venue, it.symbol, nowMs, { note: false, slots: Math.max(1, maxPos - held.length), reason: why });
        if (r.d.action === 'buy' && r.placed) { bought = true; log.push(`${it.symbol}: compra en ${venue}`); break; }
        log.push(`${it.symbol}: ${r.d.reason || 'espera'}`);
      }
    }
    // Sin ninguna cripto con ventaja demostrada: acumulación gradual (compra pequeña periódica de la más grande, sin vender por señal).
    // Es la forma barata de estar activo: se paga el costo una vez por compra, no por entrar y salir. Se puede quitar con autoMode 'validated'.
    let accum = false;
    if (active && !bought && !items.some((i) => i.qualified)) {
      // Cualquier cripto disponible en tu exchange (entre las grandes que el escáner conoce), diversificando:
      // se prefieren las que ya están en tendencia alcista (SMA20 > SMA50), no sobrecompradas (RSI < 65) y con menos dinero puesto.
      const FALL = ['BTC', 'ETH', 'SOL', 'XRP', 'ADA', 'DOGE', 'AVAX', 'LINK', 'DOT', 'LTC'].map((x) => `${x}-USD`);
      const pool = (items.length ? [...items].sort((x, y) => (y.mcap || 0) - (x.mcap || 0)).map((i) => i.symbol) : FALL).slice(0, 12);
      const heldSet = new Set(held.map((h) => h.sym));
      const cands = [];
      for (const sym of pool) {
        if (!heldSet.has(sym) && held.length >= maxPos) continue;
        const buys = (bySym.get(sym) || []).filter((o) => o.side === 'buy');
        const lastBuy = buys.reduce((x, o) => Math.max(x, o.created_at), 0);
        if (lastBuy && nowMs - lastBuy < Math.max(240, cfg.intervalMin || 60) * 60000) continue;
        try {
          const mk = await market(sym); const r14 = rsi(mk.closes, 14); const a20 = sma(mk.closes, 20); const a50 = sma(mk.closes, 50);
          if (r14 !== null && r14 >= 65) { log.push(`${sym}: RSI ${r14.toFixed(0)} alto`); continue; }
          const invested = (bySym.get(sym) || []).reduce((x, o) => x + (o.side === 'buy' ? o.usd : -o.usd), 0);
          cands.push({ sym, r14, up: a20 !== null && a50 !== null && a20 > a50, invested });
        } catch { /* sin datos de esa cripto */ }
      }
      cands.sort((x, y) => (y.up - x.up) || (x.invested - y.invested));
      for (const c of cands) {
        let conn = primary; let venue = paperVenue(cfg, byS.get(c.sym), primary);
        if (cfg.mode === 'live') {
          const it = byS.get(c.sym);
          const order = cfg.paperExchange === 'best' ? (it && it.cheaper === 'robinhood' ? ['robinhood', 'coinbase'] : ['coinbase', 'robinhood']) : [primary.exchange];
          let chosen = null;
          for (const ex of order) { const cn = conns.find((x) => x.exchange === ex); if (!cn) continue; const full = await store.getConnection(userId, cn.id); if (await availableOn(ex, c.sym, userId, full).catch(() => false)) { chosen = full; break; } }
          if (!chosen) { log.push(`${c.sym}: no disponible en tus exchanges`); continue; }
          conn = chosen; venue = chosen.exchange;
        }
        const r = await runSymbol(row, { ...cfg, symbol: c.sym, strategy: 'dca', intervalMin: 15 }, conn, venue, c.sym, nowMs, { note: false, slots: Math.max(1, maxPos - held.length),
          reason: `Sin cripto con ventaja demostrada: acumulación gradual de ${c.sym.split('-')[0]} (${c.up ? 'tendencia alcista' : 'sin tendencia bajista fuerte'}, RSI ${c.r14 === null ? '—' : c.r14.toFixed(0)}); compra pequeña, sin vender por señal` });
        if (r.d.action === 'buy' && r.placed) { bought = true; accum = c.sym; log.push(`${c.sym}: acumulación en ${venue}`); break; }
        if (r.d.action === 'hold' && /insuficiente/.test(r.d.reason || '')) break;
      }
    }
    const summary = !sc ? 'El Cerebro aún no corrió el escáner; en unos minutos tendrá la lista'
      : accum ? `Cerebro: ninguna cripto tiene ventaja demostrada, así que acumuló ${String(accum).split('-')[0]} con una compra pequeña (sin vender por señal)`
      : !picks.length ? `Cerebro: ninguna de ${sc.scanned} criptos ganó la prueba (neto de costos), por eso no compra${held.length ? `; cuida ${held.length} posición(es)` : ''}. Revisa de nuevo en la próxima corrida del escáner`
      : `Cerebro vigila ${picks.length} cripto(s) con ventaja (${picks.slice(0, 4).map((p) => p.symbol.split('-')[0]).join(', ')}) y cuida ${held.length} posición(es)${bought ? '. Compró ahora.' : '. Sin señal nueva.'}`;
    await noteDecision(userId, { t: nowMs, action: bought ? 'buy' : 'hold', reason: summary, price: null, auto: log.slice(0, 8) });
  }

  // Modo PRO (day trader): varias operaciones cuando conviene, solo si el movimiento esperado supera con holgura el costo real,
  // salidas con stop dinámico, más cautela tras malas rachas y freno por noticias negativas.
  // Máquina del Tiempo como freno de riesgo: simula 7 días hacia adelante con la volatilidad real. Si la chance de una caída fuerte es alta,
  // reduce el tamaño de la compra a la mitad o no compra. Solo REDUCE riesgo; si no hay datos, no cambia nada.
  const futureCache = new Map();
  async function futureRisk(sym, nowMs) {
    const c = futureCache.get(sym); if (c && nowMs - c.t < 6 * 3600000) return c.v;
    let v = null;
    try { const cl = await feed.getHistory(sym, 120, 86400); const p = project(cl, { horizon: 7, paths: 1000, key: sym }); if (p) v = { drop10: p.prob_drop10, up: p.prob_up }; } catch { v = null; }
    futureCache.set(sym, { t: nowMs, v }); if (futureCache.size > 80) futureCache.delete(futureCache.keys().next().value); return v;
  }
  // Velas de 15 min y 1 h (con volumen) para la ventaja multi-timeframe; cache de 5 min. Sin getCandles en el feed (o sin red) devuelve null y nada cambia.
  const tfCache = new Map();
  async function timeframes(sym, nowMs) {
    if (!feed.getCandles) return null;
    const c = tfCache.get(sym); if (c && nowMs - c.t < 300000) return c.v;
    let v = null;
    try { const [m15, h1] = await Promise.all([feed.getCandles(sym, 900), feed.getCandles(sym, 3600)]); v = { m15, h1 }; } catch { v = null; }
    tfCache.set(sym, { t: nowMs, v }); if (tfCache.size > 60) tfCache.delete(tfCache.keys().next().value); return v;
  }
  // Bitácora de decisiones (ventaja, filtro, tamaño) por cliente: las últimas 80, para analizar dónde se gana o se pierde dinero.
  async function pushDecision(userId, e) {
    try { let a = []; try { a = JSON.parse(await store.getSetting(`edge:log:${userId}`, '[]')); } catch { a = []; } a.unshift(e); await store.setSetting(`edge:log:${userId}`, JSON.stringify(a.slice(0, 80))); } catch { /* informativo */ }
  }
  // Conjunto de datos global del filtro de ventaja (anónimo: sin usuarios): cada evaluación guarda el precio y, pasadas 6 h y 24 h, lo que pasó
  // después. Permite medir con datos reales si las señales que pasan el filtro rinden más que las vetadas (y alimentar un meta-etiquetador).
  async function pushEdgeData(e) {
    try {
      let a = []; try { a = JSON.parse(await store.getSetting('edge:ds', '[]')); } catch { a = []; }
      if (a.some((x) => x.sym === e.sym && e.t - x.t < 3 * 3600000)) return; // una por cripto cada 3 h
      a.unshift(e); await store.setSetting('edge:ds', JSON.stringify(a.slice(0, 800)));
    } catch { /* informativo */ }
  }
  async function resolveEdgeOutcomes(nowMs = Date.now()) {
    let a = []; try { a = JSON.parse(await store.getSetting('edge:ds', '[]')); } catch { return { updated: 0 }; }
    let updated = 0; const px = new Map();
    for (const e of a) {
      const need6 = e.r6 === undefined && nowMs - e.t >= 6 * 3600000; const need24 = e.r24 === undefined && nowMs - e.t >= 24 * 3600000;
      if (!need6 && !need24) continue;
      if (!px.has(e.sym)) { try { px.set(e.sym, (await market(e.sym)).price); } catch { px.set(e.sym, null); } }
      const now = px.get(e.sym); if (!(now > 0)) continue;
      const r = Math.round(((now / e.px - 1) * 100) * 1000) / 1000;
      // Se asigna el retorno al horizonte vencido más largo; si el resolutor tardó, no se rellena un horizonte con datos de otro.
      if (need24 && nowMs - e.t < 30 * 3600000) { e.r24 = r; updated++; }
      if (need6 && nowMs - e.t < 12 * 3600000) { e.r6 = r; updated++; }
      else if (need6) { e.r6 = null; updated++; }
      if (need24 && nowMs - e.t >= 30 * 3600000) { e.r24 = null; updated++; }
    }
    if (updated) await store.setSetting('edge:ds', JSON.stringify(a));
    return { updated };
  }
  const hourlyRets = (cl) => { const r = []; const s0 = Math.max(1, cl.length - 96); for (let i = s0; i < cl.length; i++) r.push(cl[i] / cl[i - 1] - 1); return r; };

  // Aviso de lo que el BOT hizo solo (compró / vendió), para que el cliente se entere aunque no tenga la app abierta.
  const botDid = (uid, cfg, side, sym, usd, reason) => warn(uid, { kind: `bot:${side}:${sym}`, title: `🤖 ${side === 'buy' ? 'Compré' : 'Vendí'} ${sym.split('-')[0]}${cfg.mode === 'live' ? '' : ' (simulado)'}`,
    body: `${side === 'buy' && usd ? `~$${Number(usd).toFixed(2)}. ` : ''}${String(reason || '').replace(/^Pro( rota)?:\s*/i, '').slice(0, 110)}` });
  async function runPro({ row, cfg, primary, nowMs, items, byS, bySym, held, conns, orders }) {
    const userId = row.user_id; const log = []; let trades = 0;
    const perf = perfSummary(orders);
    let regime = null; try { regime = JSON.parse(await store.getSetting('market:snapshot', 'null'))?.regime?.code || null; } catch { regime = null; }
    let news = null; try { news = JSON.parse(await store.getSetting('news:latest', 'null')); } catch { news = null; }
    const maxPos = cfg.maxPositions || 3;
    const soldNow = new Set(); const soldWhy = new Map(); const buyWhy = new Map(); const keep = [];
    const slipLog = await loadSlipLog(store).catch(() => []);
    const newSet = await newListings(store, nowMs).catch(() => new Map());
    const closedAll = closedTrades(orders); const closedPcts = closedAll.map((x) => x.pct);
    // 1) Salidas
    for (const h of held) {
      try {
        const list = bySym.get(h.sym) || [];
        const pos = positionFromOrders(list.map((o) => ({ side: o.side, qty: o.qty, usd: o.usd, ts: o.created_at })));
        const mk = await market(h.sym); const f = features(mk.closes); if (!f || !(pos.qty > 0)) continue;
        const heldHours = Math.max(0, (nowMs - pos.lastBuyAt) / 3600000);
        const highSince = Math.max(mk.price, ...mk.closes.slice(-Math.max(2, Math.ceil(heldHours) + 1)));
        const ex0 = h.lastEx || (cfg.mode === 'live' ? primary.exchange : paperVenue(cfg, byS.get(h.sym), primary));
        const rt = roundTripPct({ symbol: h.sym, exchange: ex0, usd: pos.qty * mk.price, price: mk.price });
        const ex = exitSignal({ ...f, px: mk.price }, { avgCost: pos.avgCost, heldHours, highSince, rtPct: rt, stopLossPct: cfg.stopLossPct, takeProfitPct: cfg.takeProfitPct });
        log.push(`${h.sym}: ${ex.reason}`);
        if (!ex.sell) { keep.push({ h, f, mk, pos, heldHours, ex0, rt }); continue; }
        let conn = primary; let venue = ex0;
        if (cfg.mode === 'live') { const c = conns.find((x) => x.exchange === ex0); if (!c) continue; conn = await store.getConnection(userId, c.id); }
        const r = await runSymbol(row, { ...cfg, symbol: h.sym }, conn, venue, h.sym, nowMs, { note: false, force: { action: 'sell', reason: `Pro: ${ex.reason}` } });
        if (r.placed) { trades++; soldNow.add(h.sym); soldWhy.set(h.sym, ex.reason); await botDid(userId, cfg, 'sell', h.sym, null, ex.reason); }
      } catch (e) { log.push(`${h.sym}: ${e.message}`); }
    }
    const heldNow = held.length - soldNow.size;
    const octo = []; const boughtNow = new Set(); const foundAll = []; let rotated = null;
    // 2) Entradas
    let summary;
    if (perf.risk === 'pausa') summary = `Pro en PAUSA: las últimas operaciones cerradas salieron mal (${perf.last.length}). Reanuda en ${Math.max(1, Math.round((perf.pause_until - nowMs) / 3600000))} h`;
    else if (pnl24h(orders, nowMs) <= -0.1 * (cfg.maxDailyUsd || 100)) summary = `Pro: límite de pérdida diaria alcanzado (${pnl24h(orders, nowMs).toFixed(2)} USD en 24 h, tope ${(0.1 * (cfg.maxDailyUsd || 100)).toFixed(2)}). No abre posiciones nuevas hasta recuperar o pasar 24 h`;
    else if (news && news.risk_off) summary = 'Pro: noticias negativas en el mercado (freno de riesgo), no abre posiciones nuevas';
    else {
      const FALL = ['BTC', 'ETH', 'SOL', 'XRP', 'ADA', 'DOGE', 'AVAX', 'LINK', 'DOT', 'LTC'].map((x) => `${x}-USD`);
      const pool = (items.length ? [...items].sort((a, b) => (b.mcap || 0) - (a.mcap || 0)).map((i) => i.symbol) : FALL).slice(0, 25);
      const heldSet = new Set(held.map((h) => h.sym));
      const losers = losingSymbols(orders, nowMs);
      const found = []; const why = [];
      for (const sym of pool) {
        if (heldSet.has(sym)) continue;
        if (soldNow.has(sym)) continue;
        const base = sym.split('-')[0];
        if (losers.has(sym)) { why.push(`${base}: descansa (últimas ${losers.get(sym).trades} operaciones perdedoras)`); continue; }
        if (news && news.risk && news.risk[base] >= 1) { why.push(`${base}: noticia negativa`); continue; }
        const lastSell = (bySym.get(sym) || []).filter((o) => o.side === 'sell').reduce((x, o) => Math.max(x, o.created_at), 0);
        if (lastSell && nowMs - lastSell < 1800000) continue;
        try {
          const mk = await market(sym); const f = features(mk.closes); if (!f) continue;
          const exs = cfg.mode === 'live' ? (cfg.paperExchange === 'best' ? ['coinbase', 'robinhood'] : [primary.exchange]) : (cfg.paperExchange === 'best' ? ['coinbase', 'robinhood'] : [cfg.paperExchange]);
          let best = null;
          for (const ex of exs) {
            let conn = null;
            if (cfg.mode === 'live') { const c = conns.find((x) => x.exchange === ex); if (!c) continue; conn = await store.getConnection(userId, c.id); if (!(await availableOn(ex, sym, userId, conn).catch(() => false))) continue; }
            const rt = roundTripPct({ symbol: sym, exchange: ex, usd: cfg.usd, price: mk.price });
            if (!best || rt < best.rt) best = { ex, conn, rt };
          }
          if (!best) { why.push(`${base}: no disponible`); continue; }
          const sg = entrySignal(f, { rtPct: best.rt, regime, risk: perf.risk });
          if (sg.ok && cfg.edgeGate !== 'off') {
            // Ventaja multi-timeframe + filtro «¿operar hoy?». En 'shadow' solo registra qué habría vetado; en 'on' veta.
            const tf = await timeframes(sym, nowMs);
            if (!tf && newSet.has(sym)) { why.push(`${base}: listada hace ${newSet.get(sym)} días y sin datos de liquidez; no compro`); continue; }
            if (tf) {
              const slip = slipSummary(slipLog, { exchange: best.ex, now: nowMs });
              const eg = evaluateEdge(tf, { rtPct: best.rt, slipExtraPct: slip.extraPct, regime });
              const vol24 = tf.h1.length >= 24 ? tf.h1.slice(-24).reduce((a, x) => a + x.v * x.c, 0) : null;
              const fl = tradeFilter({ base, news, hourlyCloses: mk.closes, volume24Usd: vol24, recentPct: closedPcts });
              const veto = !eg.insufficient && (!eg.tradeable || !fl.go);
              await pushDecision(userId, { t: nowMs, sym, gate: cfg.edgeGate, edge_score: eg.edge_score, tradeable: eg.tradeable, go: fl.go, would_veto: veto, vetoed: veto && cfg.edgeGate === 'on', ev_gross_pct: eg.ev_gross_pct, cost_pct: eg.cost_pct, reasons: [...eg.reasons, ...fl.reasons].slice(0, 4), legacy_edge: Number(sg.edge.toFixed(2)) });
              await pushEdgeData({ t: nowMs, sym, score: eg.edge_score, tradeable: eg.tradeable, go: fl.go, would_veto: veto, px: mk.price, rt: Number(best.rt.toFixed(3)), insufficient: !!eg.insufficient });
              if (veto && cfg.edgeGate === 'on') { why.push(`${base}: ${(eg.reasons[0] || fl.reasons[0] || 'sin ventaja suficiente')}`); continue; }
              sg.ev = [...(sg.ev || []), `Ventaja (edge_score ${eg.edge_score}, ${eg.tradeable ? 'cumple' : 'no cumple'}${cfg.edgeGate === 'shadow' && veto ? ' · en modo sombra, no veta' : ''}): esperado ${eg.ev_gross_pct} % vs costo ${eg.cost_pct} %`];
              sg.edgeScore = eg.edge_score;
            }
          }
          if (sg.ok) {
            const fu = await futureRisk(sym, nowMs); const pd = fu ? Math.round(fu.drop10 * 100) : null;
            if (fu && futureGate(fu.drop10).skip) { why.push(`${base}: la Máquina del Tiempo ve ${pd} % de chance de una caída de 10 % en 7 días; no compro`); continue; }
            if (fu) { if (futureGate(fu.drop10).mult < 1) { sg.size *= futureGate(fu.drop10).mult; sg.ev = [...(sg.ev || []), `Máquina del Tiempo (7 d): ${pd} % de chance de caída ≥ 10 %; compro la mitad`]; } else sg.ev = [...(sg.ev || []), `Máquina del Tiempo (7 d): ${Math.round(fu.up * 100)} % de chance de subir, ${pd} % de caída ≥ 10 %`]; sg.fu = fu; }
            found.push({ sym, sg, best, mk });
          } else why.push(`${base}: ${sg.reason}`);
        } catch { /* sin datos de esa cripto */ }
      }
      // Tamaño dinámico: solo REDUCE o veta (nunca sube el monto). Requiere que el cliente declare su capital de riesgo.
      const emergencyNow = await getEmergency(store);
      const sizeFor = async (c, wantUsd) => {
        if (!cfg.dynamicSizing || !(cfg.riskCapitalUsd > 0)) return { ok: true, usd: wantUsd, note: null };
        const { curve, pcts } = curveFromClosed(closedAll, cfg.riskCapitalUsd);
        const exposure = keep.reduce((a, k) => a + k.pos.qty * k.mk.price, 0);
        const d = sizeDecision({ configuredUsd: wantUsd, equityUsd: cfg.riskCapitalUsd, openExposureUsd: exposure, candidateRets: hourlyRets(c.mk.closes),
          heldRets: keep.map((k) => ({ sym: k.h.sym, rets: hourlyRets(k.mk.closes) })), closedPnlPcts: pcts, equityCurve: curve, pnl24hUsd: pnl24h(orders, nowMs),
          regime, edgeScore: c.sg.edgeScore ?? null, killSwitch: emergencyNow.on });
        await pushDecision(userId, { t: nowMs, sym: c.sym, kind: 'size', approved: d.approved, usd: Number(d.usd.toFixed(2)), wanted: Number(wantUsd.toFixed(2)), reason: d.reason, steps: d.log.steps.map((x) => x.text).slice(-6) });
        if (!d.approved) await store.addAudit({ user_id: userId, actor: 'risk', action: 'sizing_veto', detail: `${c.sym}: ${d.reason}`.slice(0, 300) });
        return d.approved ? { ok: true, usd: Math.min(wantUsd, d.usd), note: d.usd < wantUsd ? `tamaño reducido a $${d.usd.toFixed(2)} (riesgo dinámico)` : null } : { ok: false, reason: d.reason };
      };
      found.sort((a, b) => b.sg.score - a.sg.score); foundAll.push(...found);
      for (const c of found.slice(0, Math.max(0, Math.min(3, maxPos - heldNow)))) {
        let bUsd = Math.max(1, cfg.usd * c.sg.size * confidenceSize(c.sg.edge) * (newSet.has(c.sym) ? 0.5 : 1));
        if (newSet.has(c.sym)) c.sg.reason += ` · listada hace ${newSet.get(c.sym)} días: monto a la mitad`;
        const sz = await sizeFor(c, bUsd);
        if (!sz.ok) { log.push(`${c.sym}: ${sz.reason}`); continue; }
        bUsd = sz.usd; if (sz.note) c.sg.reason += ` · ${sz.note}`;
        const r = await runSymbol(row, { ...cfg, symbol: c.sym }, c.best.conn, c.best.ex, c.sym, nowMs, { note: false, slots: Math.max(1, maxPos - heldNow),
          force: { action: 'buy', usd: bUsd, reason: `Pro: ${c.sg.reason}; ejecuta en ${c.best.ex} (el más barato)` } });
        if (r.placed) { await botDid(userId, cfg, 'buy', c.sym, bUsd, c.sg.reason); trades++; boughtNow.add(c.sym); buyWhy.set(c.sym, explainBuy({ base: c.sym.split('-')[0], sg: c.sg, usd: bUsd, baseUsd: cfg.usd, regime, risk: perf.risk, news })); log.push(`${c.sym}: compra en ${c.best.ex}`); }
      }
      // 3) Rotación: con los cupos llenos, cambia la posición que pierde fuerza por una señal claramente mejor (con costo ya descontado en el filtro de entrada).
      if (heldNow >= maxPos && found.length && !soldNow.size) {
        const cand = found.find((c) => c.sg.edge >= 1.3);
        const weak = keep.filter((k) => k.heldHours >= 1 && (k.f.roc6 <= 0 || k.mk.price < k.f.s10)
          && !entrySignal({ ...k.f, px: k.mk.price }, { rtPct: k.rt, regime, risk: perf.risk }).ok).sort((a, b) => a.f.roc6 - b.f.roc6)[0];
        const rotSz = cand && weak ? await sizeFor(cand, Math.max(1, cfg.usd * cand.sg.size * confidenceSize(cand.sg.edge))) : null;
        if (rotSz && !rotSz.ok) log.push(`rotación: ${rotSz.reason}`);
        if (cand && weak && rotSz && rotSz.ok) {
          const gain = (weak.mk.price / weak.pos.avgCost - 1) * 100;
          try {
            let wconn = primary; const wex = weak.ex0;
            if (cfg.mode === 'live') { const c = conns.find((x) => x.exchange === wex); wconn = c ? await store.getConnection(userId, c.id) : null; }
            if (cfg.mode !== 'live' || wconn) {
              const why = `Pro rota: ${weak.h.sym.split('-')[0]} pierde fuerza (${gain >= 0 ? '+' : ''}${gain.toFixed(2)} %) y ${cand.sym.split('-')[0]} tiene mejor señal (${cand.sg.edge.toFixed(1)}× el costo)`;
              const rs = await runSymbol(row, { ...cfg, symbol: weak.h.sym }, wconn, wex, weak.h.sym, nowMs, { note: false, force: { action: 'sell', reason: why } });
              if (rs.placed) {
                trades++; log.push(why); rotated = { out: weak.h.sym, in: cand.sym }; await botDid(userId, cfg, 'sell', weak.h.sym, null, why);
                const rUsd = rotSz.usd;
                const rb = await runSymbol(row, { ...cfg, symbol: cand.sym }, cand.best.conn, cand.best.ex, cand.sym, nowMs, { note: false, slots: 1,
                  force: { action: 'buy', usd: rUsd, reason: `${why}; ejecuta en ${cand.best.ex}` } });
                if (rb.placed) { await botDid(userId, cfg, 'buy', cand.sym, rUsd, why); trades++; boughtNow.add(cand.sym); buyWhy.set(cand.sym, explainBuy({ base: cand.sym.split('-')[0], sg: cand.sg, usd: rUsd, baseUsd: cfg.usd, regime, risk: perf.risk, news })); }
                soldWhy.set(weak.h.sym, `${gain >= 0 ? 'gana' : 'pierde'} ${Math.abs(gain).toFixed(2)} % y pierde fuerza; ${cand.sym.split('-')[0]} tiene mejor señal (${cand.sg.edge.toFixed(1)} veces el costo)`);
              }
            }
          } catch (e) { log.push(`rotación: ${e.message}`); }
        }
      }
      summary = trades ? `Pro: ${trades} operación(es) ahora${perf.risk === 'defensivo' ? ' (modo defensivo: tamaño reducido)' : ''}`
        : `Pro vigila ${pool.length} criptos: ${found.length ? 'hay señales pero sin saldo/cupo' : 'ninguna cumple todas las reglas ahora'}${held.length ? ` · cuida ${held.length} posición(es)` : ''}. ${why.slice(0, 2).join('; ')}`;
    }
    // Pulpo: foto de cada tentáculo (qué tiene, qué suelta, qué estira) para mostrarla en pantalla. Solo datos del propio usuario.
    try {
      const thoughts = []; const B = (x) => x.split('-')[0];
      for (const k of keep) {
        const sg = entrySignal({ ...k.f, px: k.mk.price }, { rtPct: k.rt, regime, risk: perf.risk });
        const out = rotated && rotated.out === k.h.sym; const gp = (k.mk.price / k.pos.avgCost - 1) * 100;
        const state = out ? 'suelta' : sg.ok ? 'fuerte' : (k.f.roc6 <= 0 || k.mk.price < k.f.s10) ? 'débil' : 'mantiene';
        const why = state === 'fuerte' ? `Sigo con ${B(k.h.sym)}: la tendencia sigue alcista (${gp >= 0 ? '+' : ''}${gp.toFixed(2)} %).`
          : state === 'débil' ? `${B(k.h.sym)} pierde fuerza (${gp >= 0 ? '+' : ''}${gp.toFixed(2)} %); lo vigilo para soltarlo si aparece algo mejor.`
            : `Mantengo ${B(k.h.sym)} (${gp >= 0 ? '+' : ''}${gp.toFixed(2)} %), el stop lo protege.`;
        octo.push({ symbol: k.h.sym, held: true, score: sg.ok ? sg.score : 0, gain_pct: gp, state, why, conf: sg.ok ? sg.conf : undefined, ev: sg.ok ? sg.ev : undefined });
      }
      for (const h of held) if (soldNow.has(h.sym) && !(rotated && rotated.out === h.sym)) octo.push({ symbol: h.sym, held: false, score: 0, state: 'vendió', why: explainSell(B(h.sym), soldWhy.get(h.sym) || '') });
      if (rotated) octo.push({ symbol: rotated.out, held: false, score: 0, state: 'soltó', why: explainSell(B(rotated.out), soldWhy.get(rotated.out) || 'cambio por una señal mejor') });
      for (const c of foundAll.slice(0, 6)) {
        const bw = buyWhy.get(c.sym);
        octo.push({ symbol: c.sym, held: false, score: c.sg.score, edge: c.sg.edge, conf: c.sg.conf, ev: c.sg.ev, state: boughtNow.has(c.sym) ? 'compró' : 'listo', big: bw ? bw.big : false,
          why: bw ? bw.text : `${B(c.sym)} cumple las reglas (${c.sg.edge.toFixed(1)} veces el costo) pero ${heldNow >= maxPos ? 'no hay cupo libre' : 'no hay saldo suficiente'}; ${newsNote(news, B(c.sym))}.` });
      }
      for (const it of octo) if (['compró', 'vendió', 'soltó'].includes(it.state)) thoughts.push({ k: it.state === 'compró' ? 'buy' : 'sell', big: !!it.big, text: it.why });
      if (rotated) thoughts.unshift({ k: 'sell', text: `Rotación: suelto ${B(rotated.out)} y paso a ${B(rotated.in)} porque la señal es claramente mejor, ya descontando el costo.` });
      if (news && news.risk_off) thoughts.push({ k: 'risk', text: 'Freno de riesgo: hay noticias negativas en el mercado, no abro posiciones nuevas.' });
      else if (perf.risk === 'pausa') thoughts.push({ k: 'risk', text: 'Estoy en pausa: las últimas operaciones salieron mal, espero antes de volver a comprar.' });
      if (!thoughts.length) thoughts.push({ k: 'hold', text: summary.replace(/^Pro( vigila)?:?\s*/i, 'Vigilo ').replace(/\s+/g, ' ') });
      const rgEs = regimeEs(regime);
      await store.setSetting(`octo:${userId}`, JSON.stringify({ t: nowMs, regime, risk: perf.risk, items: octo, thoughts: thoughts.slice(0, 6),
        news: news && news.items ? { risk_off: !!news.risk_off, negatives: news.items.filter((i) => i.neg).length, note: rgEs ? `mercado ${rgEs}` : '' } : null }));
    } catch { /* informativo */ }
    await noteDecision(userId, { t: nowMs, action: trades ? 'buy' : 'hold', reason: summary, price: null, auto: log.slice(0, 8) });
  }

  const paperVenue = (cfg, item, conn) => {
    if (conn) return conn.exchange;
    if (cfg.paperExchange === 'best') return item && item.cheaper && item.cheaper !== 'igual' ? item.cheaper : 'coinbase';
    return cfg.paperExchange || 'coinbase';
  };

  async function runBot(row, nowMs) {
    row = { ...row };
    const { user_id: userId } = row;
    const cfg = { ...DEFAULT_CFG, ...row.cfg };
    if (!cfg.enabled) return;
    if (nowMs - (row.last_run || 0) < 14000) return;
    if (row.state === 'PAUSED') return; // en pausa: no decide ni opera (el cliente la reanuda)
    if (cfg.mode === 'live') { const em = await getEmergency(store);
      if (!em.on && row.state === 'EMERGENCY_STOP') { await store.setBotState(row.user_id, 'RUNNING', 'emergencia levantada'); row = { ...row, state: 'RUNNING' }; }
      if (em.on && ['RUNNING', 'PAUSED'].includes(row.state)) await store.setBotState(row.user_id, 'EMERGENCY_STOP', `parada de emergencia${em.reason ? `: ${em.reason}` : ''}`);
      if (em.on) { await noteDecision(row.user_id, { t: nowMs, action: 'hold', reason: `Parada de emergencia activa${em.reason ? `: ${em.reason}` : ''}. El bot real no opera.`, price: null }); return; } }

    const user = await store.getUserById(userId);
    if (!user || user.status !== 'active') return disable(userId, 'Cuenta no activa');

    let conn = null;
    if (cfg.mode === 'live') {
      const sc = await store.getSetting('live_trading', 'off');
      if (!(sc === 'on' || (sc === 'owner' && user.role === 'owner'))) return disable(userId, 'Trading real deshabilitado por el administrador');
      const ent = await entitlement(store, user); if (ent.enforced && !ent.live) return disable(userId, ent.reason);
      if (!cfg.liveAck) return disable(userId, 'Falta la confirmación de riesgo');
      conn = cfg.connectionId ? await store.getConnection(userId, cfg.connectionId) : null;
      if (!conn || !conn.can_trade || conn.can_transfer) return disable(userId, 'Conexión inválida para trading real');
    }

    await store.patchBot(userId, { last_run: nowMs });
    try {
      if (cfg.symbol === 'AUTO') return await runAuto(row, cfg, user, conn, nowMs);
      return await runSymbol(row, cfg, conn, paperVenue(cfg, null, conn), cfg.symbol, nowMs);
    } catch (e) {
      // El cliente siempre ve qué pasó, aunque falle una fuente de datos.
      await noteDecision(userId, { t: nowMs, action: 'hold', reason: `No pude leer el mercado ahora (${String(e.message).slice(0, 80)}). Reintento en 1 minuto.`, price: null });
      throw e;
    }
  }

  async function placeLive(row, conn, base, fn, args, usd, price, reason, qtyOverride, nowMs = Date.now(), meta = {}) {
    const userId = row.user_id;
    const qty = qtyOverride ?? usd / price;
    // 0) Puerta de riesgo central: si algo falla o falta, se bloquea y NO se llama al broker.
    const platform = await loadPlatform(store); const emergency = await getEmergency(store);
    // Plan: con la facturación activada, sin plan vigente no sale ninguna orden real y los topes del plan se suman a los de plataforma y cliente (gana el menor).
    let cfgEff = meta.cfg; let planBlock = null;
    if (meta.cfg && !meta.reduceOnly) { const ent = await entitlement(store, await store.getUserById(userId)); if (ent.enforced) { if (!ent.live) planBlock = ent.reason; else cfgEff = { ...meta.cfg, maxOrderUsd: Math.min(Number(meta.cfg.maxOrderUsd), ent.caps.maxOrderUsd), maxDailyUsd: Math.min(Number(meta.cfg.maxDailyUsd), ent.caps.maxDailyUsd) }; } }
    const pre = planBlock ? { ok: false, code: 'plan', reason: planBlock } : preCheck({ reduceOnly: !!meta.reduceOnly, cfg: cfgEff, platform, emergency, order: { price, usd, side: base.side }, ageMs: meta.priceAgeMs, refPrice: meta.refPrice });
    const logRisk = (action, detail) => store.addAudit({ user_id: userId, actor: 'risk', action, detail: String(detail).slice(0, 300) });
    if (!pre.ok) { await logRisk('risk_block', `${pre.code}: ${pre.reason} · ${base.side} ${base.symbol} $${Number(usd).toFixed(2)}`); await noteDecision(userId, { t: nowMs, action: 'hold', reason: `Riesgo: ${pre.reason}`, price }); return { placed: false, reason: pre.reason }; }
    // 1) La intención se guarda ANTES de hablar con el broker, con un ID estable. Si ya existe, no se vuelve a enviar.
    const coid = clientOrderId({ userId, mode: base.mode, exchange: base.exchange, symbol: base.symbol, side: base.side, t: nowMs });
    const rsv = await store.reserveOrder({ ...base, usd, qty, price, client_order_id: coid, note: `${reason} (precio y cantidad estimados; sin confirmar)` },
      { maxDaily: pre.limits.maxDaily, maxOpen: pre.limits.maxOpen, maxPerHour: pre.limits.maxPerHour, maxRejects: pre.limits.maxRejects, now: Date.now(), reduceOnly: !!meta.reduceOnly });
    if (rsv.blocked) { await logRisk('risk_block', `${rsv.blocked}: ${rsv.reason} · ${base.side} ${base.symbol} $${Number(usd).toFixed(2)}`); await noteDecision(userId, { t: nowMs, action: 'hold', reason: `Riesgo: ${rsv.reason}`, price }); return { placed: false, reason: rsv.reason }; }
    await logRisk('risk_allow', `${base.side} ${base.symbol} $${Number(usd).toFixed(2)} dentro de límites`);
    if (!rsv.created) {
      await store.addAudit({ user_id: userId, actor: 'engine', action: 'order_duplicate_blocked', detail: `${base.side} ${base.symbol} ya registrada (${rsv.order.lifecycle}); no se reenvía` });
      return { placed: false, duplicate: true, reason: 'Ya hay una orden igual enviada hace menos de un minuto; no se repite.' };
    }
    const oid = rsv.order.id;
    let res;
    try {
      const creds = { keyId: conn.key_id, secret: decrypt(encKey, conn.secret_enc) };
      res = await adapters[conn.exchange][fn](creds, { ...args, clientOrderId: coid });
    } catch (e) {
      res = { ok: false, error: e.message, ambiguous: true };
    }
    if (res.ok) {
      // «submitted» = el broker la aceptó. No es una ejecución: la cantidad real y la comisión llegan al reconciliar.
      await store.transitionOrder(userId, oid, 'submitted', { ext_id: res.id || null }, 'aceptada por el broker');
      await store.patchBot(userId, { errors: 0 });
      await store.addAudit({ user_id: userId, actor: 'engine', action: 'order_live', detail: `${base.side} ${base.symbol} ~$${usd.toFixed(2)} (enviada, pendiente de confirmar)` });
    } else {
      const amb = res.ambiguous || isAmbiguous(res.error);
      // Fallo ambiguo (timeout/5xx/red): NO se asume rechazada ni se reintenta a ciegas; queda «unknown» para reconciliar con el broker.
      await store.transitionOrder(userId, oid, amb ? 'unknown' : 'rejected', { note: String(res.error).slice(0, 200) }, amb ? 'resultado desconocido' : 'rechazada por el broker');
      if (amb) await warn(userId, { kind: 'order_unknown', title: '⚠ Orden sin confirmar', body: `${base.side} ${base.symbol}: el broker no respondió. Revisa en tu exchange antes de repetir.` });
      const errors = (row.errors || 0) + 1;
      await store.patchBot(userId, { errors });
      if (errors >= 3) await disable(userId, 'Bot detenido tras 3 errores seguidos', { error: true });
    }
    return { placed: !!res.ok, orderId: oid, lifecycle: res.ok ? 'submitted' : (res.ambiguous || isAmbiguous(res.error) ? 'unknown' : 'rejected'), reason: res.ok ? null : String(res.error || '').slice(0, 160) };
  }

  // ---- Operación manual y cierre de posiciones (botones Comprar / Vender / Cerrar todo) ----
  // Pasan por la MISMA puerta de riesgo, el mismo ID idempotente y el mismo libro de órdenes que el bot. Cerrar = solo vender (reduceOnly).
  const OPEN_STATUS = ['ok', 'pending'];
  async function livePositions(userId, onlySymbol = null) {
    const orders = (await store.listOrders(userId, 2000)).filter((o) => o.mode === 'live' && OPEN_STATUS.includes(o.status) && (!onlySymbol || o.symbol === onlySymbol));
    const groups = new Map();
    for (const o of orders) { const k = `${o.exchange}|${o.symbol}`; if (!groups.has(k)) groups.set(k, { exchange: o.exchange, symbol: o.symbol, list: [] }); groups.get(k).list.push({ side: o.side, qty: o.qty, usd: o.usd, ts: o.created_at }); }
    return [...groups.values()].map((g) => ({ exchange: g.exchange, symbol: g.symbol, ...positionFromOrders(g.list) })).filter((p) => p.qty > 0);
  }
  async function closePositions(userId, { fraction = 1, symbol = null, source = 'cliente' } = {}) {
    const frac = Math.min(1, Math.max(0.01, Number(fraction) || 1));
    const results = []; const nowMs = Date.now();
    // Papel
    const paperOrders = (await store.listOrders(userId, 2000)).filter((o) => o.mode === 'paper' && o.status === 'ok' && (!symbol || o.symbol === symbol));
    const pg = new Map(); for (const o of paperOrders) { const k = `${o.exchange}|${o.symbol}`; if (!pg.has(k)) pg.set(k, { exchange: o.exchange, symbol: o.symbol, list: [] }); pg.get(k).list.push({ side: o.side, qty: o.qty, usd: o.usd, ts: o.created_at }); }
    for (const g of pg.values()) {
      const pos = positionFromOrders(g.list); if (!(pos.qty > 0)) continue;
      try { const m = await market(g.symbol); const qty = pos.qty * frac; const f = simulateFill({ side: 'sell', usd: qty * m.price, price: m.price, symbol: g.symbol, exchange: g.exchange });
        const gross = qty * f.price; await store.addOrder({ user_id: userId, mode: 'paper', exchange: g.exchange, symbol: g.symbol, side: 'sell', usd: gross - (gross * f.feePct) / 100, qty, price: f.price, status: 'ok', note: `Cierre manual (${source}) simulado` });
        results.push({ mode: 'paper', symbol: g.symbol, exchange: g.exchange, qty, placed: true }); } catch (e) { results.push({ mode: 'paper', symbol: g.symbol, exchange: g.exchange, placed: false, reason: `sin precio: ${String(e.message).slice(0, 60)}` }); }
    }
    // Real
    const conns = (await store.listConnections(userId));
    const row = (await store.getBot(userId)) || { user_id: userId, errors: 0 };
    for (const p of await livePositions(userId, symbol)) {
      const c = conns.find((x) => x.exchange === p.exchange && x.status === 'active' && x.can_trade && !x.can_transfer);
      if (!c) { results.push({ mode: 'live', symbol: p.symbol, exchange: p.exchange, placed: false, reason: `no hay una conexión segura activa de ${p.exchange}: vende desde el exchange` }); continue; }
      const conn = await store.getConnection(userId, c.id);
      try {
        const m = await market(p.symbol);
        const creds = { keyId: conn.key_id, secret: decrypt(encKey, conn.secret_enc) };
        const bal = (await adapters[conn.exchange].balances(creds)).find((b) => b.asset === p.symbol.split('-')[0]);
        const qty = Math.min(p.qty * frac, bal ? bal.available * 0.999 : 0);
        if (!(qty > 0)) { results.push({ mode: 'live', symbol: p.symbol, exchange: p.exchange, placed: false, reason: 'el exchange no muestra saldo disponible para vender (puede haber una orden abierta)' }); continue; }
        const r = await placeLive(row, conn, { user_id: userId, mode: 'live', exchange: conn.exchange, symbol: p.symbol, side: 'sell' }, 'marketSell', { symbol: p.symbol, qty }, qty * m.price, m.price, `Cierre manual (${source})`, qty, nowMs, { priceAgeMs: Date.now() - m.t, refPrice: null, cfg: null, reduceOnly: true });
        results.push({ mode: 'live', symbol: p.symbol, exchange: p.exchange, qty, placed: !!(r && r.placed), lifecycle: r && r.lifecycle, reason: r && r.reason });
      } catch (e) { results.push({ mode: 'live', symbol: p.symbol, exchange: p.exchange, placed: false, reason: String(e.message).slice(0, 100) }); }
    }
    await store.addAudit({ user_id: userId, actor: 'engine', action: 'close_positions', detail: `${source}: ${results.filter((r) => r.placed).length}/${results.length} cerradas${symbol ? ` (${symbol})` : ''}${frac < 1 ? ` al ${Math.round(frac * 100)}%` : ''}` });
    return results;
  }
  // Compra/venta manual de UNA cripto. Comprar en real respeta emergencia, tope por orden, tope diario y plan; vender usa el mismo cierre (reduceOnly).
  async function manualTrade(userId, { side, symbol, usd = 0, fraction = 1, mode = 'paper', connectionId = null, caps = { maxOrderUsd: 25, maxDailyUsd: 100 } }) {
    if (side === 'sell') { const r = await closePositions(userId, { fraction, symbol, source: 'botón Vender' }); return r.filter((x) => x.mode === mode); }
    let m; try { m = await market(symbol); } catch { return [{ mode, symbol, placed: false, reason: 'No pude leer el precio ahora. Intenta de nuevo en unos segundos.' }]; }
    const nowMs = Date.now();
    if (mode === 'paper') {
      const venue = 'coinbase'; const amt = Math.min(Number(usd), caps.maxOrderUsd); const f = simulateFill({ side: 'buy', usd: amt, price: m.price, symbol, exchange: venue });
      await store.addOrder({ user_id: userId, mode: 'paper', exchange: venue, symbol, side: 'buy', usd: amt + f.feeUsd, qty: amt / f.price, price: f.price, status: 'ok', note: 'Compra manual (botón Comprar) simulada' });
      return [{ mode: 'paper', symbol, qty: amt / f.price, placed: true }];
    }
    const c = connectionId ? await store.getConnection(userId, connectionId) : null;
    if (!c || c.status !== 'active' || !c.can_trade || c.can_transfer) return [{ mode: 'live', symbol, placed: false, reason: 'Elige una conexión segura (solo trading, sin retiros).' }];
    const amt = Math.min(Number(usd), caps.maxOrderUsd);
    if (!(amt >= 1)) return [{ mode: 'live', symbol, placed: false, reason: 'El monto mínimo es $1.' }];
    const spent = await store.liveUsdSince(userId, nowMs - DAY);
    if (spent + amt > caps.maxDailyUsd) return [{ mode: 'live', symbol, placed: false, reason: `Tope diario: ya van $${spent.toFixed(2)} de $${caps.maxDailyUsd}.` }];
    const row = (await store.getBot(userId)) || { user_id: userId, errors: 0 };
    const r = await placeLive(row, c, { user_id: userId, mode: 'live', exchange: c.exchange, symbol, side: 'buy' }, 'marketBuy', { symbol, usd: amt }, amt, m.price, 'Compra manual (botón Comprar)', undefined, nowMs, { priceAgeMs: Date.now() - m.t, refPrice: m.closes && m.closes.length ? m.closes[m.closes.length - 1] : null, cfg: { maxOrderUsd: caps.maxOrderUsd, maxDailyUsd: caps.maxDailyUsd } });
    return [{ mode: 'live', symbol, exchange: c.exchange, qty: amt / m.price, placed: !!(r && r.placed), lifecycle: r && r.lifecycle, reason: r && r.reason }];
  }

  // ---- Recomendación antes de comprar o vender a mano, y aviso cuando una posición sube ----
  // Solo informa: nunca envía órdenes. Usa las mismas reglas del bot (ventaja, filtro, tamaño, salida) y dice el porqué.
  async function paperPosition(userId, symbol) {
    const o = (await store.listOrders(userId, 2000)).filter((x) => x.mode === 'paper' && x.status === 'ok' && x.symbol === symbol);
    return positionFromOrders(o.map((x) => ({ side: x.side, qty: x.qty, usd: x.usd, ts: x.created_at })));
  }
  async function venueFor(userId, mode, cfg) {
    if (mode === 'live') { const c = (await store.listConnections(userId)).find((x) => x.status === 'active' && x.can_trade && !x.can_transfer); return c ? c.exchange : 'coinbase'; }
    return ['coinbase', 'robinhood'].includes(cfg.paperExchange) ? cfg.paperExchange : 'coinbase';
  }
  async function advise(userId, { side, symbol, mode = 'paper', usd = 10 }) {
    const disclaimer = 'Información educativa basada en las reglas del bot; no es asesoría de inversión y no garantiza ganancias.';
    let m; try { m = await market(symbol); } catch { return { side, symbol, verdict: 'sin_datos', headline: 'No pude leer el precio ahora. Intenta de nuevo en unos segundos.', reasons: [], disclaimer }; }
    const f = features(m.closes);
    if (!f) return { side, symbol, price: m.price, verdict: 'sin_datos', headline: 'Faltan datos de esta cripto para opinar.', reasons: [], disclaimer };
    const bot = await store.getBot(userId); const cfg = { ...DEFAULT_CFG, ...((bot && bot.cfg) || {}) };
    const exchange = await venueFor(userId, mode, cfg); const nowMs = Date.now();
    const base = symbol.split('-')[0]; const orders = await store.listOrders(userId, 2000);
    let regime = null; try { regime = JSON.parse(await store.getSetting('market:snapshot', 'null'))?.regime?.code || null; } catch { regime = null; }
    if (side === 'sell') {
      let pos;
      if (mode === 'live') { const ps = await livePositions(userId, symbol); const q = ps.reduce((a, p) => a + p.qty, 0); pos = q > 0 ? { qty: q, avgCost: ps.reduce((a, p) => a + p.avgCost * p.qty, 0) / q, lastBuyAt: Math.max(...ps.map((p) => p.lastBuyAt || 0)) } : { qty: 0 }; }
      else pos = await paperPosition(userId, symbol);
      if (!(pos.qty > 0)) return { side, symbol, price: m.price, verdict: 'sin_posicion', headline: `No tienes ${base} ${mode === 'live' ? 'real' : 'simulado'} para vender.`, reasons: [], disclaimer };
      const rt = roundTripPct({ symbol, exchange, usd: pos.qty * m.price, price: m.price });
      const gain = (m.price / pos.avgCost - 1) * 100; const net = gain - rt; const target = cfg.takeProfitPct > 0 ? cfg.takeProfitPct : 2;
      const heldHours = Math.max(0, (nowMs - (pos.lastBuyAt || nowMs)) / 3600000); const high = Math.max(m.price, ...m.closes.slice(-Math.max(2, Math.ceil(heldHours) + 1)));
      const ex = exitSignal(f, { avgCost: pos.avgCost, heldHours, highSince: high, rtPct: rt, stopLossPct: cfg.stopLossPct, takeProfitPct: target });
      const reasons = [`Precio ${m.price.toFixed(m.price < 10 ? 4 : 2)} vs tu costo medio ${pos.avgCost.toFixed(pos.avgCost < 10 ? 4 : 2)}: ${gain >= 0 ? '+' : ''}${gain.toFixed(2)} % bruto, ${net >= 0 ? '+' : ''}${net.toFixed(2)} % neto de costos (${rt.toFixed(2)} % ida y vuelta)`, ex.reason];
      let verdict; let fraction; let headline;
      if (ex.sell) { verdict = 'vender'; fraction = 1; headline = `Recomendado: VENDER todo — ${ex.reason}`; }
      else if (net >= target) { verdict = 'vender'; fraction = 0.5; headline = `Recomendado: VENDER 50 % para asegurar ganancia (+${net.toFixed(1)} % neto, meta ${target} %)`; }
      else { verdict = 'mantener'; fraction = 0; headline = `Recomendado: MANTENER — ${net >= 0 ? 'ganancia neta' : 'resultado neto'} ${net >= 0 ? '+' : ''}${net.toFixed(2)} % aún no llega a la meta de ${target} %`; }
      return { side, symbol, price: m.price, verdict, suggestedFraction: fraction, headline, reasons, gain_pct: Number(gain.toFixed(2)), net_pct: Number(net.toFixed(2)), rt_pct: Number(rt.toFixed(2)), disclaimer };
    }
    // Compra
    const want = Math.max(1, Number(usd) || cfg.usd || 10);
    const rt = roundTripPct({ symbol, exchange, usd: want, price: m.price });
    let news = null; try { news = JSON.parse(await store.getSetting('news:latest', 'null')); } catch { news = null; }
    const perf = perfSummary(orders); const closedAll = closedTrades(orders);
    const sg = entrySignal(f, { rtPct: rt, regime, risk: perf.risk });
    const tf = await timeframes(symbol, nowMs);
    const eg = tf ? evaluateEdge(tf, { rtPct: rt, regime }) : null;
    const vol24 = tf && tf.h1.length >= 24 ? tf.h1.slice(-24).reduce((a, x) => a + x.v * x.c, 0) : null;
    const fl = tradeFilter({ base, news, hourlyCloses: m.closes, volume24Usd: vol24, recentPct: closedAll.map((x) => x.pct) });
    const reasons = [...(sg.ev || [])]; let verdict = 'comprar'; let usdOk = want; let headline;
    if (!fl.go) { verdict = 'evitar'; headline = `Recomendado: NO comprar ahora — ${fl.reasons[0]}`; reasons.unshift(...fl.reasons); }
    else if (!sg.ok) { verdict = 'esperar'; headline = `Recomendado: ESPERAR — ${sg.reason}`; }
    else if (eg && !eg.insufficient && !eg.tradeable) { verdict = 'esperar'; headline = `Recomendado: ESPERAR — ${eg.reasons[0]}`; reasons.unshift(...eg.reasons); }
    if (verdict === 'comprar' && cfg.dynamicSizing && cfg.riskCapitalUsd > 0) {
      const { curve, pcts } = curveFromClosed(closedAll, cfg.riskCapitalUsd); const em = await getEmergency(store);
      const exposure = (await livePositions(userId)).reduce((a, p) => a + p.qty * p.avgCost, 0);
      const d = sizeDecision({ configuredUsd: want, equityUsd: cfg.riskCapitalUsd, openExposureUsd: exposure, candidateRets: hourlyRets(m.closes), heldRets: [], closedPnlPcts: pcts, equityCurve: curve, pnl24hUsd: pnl24h(orders, nowMs), regime, edgeScore: eg ? eg.edge_score : null, killSwitch: em.on });
      if (!d.approved) { verdict = 'evitar'; headline = `Recomendado: NO comprar ahora — ${d.reason}`; } else usdOk = Math.min(want, d.usd);
    }
    if (verdict === 'comprar') headline = `Recomendado: COMPRAR ~$${usdOk.toFixed(2)}${usdOk < want ? ` (menos que los $${want.toFixed(2)} que pusiste, por riesgo)` : ''} — ${sg.reason}`;
    return { side, symbol, price: m.price, verdict, suggestedUsd: verdict === 'comprar' ? Number(usdOk.toFixed(2)) : 0, headline, reasons: reasons.slice(0, 6), edge_score: eg ? eg.edge_score : null, filter: fl.summary, rt_pct: Number(rt.toFixed(2)), disclaimer };
  }

  // Vigila las posiciones de quienes activaron avisos: si una sube lo suficiente (ganancia NETA ≥ meta), manda push para vender.
  // Meta = takeProfitPct del bot o 2 % si no hay. Un aviso por posición cada 6 h, o antes si gana 2 puntos más. Solo avisa; no vende.
  async function sellWatch(nowMs = Date.now()) {
    if (!alert) return { checked: 0, alerts: 0 };
    const uids = [...new Set((await loadSubs(store)).map((s) => s.uid))]; let checked = 0; let alerts = 0;
    for (const uid of uids) {
      try {
        const bot = await store.getBot(uid); const cfg = { ...DEFAULT_CFG, ...((bot && bot.cfg) || {}) }; const target = cfg.takeProfitPct > 0 ? cfg.takeProfitPct : 2;
        const pos = [];
        for (const p of await livePositions(uid)) pos.push({ mode: 'live', symbol: p.symbol, exchange: p.exchange, qty: p.qty, avgCost: p.avgCost, lastBuyAt: p.lastBuyAt });
        const po = (await store.listOrders(uid, 2000)).filter((x) => x.mode === 'paper' && x.status === 'ok'); const g = new Map();
        for (const o of po) { if (!g.has(o.symbol)) g.set(o.symbol, { exchange: o.exchange, list: [] }); g.get(o.symbol).list.push({ side: o.side, qty: o.qty, usd: o.usd, ts: o.created_at }); }
        for (const [symbol, x] of g) { const q = positionFromOrders(x.list); if (q.qty > 0) pos.push({ mode: 'paper', symbol, exchange: x.exchange, qty: q.qty, avgCost: q.avgCost, lastBuyAt: q.lastBuyAt }); }
        if (!pos.length) continue;
        let st = {}; try { st = JSON.parse(await store.getSetting(`sellwatch:${uid}`, '{}')) || {}; } catch { st = {}; }
        let dirty = false;
        for (const p of pos) {
          let m; try { m = await market(p.symbol); } catch { continue; }
          checked++;
          const key = `${p.mode}:${p.symbol}`; const rt = roundTripPct({ symbol: p.symbol, exchange: p.exchange, usd: p.qty * m.price, price: m.price });
          const gain = (m.price / p.avgCost - 1) * 100; const net = gain - rt; const prev = st[key];
          if (net >= target) {
            if (!prev || nowMs - prev.t > 6 * 3600000 || net >= prev.net + 2) {
              const base = p.symbol.split('-')[0];
              await warn(uid, { kind: `sell:${key}`, title: `💰 ${base} subió +${gain.toFixed(1)} %${p.mode === 'paper' ? ' (simulada)' : ''}`, body: `Ganancia neta ≈ +${net.toFixed(1)} % tras costos. Conviene vender una parte o todo: abre la app → Vender.` });
              st[key] = { t: nowMs, net }; dirty = true; alerts++;
            }
          } else if (prev && net < target - 1) { delete st[key]; dirty = true; }
          // Protección: si la posición cayó hasta su stop dinámico / stop-loss, avisa para limitar la pérdida (un aviso por posición cada 6 h; se rearma al recuperarse).
          const f = features(m.closes);
          if (f) {
            const heldHours = Math.max(0, (nowMs - (p.lastBuyAt || nowMs)) / 3600000); const high = Math.max(m.price, ...m.closes.slice(-Math.max(2, Math.ceil(heldHours) + 1)));
            const ex = exitSignal(f, { avgCost: p.avgCost, heldHours, highSince: high, rtPct: rt, stopLossPct: cfg.stopLossPct, takeProfitPct: 0 });
            const sk = `stop:${key}`;
            if (ex.sell) {
              if (!st[sk] || nowMs - st[sk].t > 6 * 3600000) {
                const base = p.symbol.split('-')[0]; const tag = p.mode === 'paper' ? ' (simulada)' : ''; const stopHit = /^Stop dinámico/.test(ex.reason);
                const title = stopHit ? (gain < 0 ? `⚠ ${base} cayó ${gain.toFixed(1)} %${tag}` : `⚠ ${base} retrocedió desde su máximo (+${gain.toFixed(1)} %)${tag}`) : `📉 ${base} pierde fuerza (${gain >= 0 ? '+' : ''}${gain.toFixed(1)} %)${tag}`;
                const body = stopHit ? (gain < 0 ? 'Llegó a su stop: conviene vender para limitar la pérdida. Abre la app → Vender.' : 'Bajó de su stop dinámico: conviene vender para asegurar la ganancia. Abre la app → Vender.') : `${String(ex.reason).slice(0, 110)}. Conviene vender: abre la app → Vender.`;
                await warn(uid, { kind: sk, title, body });
                st[sk] = { t: nowMs }; dirty = true; alerts++;
              }
            } else if (st[sk]) { delete st[sk]; dirty = true; }
          }
        }
        if (dirty) await store.setSetting(`sellwatch:${uid}`, JSON.stringify(st));
      } catch (e) { log.error('sellWatch', uid, e.message); }
    }
    return { checked, alerts };
  }

  // Oportunidades de compra: para quienes activaron avisos (y no apagaron «buyAlerts»), revisa las criptos más grandes con las MISMAS reglas
  // de la recomendación. Solo avisa si todo cumple (señal Pro + ventaja multi-timeframe con datos + filtro + tamaño). Máx. 3 al día por persona,
  // una vez por cripto cada 12 h, y nunca de una cripto que ya tiene. Solo avisa; no compra.
  async function buyWatch(nowMs = Date.now()) {
    if (!alert) return { checked: 0, alerts: 0 };
    const uids = [...new Set((await loadSubs(store)).map((s) => s.uid))]; if (!uids.length) return { checked: 0, alerts: 0 };
    let items = []; try { const sc = await getScanner(store); items = (sc && sc.items) || []; } catch { items = []; }
    const FALL = ['BTC', 'ETH', 'SOL', 'XRP', 'ADA', 'DOGE', 'AVAX', 'LINK', 'DOT', 'LTC'].map((x) => `${x}-USD`);
    const pool = (items.length ? [...items].sort((a, b) => (b.mcap || 0) - (a.mcap || 0)).map((i) => i.symbol) : FALL).slice(0, 8);
    const day = new Date(nowMs).toISOString().slice(0, 10); let checked = 0; let alerts = 0;
    for (const uid of uids) {
      try {
        const bot = await store.getBot(uid); const cfg = { ...DEFAULT_CFG, ...((bot && bot.cfg) || {}) }; if (cfg.buyAlerts === false) continue;
        if (cfg.enabled && cfg.symbol === 'AUTO' && cfg.autoMode === 'pro') continue; // el bot ya compra solo con estas mismas reglas; el aviso útil es el de lo que hizo
        let st = {}; try { st = JSON.parse(await store.getSetting(`buywatch:${uid}`, '{}')) || {}; } catch { st = {}; }
        if (st.day !== day) st = { day, n: 0, seen: st.seen || {} };
        if (st.n >= 3) continue;
        const held = new Set((await livePositions(uid)).map((p) => p.symbol));
        for (const o of (await store.listOrders(uid, 2000)).filter((x) => x.mode === 'paper' && x.status === 'ok')) held.add(o.symbol);
        let dirty = false;
        for (const sym of pool) {
          if (st.n >= 3) break;
          if (held.has(sym) || (st.seen[sym] && nowMs - st.seen[sym] < 12 * 3600000)) continue;
          checked++;
          const mode = cfg.mode === 'live' ? 'live' : 'paper';
          let a; try { a = await advise(uid, { side: 'buy', symbol: sym, mode, usd: cfg.usd }); } catch { continue; }
          if (a.verdict !== 'comprar' || a.edge_score === null || a.edge_score === undefined) continue; // sin datos de 15 min/volumen no se avisa
          const base = sym.split('-')[0];
          await warn(uid, { kind: `buy:${sym}`, title: `🟢 Oportunidad: ${base}`, body: `Cumple todos los filtros (ventaja ${a.edge_score}/100). Sugerido ~$${a.suggestedUsd}. Revisa y decide: abre la app → Comprar.` });
          st.seen[sym] = nowMs; st.n++; dirty = true; alerts++;
        }
        if (dirty || st.day !== day) await store.setSetting(`buywatch:${uid}`, JSON.stringify(st));
      } catch (e) { log.error('buyWatch', uid, e.message); }
    }
    return { checked, alerts };
  }

  async function tick() {
    if (running || stopping) return;
    running = true;
    try {
      // Solo una instancia ejecuta los bots a la vez; si esta pierde el candado (u otra lo tiene), no hace nada.
      if (store.acquireLease && !(await store.acquireLease('engine', instanceId, 45000))) return;
      const nowMs = Date.now();
      for (const row of await store.listBots()) {
        try { await runBot(row, nowMs); } catch (e) { log.error('bot error', row.user_id, e.message); }
      }
    } finally {
      running = false;
    }
  }

  // Apagado ordenado: no empieza ciclos nuevos y espera (hasta maxMs) a que termine el que está en curso.
  async function stop(maxMs = 20000) { stopping = true; const t0 = Date.now(); while (running && Date.now() - t0 < maxMs) await new Promise((r) => setTimeout(r, 100)); return !running; }
  return { tick, runBot, stop, closePositions, manualTrade, livePositions, advise, sellWatch, buyWatch, resolveEdgeOutcomes };
}
