#!/usr/bin/env bash
# Verificación de humo de un despliegue (NO prueba que el trading funcione). Uso: ops/smoke.sh https://tu-app.onrender.com
set -u
U="${1:?URL base}"; fail=0
chk() { if eval "$2"; then echo "ok   $1"; else echo "FALLA $1"; fail=1; fi; }
H=$(curl -fsS -m 15 "$U/api/health" || echo "")
chk "health responde y declara versión" '[[ "$H" == *"\"status\":\"ok\""* && "$H" == *"version"* ]]'
chk "liveness (/api/live)" 'curl -fsS -m 10 "$U/api/live" | grep -q alive'
R=$(curl -sS -m 15 -o /dev/null -w "%{http_code}" "$U/api/ready"); chk "readiness (/api/ready) = 200 (base de datos responde)" '[ "$R" = 200 ]'
chk "base de datos NO es memoria (producción)" '[[ "$H" == *"\"database\":\"postgres\""* ]]'
HD=$(curl -sSI -m 15 "$U/app"); chk "cabeceras de seguridad (CSP, nosniff, X-Request-Id)" '[[ "${HD,,}" == *"content-security-policy"* && "${HD,,}" == *"x-content-type-options: nosniff"* ]]'
chk "ruta privada exige sesión (401)" '[ "$(curl -sS -m 10 -o /dev/null -w %{http_code} "$U/api/bot/status")" = 401 ]'
chk "ruta de dueño exige sesión (401)" '[ "$(curl -sS -m 10 -o /dev/null -w %{http_code} "$U/api/owner/risk")" = 401 ]'
chk "métodos que cambian datos sin cabecera CSRF (403)" '[ "$(curl -sS -m 10 -o /dev/null -w %{http_code} -X POST "$U/api/auth/login")" = 403 ]'
[ "$fail" = 0 ] && echo "SMOKE OK" || { echo "SMOKE CON FALLAS"; exit 1; }
