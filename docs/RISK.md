# Gestión de riesgo central (Fase 2)

Toda orden **real** pasa por `placeLive` → `lib/risk.js` + `store.reserveOrder(..., risk)` antes de tocar al broker. Las órdenes de papel no llegan a ningún broker y no pasan por esta puerta.

## Reglas y semántica
| Regla | Dónde | Cálculo |
|---|---|---|
| Parada de emergencia | `preCheck` | ajuste `risk:emergency`; ilegible = **activa** (falla cerrado) |
| Límites obligatorios | `preCheck` | el bot necesita `maxOrderUsd` y `maxDailyUsd` > 0 y la plataforma límites válidos; si no, **bloquea** |
| Precio válido y fresco | `preCheck` | `precio > 0`; edad = ahora − momento en que se leyó (máx. `maxPriceAgeMs`, 60 s) |
| Desviación de precio | `preCheck` | `|precio − último cierre horario| / cierre` ≤ `maxPriceDeviationPct` (10 %). **Solo compras**: una venta (stop-loss) no se frena |
| Máximo por orden | `preCheck` | USD de la orden ≤ menor(cliente, plataforma) |
| Tope diario | `reserveOrder` (atómico) | suma USD de compras reales de 24 h con estado `ok`/`pending` (incluye enviadas y desconocidas) + esta orden ≤ menor(cliente, plataforma). Las ventas no cuentan ni se bloquean por él |
| Órdenes abiertas | `reserveOrder` (atómico) | reales en `submitting/submitted/confirmed/partial/unknown` **de los últimos 30 min** ≥ `maxOpenOrders` (3) bloquea compras |
| Frecuencia | `reserveOrder` (atómico) | órdenes reales en 1 h ≥ `maxOrdersPerHour` (12) bloquea |
| Rechazos seguidos | `reserveOrder` (atómico) | las últimas N (3) órdenes reales todas `rejected` bloquea compras |
**Reserva atómica:** en Postgres, `pg_advisory_xact_lock(hashtext(user_id))` + comprobación + inserción en una transacción. Prueba con `psql` (12 sesiones simultáneas, $30 c/u, tope $100): **3 creadas con candado; 4 sin candado** (control negativo).
**Persistencia:** el gasto diario y los conteos se calculan de la tabla `orders`, por lo que sobreviven a reinicios. No hay contadores en memoria.
**Cada decisión se registra** en `audit` (actor `risk`, acción `risk_allow`/`risk_block` con código y motivo).

## No implementado todavía (declarado, no simulado)
Apalancamiento (el producto es spot: no aplica), pérdida diaria realizada/no realizada y *drawdown* a nivel plataforma, concentración y exposición de cartera, presupuesto por estrategia. Requieren posiciones y valoraciones conciliadas con el broker (Fase 4). Hasta entonces el modo Pro conserva su propio freno de pérdida diaria dentro del bot.
Limitación conocida: mientras no exista la reconciliación (Fase 4), las órdenes `submitted` no pasan a `filled`; por eso la regla de «abiertas» solo mira 30 min.

## Parada de emergencia: política
- **Bloquea**: toda orden real nueva (compras **y ventas**) y los ciclos de los bots reales.
- **No hace**: cancelar órdenes ya enviadas ni vender posiciones. **Nunca liquida automáticamente.** Quien decide es la persona, con su broker.
- Activar/levantar: Ajustes (dueño) → «Riesgo y parada de emergencia», o `POST /api/owner/emergency {on, reason}`. Queda en la auditoría.

## Recuperación
1. Levanta la emergencia solo después de revisar `Últimas decisiones de riesgo`, el estado del broker y las órdenes `unknown`.
2. Si los límites de plataforma salen ilegibles, corrige con `PUT /api/owner/risk` (valores > 0) o borra el ajuste `risk:platform` para volver a los valores por defecto.
3. Para ver por qué se bloqueó una orden: auditoría, actor `risk`.

## Cerrar posiciones y operación manual (v19.34)
- **Kill switch = «Cerrar todo y apagar»** (`POST /api/bot/kill {closeAll:true}`): apaga el bot y **vende** todas las posiciones abiertas del cliente (real y papel) a mercado. No cancela órdenes que ya estén abiertas en el exchange (hay que revisarlas allí).
- **Cerrar = solo vender (`reduceOnly`)**: se permite aunque el administrador haya apagado el trading real y aunque haya parada de emergencia, porque solo reduce riesgo. No se salta: límites de plataforma legibles (si están corruptos, **no vende**: falla cerrado), precio válido y fresco, ID idempotente (doble pulsación en el mismo minuto no vende dos veces), libro de órdenes y auditoría.
- La cantidad vendida es `min(posición del libro, saldo disponible del exchange × 0.999)`. Si el exchange no muestra saldo, no se envía nada.
- **Comprar a mano** (`POST /api/trade`) en real pasa por TODAS las compuertas: correo verificado, trading real habilitado, plan, tope por orden y por día, parada de emergencia, riesgo central y confirmación explícita. En la app, cada botón exige un segundo toque.
- Las ventas/compras reales quedan «enviadas/pendientes» hasta que la conciliación confirme con el broker.
