# Notas de versión

## 19.43 — Aviso de caída al stop
Además del aviso de subida, ahora llega un push si una posición (real o simulada) cae hasta su stop: «conviene vender para limitar la pérdida». Un aviso por posición cada 6 h; se rearma al recuperarse. Solo avisa, no vende.

## 19.42 — Recomendación al tocar Comprar/Vender y aviso de subida
- Al tocar Comprar o Vender por primera vez, la app muestra lo recomendado (comprar, esperar, no comprar, vender un % o mantener) con el porqué, usando las reglas del bot. El segundo toque ejecuta. Solo informa.
- Aviso push cuando una posición (real o simulada) sube hasta que la ganancia NETA de costos alcanza tu meta (la del bot, o 2 % si no hay). Un aviso por posición cada 6 h, o antes si gana 2 puntos más. Solo quienes activaron los avisos.

## 19.41 — Ventaja, tamaño dinámico, filtro y validación
- Filtro de ventaja multi-timeframe (15m/1h/4h) con volumen relativo y valor esperado neto de costos y deslizamiento. Arranca en modo «sombra» (solo registra).
- Tamaño dinámico: objetivo de volatilidad, Kelly fraccional, correlación, pausa por caída máxima y pérdida diaria. Solo reduce o veta; requiere declarar el capital de riesgo.
- Filtro «¿operar hoy?», deslizamiento real medido, bitácora de decisiones y validación walk-forward por régimen con estrés de deslizamiento. Ver docs/EDGE-AND-RISK.md.

## 19.40 — Pantalla de rastros y guía de lanzamiento
Cerebro → «Rastros y reproducción»: ver qué versión de cada agente corrió y reproducirlo en seco. Nueva guía `docs/GO-LIVE-STEPS.md` con los pasos que solo puede hacer el dueño.

## 19.39 — Probar conexión, contrato de Coinbase y rastros del Director
- Botón «Probar» en cada conexión: revisa llave, permisos (sin retiros), lectura de saldos y precio. Solo lectura: no envía ninguna orden.
- 24 pruebas de contrato del conector de Coinbase (firma JWT, forma de pedidos, errores). Usan un servidor falso con las reglas documentadas; no sustituyen una orden mínima real.
- El Director guarda un rastro por corrida (versión de cada agente, propuestas y resultado) y el dueño puede reproducir un agente en seco (`/api/owner/director/traces`, `/replay`).

## 19.38 — Alertas críticas
Aviso push (si activaste avisos) cuando tu bot se apaga o una orden queda sin confirmar. Máximo uno por motivo cada 10 min; el aviso no lleva datos sensibles. Si no activaste avisos, nada cambia: el bot sigue igual.

## 19.32 — Planes y facturación
## 19.37 — Panel honesto
Las órdenes «pendientes de confirmar» ya no cuentan como error. El panel de dinero real muestra cuántas órdenes confirmó el broker, cuántas siguen estimadas, las comisiones reales y marca el resultado como «estimado» hasta que todo esté confirmado.

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
