# Ventaja, tamaño de posición, filtro y validación (v19.41)

Todo está en JavaScript (el proyecto no usa Python), en módulos puros y probados. **Nada de esto garantiza ganancias**: son filtros y frenos que descartan operaciones malas y limitan pérdidas. Lo único que prueba si hay ventaja real es medirla (modo sombra + validación + órdenes reales pequeñas).

## 1. Ventaja (`lib/edge.js`)
`evaluateEdge(tf, ctx, params)` devuelve `edge_score` (0–100), `tradeable`, valor esperado bruto/neto y la lista de chequeos con su detalle.

| Filtro | Qué exige | Por qué mejora la expectativa |
|---|---|---|
| Confluencia 15m / 1h / 4h | los 3 al alza (SMA rápida > lenta y precio sobre la rápida) | las señales de un solo timeframe son ruido con más frecuencia |
| Volumen relativo | volumen de las últimas 3 velas ≥ 1× el promedio de 24 h | un movimiento sin participación se revierte más y cuesta más ejecutar |
| RSI 1 h | entre 42 y 72 | evita entrar sin fuerza o ya sobrecomprado |
| Valor esperado neto | movimiento esperado bruto ≥ 1.5× el costo total y neto > 0 | solo entra si lo esperado paga con holgura comisión + spread + impacto + deslizamiento real |
| edge_score | ≥ 70 | resume lo anterior; pesos: confluencia 35, tendencia/RSI 15, volumen 15, holgura de costos 25, régimen 10 |

Movimiento esperado bruto = media del retorno por hora de las últimas 24 h × 12 h × 0.5 (se cree solo la mitad del impulso). Con comisiones de Coinbase para cuentas pequeñas (≈1.6 % de ida y vuelta) casi nunca pasa: eso es lo correcto, no un fallo.

**Parámetros** (`DEFAULT_EDGE`): `minScore` 70, `evCostMultiple` 1.5, `minRelVol` 1.0, `relVolLookback` 24, `fast` 10, `slow` 30, `rsiLo` 42, `rsiHi` 72, `horizonBars` 12, `driftShrink` 0.5, `minAgree` 3.

**Cómo se usa:** en la configuración del bot, «Filtro de ventaja»: `Sombra` (por defecto: registra qué habría vetado, sin cambiar órdenes), `Activo` (veta) o `Apagado`. Empieza en sombra y revisa la bitácora (Mi bot → Bitácora de ventaja y tamaño) antes de activar.

## 2. Tamaño y riesgo de portafolio (`lib/sizing.js`)
`sizeDecision()` **solo puede reducir o vetar** una compra; nunca la sube sobre lo que pediste ni sobre los topes de la plataforma (que siguen aplicándose después). Requiere que declares tu **capital de riesgo** (campo «Capital de riesgo USD»); con 0 queda apagado y el bot se comporta como antes.

Pasos y parámetros (`DEFAULT_SIZING`): pausa por apagado de emergencia; pausa si el capital cae `maxDrawdownPct` 10 % desde su máximo (curva de operaciones cerradas); pausa si pierdes `dailyLossPct` 3 % en 24 h; tope `maxPositionPct` 5 % por posición y `maxExposurePct` 40 % total; objetivo de volatilidad (`targetDailyRiskPct` 0.5 % del capital por posición); Kelly fraccional `kellyMult` 0.35 solo con ≥ `kellyMinTrades` 20 operaciones cerradas (si Kelly ≤ 0 se veta: sin ventaja demostrada); correlación: veto si ≥ 0.85 con algo que ya tienes, mitad del tamaño si ≥ 0.7; ×0.5 en régimen volátil o bajista; ×0.6 si edge_score < 80; mínimo `minTradeUsd` $10. Cada paso queda en la bitácora y los vetos en la auditoría (`sizing_veto`).

## 3. Filtro «¿operar hoy?» (`lib/filter.js`)
`tradeFilter()` devuelve GO/NO-GO y cada razón: noticias negativas (de la cripto o del mercado), volatilidad diaria extrema o disparada vs la semana previa, expectativa de las últimas 10 operaciones colapsada, liquidez baja (volumen 24 h < $5 M) y spread alto si hay dato. **Funding** solo se evalúa si se entrega el dato; no hay fuente verificada, así que hoy aparece como «no evaluado» y no bloquea. Solo veta compras nuevas, nunca ventas ni cierres.

