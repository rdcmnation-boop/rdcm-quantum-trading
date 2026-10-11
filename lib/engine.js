// Motor del bot hospedado: evalúa cada bot activo cada minuto.
// Modo "paper" = simulado con precio real. Modo "live" = órdenes reales con las llaves del cliente,
// solo si el dueño habilitó trading real, el cliente aceptó el riesgo y se respetan los topes.
import { decrypt } from './security.js';
import { decide, positionFromOrders, DEFAULT_CFG } from './strategy.js';
import { simulateFill } from './costs.js';
import { getUniverse, robinhoodPairs } from './universe.js';
import { getScanner } from './scanner.js';

const DAY = 86400000;

export function createEngine({ store, adapters, feed, encKey, log = console }) {
  const cache = new Map();
  const skipLog = new Map();
  let running = false;

  async function market(symbol) {
    const c = cache.get(symbol);
    if (c && Date.now() - c.t < 55000) return c;
    const [price, closes] = await Promise.all([feed.getPrice(symbol), feed.getCloses(symbol)]);
    const v = { t: Date.now(), price, closes };
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
  async function runSymbol(row, cfg, conn, venue, symbol, nowMs, { note = true } = {}) {
    const userId = row.user_id;
    const m = await market(symbol);
    const orders = (await store.listOrders(userId, 1000))
      .filter((o) => o.mode === cfg.mode && o.symbol === symbol && o.status === 'ok');
    const pos = positionFromOrders(orders.map((o) => ({ side: o.side, qty: o.qty, usd: o.usd, ts: o.created_at })));
    const position = pos.qty;
    const d = decide(cfg, { closes: m.closes, now: nowMs, price: m.price, lastBuyAt: pos.lastBuyAt,
      lastSellAt: pos.lastSellAt, position, avgCost: pos.avgCost });
    if (note) await noteDecision(userId, { t: nowMs, action: d.action, reason: d.reason || '', price: m.price });
    if (d.action === 'hold') return { d, price: m.price, placed: false };

    const base = { user_id: userId, mode: cfg.mode, exchange: conn ? conn.exchange : venue, symbol, side: d.action };

    if (d.action === 'buy') {
      const usd = Math.min(d.usd, cfg.maxOrderUsd);
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
    const picks = items.filter((i) => i.qualified).slice(0, 6);
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
        const r = await runSymbol(row, symCfg(it.symbol), conn, venue, it.symbol, nowMs, { note: false });
        if (r.d.action === 'buy' && r.placed) { bought = true; log.push(`${it.symbol}: compra en ${venue}`); break; }
        log.push(`${it.symbol}: ${r.d.reason || 'espera'}`);
      }
    }
    const summary = !sc ? 'El Cerebro aún no corrió el escáner; en unos minutos tendrá la lista'
      : !picks.length && !held.length ? `Cerebro: ninguna de ${sc.scanned} criptos pasó la prueba (neto de costos). Espera, no compra`
      : `Cerebro vigila ${picks.length} validadas (${picks.slice(0, 4).map((p) => p.symbol.split('-')[0]).join(', ')}) y cuida ${held.length} posición(es)${bought ? '. Compró ahora.' : '. Sin señal nueva.'}`;
    await noteDecision(userId, { t: nowMs, action: bought ? 'buy' : 'hold', reason: summary, price: null, auto: log.slice(0, 8) });
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
    if (nowMs - (row.last_run || 0) < 55000) return;

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
    if (cfg.symbol === 'AUTO') return runAuto(row, cfg, user, conn, nowMs);
    const venue = paperVenue(cfg, null, conn);
    return runSymbol(row, cfg, conn, venue, cfg.symbol, nowMs);
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
