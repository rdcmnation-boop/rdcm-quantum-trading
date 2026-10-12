# Operación en producción (Fase 5)

## Evidencia de esta fase (ejecutada en el entorno de desarrollo, no en producción)
| Comprobación | Resultado |
|---|---|
| `node tests/run.mjs` | 459 ok, 0 fallos |
| `tests/pg-integration.mjs` contra **PostgreSQL 16 real** (transporte por `psql`; el driver `pg` no se pudo instalar aquí) | 19 ok, 0 fallos: migraciones idempotentes, reserva atómica (20 concurrentes → 1), tope diario concurrente, transiciones, candado de líder, estados de bot, borrado de cuenta |
| Arranque completo en `NODE_ENV=production` contra Postgres real | migraciones 1-3 aplicadas; `ops/smoke.sh` → SMOKE OK (8/8) |
| Caída de la base de datos | `/api/live` 200, `/api/ready` **503**, `/api/health` 200; al volver la BD, `/api/ready` 200 |
| `SIGTERM` | «apagado ordenado»: cierra el servidor, espera el ciclo del motor, cierra la BD y sale |
| `ops/backup.sh` + `ops/restore-test.sh` (pg_dump real → restauración en otra BD) | todas las tablas con las mismas filas: «RESTAURACIÓN VERIFICADA» |
**No verificado**: el driver `pg` real contra Postgres (lo cubre el CI de `.github/workflows/ci.yml`, que aún no se ha ejecutado), el servicio real de Render, las variables reales, los respaldos automáticos de Render, alertas y rastreo de errores externos.

## Endpoints y registros
- `GET /api/live` (proceso vivo), `GET /api/ready` (arranque terminado + BD responde; 503 si no), `GET /api/health` (versión y tipo de BD; úsalo como `healthCheckPath` de Render: un `ready` en rojo por un fallo breve de la BD no debe reiniciar el servicio).
- `GET /api/owner/metrics` (solo dueño, formato Prometheus): peticiones por clase, errores, órdenes 24 h por estado, bots por estado.
- Cada petición deja una línea JSON `{t, level, rid, method, path, status, ms, uid}` y la cabecera `X-Request-Id`. No se registran cuerpos, cookies, cabeceras ni la query. `LOG_REQUESTS=off` lo apaga; en desarrollo se activa con `LOG_REQUESTS=on`.
- Alertas recomendadas (a configurar en Render/UptimeRobot/etc., **no están creadas**): `/api/ready` ≠ 200 durante 2 min; `qt_errors_total` creciendo; `qt_bots{state="ERROR"}` > 0; `qt_orders_24h{lifecycle="unknown"}` > 0 durante más de 15 min; conciliación con errores (auditoría `reconcile_error`).

## Variables de entorno
`DATABASE_URL`, `SESSION_SECRET`, `ENCRYPTION_KEY` (≥ 32 caracteres, distintas), `OWNER_EMAIL`, `OWNER_PASSWORD` (se escriben en el panel de Render, nunca en el chat ni en el repo). Opcionales: `PG_POOL_MAX` (8), `PG_SSL_VERIFY=1` (verifica el certificado de la BD; por defecto **no** se verifica porque la URL interna de Render no trae una CA propia: riesgo aceptado, revisar), `LOG_REQUESTS`.

## Despliegue
1. Merge a la rama `quantum-trading` → Render construye (`npm install`) y arranca (`npm start`).
2. Al arrancar se aplican las migraciones pendientes bajo un candado de base de datos. Son **solo aditivas**.
3. Verifica: `ops/smoke.sh https://tu-app.onrender.com` (debe terminar en SMOKE OK). El smoke **no** prueba que el trading funcione.
4. Trading real sigue apagado por defecto; ver `docs/RISK.md` antes de abrirlo.
**Staging** (recomendado antes de abrir trading real): segundo servicio y segunda base de datos en Render con otras `SESSION_SECRET/ENCRYPTION_KEY`, sin `OWNER_PASSWORD` real, modo papel. No hay uno creado.

## Reversión
- Código: en Render → Deploys → «Rollback» al despliegue anterior (o `git revert` y push). Las migraciones no tienen «down»: el código anterior ignora las columnas y tablas nuevas, así que revertir es seguro.
- Si hay una orden `submitting`/`unknown` después de revertir: la conciliación (versión ≥ 19.29) las resuelve; con una versión anterior, revisa el broker a mano.
- Emergencia: Ajustes (dueño) → «ACTIVAR parada de emergencia» (ver `docs/RISK.md`) y, si hace falta, apaga el trading real para todos.

## Respaldos y recuperación (objetivos propuestos, NO garantías)
- Respaldo lógico: `DATABASE_URL=… ops/backup.sh ./backups`. Guárdalo fuera de Render y cifrado (contiene correos y llaves API **cifradas**; la `ENCRYPTION_KEY` se guarda por separado: sin ella las llaves no se pueden abrir).
- Prueba de restauración: `SOURCE_URL=… SCRATCH_URL=<BD desechable> ops/restore-test.sh archivo.sql.gz`.
- Render con plan de pago ofrece respaldos automáticos/recuperación a un punto en el tiempo: **confirma en el panel** que estén activos y su retención antes de afirmar un RPO.
- Objetivos propuestos para validar: RPO ≤ 24 h con respaldo diario (o menos con PITR de Render), RTO ≤ 4 h (restaurar en una BD nueva, cambiar `DATABASE_URL`, redeploy, `smoke.sh`, conciliar).
- Recuperación total: nueva BD → `gunzip -c respaldo | psql NUEVA_URL` → apuntar `DATABASE_URL` → desplegar → `smoke.sh` → `POST /api/owner/reconcile` → revisar órdenes `unknown`.

## Respuesta a incidentes (resumen; el procedimiento formal es parte de la Fase 8)
1. Contener: parada de emergencia; si es una filtración de llaves, pedir a los clientes revocar las llaves en su broker (el broker es la fuente de verdad) y rotar `ENCRYPTION_KEY` (invalida las llaves guardadas).
2. Evaluar: auditoría (`/api/owner/audit`), actor `risk`/`reconcile`/`engine`, métricas, registros con `rid`.
3. Recuperar y comunicar a los clientes afectados; asesoría legal sobre obligaciones de notificación (Florida).

## Pendiente de la Fase 5
Worker/cola duradera separados del proceso web (hoy hay candado de líder, no cola); rastreo de errores externo (Sentry u otro); alertas reales; staging real; CI ejecutado; prueba con el driver `pg` real en CI.
