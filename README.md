# Quantum Trading

Plataforma SaaS **no-custodial** de bots cripto (Coinbase Advanced y Robinhood Crypto). Cada cliente tiene su cuenta aislada; el dueño tiene una consola con analíticas reales.

## Variables de entorno (Render → Environment)
| Variable | Qué es |
|---|---|
| `DATABASE_URL` | Se conecta sola desde `render.yaml` |
| `SESSION_SECRET`, `ENCRYPTION_KEY` | Se generan solas. **No las cambies** o se pierden las llaves cifradas de los clientes |
| `AZURE_SPEECH_KEY`, `AZURE_SPEECH_REGION` | **Opcional (voz natural).** Créalos en Render → Environment (recurso «Speech» de Azure; región p. ej. `eastus`). Sin ellos la app usa la voz del teléfono. La llave nunca llega al navegador |
| `GEMINI_API_KEY` / `ANTHROPIC_API_KEY` | **Opcional (Explicador IA).** Sin ninguna, el agente explica gratis con plantillas sobre datos reales. `GEMINI_API_KEY` (plan gratuito de Google AI Studio) o `ANTHROPIC_API_KEY` (de pago) hacen que redacte con IA. Máx. 4 llamadas al día; solo redacta, nunca opera |
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

## Cuentas y correo (v19.31)
- Variables nuevas (opcionales): `RESEND_API_KEY` + `EMAIL_FROM` (correo transaccional vía Resend; integración NO verificada con cuenta real) y `PUBLIC_URL` (base de los enlaces de los correos, p. ej. `https://tu-dominio`).
- Sin proveedor de correo no se envía nada y la app lo dice (`/api/health` → `mail: "none"`). Mientras tanto el dueño puede verificar correos a mano (`POST /api/owner/users/:id/verify-email`, auditado).
- Operar en real exige correo verificado (clientes). La recuperación de contraseña no aplica al dueño (se cambia con `OWNER_PASSWORD`).
