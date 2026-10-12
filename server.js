import http from 'node:http';
import crypto from 'node:crypto';
import { createApp } from './lib/app.js';
import { setCalibration, setRobinhoodSpreads } from './lib/costs.js';
import { createEngine } from './lib/engine.js';
import { createDirector, getGuardrails } from './lib/agents.js';
import { memoryStore, pgStore } from './lib/store.js';
import { runScanner, getScanner } from './lib/scanner.js';
import { fetchNews } from './lib/news.js';
import { notifyNews } from './lib/push.js';
import { ADAPTERS, getPrice, getCloses, getHistory } from './lib/exchanges.js';

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
  store = await pgStore(env.DATABASE_URL, { ssl: prod });
} else if (prod) {
  console.error('Falta DATABASE_URL en producción. Abortando.');
  process.exit(1);
} else {
  console.warn('Sin DATABASE_URL: usando memoria (se pierde al reiniciar).');
  store = memoryStore();
}

const feed = { getPrice, getCloses, getHistory };
const engine = createEngine({ store, adapters: ADAPTERS, feed, encKey: env.ENCRYPTION_KEY });
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
process.on('SIGTERM', () => { clearInterval(timer); clearInterval(autoTimer); clearInterval(scanTimer); clearInterval(newsTimer); if (keepTimer) clearInterval(keepTimer); server.close(() => process.exit(0)); });
