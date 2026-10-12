# RDCMNATION QUANTUM — Informe de auditoría 01 (solo lectura)

Fecha: 2026-10-11 · Versión auditada: 19.25.1 · Repo: rdcm-quantum-trading, rama `v3-brain` → `quantum-trading`
Método: lectura del código real (`lib/`, `server.js`, `bot/`, `public/`, `render.yaml`, `tests/`) y ejecución de `node tests/run.mjs` (**368 ok, 0 fallos**, ejecutado hoy en el sandbox).
Límites de esta auditoría: no pude alcanzar el dominio de producción desde el sandbox (sin respuesta de `/api/health`), no vi el panel de Render ni sus variables de entorno, y no probé ningún exchange real. Todo lo que dependa de eso figura como **no verificado**.

## 1. Estructura real
Node ESM, **una sola dependencia (`pg`)**. ~22 800 líneas entre código, pruebas y capturas.
| Capa | Archivos |
|---|---|
| Servidor y timers | `server.js` (HTTP, `setInterval`: motor 15 s, Director 30 min, escáner, noticias 5 min, keep-alive) |
| API (67 rutas `/api/*`) | `lib/app.js` (1 208 líneas) |
| Datos | `lib/store.js`: memoria (tests) o Postgres, `CREATE TABLE IF NOT EXISTS` |
| Motor de bots | `lib/engine.js`, `lib/strategy.js`, `lib/pro.js`, `lib/costs.js`, `bot/runner.js` |
| Exchanges | `lib/exchanges.js` (Coinbase, Robinhood) |
| Mercado | `lib/market.js`, `lib/scanner.js`, `lib/universe.js`, `lib/news.js`, `lib/timemachine.js` |
| Agentes | `lib/agents.js` (12 agentes), `lib/lab.js`, `lib/ml.js` |
| Seguridad | `lib/security.js` (scrypt, HMAC de sesión, AES-256-GCM, TOTP, limitador) |
| Frontend | `public/` (vanilla JS, `app.js` 1 419 líneas, 3D, i18n ES/EN) |
Tablas Postgres: `users, connections, bots, orders, audit, settings, proposals` (7).

## 2. Clasificación de funciones
Leyenda: **I** implementado y probado · **P** parcial · **S** simulado · **R** roto/riesgo comprobado · **N** no existe

| Área | Estado | Evidencia |
|---|---|---|
| Registro/login, scrypt, cookie httpOnly SameSite=Strict, CSRF por cabecera | I | `security.js`, `app.js:1176` |
| Revocación de sesión | P | `sv` en usuario (`app.js:140`); sesión dura 12 h, sin lista de dispositivos |
| MFA TOTP del dueño | P | existe (`/api/owner/2fa/*`); no es obligatorio para el dueño ni opcional para clientes |
| Verificación de email | **N** | no hay ruta ni envío de correo |
| Recuperación de contraseña | **N** | solo `POST /api/me/password` con sesión activa |
| Aislamiento entre clientes | P | las funciones de `store` reciben `user_id` y hay prueba «cada quien solo ve lo suyo»; **no** hay prueba cruzada exhaustiva por ruta, y `tenant` = `user_id` (sin organizaciones/Business) |
| Cifrado de llaves de exchange | I | AES-256-GCM (`security.js:64`); llave derivada con SHA-256 simple (sin KDF/rotación; rotación manual invalida las llaves, documentado en `app.js:1045`) |
| Conexión: exige permiso de trading y rechaza permiso de transferencia | I | `engine.js:~420` (`can_trade && !can_transfer`) |
| Bot en papel | S (declarado) | `engine.js:94-108` simula con costos calibrados; etiquetado como simulación |
| Bot en vivo (órdenes reales) | **P / R** | ver §3 |
| Estados del bot | **N** | solo `cfg.enabled` booleano; un bot por usuario (`getBot(user_id)`) |
| Ciclo de vida de la orden | **N** | `status` solo `'ok'` o `'error'` (`engine.js:449,453`); no hay señal/enviada/confirmada/parcial/cancelada |
| Gestión de riesgo | P | topes por orden/día, stop-loss, freno de pérdida diaria (Pro), kill por cliente, bloqueo por «futuro» (Time Machine). Aplicada **dentro del engine por bot**, no en una puerta central ni con reserva atómica |
| Parada de emergencia global | P | `POST /api/bot/kill` por cliente; interruptor `live_trading` off/owner/on para toda la plataforma. No hay estado EMERGENCY_STOP persistido ni política documentada de órdenes abiertas |
| Reconciliación con el broker | **N** | no se consulta el fill real; `reconcile` en `verify.js` compara series, no órdenes |
| Datos de mercado: frescura | P | cachés con `stale` (`market.js:115`); el motor **no rechaza** explícitamente precios viejos por edad máxima |
| Rate limits | P | limitador por IP/ruta (`createLimiter`); 429 de exchanges se reintenta por tick |
| Director/agentes | I (reglas) | 12 agentes deterministas que solo proponen; el dueño aprueba. No hay LLM salvo el explicador opcional |
| Facturación, planes, webhooks | **N** | `billing: 'pendiente'` (`app.js:776`); `/api/public/plan` es informativo |
| Panel del cliente: métricas | P | provienen de la tabla `orders` (ver §4) |
| Salud/operaciones | P | `/api/health` simple; sin readiness, métricas, alertas ni rastreo de errores |
| Pruebas | I | 368 pruebas propias en un solo archivo (sin framework); sin CI configurado |

