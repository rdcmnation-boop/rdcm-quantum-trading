# Pasos para lanzar (lo que solo puedes hacer tú)

Orden recomendado. Ninguna llave va al chat ni al código: solo a las variables de entorno de Render. Cada paso dice **cómo comprobar** que quedó bien. Lo que está marcado como *no probado* no se ha ejecutado contra el servicio real.

## 1. Render: plan y base de datos con copias
1. En Render → tu servicio web: confirma el **plan** (si dice Free, el servicio se duerme y no sirve para dinero de clientes).
2. Crea o revisa la base **Postgres de pago** (la gratuita vence y no garantiza copias). Activa las copias automáticas y apunta cada cuánto se hacen.
3. Comprueba que `DATABASE_URL` está enlazada al servicio.
- **Comprobar:** `/api/health` muestra la versión actual y la base como Postgres (no «memoria»). `/status` en verde.
- **Prueba de restauración:** restaura una copia en una base nueva al menos una vez; una copia que nunca se restauró no cuenta.

## 2. Correo (verificación y recuperar contraseña)
1. Cuenta en Resend (u otro), verifica tu dominio (SPF y DKIM).
2. En Render: `RESEND_API_KEY`, `EMAIL_FROM`, `PUBLIC_URL`.
- **Comprobar:** `/api/health` ya no dice `mail: none`; regístrate con un correo tuyo y llega el enlace. *No probado contra el proveedor real.*

## 3. Cobros (Stripe, primero en modo prueba)
1. Sigue `docs/BILLING.md`: crea los 3 precios, el webhook y pon `STRIPE_*` en Render con **claves de prueba**.
2. Paga con la tarjeta de prueba de Stripe y mira que el plan cambie **por el webhook**, no por volver de la página de pago.
3. Deja `billing_enforce` apagado hasta que todo esto funcione.
- *No probado contra Stripe real.*

## 4. Prueba real mínima con el broker
1. En Conectar → **Probar** en cada conexión (solo lectura).
2. Con tu propia cuenta: compra de $5 y venta de $5 con los botones. Confirma en el exchange que existen las dos órdenes y que la app las marca confirmadas.
3. Prueba «Cerrar todo y apagar» con esa posición.
- Esto también confirma lo que las pruebas de contrato no pueden: que Coinbase/Robinhood siguen aceptando lo que enviamos hoy.

## 5. Avisos y vigilancia
- Activa los avisos push en tu teléfono (alertas de bot apagado y orden sin confirmar).
- Pon un monitor externo gratuito (UptimeRobot o similar) sobre `/api/ready` con aviso a tu correo.

## 6. Legal (antes de cobrar o de operar con dinero de clientes)
- Un abogado revisa `docs/LEGAL-DRAFTS.md` y `public/legal.html` (hoy tiene 4 datos pendientes entre [corchetes]).
- Confirma los términos comerciales de las fuentes de datos y de cada exchange.

## 7. Abrir a clientes, de a poco
- Mantén `live_trading` para clientes **apagado** hasta cerrar 1–6.
- Abre con 2–3 personas conocidas, topes bajos, y revisa el panel de auditoría cada día la primera semana.

Estado de cada bloqueo: `docs/LAUNCH-READINESS.md`.
