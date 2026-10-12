#!/usr/bin/env bash
# Respaldo lógico de la base de datos (pg_dump comprimido). Uso: DATABASE_URL=postgres://... ops/backup.sh [carpeta]
# Render con plan de pago también hace respaldos automáticos: verifica en el panel de la base de datos (Backups) y su retención.
set -euo pipefail
: "${DATABASE_URL:?Falta DATABASE_URL}"
OUT="${1:-./backups}"; mkdir -p "$OUT"
F="$OUT/quantum-$(date -u +%Y%m%dT%H%M%SZ).sql.gz"
pg_dump --no-owner --no-privileges "$DATABASE_URL" | gzip -9 > "$F"
test -s "$F" || { echo "respaldo vacío"; rm -f "$F"; exit 1; }
echo "$F"
