# Conciliación con el broker (Fase 4)

`lib/reconcile.js` es la **única** vía por la que una orden real pasa a «ejecutada». Corre cada 60 s (`server.js`, con candado de líder `reconcile`) y a demanda con `POST /api/owner/reconcile`. Es de solo lectura sobre el broker.

## Qué consulta (verificación contra documentación)
| Broker | Llamada | Verificación |
|---|---|---|
| Coinbase Advanced Trade | `GET /api/v3/brokerage/orders/historical/{order_id}`; para órdenes sin ID, `…/historical/batch?product_ids=…` buscando `client_order_id` | **Verificado** en docs.cdp.coinbase.com («get order»): estados `PENDING, OPEN, FILLED, CANCELLED, EXPIRED, FAILED, UNKNOWN_ORDER_STATUS, QUEUED, CANCEL_QUEUED, EDIT_QUEUED`; campos `filled_size, filled_value, average_filled_price, total_fees, client_order_id, reject_message, cancel_message`. **No verificado**: si reutilizar un `client_order_id` devuelve la misma orden o un error (la documentación consultada no lo dice). |
| Robinhood Crypto | `GET /api/v1/crypto/trading/orders/{id}/` y `GET …/orders/` (paginado) | **Verificación parcial**: la página oficial no se pudo abrir desde el entorno de desarrollo; los campos (`state`: open/canceled/partially_filled/filled/failed, `filled_asset_quantity`, `average_price`, `executions[]`, `client_order_id`) vienen de un catálogo público del spec (apis.io). Un estado no reconocido jamás se toma como ejecutado. La API de órdenes no informa comisión: `fee_usd` queda `null` (no se inventa). |
Ninguna de las dos integraciones se ha probado contra el broker real ni contra un sandbox desde aquí: las pruebas usan respuestas simuladas con la forma documentada (pruebas de contrato).

## Reglas
- `submitted/confirmed/partial/unknown` se consultan; `filled/cancelled/rejected` son terminales y no se vuelven a consultar. Repetir la conciliación no cambia nada (idempotente).
- Al confirmar, **cantidad, precio medio, USD y comisión reales sustituyen a la estimación**. `usd` = efectivo neto (compra: valor + comisión; venta: valor − comisión). Esa suposición sobre `filled_value` (sin comisión) hay que confirmarla con una orden real mínima.
- Cancelada tras llenarse en parte → se registra como `filled` solo con lo ejecutado.
- `submitting` de más de 2 min (el proceso murió a mitad del envío) → `unknown` y se resuelve por `client_order_id`; **nunca se reenvía**.
- `unknown` que el broker no lista tras 10 min con consulta exitosa → `rejected` («no se envió») y libera el cupo. Es una suposición operativa: si un broker tarda más en listar, habría que alargar `GRACE_NOT_FOUND_MS`.
- Error de la API (429/5xx/red) → la orden no cambia, se audita `reconcile_error` y se reintenta.
- Diferencia > 1 % entre lo estimado y lo real → auditoría `reconcile_adjusted`.
- Estado desconocido del broker → se mantiene sin resolver y se audita.
`GET /api/bot/status → lifecycle.unreconciled_live_orders` indica cuántas órdenes reales siguen sin confirmar.

## Pendiente
Conciliar saldos y posiciones completas contra el broker, depósitos/retiros y acciones corporativas (no aplican a cripto spot), y una prueba real con monto mínimo.