## 3. Hallazgos críticos (ordenados por riesgo)
**C1 — Órdenes en vivo se registran como «ok» sin confirmación de fill.** `placeLive` guarda `status:'ok'` en cuanto el exchange acepta la solicitud, con `qty = usd/price` **estimados** (la nota lo admite: «precio y cantidad estimados»). Consecuencia: el P&L, el gasto diario y las posiciones del cliente se calculan con estimaciones, no con ejecuciones reales; una orden rechazada después, parcial o cancelada se vería como completa.
**C2 — Sin idempotencia estable.** `client_order_id: crypto.randomUUID()` se genera en cada llamada (`exchanges.js:97,105,213`). Un reintento tras timeout, o un reinicio entre «enviar» y «guardar», puede duplicar la orden real.
**C3 — Un solo proceso, sin bloqueo en base de datos.** El motor corre con `setInterval` dentro del proceso web. Si Render levanta dos instancias (deploy solapado, escalado), ambas ejecutarán los mismos bots. El único freno es `last_run` leído/escrito sin transacción (`engine.js:~417`): no es atómico.
**C4 — Riesgo no centralizado ni atómico.** El tope diario se calcula leyendo órdenes pasadas y luego se envía (`engine.js:82`): dos señales simultáneas (AUTO con varios símbolos, o dos instancias) pueden superar el límite. Si falta configuración, se aplican valores por defecto (no falla cerrado).
**C5 — Despliegue: `render.yaml` declara `plan: free` para web y base de datos.** Dices que tienes plan de pago: **verifica en el panel**. Si la base de datos es del plan gratuito de Render, caduca y se borra a los 30 días; el servicio web gratuito se duerme (el código ya lo compensa con un ping propio, que no es una solución de producción). No verificado: no tengo acceso al panel.
**C6 — Sin copias de seguridad ni restauración probada, sin migraciones versionadas.** El esquema se crea con `CREATE TABLE IF NOT EXISTS`; un cambio de columna futuro requiere migración manual. `ssl: { rejectUnauthorized: false }` en el pool (acepta cualquier certificado).
**C7 — Sin verificación de correo ni recuperación de contraseña.** Cualquiera puede registrarse con un correo ajeno y no hay vía de recuperación para clientes.

## 4. Origen de cada métrica del panel
| Métrica | Fuente real | Observación |
|---|---|---|
| Resultado/P&L de papel | tabla `orders` modo `paper`, simulado con costos de `costs.js` | declarado simulación |
| P&L «real» | tabla `orders` modo `live`, estado `ok` | **usa cantidades estimadas (C1)**; no incluye comisiones reales del broker |
| Gasto del día | suma de órdenes 24 h | no reserva capacidad (C4) |
| Saldos | `GET /api/connections/:id/balances` → API del exchange en tiempo real | real, no persistido ni con marca de tiempo de valoración en BD |
| Win rate / profit factor | calculados sobre `orders` cerradas | tamaño de muestra no siempre visible |
| Equity, buying power, posiciones reconciliadas, comisiones reales, retiros/depósitos | **no existen** | no se pueden mostrar sin integrar fills y transferencias |
| Estado de feeds | `market.js` (`stale`) y `sources` | parcial |

## 5. Lo que ya está bien (conservar)
Solo-propuesta de agentes con aprobación del dueño; trading en vivo apagado por defecto y bloqueado por el interruptor de plataforma; exigencia de permiso sin transferencia; confirmación de riesgo (`liveAck`); kill por cliente; la voz nunca opera ni inicia sesión; cifrado de llaves y TOTP sellado; CSP estricta; límites de tasa; exportación y borrado de cuenta; auditoría de acciones; etiquetado honesto de simulaciones.

## 6. Plan por fases (cada una con pruebas y migración reversible)
| Fase | Alcance | Cierra |
|---|---|---|
| 1 | Libro mayor de órdenes con ciclo de vida (`signal → submitted → confirmed → partial → filled / cancelled / rejected`), `client_order_id` determinista guardado **antes** de enviar, tabla `order_events`, migración aditiva | C1, C2 |
| 2 | Puerta de riesgo central: reserva atómica en Postgres (`risk_reservations`), límites persistidos, falla cerrada, bloqueo (`FOR UPDATE`/advisory lock) por tenant | C4 |
| 3 | Bloqueo de líder para el motor (advisory lock) + estados del bot persistidos + EMERGENCY_STOP | C3 |
| 4 | Reconciliación: consultar órdenes/fills al broker, corregir cantidades y comisiones reales, métricas desde fills | C1, §4 |
| 5 | Operación: migraciones versionadas, readiness/liveness, copias de seguridad y restauración probada, verificación del plan de Render | C5, C6 |
| 6 | Cuentas: verificación de correo, recuperación, MFA opcional/obligatorio para admins (requiere proveedor de correo) | C7 |
| 7 | Facturación (Stripe) con webhooks idempotentes y límites por plan | N |
| 8 | Lanzamiento: revisión legal/regulatoria profesional, licencias de datos y bibliotecas | — |
Regla: **no activar trading real para clientes** antes de cerrar las fases 1–5 y probarlas contra el sandbox/papel de cada broker.

## 7. Riesgos sin resolver y supuestos
- Rutas y ciclo de vida reales de Coinbase/Robinhood: no verificados contra la documentación oficial en esta auditoría (Fase 4 lo exige).
- Plan, variables y backups reales de Render: no verificados.
- Revisión de abogado, licencias de datos de mercado y de bibliotecas: pendiente (`package.json` declara `UNLICENSED`; solo `pg` como dependencia, licencia MIT, por confirmar).
- El enlace de producción no respondió desde el sandbox: el estado en vivo está sin comprobar.
