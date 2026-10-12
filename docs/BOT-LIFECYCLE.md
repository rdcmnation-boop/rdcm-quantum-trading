# Ciclo de vida del bot y candado de líder (Fase 3)

Estados persistidos (`bots.state`, historial en `bot_events` con motivo): CREATED, CONFIGURED, VALIDATING, RUNNING, PAUSED, STOPPING, STOPPED, ERROR, EMERGENCY_STOP.
| Evento | Transición |
|---|---|
| Guardar config apagada | → CONFIGURED |
| Guardar config encendida | → VALIDATING → RUNNING |
| Apagar (cliente, kill, dueño, conexión borrada) | RUNNING → STOPPING → STOPPED |
| Pausar / reanudar | RUNNING ⇄ PAUSED (el bot no decide ni opera en pausa) |
| 3 errores seguidos | → ERROR (apagado, con motivo) |
| Parada de emergencia (solo bots reales) | RUNNING/PAUSED → EMERGENCY_STOP; al levantarla, vuelve a RUNNING si sigue encendido |
Las transiciones inválidas se rechazan y no cambian nada. Cada bot tiene `user_id` (inquilino), `strategy_version` (`qt-2026.10`), configuración, latido (`last_run`) y salud (`ok`/`stale`/`error`/`emergency`/`idle`) en `GET /api/bot/status → lifecycle`.

## Candado de líder
Tabla `leases(name, holder, expires_at)`; `INSERT … ON CONFLICT DO UPDATE … WHERE holder = mío OR caducó`. Lo usan el motor (45 s, renovado en cada ciclo de 15 s), el Director, el escáner y las noticias. Si una instancia cae, otra toma el relevo cuando caduca. Verificado con `psql`: 6 sesiones simultáneas → 1 ganadora.
Límite: sigue habiendo un proceso web que ejecuta los trabajos. Un worker separado y una cola duradera son parte de la Fase 5.
