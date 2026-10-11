import http from 'node:http';
import crypto from 'node:crypto';
import { createApp } from './lib/app.js';
import { createEngine } from './lib/engine.js';
import { memoryStore, pgStore } from './lib/store.js';
import { ADAPTERS, getPrice, getCloses } from './lib/exchanges.js';

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

const feed = { getPrice, getCloses };
const engine = createEngine({ store, adapters: ADAPTERS, feed, encKey: env.ENCRYPTION_KEY });
const app = createApp({ store, env, adapters: ADAPTERS, feed, engine });
await app.bootstrap();

const server = http.createServer(app.handler);
server.listen(PORT, '0.0.0.0', () => console.log(`Quantum Trading escuchando en :${PORT}`));

const timer = setInterval(() => engine.tick().catch((e) => console.error('tick', e.message)), 60000);
process.on('SIGTERM', () => { clearInterval(timer); server.close(() => process.exit(0)); });
