# Borradores legales — SOLO PARA REVISIÓN PROFESIONAL

> **Esto no es asesoría legal ni está revisado por un abogado.** Son borradores de trabajo para que un abogado (p. ej. de Florida, con experiencia en valores/commodities, transmisión de dinero/FinCEN, protección al consumidor y privacidad) los corrija. No los publiques como definitivos ni afirmes «cumplimos la ley» hasta tener esa revisión. Lo que está entre [corchetes] debe completarse.
> Ya existe una versión publicada en `public/legal.html` (Términos, Aviso de riesgo, Privacidad). Estos borradores la **complementan**.

## 1. Términos de suscripción y reembolsos (borrador)
1. **Servicio.** [EMPRESA] ofrece software de automatización que envía órdenes a *tu* cuenta en un exchange usando *tus* llaves API. No custodiamos fondos ni aceptamos retiros; las llaves con permiso de retiro se rechazan.
2. **Planes y precios.** Los planes, topes y precios vigentes se muestran en la app. Los precios pueden cambiar con aviso previo de [30] días; el cambio aplica a la siguiente renovación.
3. **Prueba gratis.** [14] días solo en modo papel (simulación), sin tarjeta.
4. **Cobro y renovación.** Suscripción mensual con renovación automática hasta que la canceles. El cobro lo procesa [PROCESADOR DE PAGOS]; no almacenamos datos de tarjeta.
5. **Cancelación.** Puedes cancelar cuando quieras desde «Cuenta → Mi plan → Administrar pago». Sigues con acceso hasta el final del periodo pagado; no se renueva.
6. **Reembolsos.** [POLÍTICA A DEFINIR CON ABOGADO: p. ej., reembolso del primer mes dentro de [7] días si no operaste en real; sin reembolso prorrateado por meses ya usados; excepciones por ley aplicable.] Las pérdidas de trading **no** son reembolsables.
7. **Pagos fallidos.** Si el pago falla, el trading real se pausa automáticamente hasta regularizarlo; el modo papel sigue disponible. Podemos suspender cuentas con pagos vencidos por más de [X] días.
8. **Límites.** Cada plan impone topes por orden y por día, y existen topes de plataforma y una parada de emergencia que pueden bloquear órdenes. Que una orden se bloquee no genera derecho a compensación.
9. **Cambios y terminación.** Podemos modificar o discontinuar funciones con aviso razonable. Si discontinuamos el servicio de pago, reembolsaremos la parte no usada del periodo [A CONFIRMAR].
10. **Ley aplicable y jurisdicción.** [A DEFINIR: Florida, EE. UU.] [Arbitraje/renuncia a demandas colectivas: A DECIDIR CON ABOGADO].

## 2. Divulgaciones de riesgo (adicionales al Aviso de riesgo publicado)
- Operar criptoactivos puede causar la pérdida total del capital. Rendimientos pasados o simulados **no** garantizan resultados futuros.
- El modo papel y el backtest no reflejan por completo comisiones, deslizamiento, liquidez, latencia ni fallas del broker.
- Una orden figura como «ejecutada» **solo** cuando el broker la confirma; mientras tanto se muestra como pendiente o desconocida.
- Podemos pausar bots (parada de emergencia, límites, pago vencido, fallas de datos) sin previo aviso; no cancelamos ni liquidamos órdenes ya enviadas al broker.
- Los agentes de IA solo *proponen*; no pueden cambiar sus permisos, límites de riesgo ni credenciales. La IA puede equivocarse.
- No somos asesores de inversión, corredores ni custodios. [CONFIRMAR CON ABOGADO si el modelo requiere registro o licencia.]
- No prometemos rentabilidad. Los materiales de marketing no deben hacerlo.

## 3. Privacidad: puntos a verificar (la política publicada ya existe)
- Datos que tratamos: correo, hash de contraseña, secreto 2FA (cifrado), llaves API (cifradas), órdenes, configuración, registros de auditoría, IP y agente de usuario de sesiones.
- Terceros (subencargados): hosting [Render], procesador de pagos [Stripe], correo [Resend u otro], datos de mercado (Coinbase, CoinGecko), noticias, IA opcional (Google Gemini / Anthropic) — **a las IA solo se envían datos de mercado/órdenes agregadas, nunca llaves**; confirmar y reflejar en la política.
- Retención: [A DEFINIR]. Borrado de cuenta: elimina conexiones, bots, órdenes, eventos, sesiones, tokens y suscripción; la auditoría se anonimiza.
- Derechos (acceso/exportación/borrado): `GET /api/me/export` y `DELETE /api/me`. [Definir plazo de respuesta y correo de privacidad.]
- Menores: solo mayores de 18.
- Transferencias internacionales / aviso de brechas: [A DEFINIR con abogado según estados y países de los clientes].

## 4. Procedimiento de incidentes (borrador operativo)
1. **Detectar:** alerta, reporte de cliente, `qt_errors_total`, auditoría, webhooks fallidos.
2. **Contener (minutos):** parada de emergencia (Ajustes → Riesgo) si hay riesgo de órdenes erróneas; apagar trading real global (`live_trading=off`); revocar sesiones afectadas.
3. **Evaluar:** ¿hubo acceso no autorizado a datos, llaves u órdenes? Revisar auditoría (`risk_*`, `login_*`, `owner_*`).
4. **Credenciales:** si se sospecha filtración de `ENCRYPTION_KEY`/`SESSION_SECRET`: rotar, pedir a los clientes rotar sus llaves API en el exchange.
5. **Conciliar:** ejecutar conciliación (`POST /api/owner/reconcile`) y comparar con el exchange antes de reanudar.
6. **Notificar:** a clientes afectados y autoridades **según ley aplicable** [PLAZOS A CONFIRMAR CON ABOGADO].
7. **Post-mortem sin culpas** en [5] días: causa, impacto, acciones, pruebas nuevas.

## 5. Contacto y datos de la empresa por completar
[NOMBRE LEGAL], [DIRECCIÓN], [CORREO DE SOPORTE], [CORREO DE PRIVACIDAD], [NÚMERO DE REGISTRO].
