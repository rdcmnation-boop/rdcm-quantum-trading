# Revisión de licencias (código, fuentes, recursos)

Revisión **de lo que hay en el repositorio**, hecha leyendo el código. No sustituye una revisión legal.

| Componente | Origen | Licencia | Notas |
|---|---|---|---|
| Servidor (`server.js`, `lib/*`) | Propio | UNLICENSED (privado, `package.json`) | Sin copia de código ajeno conocida. |
| `pg` (única dependencia) | npm | MIT (según el paquete público; **verifica** en `node_modules/pg/package.json` tras `npm install`) | No se pudo instalar en este entorno; CI sí lo instala y corre `npm audit`. |
| Cliente web (`public/*.js`, `*.css`) | Propio | UNLICENSED | Sin librerías de terceros ni CDN: ni frameworks, ni gráficos, ni 3D externo (`city3d.js` y `octo3d.js` son código propio). |
| Tipografías | Fuentes del sistema (`system-ui`, `ui-monospace`) | n/a | No se carga ninguna fuente web. |
| Iconos | `public/icon.svg` y SVG en línea en `app.js` | Propios | Origen del `icon.svg`: [CONFIRMAR que lo creaste tú o su licencia]. |
| Logo / nombre «RDCMNATION QUANTUM» | Propio | — | [Búsqueda de marca: pendiente; no se verificó conflicto de marca]. |
| Audio / voz | Voz del navegador (Web Speech) y Azure TTS opcional | Términos del proveedor | El uso de Azure TTS requiere tu cuenta y sus términos. |
| Datos de mercado | Coinbase Exchange API, CoinGecko, Stooq, RSS (CoinDesk, Cointelegraph, Decrypt, Bitcoin Magazine) | Términos de cada proveedor | **Pendiente:** confirmar que el uso comercial/redistribución (mostrar precios y titulares a clientes de pago) está permitido por cada API/RSS; CoinGecko y algunos RSS limitan uso comercial y exigen atribución. |
| IA opcional | Google Gemini / Anthropic API | Términos del proveedor | Solo se activa con tu clave. |

## Pendientes antes de cobrar
1. Confirmar términos de uso comercial de cada fuente de datos (tabla de arriba).
2. Confirmar licencia/origen del `icon.svg` y búsqueda de marca.
3. Tras `npm install`, regenerar el inventario (`npm ls --all`) y revisar licencias de transitivas (CI ya ejecuta `npm audit`).
