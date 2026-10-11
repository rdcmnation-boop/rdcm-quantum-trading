# Quantum Trading

Plataforma SaaS **no-custodial** de bots cripto (Coinbase Advanced y Robinhood Crypto). Cada cliente tiene su cuenta aislada; el dueño tiene una consola con analíticas reales.

## Variables de entorno (Render → Environment)
| Variable | Qué es |
|---|---|
| `DATABASE_URL` | Se conecta sola desde `render.yaml` |
| `SESSION_SECRET`, `ENCRYPTION_KEY` | Se generan solas. **No las cambies** o se pierden las llaves cifradas de los clientes |
| `OWNER_EMAIL`, `OWNER_PASSWORD` | **Tú las pones.** Solo ese correo puede ser dueño. Cambiar la contraseña aquí la rota al reiniciar |

## Seguridad
- Rol de dueño solo para `OWNER_EMAIL`; el registro nunca puede crearlo. **2FA (TOTP) obligatorio** para usar la consola del dueño.
- Contraseñas con scrypt, cookie `HttpOnly` + `SameSite=Strict`, protección CSRF, límite de intentos, auditoría.
- Llaves API cifradas con AES-256-GCM; se rechazan llaves con permiso de retiro; el dueño nunca ve llaves ni órdenes individuales.
- Trading real apagado por defecto: lo habilita el dueño en Ajustes. Topes por orden y por día, y botón de apagado.

## Pruebas
`npm test` (sin red ni base de datos).

## Legal
`public/legal.html` es un **borrador**. Revísalo con un abogado de Florida antes de cobrar o activar trading real para clientes.
