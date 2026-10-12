# Planes y facturación (v19.32)

**Estado:** implementado y probado con simulaciones locales. **No** se ha probado contra una cuenta real de Stripe.

## Reglas que el código hace cumplir
1. Un redireccionamiento de «pago exitoso» **no activa nada**. Solo un webhook con firma verificada (HMAC-SHA256 sobre el cuerpo crudo, tolerancia 5 min) cambia un plan.
2. Webhooks idempotentes (tabla `webhook_events`, `INSERT … ON CONFLICT`); un evento fallido se reintenta (responde 500) y cuenta intentos.
3. Orden de eventos: uno más viejo que el estado guardado se ignora.
4. Dudas = sin acceso: precio desconocido, usuario inexistente o estado raro → no se concede y se audita.
5. Límites de plan en el servidor: `PUT /api/bot`, `POST /api/connections`, `runBot` (apaga el bot real si no hay plan vigente) y `placeLive` (recorta/bloquea). El menor entre plan, cliente y plataforma gana.
6. Con el pago vencido o la suscripción vencida >3 días: sin trading real (el papel sigue).
7. `billing_enforce` está **apagado** por defecto: nada cambia hasta que el dueño lo activa (Ajustes → Planes y facturación).

## Planes (propuestas a validar con clientes; no son oferta)
| Plan | USD/mes (propuesta) | Real | Tope/orden | Tope/día | Conexiones |
|---|---|---|---|---|---|
| Prueba gratis | 0 | No (solo papel) | — | — | 1 |
| Starter | 29 | Sí | 100 | 300 | 1 |
| Pro | 79 | Sí | 500 | 2000 | 2 |
| Business | 249 | Sí | 1000 | 5000 | 5 |

La prueba dura 14 días desde el registro. Los topes nunca superan los de la plataforma (`docs/RISK.md`).

## Variables de entorno (todas opcionales hasta el lanzamiento)
`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_STARTER`, `STRIPE_PRICE_PRO`, `STRIPE_PRICE_BUSINESS`, `PUBLIC_URL`. Sin ellas el cobro responde 503 con un mensaje honesto.

## Configuración en Stripe (la haces tú, con tu cuenta)
1. Crea 3 productos con precio mensual recurrente y copia sus `price_…`.
2. Crea un endpoint de webhook → `https://<tu-dominio>/api/billing/webhook/stripe` con los eventos `customer.subscription.created|updated|deleted`, `invoice.payment_failed`, `invoice.paid`.
3. Copia el «signing secret» a `STRIPE_WEBHOOK_SECRET`. Pon las claves **solo** en las variables de entorno de Render, nunca en el chat ni en el código.
4. Prueba en modo test con tarjetas de prueba de Stripe y confirma en la consola (Ajustes → Planes y facturación) que los eventos aparecen como `done`.
5. Verifica el comportamiento real de `invoice.paid` / `customer.subscription.updated` antes de activar `billing_enforce`.

## Soporte
`GET /api/owner/users/:id/support` devuelve un resumen operativo **sin llaves ni credenciales** y deja rastro (`support_view`). `POST /api/owner/users/:id/plan` concede un plan a mano (pilotos) y queda auditado.
