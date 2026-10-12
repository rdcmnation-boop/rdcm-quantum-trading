# Notas de versión

## 19.32 — Planes y facturación
## 19.36 — Audio y meta de ganancia
Botón 🔈 en cada sección (lee título y contenido). Nueva «meta de ganancia» (neta de costos en AUTO) para vender y seguir buscando; el stop-loss se mantiene.

## 19.34 — Cerrar todo y operación manual
El kill switch ahora **cierra todas las posiciones y apaga** (solo vende, permitido incluso con parada de emergencia). Botones Comprar / Vender (25/50/100 %) con confirmación de doble toque y las mismas compuertas de riesgo.

## 19.33 — Lanzamiento
Borradores legales (para abogado), revisión de licencias, onboarding y checklist de aceptación, página de estado (`/status.html`) e informe de preparación con bloqueos (`docs/LAUNCH-READINESS.md`).

Planes (Prueba gratis, Starter, Pro, Business; precios = propuestas), límites de plan aplicados en el servidor y en el motor de órdenes, webhooks de pago con firma verificada e idempotentes, consola de facturación y soporte con acceso limitado y auditado. Los límites de plan están **apagados por defecto** (`billing_enforce`).

## 19.31 — Cuentas
Verificación de correo, recuperación de contraseña, 2FA opcional para clientes con códigos de respaldo, lista de dispositivos y revocación de sesiones. Operar en real exige correo verificado.

## 19.30 — Operación
Migraciones versionadas, `/api/live` y `/api/ready`, logs estructurados, métricas, apagado ordenado, respaldo/restauración, CI con Postgres.

## 19.29 y anteriores
Libro de órdenes con ciclo de vida e ID idempotente, puerta de riesgo central y parada de emergencia, estados del bot, conciliación con el broker. Ver `docs/`.