## 4. Deslizamiento real (`lib/slippage.js`)
Al conciliar una orden llenada se compara el precio de decisión con el precio medio real del broker y se guarda (por exchange). Con ≥ 10 fills, el exceso mediano sobre el modelo se resta del valor esperado (2 veces: entrada y salida). Solo cuenta órdenes sin llenado parcial previo.

## 5. Validación (`lib/validate.js`)
Walk-forward sin mirar el futuro de la lógica Pro: elige parámetros con entrenamiento, mide en datos posteriores con 24 h de embargo, con costos reales del exchange, por régimen (alcista/bajista/lateral/volátil), contra comprar y mantener la cripto y BTC, y con deslizamiento ×2 y ×3. Veredicto automático y conservador (≥ 20 operaciones, retorno > 0, ≥ 60 % de ventanas positivas, positivo con deslizamiento ×2). Se corre desde Cerebro → «Validación walk-forward» (necesita red a Coinbase; en producción sí). Formato del informe: ver `formatReport` (veredicto, resultado vs mantener, regímenes, estrés, ventanas, límites).

## Lo que NO está hecho (y por qué)
- **Órdenes límite / TWAP:** exige colocar, consultar y cancelar órdenes y encajarlo en el libro de órdenes (estados parcial/cancelada/desconocida). Sin poder probarlo contra el broker real, es más riesgo que beneficio. Lo que sí hay: medir el deslizamiento real y descontarlo.
- **Funding, open interest, liquidaciones:** son datos de derivados; Coinbase/Robinhood aquí son spot y no hay fuente verificada ni sus términos comerciales revisados.
- **Meta-etiquetador ML y agente de sentimiento/on-chain:** el filtro de noticias existente cubre sentimiento básico; un meta-etiquetador necesita cientos de señales con resultado, que la bitácora en modo sombra empezará a acumular.
- **Validación de las capas de volumen y 15 min:** no hay velas históricas con volumen guardadas, así que la validación prueba la lógica Pro base; la capa nueva se valida hacia adelante con el modo sombra.
- **Validación cruzada «purgada»:** se usa walk-forward con embargo (equivalente para series de tiempo con una sola ventana de prueba por vez).

## 6. Recomendación al tocar y aviso de subida (v19.42)
- `GET /api/trade/advice` (usado por los botones Comprar/Vender): compra = señal Pro + ventaja multi-timeframe + filtro «¿operar hoy?» + tamaño dinámico; venta = salida Pro + ganancia neta vs meta. Veredictos: comprar / esperar / evitar / vender (con %) / mantener / sin posición. Solo informa.
- `engine.sellWatch()` corre cada 5 min (una instancia a la vez): para quienes activaron avisos, si la ganancia **neta de costos** de una posición llega a la meta (`takeProfitPct` o 2 %), manda push; no repite en 6 h salvo que gane 2 puntos más; se rearma si cae 1 punto bajo la meta.
- No puede vender solo desde ese aviso: el aviso te lleva a la app, donde tú decides.
- Protección (v19.43): si una posición en pérdida llega a su stop dinámico o stop-loss, `sellWatch` manda un push «cayó −X %: conviene vender para limitar la pérdida» (un aviso por posición cada 6 h; se rearma al recuperarse).
- Avisos de compra (v19.44): `engine.buyWatch()` cada 10 min, solo para quien tiene avisos activos, `buyAlerts` encendido y el bot apagado o fuera de AUTO Pro (si el bot ya compra solo, el aviso útil es «🤖 Compré X»). Exige veredicto «comprar» con edge_score calculado (datos de 15 min y volumen), máx. 3/día, 12 h por cripto, no de lo que ya tienes.
- Avisos de lo que hizo el bot: `botDid()` manda push al comprar o vender en AUTO Pro (con motivo y monto). Venta por debilitamiento: `sellWatch` avisa también cuando `exitSignal` indica tendencia rota o sobrecompra.
