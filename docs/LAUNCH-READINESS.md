# Informe de preparación para lanzamiento (v19.32)

**Veredicto: NO listo para operar dinero real de clientes.** Está listo para: demo, modo papel, pilotos cerrados con el dueño como único operador real y montos mínimos. Lo siguiente separa **lo verificado** de **lo que falta**.

## Qué está verificado (con pruebas ejecutadas)
- Suite local: `npm test` (545 pruebas, 0 fallos) y `npm run test:pg` contra **Postgres 16 real** (34 pruebas, 0 fallos): reservas atómicas bajo concurrencia, candado de líder, tokens/webhooks de un solo uso bajo carrera, borrado de cuenta, migraciones idempotentes, respaldo→restauración real.
- Arranque completo en modo producción contra Postgres real, `ops/smoke.sh`, caída de base de datos (live 200 / ready 503 / recuperación) y apagado ordenado.
- Aislamiento entre clientes (datos, sesiones, conexiones), roles, CSRF, límites de intentos, anti-enumeración de cuentas, 2FA con anti-reuso y códigos de respaldo de un solo uso.
- Riesgo central en el servidor (límites, parada de emergencia, fallar cerrado), ciclo de vida de órdenes sin «ejecutada» sin confirmación del broker, conciliación contra respuestas simuladas del broker.
- Webhooks de pago: firma, idempotencia, orden de eventos, fallo transitorio → reintento; límites de plan aplicados en rutas y motor.

## BLOQUEOS (hay que resolverlos antes de cobrar o abrir trading real a clientes)
| # | Bloqueo | Quién | Cómo se cierra |
|---|---|---|---|
| 1 | **Revisión legal** de Términos, Privacidad, Riesgo, suscripción/reembolsos; ¿se requiere registro/licencia (valores, commodities, FinCEN/MSB, asesor)? Datos de empresa en `[corchetes]`. | Abogado | `docs/LEGAL-DRAFTS.md`; reemplazar `[…]` en `public/legal.html`. |
| 2 | **Correo transaccional no configurado** (`mail: none`): sin él no llegan verificación ni recuperación; operar en real exige correo verificado. | Tú | Cuenta Resend (o similar) → `RESEND_API_KEY`, `EMAIL_FROM`, `PUBLIC_URL`; dominio con SPF/DKIM. Integración **no probada** contra el proveedor real. |
| 3 | **Cobro no configurado ni probado**: Stripe sin cuenta/precios/webhook; código probado solo con simulaciones locales. | Tú | `docs/BILLING.md`; pruebas en modo test de Stripe antes de activar `billing_enforce`. |
| 4 | **Brokers reales nunca probados end-to-end**: Coinbase/Robinhood solo contra respuestas simuladas; no se verificó la semántica real de `client_order_id` repetido, que `filled_value` excluya comisiones, ni la doc oficial de Robinhood. | Tú + sandbox/orden mínima | Contratos contra sandbox (Coinbase) y **una orden real mínima** supervisada por exchange; comparar con la conciliación. |
| 5 | **Plan de Render sin verificar**: `render.yaml` dice `plan: free` (Postgres gratuito de Render **caduca** y no tiene respaldos garantizados). Si ya pagas, confirmar plan del web y de la BD. | Tú | Panel de Render; plan de pago de BD con backups; programar `ops/backup.sh` y probar `ops/restore-test.sh`. |
| 6 | **Driver `pg` real** no ejecutado aquí (npm bloqueado; solo se usó un adaptador a `psql`). | CI | Que GitHub Actions (`.github/workflows/ci.yml`) pase en verde con `pg` real. |
| 7 | **Términos de uso comercial de datos** (CoinGecko, RSS, Stooq) sin confirmar. | Tú | `docs/LICENSES.md`. |
| 8 | **Sin monitoreo externo ni alertas reales**: hay logs JSON, métricas Prometheus y página de estado, pero nadie recibe una alerta si cae. | Tú | UptimeRobot/Better Stack sobre `/api/ready`; error tracking (Sentry) opcional. |
| 9 | **Staging inexistente**: se despliega directo a producción. | Tú | Segundo servicio en Render con base separada. |
| 10 | **Sin cola/worker duradero**: el motor corre en el mismo proceso web con candado de líder; sirve para pocos clientes. | Ingeniería | Separar worker cuando crezca. |

## Pendiente de producto (no bloquea un piloto cerrado)
- Panel de métricas reconstruido solo con fills conciliados (equity, comisiones, P/L neto, win rate con tamaño de muestra, separar real/papel/backtest, estados «no disponible»).
- Asistente de conexión con «probar conexión» y revocación guiada; pruebas de contrato contra sandboxes.
- Flujo del Director con agentes especializados (Market Data, Risk, Execution, Reconciliation…), trazas de decisión reproducibles, prompts versionados y evaluaciones.
- Cobro: el plan «Business» y los topes son propuestas; validar precios (ver `docs/ONBOARDING.md`).
- Marca: sin búsqueda de conflicto de marca.

## Decisión recomendada
1. Mantén **trading real de clientes apagado** (`live_trading` ≠ `on`) y `billing_enforce` apagado.
2. Cierra bloqueos 2, 4, 5, 6 y 8 (rápidos, dependen de ti) → piloto cerrado con 3–5 clientes en **papel**.
3. Cierra 1, 3 y 7 (legal, cobro, licencias) → cobrar suscripción de **papel + señales**.
4. Solo con 4 verificado con órdenes reales mínimas y el abogado de acuerdo, abrir trading real a clientes con topes del plan Starter.
