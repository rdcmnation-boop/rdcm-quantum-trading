// Cerebro + Director + agentes de apoyo.
// REGLA DE ORO: los agentes SOLO proponen. Nada cambia sin la aprobación explícita del dueño,
// y las propuestas que toquen áreas protegidas (seguridad, aislamiento, reglas de riesgo, acceso) se bloquean siempre.
// Los agentes son analizadores deterministas (sin LLM): sus hallazgos salen de datos reales y quedan auditados.
import fs from 'node:fs';
import { backtest } from './backtest.js';
import { walkForward, features, predictProb, explain } from './ml.js';
import { validateCfg } from './strategy.js';
import { SYMBOLS } from './exchanges.js';
import { runScanner, scannerProposals, getScanner } from './scanner.js';
import { runLab, labProposals } from './lab.js';
import { getMarket } from './market.js';
import { setCalibration } from './costs.js';
import { createExplainer, clean } from './llm.js';

const DAY = 86400000;
const WATCH = ['BTC-USD', 'ETH-USD'];

export const KINDS = ['strategy_defaults', 'agent_toggle', 'model_update', 'risk_alert', 'ops_alert', 'insight'];
export const PROTECTED_MIN = ['risk_rules', 'data_isolation', 'security', 'auth', 'owner_access'];
// Piloto automático (OPT-IN, apagado por defecto): solo puede aplicar estos tipos de bajo riesgo y reversibles. Nunca agentes, riesgo, seguridad ni acceso.
export const AUTO_KINDS = ['model_update', 'strategy_defaults'];
export const DEFAULT_GUARDRAILS = { maxPendingProposals: 20, autoRunHours: 6, allowedKinds: KINDS.slice(), protectedAreas: PROTECTED_MIN.slice(), autopilot: { enabled: true, kinds: AUTO_KINDS.slice() } };
const STATE_KINDS = ['strategy_defaults', 'agent_toggle', 'model_update']; // los que cambian algo al aprobarse

export async function getGuardrails(store) {
  const raw = await store.getSetting('guardrails', null);
  let g = {};
  try { g = raw ? JSON.parse(raw) : {}; } catch { g = {}; }
  const merged = { ...DEFAULT_GUARDRAILS, ...g };
  merged.protectedAreas = [...new Set([...PROTECTED_MIN, ...(merged.protectedAreas || [])])]; // las mínimas no se pueden quitar
  merged.allowedKinds = (merged.allowedKinds || []).filter((k) => KINDS.includes(k));
  merged.autopilot = { enabled: g.autopilot?.enabled !== false, kinds: (Array.isArray(g.autopilot?.kinds) ? g.autopilot.kinds : AUTO_KINDS).filter((k) => AUTO_KINDS.includes(k)) };
  return merged;
}

export async function setGuardrails(store, input) {
  const cur = await getGuardrails(store);
  const next = { ...cur };
  if (input.maxPendingProposals !== undefined) next.maxPendingProposals = Math.min(100, Math.max(1, Math.floor(Number(input.maxPendingProposals)) || cur.maxPendingProposals));
  if (input.autoRunHours !== undefined) next.autoRunHours = Math.min(168, Math.max(1, Math.floor(Number(input.autoRunHours)) || cur.autoRunHours));
  if (Array.isArray(input.allowedKinds)) next.allowedKinds = input.allowedKinds.filter((k) => KINDS.includes(k));
  if (Array.isArray(input.protectedAreas)) next.protectedAreas = [...new Set([...PROTECTED_MIN, ...input.protectedAreas.map(String).slice(0, 20)])];
  if (input.autopilot && typeof input.autopilot === 'object') {
    next.autopilot = { enabled: input.autopilot.enabled === true, kinds: (Array.isArray(input.autopilot.kinds) ? input.autopilot.kinds : cur.autopilot.kinds).filter((k) => AUTO_KINDS.includes(k)) };
  }
  await store.setSetting('guardrails', JSON.stringify(next));
  return next;
}

const pct = (x) => `${x.toFixed(1)} %`;

