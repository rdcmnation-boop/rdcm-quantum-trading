import http from 'node:http';
import crypto from 'node:crypto';
import { createApp } from './lib/app.js';
import { setCalibration, setRobinhoodSpreads } from './lib/costs.js';
import { createEngine } from './lib/engine.js';
import { createDirector, getGuardrails } from './lib/agents.js';
import { memoryStore, pgStore } from './lib/store.js';
import { runScanner, getScanner } from './lib/scanner.js';
import { fetchNews } from './lib/news.js';
import { notifyNews, notifyUser } from './lib/push.js';
import { reconcileAll } from './lib/reconcile.js';
import { ADAPTERS, getPrice, getCloses, getHistory, getCandles } from './lib/exchanges.js';

const env = { ...process.env };
const prod = env.NODE_ENV === 'production';
const PORT = Number(env.PORT) || 3000;

for (const k of ['SESSION_SECRET', 'ENCRYPTION_KEY']) {
  if (!env[k] || env[k].length < 32) {
    if (prod) { console.error(`Falta ${k} (mínimo 32 caracteres). Abortando.`); process.exit(1); }
    env[k] = crypto.randomBytes(32).toString('hex');
    console.warn(`${k} temporal generada (solo desarrollo).`);
  }
}

let store;
if (env.DATABASE_URL) {
  store = await pgStore(env.DATABASE_URL, { ssl: prod, verify: env.PG_SSL_VERIFY === '1', max: Number(env.PG_POOL_MAX) || 8 });
} else if (prod) {
  console.error('Falta DATABASE_URL en producción. Abortando.');
  process.exit(1);
} else {
  console.warn('Sin DATABASE_URL: usando memoria (se pierde al reiniciar).');
  store = memoryStore();
}

const feed = { getPrice, getCloses, getHistory, getCandles };
const engine = createEngine({ store, adapters: ADAPTERS, feed, encKey: env.ENCRYPTION_KEY, alert: (uid, a) => notifyUser(store, uid, a, { subject: env.PUSH_SUBJECT || env.RENDER_EXTERNAL_URL || 'https://quantum-trading.invalid' }) });
const director = createDirector({ store, feed });
const app = createApp({ store, env, adapters: ADAPTERS, feed, engine, director });
await app.bootstrap();
try { setCalibration(JSON.parse(await store.getSetting('market:calibration', 'null'))); } catch { /* sin calibración previa */ }
try { setRobinhoodSpreads(JSON.parse(await store.getSetting('market:rhspread', '{}'))); } catch { /* sin spreads de Robinhood */ }

const server = http.createServer(app.handler);
server.listen(PORT, '0.0.0.0', () => console.log(`Quantum Trading escuchando en :${PORT}`));

const instanceId = crypto.randomUUID();
const leader = async (name, ttl) => (store.acquireLease ? store.acquireLease(name, instanceId, ttl) : true);
const timer = setInterval(() => engine.tick().catch((e) => console.error('tick', e.message)), 15000);
// El Director corre solo cada N horas (ver límites del dueño). Solo PROPONE; nada se aplica sin tu aprobación.
const autoTimer = setInterval(async () => {
  try {
    if (!(await leader('director', 25 * 60000))) return;
    const g = await getGuardrails(store);
    const last = Number(await store.getSetting('director_last_run', '0')) || 0;
    if (Date.now() - last >= g.autoRunHours * 3600000) await director.run({ trigger: 'auto' });
  } catch (e) { console.error('director', e.message); }
}, 30 * 60000);
// Conciliación con el broker cada minuto: confirma ejecuciones, parciales, cancelaciones y rechazos reales (una sola instancia a la vez).
const recTimer = setInterval(async () => {
  try { if (!(await leader('reconcile', 50000))) return; const r = await reconcileAll({ store, adapters: ADAPTERS, encKey: env.ENCRYPTION_KEY }); if (r.checked) console.log('conciliación', JSON.stringify(r)); }
  catch (e) { console.error('conciliación', e.message); }
}, 60000);
// Aviso de «subió, conviene vender»: cada 5 min revisa las posiciones de quienes activaron avisos (una sola instancia a la vez).
const sellTimer = setInterval(async () => {
  try { if (!(await leader('sellwatch', 4 * 60000))) return; await engine.sellWatch(); await engine.resolveEdgeOutcomes(); } catch (e) { console.error('sellwatch', e.message); }
}, 5 * 60000);
// Aviso de oportunidad de compra (solo si cumple todos los filtros): cada 10 min, una sola instancia a la vez.
const buyTimer = setInterval(async () => {
  try { if (!(await leader('buywatch', 9 * 60000))) return; await engine.buyWatch(); } catch (e) { console.error('buywatch', e.message); }
}, 10 * 60000);
// El escáner de criptos (alimenta el modo AUTO) corre al arrancar y se refresca cada 6 h, sin esperar al Director.
const scan = async () => {
  try { if (!(await leader('scanner', 5 * 60000))) return; const sc = await getScanner(store); if (!sc || Date.now() - sc.t > 6 * 3600000) await runScanner({ store, feed }); } catch (e) { console.error('escáner', e.message); }
};
setTimeout(scan, 15000);
// Noticias: titulares públicos cada 5 min; solo sirven de freno de riesgo para el modo Pro.
const newsRun = async () => { try { if (!(await leader('news', 4 * 60000))) return; const n = await fetchNews(); if (n.sources) { await store.setSetting('news:latest', JSON.stringify(n)); await notifyNews(store, n, { subject: env.PUSH_SUBJECT || env.RENDER_EXTERNAL_URL || 'https://quantum-trading.invalid' }); } } catch (e) { console.error('noticias', e.message); } };
setTimeout(newsRun, 20000);
const newsTimer = setInterval(newsRun, 5 * 60000);
// Plan gratis de Render: se duerme sin visitas y el bot se detendría. Un ping propio al dominio público lo mantiene despierto.
let keepTimer = null;
if (env.RENDER_EXTERNAL_URL) keepTimer = setInterval(() => { fetch(`${env.RENDER_EXTERNAL_URL}/api/health`).catch(() => {}); }, 10 * 60000);
const scanTimer = setInterval(scan, 30 * 60000);
// Apagado ordenado: deja de aceptar peticiones, no inicia ciclos nuevos, espera al ciclo del motor en curso y cierra la base de datos.
let shuttingDown = false;
async function shutdown(sig) {
  if (shuttingDown) return; shuttingDown = true;
  console.log(JSON.stringify({ level: 'info', msg: `señal ${sig}: apagado ordenado` }));
  const force = setTimeout(() => { console.error('apagado forzado por tiempo'); process.exit(1); }, 25000); force.unref();
  for (const t of [timer, recTimer, autoTimer, scanTimer, newsTimer, keepTimer, sellTimer, buyTimer]) if (t) clearInterval(t);
  server.close();
  try { const idle = await engine.stop(20000); if (!idle) console.error('el ciclo del motor no terminó a tiempo'); } catch (e) { console.error('engine.stop', e.message); }
  try { await store.close(); } catch (e) { console.error('store.close', e.message); }
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM')); process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (e) => console.error(JSON.stringify({ level: 'error', msg: 'unhandledRejection', detail: String(e && e.message || e).slice(0, 300) })));
process.on('uncaughtException', (e) => { console.error(JSON.stringify({ level: 'error', msg: 'uncaughtException', detail: String(e && e.message || e).slice(0, 300) })); shutdown('uncaughtException'); });
