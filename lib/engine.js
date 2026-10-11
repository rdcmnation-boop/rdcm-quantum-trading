// Motor del bot hospedado: evalúa cada bot activo cada minuto.
// Modo "paper" = simulado con precio real. Modo "live" = órdenes reales con las llaves del cliente,
// solo si el dueño habilitó trading real, el cliente aceptó el riesgo y se respetan los topes.
import { decrypt } from './security.js';
import { decide, positionFromOrders, DEFAULT_CFG } from './strategy.js';
import { simulateFill } from './costs.js';

const paperExchange = (conn, cfg) => (conn && conn.exchange) || cfg.paperExchange || 'coinbase';

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

  async function runBot(row, nowMs) {
    const { user_id: userId } = row;
    const cfg = { ...DEFAULT_CFG, ...row.cfg };
    if (!cfg.enabled) return;
    if (nowMs - (row.last_run || 0) < 55000) return;

    const user = await store.getUserById(userId);
    if (!user || user.status !== 'active') return disable(userId, 'Cuenta no activa');

    let conn = null;
    if (cfg.mode === 'live') {
      if ((await store.getSetting('live_trading', 'off')) !== 'on') return disable(userId, 'Trading real deshabilitado por el administrador');
      if (!cfg.liveAck) return disable(userId, 'Falta la confirmación de riesgo');
      conn = cfg.connectionId ? await store.getConnection(userId, cfg.connectionId) : null;
      if (!conn || !conn.can_trade || conn.can_transfer) return disable(userId, 'Conexión inválida para trading real');
    }

    await store.patchBot(userId, { last_run: nowMs });
    const m = await market(cfg.symbol);
    const orders = (await store.listOrders(userId, 1000))
      .filter((o) => o.mode === cfg.mode && o.symbol === cfg.symbol && o.status === 'ok');
    const pos = positionFromOrders(orders.map((o) => ({ side: o.side, qty: o.qty, usd: o.usd, ts: o.created_at })));
    const position = pos.qty;
    const d = decide(cfg, { closes: m.closes, now: nowMs, price: m.price, lastBuyAt: pos.lastBuyAt,
      lastSellAt: pos.lastSellAt, position, avgCost: pos.avgCost });
    await noteDecision(userId, { t: nowMs, action: d.action, reason: d.reason || '', price: m.price });
    if (d.action === 'hold') return;

    const base = { user_id: userId, mode: cfg.mode, exchange: conn ? conn.exchange : 'paper', symbol: cfg.symbol, side: d.action };

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
          return;
        }
      }
      if (cfg.mode === 'paper') {
        // Papel realista: mismo spread, impacto y comisión estimados del exchange (no es precio de mercado puro).
        const f = simulateFill({ side: 'buy', usd, price: m.price, symbol: cfg.symbol, exchange: paperExchange(conn, cfg) });
        await store.addOrder({ ...base, usd: usd + f.feeUsd, qty: usd / f.price, price: f.price, status: 'ok',
          note: `${d.reason} (simulado: comisión ${f.feePct}% + deslizamiento ${f.slipPct.toFixed(3)}%)` });
        return;
      }
      return placeLive(row, conn, base, 'marketBuy', { symbol: cfg.symbol, usd }, usd, m.price, d.reason);
    }

    // sell
    const qty = Math.min(d.qty, position);
    if (!(qty > 0)) return;
    if (cfg.mode === 'paper') {
      const f = simulateFill({ side: 'sell', usd: qty * m.price, price: m.price, symbol: cfg.symbol, exchange: paperExchange(conn, cfg) });
      const gross = qty * f.price;
      await store.addOrder({ ...base, usd: gross - (gross * f.feePct) / 100, qty, price: f.price, status: 'ok',
        note: `${d.reason} (simulado: comisión ${f.feePct}% + deslizamiento ${f.slipPct.toFixed(3)}%)` });
      return;
    }
    // En real, nunca vendemos más de lo que el exchange dice que hay disponible.
    let sellQty = qty;
    try {
      const creds = { keyId: conn.key_id, secret: decrypt(encKey, conn.secret_enc) };
      const bal = (await adapters[conn.exchange].balances(creds)).find((b) => b.asset === cfg.symbol.split('-')[0]);
      sellQty = Math.min(qty, bal ? bal.available * 0.999 : 0);
    } catch { sellQty = 0; }
    if (!(sellQty > 0)) return;
    return placeLive(row, conn, base, 'marketSell', { symbol: cfg.symbol, qty: sellQty }, sellQty * m.price, m.price, d.reason, sellQty);
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
