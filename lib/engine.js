// Motor del bot hospedado: evalúa cada bot activo cada minuto.
// Modo "paper" = simulado con precio real. Modo "live" = órdenes reales con las llaves del cliente,
// solo si el dueño habilitó trading real, el cliente aceptó el riesgo y se respetan los topes.
import { decrypt } from './security.js';
import { decide, positionFromOrders, DEFAULT_CFG } from './strategy.js';
import { sma, rsi, macd } from './indicators.js';
import { features, roundTripPct, entrySignal, exitSignal, perfSummary, losingSymbols, pnl24h, confidenceSize, explainBuy, explainSell, newsNote, regimeEs } from './pro.js';
import { simulateFill } from './costs.js';
import { getUniverse, robinhoodPairs } from './universe.js';
import { getScanner } from './scanner.js';

const DAY = 86400000;

export function createEngine({ store, adapters, feed, encKey, log = console }) {
  const cache = new Map();
  const skipLog = new Map();
  let running = false;

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

  async function disable(userId, why) {
    const b = await store.getBot(userId);
    if (b) await store.patchBot(userId, { cfg: { ...b.cfg, enabled: false } });
    await store.addAudit({ user_id: userId, actor: 'engine', action: 'bot_disabled', detail: why });
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
      await placeLive(row, conn, base, 'marketBuy', { symbol, usd }, usd, m.price, d.reason);
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
    await placeLive(row, conn, base, 'marketSell', { symbol, qty: sellQty }, sellQty * m.price, m.price, d.reason, sellQty);
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
  async function runPro({ row, cfg, primary, nowMs, items, byS, bySym, held, conns, orders }) {
    const userId = row.user_id; const log = []; let trades = 0;
    const perf = perfSummary(orders);
    let regime = null; try { regime = JSON.parse(await store.getSetting('market:snapshot', 'null'))?.regime?.code || null; } catch { regime = null; }
    let news = null; try { news = JSON.parse(await store.getSetting('news:latest', 'null')); } catch { news = null; }
    const maxPos = cfg.maxPositions || 3;
    const soldNow = new Set(); const soldWhy = new Map(); const buyWhy = new Map(); const keep = [];
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
        const ex = exitSignal({ ...f, px: mk.price }, { avgCost: pos.avgCost, heldHours, highSince, rtPct: rt, stopLossPct: cfg.stopLossPct });
        log.push(`${h.sym}: ${ex.reason}`);
        if (!ex.sell) { keep.push({ h, f, mk, pos, heldHours, ex0, rt }); continue; }
        let conn = primary; let venue = ex0;
        if (cfg.mode === 'live') { const c = conns.find((x) => x.exchange === ex0); if (!c) continue; conn = await store.getConnection(userId, c.id); }
        const r = await runSymbol(row, { ...cfg, symbol: h.sym }, conn, venue, h.sym, nowMs, { note: false, force: { action: 'sell', reason: `Pro: ${ex.reason}` } });
        if (r.placed) { trades++; soldNow.add(h.sym); soldWhy.set(h.sym, ex.reason); }
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
          if (sg.ok) found.push({ sym, sg, best }); else why.push(`${base}: ${sg.reason}`);
        } catch { /* sin datos de esa cripto */ }
      }
      found.sort((a, b) => b.sg.score - a.sg.score); foundAll.push(...found);
      for (const c of found.slice(0, Math.max(0, Math.min(3, maxPos - heldNow)))) {
        const bUsd = Math.max(1, cfg.usd * c.sg.size * confidenceSize(c.sg.edge));
        const r = await runSymbol(row, { ...cfg, symbol: c.sym }, c.best.conn, c.best.ex, c.sym, nowMs, { note: false, slots: Math.max(1, maxPos - heldNow),
          force: { action: 'buy', usd: bUsd, reason: `Pro: ${c.sg.reason}; ejecuta en ${c.best.ex} (el más barato)` } });
        if (r.placed) { trades++; boughtNow.add(c.sym); buyWhy.set(c.sym, explainBuy({ base: c.sym.split('-')[0], sg: c.sg, usd: bUsd, baseUsd: cfg.usd, regime, risk: perf.risk, news })); log.push(`${c.sym}: compra en ${c.best.ex}`); }
      }
      // 3) Rotación: con los cupos llenos, cambia la posición que pierde fuerza por una señal claramente mejor (con costo ya descontado en el filtro de entrada).
      if (heldNow >= maxPos && found.length && !soldNow.size) {
        const cand = found.find((c) => c.sg.edge >= 1.3);
        const weak = keep.filter((k) => k.heldHours >= 1 && (k.f.roc6 <= 0 || k.mk.price < k.f.s10)
          && !entrySignal({ ...k.f, px: k.mk.price }, { rtPct: k.rt, regime, risk: perf.risk }).ok).sort((a, b) => a.f.roc6 - b.f.roc6)[0];
        if (cand && weak) {
          const gain = (weak.mk.price / weak.pos.avgCost - 1) * 100;
          try {
            let wconn = primary; const wex = weak.ex0;
            if (cfg.mode === 'live') { const c = conns.find((x) => x.exchange === wex); wconn = c ? await store.getConnection(userId, c.id) : null; }
            if (cfg.mode !== 'live' || wconn) {
              const why = `Pro rota: ${weak.h.sym.split('-')[0]} pierde fuerza (${gain >= 0 ? '+' : ''}${gain.toFixed(2)} %) y ${cand.sym.split('-')[0]} tiene mejor señal (${cand.sg.edge.toFixed(1)}× el costo)`;
              const rs = await runSymbol(row, { ...cfg, symbol: weak.h.sym }, wconn, wex, weak.h.sym, nowMs, { note: false, force: { action: 'sell', reason: why } });
              if (rs.placed) {
                trades++; log.push(why); rotated = { out: weak.h.sym, in: cand.sym };
                const rUsd = Math.max(1, cfg.usd * cand.sg.size * confidenceSize(cand.sg.edge));
                const rb = await runSymbol(row, { ...cfg, symbol: cand.sym }, cand.best.conn, cand.best.ex, cand.sym, nowMs, { note: false, slots: 1,
                  force: { action: 'buy', usd: rUsd, reason: `${why}; ejecuta en ${cand.best.ex}` } });
                if (rb.placed) { trades++; boughtNow.add(cand.sym); buyWhy.set(cand.sym, explainBuy({ base: cand.sym.split('-')[0], sg: cand.sg, usd: rUsd, baseUsd: cfg.usd, regime, risk: perf.risk, news })); }
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
        octo.push({ symbol: k.h.sym, held: true, score: sg.ok ? sg.score : 0, gain_pct: gp, state, why });
      }
      for (const h of held) if (soldNow.has(h.sym) && !(rotated && rotated.out === h.sym)) octo.push({ symbol: h.sym, held: false, score: 0, state: 'vendió', why: explainSell(B(h.sym), soldWhy.get(h.sym) || '') });
      if (rotated) octo.push({ symbol: rotated.out, held: false, score: 0, state: 'soltó', why: explainSell(B(rotated.out), soldWhy.get(rotated.out) || 'cambio por una señal mejor') });
      for (const c of foundAll.slice(0, 6)) {
        const bw = buyWhy.get(c.sym);
        octo.push({ symbol: c.sym, held: false, score: c.sg.score, edge: c.sg.edge, state: boughtNow.has(c.sym) ? 'compró' : 'listo', big: bw ? bw.big : false,
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
    const { user_id: userId } = row;
    const cfg = { ...DEFAULT_CFG, ...row.cfg };
    if (!cfg.enabled) return;
    if (nowMs - (row.last_run || 0) < 14000) return;

    const user = await store.getUserById(userId);
    if (!user || user.status !== 'active') return disable(userId, 'Cuenta no activa');

    let conn = null;
    if (cfg.mode === 'live') {
      const sc = await store.getSetting('live_trading', 'off');
      if (!(sc === 'on' || (sc === 'owner' && user.role === 'owner'))) return disable(userId, 'Trading real deshabilitado por el administrador');
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

  async function placeLive(row, conn, base, fn, args, usd, price, reason, qtyOverride) {
    const userId = row.user_id;
    let res;
    try {
      const creds = { keyId: conn.key_id, secret: decrypt(encKey, conn.secret_enc) };
      res = await adapters[conn.exchange][fn](creds, args);
    } catch (e) {
      res = { ok: false, error: e.message };
    }
    const qty = qtyOverride ?? usd / price;
    if (res.ok) {
      await store.patchBot(userId, { errors: 0 });
      await store.addOrder({ ...base, usd, qty, price, status: 'ok', ext_id: res.id || null,
        note: `${reason} (precio y cantidad estimados)` });
      await store.addAudit({ user_id: userId, actor: 'engine', action: 'order_live', detail: `${base.side} ${base.symbol} ~$${usd.toFixed(2)}` });
    } else {
      await store.addOrder({ ...base, usd, qty, price, status: 'error', note: String(res.error).slice(0, 200) });
      const errors = (row.errors || 0) + 1;
      await store.patchBot(userId, { errors });
      if (errors >= 3) await disable(userId, 'Bot detenido tras 3 errores seguidos');
    }
  }

  async function tick() {
    if (running) return;
    running = true;
    try {
      const nowMs = Date.now();
      for (const row of await store.listBots()) {
        try { await runBot(row, nowMs); } catch (e) { log.error('bot error', row.user_id, e.message); }
      }
    } finally {
      running = false;
    }
  }

  return { tick, runBot };
}
