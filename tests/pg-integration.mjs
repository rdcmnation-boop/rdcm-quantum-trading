// Pruebas de integración contra un Postgres REAL (o su imitación local por psql). Se ejecuta solo si hay TEST_DATABASE_URL.
//   TEST_DATABASE_URL=postgres://... node tests/pg-integration.mjs      (¡borra las tablas de esa base de datos!)
import { pgStore } from '../lib/store.js';
const url = process.env.TEST_DATABASE_URL;
if (!url) { console.log('TEST_DATABASE_URL no definido: pruebas de Postgres omitidas'); process.exit(0); }
let pass = 0; let fail = 0;
const t = (name, ok, extra = '') => { if (ok) { pass++; console.log(`  ok   ${name}`); } else { fail++; console.log(`  FAIL ${name} ${extra}`); } };
const store = await pgStore(url, { ssl: false });
await store.dropAllForTests();
await store.init(); await store.init();
t('migraciones: se aplican dos veces sin error (idempotentes)', true);
const mig = await store.migrationStatus(); t('migraciones: quedan registradas y ordenadas', mig.length >= 3 && mig.every((m, i) => i === 0 || m.id > mig[i - 1].id), JSON.stringify(mig));

const u = await store.createUser({ email: 'pg@demo.com', pass_hash: 'x' }); const u2 = await store.createUser({ email: 'pg2@demo.com', pass_hash: 'x' });
const base = (n, extra = {}) => ({ user_id: u.id, mode: 'live', exchange: 'coinbase', symbol: 'BTC-USD', side: 'buy', usd: 30, qty: 0.0003, price: 100000, client_order_id: `K${n}`, ...extra });
const same = await Promise.all(Array.from({ length: 20 }, () => store.reserveOrder(base('dup'))));
t('Postgres: 20 reservas simultáneas con el mismo ID crean 1 sola orden', same.filter((r) => r.created).length === 1 && (await store.listOrders(u.id)).length === 1);
t('Postgres: el mismo ID en otro cliente es independiente', (await store.reserveOrder({ ...base('dup'), user_id: u2.id })).created);
const L = { maxDaily: 100, maxOpen: 99, maxPerHour: 99, maxRejects: 3 };
const many = await Promise.all(Array.from({ length: 12 }, (_, i) => store.reserveOrder(base(`c${i}`), L)));
const made = many.filter((r) => r.created).length;
t('Postgres: 12 señales simultáneas de $30 con tope diario $100 crean exactamente 2 nuevas (con la ya existente suman $90 ≤ $100; el candado por cliente funciona)', made === 2, `creadas=${made}`);
t('Postgres: lo bloqueado trae motivo', many.filter((r) => r.blocked).every((r) => r.blocked === 'daily_cap'));
t('Postgres: el gasto diario cuenta lo reservado', (await store.liveUsdSince(u.id, 0)) <= 100 + 1e-9 && Math.abs((await store.liveUsdSince(u.id, 0)) - 90) < 1e-9);

const first = (await store.listOrders(u.id)).find((o) => o.client_order_id === 'K' + 'dup');
const bad = await store.transitionOrder(u.id, first.id, 'filled'); t('Postgres: transición inválida rechazada', bad.ok === false && (await store.listOrders(u.id)).find((o) => o.id === first.id).lifecycle === 'submitting');
await store.transitionOrder(u.id, first.id, 'submitted', { ext_id: 'X1' }, 'aceptada'); await store.transitionOrder(u.id, first.id, 'partial', { filled_qty: 0.0001 }, 'parcial');
const fin = await store.transitionOrder(u.id, first.id, 'filled', { filled_qty: 0.0003, fee_usd: 0.18, qty: 0.0003, price: 100100, usd: 30.18 }, 'completa');
t('Postgres: ciclo completo con eventos y valores reales', fin.ok && fin.order.lifecycle === 'filled' && fin.order.fee_usd === 0.18 && fin.order.price === 100100 && (await store.listOrderEvents(u.id, first.id)).map((e) => e.to_state).join() === 'submitting,submitted,partial,filled');
t('Postgres: eventos aislados por cliente', (await store.listOrderEvents(u2.id, first.id)).length === 0 && (await store.transitionOrder(u2.id, first.id, 'cancelled')).ok === false);
t('Postgres: listOrdersByLifecycle', (await store.listOrdersByLifecycle(['submitting'], 0)).length >= 1 && (await store.listOrdersByLifecycle(['filled'], 0)).length === 1);
await store.reserveOrder({ ...base('rj1', { usd: 1 }) }); const rj = (await store.listOrders(u.id)).find((o) => o.client_order_id === 'Krj1'); await store.transitionOrder(u.id, rj.id, 'rejected');

// Candado de líder
await Promise.all(['A', 'B', 'C', 'D'].map((h) => store.acquireLease('engine', h, 5000)));
const holders = []; for (const h of ['A', 'B', 'C', 'D']) if (await store.acquireLease('engine', h, 5000)) holders.push(h);
t('Postgres: candado de líder: solo un titular a la vez y puede renovar', holders.length === 1);
await store.releaseLease('engine', holders[0]); t('Postgres: al soltarlo otro lo toma', await store.acquireLease('engine', 'Z', 5000));
await new Promise((r) => setTimeout(r, 60)); t('Postgres: caduca y otro toma el relevo', await store.acquireLease('short', 'A', 20) && (await new Promise((r) => setTimeout(r, 40)), await store.acquireLease('short', 'B', 20)));

// Estados del bot
await store.saveBot(u.id, { symbol: 'BTC-USD', enabled: true, mode: 'paper' });
t('Postgres: bot encendido → RUNNING con historial', (await store.getBot(u.id)).state === 'RUNNING' && (await store.listBotEvents(u.id)).map((e) => e.to_state).reverse().join() === 'CREATED,CONFIGURED,VALIDATING,RUNNING');
t('Postgres: transición de bot inválida rechazada', (await store.setBotState(u.id, 'CREATED')).ok === false);
const b = await store.getBot(u.id); await store.patchBot(u.id, { cfg: { ...b.cfg, enabled: false } });
t('Postgres: apagar → STOPPED', (await store.getBot(u.id)).state === 'STOPPED' && (await store.getBot(u.id)).strategy_version === 'qt-2026.10');
await store.saveBot(u.id, { symbol: 'BTC-USD', enabled: true, mode: 'live' }); await store.setBotState(u.id, 'EMERGENCY_STOP', 'prueba'); t('Postgres: EMERGENCY_STOP y vuelta a RUNNING', (await store.getBot(u.id)).state === 'EMERGENCY_STOP' && (await store.setBotState(u.id, 'RUNNING', 'levantada')).state === 'RUNNING');

// Borrado de cuenta: todo, incluido el libro de órdenes
await store.deleteUserData(u.id);
t('Postgres: borrar la cuenta borra órdenes, eventos y bot', (await store.listOrders(u.id)).length === 0 && (await store.listOrderEvents(u.id, first.id)).length === 0 && (await store.getBot(u.id)) === null && (await store.getUserById(u.id)) === null);
console.log(`\n${pass} ok, ${fail} fallos`); await store.close(); process.exit(fail ? 1 : 0);