// ---------------------------------------------------------------- agentes
export const AGENTS = {
  problem_processing: {
    label: 'Procesador de problemas', available: true,
    description: 'Detecta errores de órdenes, ataques de fuerza bruta y bots apagados automáticamente (últimas 24 h).',
    async run({ store, now }) {
      const since = now - DAY;
      const [audit, orders] = await Promise.all([store.listAuditSince(since), store.listAllOrdersSince(since)]);
      const proposals = [];
      const err = orders.filter((o) => o.status === 'error').length;
      if (orders.length >= 5 && err / orders.length > 0.2) {
        proposals.push({ kind: 'ops_alert', key: 'ops:order_errors', title: `Errores de órdenes altos: ${pct((err / orders.length) * 100)} en 24 h`,
          detail: { text: 'Revisa el estado del exchange y las llaves de los clientes afectados. El motor ya apaga bots tras 3 errores seguidos.' },
          evidence: { orders_24h: orders.length, errors_24h: err }, touches: [] });
      }
      const fails = audit.filter((a) => a.action === 'login_fail').length;
      if (fails > 30) {
        proposals.push({ kind: 'risk_alert', key: 'risk:bruteforce', title: `Posible fuerza bruta: ${fails} logins fallidos en 24 h`,
          detail: { text: 'Considera cerrar el registro temporalmente (Ajustes) y revisar las IP en Seguridad.' },
          evidence: { failed_logins_24h: fails }, touches: [] });
      }
      const dis = audit.filter((a) => a.action === 'bot_disabled');
      if (dis.length) {
        const reasons = [...new Set(dis.map((d) => d.detail))].slice(0, 3);
        proposals.push({ kind: 'ops_alert', key: 'ops:bots_disabled', title: `${dis.length} bot(s) apagados automáticamente en 24 h`,
          detail: { text: 'El motor apagó bots por seguridad. Revisa los motivos.' }, evidence: { count: dis.length, reasons }, touches: [] });
      }
      return { proposals, notes: [`órdenes 24h: ${orders.length}`, `logins fallidos 24h: ${fails}`] };
    },
  },

  owner_analytics: {
    label: 'Analista del dueño', available: true,
    description: 'Mide activación de clientes y tendencia de altas con datos reales; propone acciones de producto.',
    async run({ store, now }) {
      const users = (await store.listUsers()).filter((u) => u.role === 'client' && u.status === 'active');
      const proposals = [];
      if (users.length >= 3) {
        let withConn = 0;
        for (const u of users) if ((await store.listConnections(u.id)).length) withConn++;
        const rate = (withConn / users.length) * 100;
        if (rate < 50) {
          proposals.push({ kind: 'insight', key: 'insight:activation', title: `Activación baja: solo ${pct(rate)} de los clientes conectó un exchange`,
            detail: { text: 'Mejora el onboarding: guía paso a paso para crear la llave solo-trading y un recordatorio por correo (requiere servicio de email).' },
            evidence: { clientes_activos: users.length, con_exchange: withConn }, touches: [] });
        }
      }
      const last7 = users.filter((u) => u.created_at >= now - 7 * DAY).length;
      const prev7 = users.filter((u) => u.created_at >= now - 14 * DAY && u.created_at < now - 7 * DAY).length;
      if (prev7 >= 4 && last7 < prev7 / 2) {
        proposals.push({ kind: 'insight', key: 'insight:signups_drop', title: `Las altas cayeron: ${last7} esta semana vs ${prev7} la anterior`,
          detail: { text: 'Revisa el canal de adquisición y la landing.' }, evidence: { last7, prev7 }, touches: [] });
      }
      return { proposals, notes: [`clientes activos: ${users.length}`] };
    },
  },

  trading_improvement: {
    label: 'Mejora de trading', available: true,
    description: 'Laboratorio de papel con $1M virtual: prueba estrategias (SMA, RSI, MACD) con ~50 días de historial real y costos estimados de Coinbase y Robinhood (comisión, spread, impacto, latencia), entrenando en el pasado y validando en el futuro. Solo propone si gana fuera de muestra.',
    async run({ feed }) {
      const proposals = []; const notes = [];
      const CAPITAL = 1000000; // laboratorio de papel: capital virtual de $1M, sin dinero real
      const base = { usd: 50000, maxOrderUsd: 250000, maxDailyUsd: 1000000, stopLossPct: 8, intervalMin: 60 };
      const grid = [
        { strategy: 'sma', fast: 5, slow: 20 }, { strategy: 'sma', fast: 10, slow: 30 }, { strategy: 'sma', fast: 20, slow: 50 },
        { strategy: 'macd' }, { strategy: 'rsi', rsiBuy: 30, rsiSell: 60 }, { strategy: 'rsi', rsiBuy: 25, rsiSell: 55 },
      ].map((g) => ({ ...base, fast: 20, slow: 50, rsiBuy: 30, rsiSell: 60, ...g }));
      for (const symbol of WATCH) {
        let closes;
        try { closes = await feed.getHistory(symbol, 1200); } catch (e) { notes.push(`${symbol}: ${e.message}`); continue; }
        if (closes.length < 400) { notes.push(`${symbol}: historial insuficiente`); continue; }
        const cut = Math.floor(closes.length * 0.7);
        const train = closes.slice(0, cut); const test = closes.slice(cut - 60);
        const opt = (exchange) => ({ capital: CAPITAL, exchange });
        let best = null;
        for (const cfg of grid) {
          try {
            const r = backtest(train, { ...cfg, symbol }, opt('coinbase'));
            const s = r.metrics.sharpe ?? -Infinity;
            if (r.metrics.closedTrades >= 3 && (!best || s > best.s)) best = { cfg, s, train: r.metrics };
          } catch { /* configuración sin datos suficientes */ }
        }
        if (!best) { notes.push(`${symbol}: ninguna estrategia generó operaciones suficientes en entrenamiento`); continue; }
        const val = {};
        for (const ex of ['coinbase', 'robinhood']) {
          const r = backtest(test, { ...best.cfg, symbol }, opt(ex));
          val[ex] = { ...r.metrics, costos_usd: Math.round(r.costs.totalUsd), costos_pct_capital: r.costs.dragPct };
        }
        const ok = (t) => t.totalReturnPct > 0 && t.totalReturnPct > t.buyHoldPct && t.closedTrades >= 3 && (t.sharpe ?? 0) > 1;
        const wins = ok(val.coinbase) && ok(val.robinhood); // debe ganar neto de costos en AMBOS exchanges
        const t = val.coinbase;
        const label = best.cfg.strategy === 'sma' ? `SMA ${best.cfg.fast}/${best.cfg.slow}` : best.cfg.strategy.toUpperCase();
        const evidence = { symbol, capital_virtual: CAPITAL, velas: closes.length, mejor_en_entrenamiento: label, entrenamiento_coinbase: best.train,
          validacion_coinbase: val.coinbase, validacion_robinhood: val.robinhood,
          advertencia: 'Capital virtual de $1M con costos ESTIMADOS (comisión por nivel, spread, impacto y latencia). Muestra corta (~50 días): no es prueba concluyente.' };
        if (wins) {
          proposals.push({ kind: 'strategy_defaults', key: `strategy:${symbol}:${label}`, title: `Usar ${label} como estrategia sugerida (superó a comprar y mantener en ${symbol}, neto de costos, en Coinbase y Robinhood)`,
            detail: { text: 'Prueba de papel con $1M virtual. Solo cambia el valor sugerido para bots nuevos; no modifica los bots existentes ni las reglas de riesgo.',
              action: { type: 'default_cfg', cfg: { strategy: best.cfg.strategy, fast: best.cfg.fast, slow: best.cfg.slow, rsiBuy: best.cfg.rsiBuy, rsiSell: best.cfg.rsiSell } } },
            evidence, touches: ['strategy_defaults'] });
        } else {
          proposals.push({ kind: 'insight', key: `insight:trading:${symbol}`, title: `${symbol}: ninguna estrategia superó a comprar y mantener fuera de muestra, neto de costos`,
            detail: { text: `Con $1M virtual, la mejor en entrenamiento (${label}) rindió ${pct(t.totalReturnPct)} en Coinbase y ${pct(val.robinhood.totalReturnPct)} en Robinhood vs ${pct(t.buyHoldPct)} de comprar y mantener. Costos: $${val.coinbase.costos_usd.toLocaleString('en-US')} (Coinbase) y $${val.robinhood.costos_usd.toLocaleString('en-US')} (Robinhood). No se recomienda cambiar nada.` },
            evidence, touches: [] });
        }
      }
      return { proposals, notes };
    },
  },

  ml_models: {
    label: 'Modelos ML', available: true,
    description: 'Entrena una regresión logística (dirección de la próxima hora) con validación walk-forward y vigila la deriva de datos. Solo propone activar el modelo si supera la línea base de forma estadísticamente significativa.',
    async run({ store, feed, now }) {
      const proposals = []; const notes = [];
      for (const symbol of WATCH) {
        let closes;
        try { closes = await feed.getHistory(symbol, 1200); } catch (e) { notes.push(`${symbol}: ${e.message}`); continue; }
        let wf;
        try { wf = walkForward(closes); } catch (e) { notes.push(`${symbol}: ${e.message}`); continue; }
        const snapshot = { symbol, trained_at: now, candles: closes.length, model: wf.model, metrics: wf.metrics, drift: wf.drift, importance: wf.importance };
        await store.setSetting(`model:candidate:${symbol}`, JSON.stringify(snapshot));
        const m = wf.metrics;
        const summary = { symbol, precision_test: m.acc_test, linea_base: m.baseline_test, z: m.z_test, n_test: m.n_test, deriva: wf.drift };
        if (m.edge) {
          proposals.push({ kind: 'model_update', key: `model:${symbol}`, title: `Activar el modelo de ${symbol} para la señal informativa (precisión ${pct(m.acc_test * 100)} vs ${pct(m.baseline_test * 100)})`,
            detail: { text: 'El modelo solo alimenta la señal informativa que ven los clientes; no opera dinero por sí solo.', action: { type: 'activate_model', symbol } },
            evidence: summary, touches: ['models'] });
        } else {
          proposals.push({ kind: 'insight', key: `insight:ml:${symbol}`, title: `${symbol}: el modelo no supera la línea base (${pct(m.acc_test * 100)} vs ${pct(m.baseline_test * 100)})`,
            detail: { text: 'Es el resultado esperado con datos de precio solamente. No se activa; se reentrenará en la próxima corrida.' }, evidence: summary, touches: [] });
        }
        const active = await store.getSetting(`model:active:${symbol}`, null);
        if (active && wf.drift.score > 1) {
          proposals.push({ kind: 'ops_alert', key: `ops:drift:${symbol}`, title: `Deriva de datos en ${symbol}: ${wf.drift.worst_feature} (${wf.drift.score.toFixed(1)} desv.)`,
            detail: { text: 'Los datos recientes se alejan de los de entrenamiento. Considera desactivar el modelo.' }, evidence: summary, touches: [] });
        }
      }
      return { proposals, notes };
    },
  },

  market_intel: {
    label: 'Inteligencia de mercado', available: true,
    description: 'Lee CoinGecko (mercado global) y el libro de órdenes real de Coinbase Exchange. Detecta el régimen de mercado y calibra los costos del laboratorio con spreads y volumen reales.',
    async run({ store, now, market }) {
      const m = await (market || getMarket)({ force: true, now });
      const notes = []; const proposals = [];
      if (m.gecko.stale) notes.push(`CoinGecko limitó el uso (429); sigo con sus últimos datos buenos, de hace ${m.gecko.staleMin} min, y reintento solo más tarde`);
      else if (!m.sources.coingecko) notes.push(`CoinGecko sin datos (${(m.gecko.errors || []).join('; ')}); el régimen se calcula con velas de Coinbase`);
      if (!m.sources.coinbase_exchange) notes.push('Coinbase Exchange sin datos de libro');
      if (m.calibration && Object.keys(m.calibration.coinbase.halfSpreadPct).length) {
        setCalibration(m.calibration);
        await store.setSetting('market:calibration', JSON.stringify(m.calibration));
        notes.push(`Costos calibrados: ${Object.entries(m.calibration.coinbase.halfSpreadPct).map(([k, v]) => `${k} medio spread ${v.toFixed(3)} %`).join(', ')}`);
      }
      let hist = []; try { hist = JSON.parse(await store.getSetting('market:history', '[]')); } catch { hist = []; }
      const btc = m.gecko.coins?.find((c) => c.symbol === 'BTC-USD');
      const prev = hist[0];
      const point = { t: now, regime: m.regime.code, btcDom: m.gecko.global?.btcDom ?? null, mcap24: m.gecko.global?.mcap24 ?? null, btc24: btc?.ch24 ?? null, btc7: btc?.ch7 ?? null,
        spread: m.books.find((b) => b.symbol === 'BTC-USD')?.spreadPct ?? null };
      hist.unshift(point);
      await store.setSetting('market:history', JSON.stringify(hist.slice(0, 200)));
      await store.setSetting('market:snapshot', JSON.stringify({ t: now, regime: m.regime, global: m.gecko.global || null, books: m.books, trending: m.gecko.trending || [] }));
      if (prev && prev.regime !== point.regime && point.regime !== 'unknown') {
        proposals.push({ kind: 'insight', key: `market:regime:${point.regime}`, title: `Régimen de mercado cambió: ${prev.regime} → ${m.regime.label}`,
          detail: { text: 'El laboratorio sigue con su campeón congelado; revisa su avance en este nuevo régimen.' }, evidence: { btc7: btc?.ch7, btc30: btc?.ch30, mcap24: m.gecko.global?.mcap24, btcDom: m.gecko.global?.btcDom }, touches: [] });
      }
      const sp = point.spread; const base = hist.slice(1, 20).map((h) => h.spread).filter((x) => x !== null);
      if (sp !== null && base.length >= 5 && sp > 3 * (base.reduce((a, b) => a + b, 0) / base.length)) {
        proposals.push({ kind: 'ops_alert', key: 'market:spread', title: `Spread de BTC inusual en Coinbase: ${sp.toFixed(3)} % (3× su media)`, detail: { text: 'Mala liquidez momentánea: los costos de ejecución reales pueden ser mayores.' }, evidence: { spread: sp }, touches: [] });
      }
      return { proposals, notes };
    },
  },

  paper_lab: {
    label: 'Laboratorio de papel $1M', available: true,
    description: 'Elige una estrategia campeona, la congela y la prueba en vivo con $1M virtual y costos de Coinbase y Robinhood. Aprende de su avance real.',
    async run({ store, feed, now }) {
      const { lab, notes } = await runLab({ store, feed, now });
      return { proposals: labProposals(lab), notes };
    },
  },

  opportunity_scanner: {
    label: 'Escáner de criptos', available: true,
    description: 'Recorre las criptos más grandes de Coinbase (CoinGecko para el ranking), prueba una estrategia en cada una con costos de Coinbase y Robinhood y rankea. Muestra la brecha de costo entre exchanges. El bot AUTO solo opera las que pasan.',
    async run({ store, feed, now }) {
      const sc = await runScanner({ store, feed, now });
      return { proposals: scannerProposals(sc), notes: [`escaneadas ${sc.scanned} de ${sc.universe} listadas; calificadas ${sc.items.filter((i) => i.qualified).length}`, ...sc.notes.slice(0, 4)] };
    },
  },

  legal_watch: {
    label: 'Abogado Quantum (cumplimiento)', available: true,
    description: 'Vigila el cumplimiento técnico en vivo: datos legales pendientes, avisos de riesgo visibles, trading real abierto sin revisión de abogado. NO es un abogado ni da asesoría legal: te deja la lista para tu abogado de Florida.',
    async run({ store }) {
      const proposals = []; const notes = ['No es asesoría legal: revisa controles técnicos y lista pendientes para tu abogado de Florida.'];
      let legal = ''; let land = ''; const rd = (f) => { try { return fs.readFileSync(new URL(`../public/${f}`, import.meta.url), 'utf8'); } catch { return ''; } };
      legal = rd('legal.html'); land = rd('landing.html');
      const open = [...new Set(legal.match(/\[[A-ZÁÉÍÓÚÑ ]{4,}\]/g) || [])];
      if (open.length) proposals.push({ kind: 'ops_alert', key: 'legal:placeholders', title: `Faltan ${open.length} dato(s) legales entre [corchetes] en legal.html`,
        detail: { text: 'Completa nombre de la empresa, dirección y correos antes de cobrar o abrir el trading real a clientes. Después pide a tu abogado de Florida que lo revise.' }, evidence: { pendientes: open.slice(0, 6) }, touches: [] });
      const miss = [];
      if (!/id="riesgo"/.test(legal)) miss.push('Aviso de riesgo en legal.html');
      if (!/id="terminos"/.test(legal)) miss.push('Términos de servicio en legal.html');
      if (!/no es asesor[ií]a de inversi/i.test(land)) miss.push('descargo de “no es asesoría” en la landing');
      if (!/FDIC/.test(land)) miss.push('aviso FDIC/SIPC en la landing');
      if (miss.length) proposals.push({ kind: 'risk_alert', key: 'legal:missing_notices', title: `Faltan avisos obligatorios: ${miss.join(', ')}`, detail: { text: 'Restaura esos textos; son parte de la postura de cumplimiento (no es asesoría de inversión, riesgo de pérdida).' }, evidence: { faltan: miss }, touches: [] });
      const live = await store.getSetting('live_trading', 'off'); const att = await store.getSetting('launch:attorney', 'no');
      if (live === 'on' && att !== 'yes') proposals.push({ kind: 'risk_alert', key: 'legal:live_open_no_attorney', title: 'El trading real está abierto a todos sin revisión de abogado marcada',
        detail: { text: 'Considera volver a «Solo yo» (Ajustes → Trading REAL) hasta que un abogado revise Términos, Privacidad y Aviso de riesgo, y marca ese paso en la lista de lanzamiento.' }, evidence: { live_trading: live, abogado_revisó: att }, touches: [] });
      notes.push(open.length || miss.length ? `pendientes: ${open.length + miss.length}` : 'sin pendientes técnicos');
      return { proposals, notes };
    },
  },
  superintendent: {
    label: 'Superintendente Quantum (supervisión)', available: true,
    description: 'Supervisa en vivo que todo funcione: escáner, noticias, bots encendidos, errores de agentes y de órdenes. Si algo se estanca, lo reporta; no cambia nada por su cuenta.',
    async run({ store, now }) {
      const proposals = []; const notes = []; const H = 3600000;
      const sc = await getScanner(store); const scAge = sc ? now - sc.t : null;
      if (scAge === null || scAge > 12 * H) proposals.push({ kind: 'ops_alert', key: 'sup:scanner_stale', title: sc ? `El escáner lleva ${Math.round(scAge / H)} h sin actualizarse` : 'El escáner aún no corrió', detail: { text: 'Fuerza el escáner en Cerebro. Si sigue fallando, revisa CoinGecko/Coinbase (límites de uso).' }, evidence: { horas: sc ? Math.round(scAge / H) : null }, touches: [] });
      notes.push(sc ? `escáner hace ${Math.round(scAge / 60000)} min` : 'escáner sin datos');
      let nw = null; try { nw = JSON.parse(await store.getSetting('news:latest', 'null')); } catch { nw = null; }
      const nAge = nw ? now - nw.t : null;
      if (nAge === null || nAge > 2 * H || (nw && nw.sources === 0)) proposals.push({ kind: 'ops_alert', key: 'sup:news_stale', title: nw ? `Las noticias llevan ${Math.round(nAge / H)} h sin actualizarse` : 'Las noticias aún no cargaron', detail: { text: 'Sin noticias, el freno de riesgo por noticias no ve nada nuevo. Revisa las fuentes RSS (CoinDesk, Cointelegraph, Decrypt, Bitcoin Magazine).' }, evidence: { horas: nw ? Math.round(nAge / H) : null }, touches: [] });
      notes.push(nw ? `noticias hace ${Math.round(nAge / 60000)} min` : 'noticias sin datos');
      const bots = (await store.listBots()).filter((b) => b.cfg && b.cfg.enabled); const stalled = bots.filter((b) => !b.last_run || now - b.last_run > 15 * 60000);
      if (stalled.length) proposals.push({ kind: 'ops_alert', key: 'sup:bots_stalled', title: `${stalled.length} bot(s) encendidos no corren desde hace más de 15 min`, detail: { text: 'El servidor pudo dormirse o reiniciarse. Con el plan de pago de Render debería quedar despierto; revisa los registros.' }, evidence: { encendidos: bots.length, detenidos: stalled.length }, touches: [] });
      notes.push(`${bots.length} bot(s) encendidos, ${stalled.length} detenidos`);
      const au = await store.listAuditSince(now - DAY); const ae = au.filter((a) => a.action === 'agent_error');
      if (ae.length) proposals.push({ kind: 'ops_alert', key: 'sup:agent_errors', title: `${ae.length} error(es) de agentes en 24 h`, detail: { text: [...new Set(ae.map((a) => a.detail))].slice(0, 3).join(' · ') }, evidence: { errores: ae.length }, touches: [] });
      notes.push(ae.length ? `${ae.length} error(es) de agentes` : 'agentes sin errores');
      return { proposals, notes };
    },
  },

  ui_landing: {
    label: 'Mejora de UI y landing', available: true,
    description: 'Audita la landing y la app con datos reales: título y descripción, un solo H1, llamada a la acción, peso de los archivos y qué textos aún no tienen traducción al inglés. Propone mejoras; no cambia el diseño por su cuenta.',
    async run() {
      const rd = (f) => { try { return fs.readFileSync(new URL(`../public/${f}`, import.meta.url), 'utf8'); } catch { return ''; } };
      const land = rd('landing.html'); const app = rd('index.html'); const proposals = []; const notes = []; const issues = [];
      if (!/<title>[^<]{3,}<\/title>/.test(land)) issues.push('la landing no tiene <title>');
      if (!/<meta name="description" content="[^"]{40,}/.test(land)) issues.push('falta una meta descripción útil (40+ caracteres)');
      if ((land.match(/<h1[\s>]/g) || []).length !== 1) issues.push('la landing debería tener exactamente un H1');
      if (!/href="\/app"/.test(land)) issues.push('la landing no enlaza a /app (llamada a la acción)');
      if ((land.match(/<img(?![^>]*\balt=)[^>]*>/g) || []).length) issues.push('hay imágenes sin texto alternativo');
      if (!/rel="manifest"/.test(app)) issues.push('la app no declara manifiesto (instalable)');
      if (!/name="theme-color"/.test(app)) issues.push('la app no declara theme-color');
      const size = (f) => rd(f).length; const kb = Math.round((size('app.js') + size('styles.css') + size('octo3d.js') + size('city3d.js')) / 1024);
      if (kb > 700) issues.push(`la app pesa ${kb} KB entre JS y CSS principales: conviene dividir o comprimir`);
      notes.push(`app ${kb} KB (JS+CSS principales)`);
      // Cobertura de inglés: textos de la landing que no están en el diccionario.
      let dict = new Set(); try { const m = await import('../public/i18n-en.js'); dict = new Set(m.default.map(([es]) => es.replace(/\s+/g, ' ').trim())); } catch { /* sin diccionario */ }
      const texts = [...land.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, '').matchAll(/>([^<>]{12,})</g)].map((x) => x[1].replace(/&[a-z#0-9]+;/g, ' ').replace(/\s+/g, ' ').trim()).filter((x) => /[a-záéíóúñ]/i.test(x));
      const miss = [...new Set(texts.filter((x) => !dict.has(x)))]; notes.push(`landing: ${texts.length - miss.length} de ${new Set(texts).size} textos con inglés`);
      if (miss.length) proposals.push({ kind: 'insight', key: 'ui:landing_untranslated', title: `${miss.length} texto(s) de la landing sin traducción al inglés`, detail: { text: 'Se verán en español al cambiar a EN. Añádelos al diccionario (public/i18n-en.js).' }, evidence: { ejemplos: miss.slice(0, 4) }, touches: [] });
      if (issues.length) proposals.push({ kind: 'insight', key: 'ui:audit', title: `Auditoría de UI/landing: ${issues.length} mejora(s) posible(s)`, detail: { text: issues.join(' · ') }, evidence: { hallazgos: issues }, touches: [] });
      notes.push(issues.length ? `${issues.length} hallazgo(s)` : 'sin hallazgos de UI');
      return { proposals, notes };
    },
  },
  client_support: {
    label: 'Soporte al cliente', available: true,
    description: 'Agrupa los problemas reales de los clientes (errores de órdenes, llaves, límites del exchange) y deja respuestas listas en español para copiar y enviar. No envía correos ni responde solo: tú decides.',
    async run({ store, now }) {
      const since = now - DAY; const orders = (await store.listAllOrdersSince(since)).filter((o) => o.status === 'error');
      const KB = [
        [/precision|nearest\s+[0-9.]+/i, 'redondeo', 'Hola. Robinhood pidió redondear la cantidad de tu orden. Nuestro bot ya lo corrige solo y reintenta; no tienes que hacer nada. Si ves el error repetirse, escríbenos con la hora y la cripto.'],
        [/insufficient|buying power|not enough|saldo/i, 'saldo', 'Hola. Tu exchange dice que no hay saldo suficiente para esa orden. Agrega fondos o baja el monto por compra en tu bot (Bot → USD por compra).'],
        [/429|too many|rate|demasiad/i, 'límite', 'Hola. El exchange pidió ir más despacio y el bot reintenta solo. Normalmente se resuelve en minutos; no hace falta que hagas nada.'],
        [/key|llave|unauthori|401|403|permission|permiso/i, 'llave', 'Hola. Tu exchange rechazó la llave. Revisa en Conectar que sea la correcta y que tenga permiso de ver y operar (nunca de retirar); si cambió, vuelve a pegarla.'],
        [/no está disponible|not available|tradable|delist/i, 'cripto', 'Hola. Esa cripto no está disponible para operar ahora en tu exchange. El bot la saltará y seguirá con otras.'],
      ];
      const groups = new Map();
      for (const o of orders) { const note = String(o.note || ''); const hit = KB.find(([re]) => re.test(note)); const k = hit ? hit[1] : 'otro'; const g = groups.get(k) || { n: 0, users: new Set(), sample: note, tpl: hit ? hit[2] : null }; g.n++; g.users.add(o.user_id); groups.set(k, g); }
      const proposals = []; const notes = [`${orders.length} error(es) de órdenes en 24 h, ${new Set(orders.map((o) => o.user_id)).size} cliente(s)`];
      for (const [k, g] of groups) {
        proposals.push({ kind: 'insight', key: `support:${k}`, title: `Soporte: ${g.n} caso(s) de “${k}” en 24 h (${g.users.size} cliente(s))`,
          detail: { text: g.tpl ? `Respuesta sugerida: ${g.tpl}` : `Sin respuesta estándar todavía. Ejemplo del error: ${g.sample.slice(0, 160)}` }, evidence: { casos: g.n, clientes: g.users.size, ejemplo: g.sample.slice(0, 120) }, touches: [] });
      }
      return { proposals, notes };
    },
  },
  ia_explainer: {
    label: 'Explicador IA (por qué compra)', available: true,
    description: 'Explica en palabras simples qué hizo el Cerebro en las últimas 24 h y por qué, solo con datos reales (órdenes, noticias, escáner). Gratis por defecto (plantillas sobre datos reales); con GEMINI_API_KEY (plan gratuito de Google) o ANTHROPIC_API_KEY redacta con IA. No opera ni decide; máximo 4 corridas al día.',
    async run({ store, now, llm }) {
      const ex = llm || createExplainer({ env: process.env });
      const day = new Date(now).toISOString().slice(0, 10); const ck = `ia:calls:${day}`; const used = Number(await store.getSetting(ck, '0')) || 0;
      if (used >= 4) return { proposals: [], notes: [`límite diario de IA alcanzado (${used}/4)`] };
      const orders = (await store.listAllOrdersSince(now - DAY)).filter((o) => o.status === 'ok').slice(-8)
        .map((o) => ({ cripto: clean(o.symbol, 20), lado: clean(o.side, 6), usd: o.usd, modo: clean(o.mode, 8), motivo: clean(o.note, 160) }));
      let nw = null; try { nw = JSON.parse(await store.getSetting('news:latest', 'null')); } catch { nw = null; }
      const heads = ((nw && nw.items) || []).slice(0, 5).map((i) => ({ titular: clean(i.title, 120), tono: i.neg ? 'negativo' : i.pos ? 'positivo' : 'neutral' }));
      const sc = await getScanner(store); const top = ((sc && (sc.top || sc.coins)) || []).slice(0, 4).map((c) => clean(c.symbol || c.sym || c.id, 20));
      if (!orders.length && !heads.length) return { proposals: [], notes: ['sin datos nuevos que explicar'] };
      await store.setSetting(ck, String(used + 1));
      const r = await ex.explain({ ordenes_24h: orders, noticias: heads, escaner_top: top });
      if (!r.ok) return { proposals: [], notes: [`IA: ${r.error}`] };
      return { proposals: [{ kind: 'insight', key: `ia:explain:${day}:${used}`, title: 'Explicación IA de lo que hizo el Cerebro (24 h)', detail: { text: r.text }, evidence: { ordenes: orders.length, titulares: heads.length, motor: ex.model || 'reglas (gratis)' }, touches: [] }], notes: [`explicación generada con ${ex.model || 'reglas'} (${used + 1}/4 hoy)${r.note ? ` · ${r.note}, usé plantilla gratis` : ''}`] };
    },
  },
};

// ---------------------------------------------------------------- Director
export function createDirector({ store, feed, market = null, agents = AGENTS, log = console }) {
  const enabledKey = (n) => `agent:${n}:enabled`;
  const isEnabled = async (n) => (await store.getSetting(enabledKey(n), 'on')) === 'on';
  const audit = (action, detail, actor = 'director') => store.addAudit({ actor, action, detail: String(detail).slice(0, 400) });

  async function logChange(entry) {
    let arr = []; try { arr = JSON.parse(await store.getSetting('brain:changes', '[]')); } catch { arr = []; }
    arr.unshift(entry);
    await store.setSetting('brain:changes', JSON.stringify(arr.slice(0, 50)));
  }
  const bump = async () => store.setSetting('brain_version', String((Number(await store.getSetting('brain_version', '1')) || 1) + 1));

  async function admit(agentName, p, g) {
    if (!KINDS.includes(p.kind) || !g.allowedKinds.includes(p.kind)) return 'tipo no permitido';
    if ((p.touches || []).some((t) => g.protectedAreas.includes(t))) return 'toca un área protegida';
    const pending = await store.listProposals('pending', 500);
    if (pending.length >= g.maxPendingProposals) return 'límite de propuestas pendientes';
    if (pending.some((x) => x.key === p.key)) return 'duplicada';
    await store.addProposal({ agent: agentName, kind: p.kind, key: p.key, title: String(p.title).slice(0, 200),
      detail: JSON.stringify(p.detail || {}), evidence: JSON.stringify(p.evidence || {}), touches: JSON.stringify(p.touches || []) });
    return null;
  }

  async function run({ now = Date.now(), trigger = 'manual' } = {}) {
    const g = await getGuardrails(store);
    const summary = [];
    for (const [name, agent] of Object.entries(agents)) {
      if (!agent.available || !(await isEnabled(name))) continue;
      let out;
      try { out = await agent.run({ store, feed, now, market }); } catch (e) { await audit('agent_error', `${name}: ${e.message}`, `agent:${name}`); summary.push({ agent: name, error: e.message }); continue; }
      let created = 0; let blocked = 0;
      for (const p of out.proposals || []) {
        const why = await admit(name, p, g);
        if (!why) created++;
        else if (why !== 'duplicada') { blocked++; await audit('agent_blocked', `${name}: ${p.kind} "${String(p.title).slice(0, 80)}" -> ${why}`, `agent:${name}`); }
      }
      await audit('agent_run', `propuestas=${created} bloqueadas=${blocked} (${trigger})`, `agent:${name}`);
      summary.push({ agent: name, created, blocked, notes: out.notes || [] });
    }
    // Piloto automático (solo si el dueño lo encendió): aplica propuestas de bajo riesgo y reversibles, con las mismas validaciones y auditoría.
    let auto = 0;
    if (g.autopilot.enabled) {
      for (const p of await store.listProposals('pending', 200)) {
        if (p.created_at < now - 60000 || !g.autopilot.kinds.includes(p.kind) || p.agent === 'director') continue;
        try { await approve(p.id, 'auto (piloto automático)', 'director:autopilot'); auto++; } catch (e) { await audit('autopilot_skip', `${p.kind}: ${e.message}`, 'director:autopilot'); }
      }
      if (auto) summary.push({ agent: 'autopilot', created: auto, blocked: 0, notes: [`Aplicó ${auto} mejora(s) de bajo riesgo (se pueden deshacer)`] });
    }
    // Los hallazgos puramente informativos (insight) no cambian nada: el Director los archiva solo. Las alertas siguen esperando al dueño.
    let acked = 0;
    for (const p of await store.listProposals('pending', 500)) {
      if (p.kind !== 'insight') continue;
      try { await approve(p.id, 'archivado por el Director (informativo)', 'director:auto'); acked++; } catch { /* queda pendiente */ }
    }
    if (acked) summary.push({ agent: 'director', created: acked, blocked: 0, notes: [`Archivó ${acked} hallazgo(s) informativos; solo te deja lo que requiere tu decisión`] });
    // El Director recomienda (nunca decide): un agente cuyas propuestas casi siempre se rechazan debería apagarse.
    const decided = await store.listProposals(null, 500);
    for (const name of Object.keys(agents)) {
      if (!agents[name].available || !(await isEnabled(name))) continue;
      const mine = decided.filter((p) => p.agent === name);
      const rej = mine.filter((p) => p.status === 'rejected').length;
      const acc = mine.filter((p) => ['approved', 'applied'].includes(p.status)).length;
      if (rej >= 5 && acc === 0) {
        await admit('director', { kind: 'agent_toggle', key: `toggle:${name}`, title: `Recomiendo desactivar a "${agents[name].label}": ${rej} propuestas rechazadas y ninguna aprobada`,
          detail: { text: 'Solo se desactiva si lo apruebas.', action: { type: 'agent_enabled', agent: name, enabled: false } },
          evidence: { rechazadas: rej, aprobadas: acc }, touches: [] }, g);
      }
    }
    try {
      const prev = JSON.parse(await store.getSetting('director:runs', '[]'));
      prev.unshift({ t: now, trigger, agents: summary.map((x) => ({ agent: x.agent, created: x.created ?? 0, blocked: x.blocked ?? 0, error: x.error || null, notes: (x.notes || []).slice(0, 4) })) });
      await store.setSetting('director:runs', JSON.stringify(prev.slice(0, 30)));
    } catch { /* el registro es opcional */ }
    await store.setSetting('director_last_run', String(now));
    await audit('director_run', `${trigger}: ${summary.length} agentes`);
    return summary;
  }

  // Deshace un cambio aplicado (restaura el valor anterior). Solo el dueño puede llamarlo (ruta protegida).
  async function undo(id, actorEmail) {
    let arr = []; try { arr = JSON.parse(await store.getSetting('brain:changes', '[]')); } catch { arr = []; }
    const c = arr.find((x) => x.id === id);
    if (!c || c.undone) throw Object.assign(new Error('Cambio no encontrado o ya deshecho'), { status: 404 });
    if (!/^(default_cfg|agent:[a-z_]+:enabled|model:active:[A-Z0-9-]+)$/.test(c.store_key)) throw Object.assign(new Error('Cambio no reversible'), { status: 400 });
    await store.setSetting(c.store_key, c.before ?? '');
    c.undone = true;
    await store.setSetting('brain:changes', JSON.stringify(arr));
    await bump();
    await audit('proposal_undone', `${c.kind}: ${c.title.slice(0, 100)}`, actorEmail);
    return { ok: true };
  }

  // Aplica una propuesta YA decidida por el dueño. Revalida todo: nunca confía en lo guardado.
  async function approve(id, note, actorEmail) {
    const p = await store.getProposal(id);
    if (!p || p.status !== 'pending') throw Object.assign(new Error('Propuesta no encontrada o ya decidida'), { status: 404 });
    const g = await getGuardrails(store);
    const touches = JSON.parse(p.touches || '[]');
    if (!g.allowedKinds.includes(p.kind) || touches.some((t) => g.protectedAreas.includes(t))) {
      await store.updateProposal(id, { status: 'failed', decided_at: Date.now(), decided_note: 'Bloqueada por tus límites' });
      throw Object.assign(new Error('La propuesta toca un área protegida o un tipo no permitido'), { status: 400 });
    }
    const detail = JSON.parse(p.detail || '{}');
    const action = detail.action;
    let changed = false; let change = null;
    if (p.kind === 'strategy_defaults' && action?.type === 'default_cfg') {
      const v = validateCfg({ ...action.cfg, mode: 'paper' }, { symbols: SYMBOLS });
      if (!v.ok) throw Object.assign(new Error(`Configuración inválida: ${v.error}`), { status: 400 });
      const { strategy, fast, slow, rsiBuy, rsiSell } = v.cfg;
      change = { store_key: 'default_cfg', before: await store.getSetting('default_cfg', ''), label: 'Estrategia sugerida' };
      await store.setSetting('default_cfg', JSON.stringify({ strategy, fast, slow, rsiBuy, rsiSell }));
      changed = true;
    } else if (p.kind === 'agent_toggle' && action?.type === 'agent_enabled' && agents[action.agent]) {
      change = { store_key: enabledKey(action.agent), before: await store.getSetting(enabledKey(action.agent), 'on'), label: `Agente ${action.agent}` };
      await store.setSetting(enabledKey(action.agent), action.enabled ? 'on' : 'off');
      changed = true;
    } else if (p.kind === 'model_update' && action?.type === 'activate_model' && SYMBOLS.includes(action.symbol)) {
      const cand = await store.getSetting(`model:candidate:${action.symbol}`, null);
      if (!cand) throw Object.assign(new Error('No hay modelo candidato'), { status: 400 });
      change = { store_key: `model:active:${action.symbol}`, before: await store.getSetting(`model:active:${action.symbol}`, ''), label: `Modelo ${action.symbol}` };
      await store.setSetting(`model:active:${action.symbol}`, cand);
      changed = true;
    } else if (STATE_KINDS.includes(p.kind)) {
      throw Object.assign(new Error('Acción de propuesta no reconocida'), { status: 400 });
    }
    if (changed) { await bump(); await logChange({ id: p.id, t: Date.now(), kind: p.kind, title: p.title.slice(0, 160), auto: String(actorEmail || '').startsWith('director:'), ...change, undone: false }); }
    await store.updateProposal(id, { status: 'applied', decided_at: Date.now(), applied_at: Date.now(), decided_note: String(note || '').slice(0, 300) });
    await audit('proposal_approved', `${p.kind}: ${p.title.slice(0, 100)}`, actorEmail);
    return { changed };
  }

  async function reject(id, note, actorEmail) {
    const p = await store.getProposal(id);
    if (!p || p.status !== 'pending') throw Object.assign(new Error('Propuesta no encontrada o ya decidida'), { status: 404 });
    await store.updateProposal(id, { status: 'rejected', decided_at: Date.now(), decided_note: String(note || '').slice(0, 300) });
    await audit('proposal_rejected', `${p.kind}: ${p.title.slice(0, 100)}`, actorEmail);
  }

  async function setAgentEnabled(name, enabled, actorEmail) {
    if (!agents[name] || !agents[name].available) throw Object.assign(new Error('Agente no disponible'), { status: 404 });
    await store.setSetting(enabledKey(name), enabled ? 'on' : 'off');
    await audit('agent_toggle', `${name} -> ${enabled ? 'on' : 'off'}`, actorEmail);
  }

  async function overview() {
    const out = [];
    for (const [name, a] of Object.entries(agents)) out.push({ name, label: a.label, description: a.description, available: a.available, reason: a.reason || null, enabled: a.available && (await isEnabled(name)) });
    return out;
  }

  // Señal informativa: si hay modelo activo para el símbolo, devuelve probabilidad y explicación.
  async function signal(symbol, closes) {
    const raw = await store.getSetting(`model:active:${symbol}`, null);
    if (!raw || closes.length < 80) return null;
    const snap = JSON.parse(raw);
    const x = features(closes, closes.length - 1);
    return { prob_up: predictProb(snap.model, x), trained_at: snap.trained_at, test_accuracy: snap.metrics.acc_test, baseline: snap.metrics.baseline_test,
      why: explain(snap.model, x).slice(0, 3) };
  }

  return { run, approve, reject, undo, setAgentEnabled, overview, signal, agents };
}
