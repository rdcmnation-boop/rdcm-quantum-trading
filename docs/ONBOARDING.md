# Onboarding del cliente, demo y checklist de aceptación

## Recorrido del cliente (lo que ya existe en la app)
1. **Crear cuenta** (acepta Términos, Privacidad y Riesgo; mayor de 18) → llega correo de verificación.
2. **Verificar correo** (Cuenta → Seguridad). Requisito para operar en real.
3. **Activar 2FA** (recomendado) y guardar los 8 códigos de respaldo.
4. **Modo papel primero:** Bot → «Encender Cerebro (papel)». Observa decisiones y resultados simulados.
5. **Conectar el exchange** con una llave **de solo trading, sin retiros** (la app rechaza llaves con retiro). Nunca compartas tus llaves por chat o correo.
6. **Elegir un plan** (Cuenta → Mi plan). Sin plan vigente no hay trading real (cuando el dueño activa los límites de plan).
7. **Trading real:** solo si el dueño lo habilitó, con topes bajos y confirmación de riesgo. Empieza con montos mínimos.
8. **Seguimiento:** Órdenes (estado real: pendiente/confirmada/ejecutada/desconocida), Resumen, Verificación con tu exchange.

## Guion de demo (5 min, sin dinero real)
Registro → modo papel → mostrar «por qué compró/esperó» → mostrar límites y botón de apagado → mostrar que una orden bloqueada por riesgo queda explicada → mostrar estado de órdenes («pendiente» hasta confirmación del broker) → exportar mis datos.

## Exportar y borrar cuenta
- Exportar: Cuenta → «Descargar mis datos (JSON)» (sin llaves).
- Borrar: Cuenta → «Eliminar mi cuenta» (contraseña + doble confirmación). Borra conexiones, bot, órdenes, eventos, sesiones, tokens y suscripción.

## Checklist de aceptación por cliente (marca antes de activar trading real)
- [ ] Correo verificado y 2FA activado (o rechazado a sabiendas).
- [ ] Leyó y aceptó Términos, Privacidad, Aviso de riesgo (versión registrada).
- [ ] Llave de **solo trading** confirmada (3 verificaciones en verde, sin retiros).
- [ ] Probó en papel ≥ [7] días y entiende la diferencia con real.
- [ ] Topes por orden/día definidos por él y dentro de su plan.
- [ ] Plan activo y pago al día.
- [ ] Sabe usar el botón de apagado y qué hace (y qué **no** hace) la parada de emergencia.
- [ ] Hizo (con el dueño) una orden real **mínima** de verificación y la vio confirmada por el broker.
- [ ] Sabe a quién escribir ante un problema ([CORREO DE SOPORTE]).

## Validación de precios (antes de fijarlos)
Los precios en `lib/billing.js` son **propuestas**. Valídalos con 5–10 entrevistas o una lista de espera: ¿cuánto pagarían por mes?, ¿qué límite de monto necesitan?, ¿prefieren cobro fijo o % de rendimiento (este último puede tener implicaciones regulatorias: consultar abogado)? Ajusta `PLANS` y las variables `STRIPE_PRICE_*`.
