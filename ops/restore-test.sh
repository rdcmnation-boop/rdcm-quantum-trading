#!/usr/bin/env bash
# Prueba de restauración: restaura un respaldo en una base de datos DESECHABLE y compara los conteos con la original.
# Uso: SOURCE_URL=postgres://origen SCRATCH_URL=postgres://base-vacia-desechable ops/restore-test.sh archivo.sql.gz
# NUNCA apuntes SCRATCH_URL a producción: se vacía el esquema public.
set -euo pipefail
: "${SOURCE_URL:?}"; : "${SCRATCH_URL:?}"; F="${1:?archivo .sql.gz}"
[ "$SOURCE_URL" != "$SCRATCH_URL" ] || { echo "SCRATCH_URL no puede ser igual a SOURCE_URL"; exit 2; }
psql "$SCRATCH_URL" -v ON_ERROR_STOP=1 -q -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"
gunzip -c "$F" | psql "$SCRATCH_URL" -v ON_ERROR_STOP=1 -q >/dev/null
ok=1
for t in users connections bots orders order_events bot_events audit settings proposals schema_migrations; do
  a=$(psql "$SOURCE_URL" -At -c "SELECT count(*) FROM $t"); b=$(psql "$SCRATCH_URL" -At -c "SELECT count(*) FROM $t")
  if [ "$a" = "$b" ]; then echo "ok   $t: $a filas"; else echo "FALLA $t: origen=$a restaurada=$b"; ok=0; fi
done
[ "$ok" = 1 ] && echo "RESTAURACIÓN VERIFICADA" || { echo "RESTAURACIÓN CON DIFERENCIAS"; exit 1; }
