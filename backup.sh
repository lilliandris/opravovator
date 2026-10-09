#!/usr/bin/env bash
# Záloha lokálnych dát do backups/: databáza (pg_dump) + súbory (PDF, opravy, obrázky).
# Použitie: ./backup.sh        (aplikácia musí bežať, aspoň databáza)
set -euo pipefail
cd "$(dirname "$0")"
source scripts/compose.sh

STAMP=$(date +%Y%m%d-%H%M%S)
mkdir -p backups
"${COMPOSE[@]}" exec -T db pg_dump -U opravovator opravovator > "backups/local-db-$STAMP.sql"
echo "databáza → backups/local-db-$STAMP.sql"
"$ENGINE" run --rm -v "${PROJECT}_app-data:/data:ro" -v "$PWD/backups:/backup" alpine \
  sh -c "tar czf /backup/local-files-$STAMP.tgz -C /data . && chown $(id -u):$(id -g) /backup/local-files-$STAMP.tgz"
echo "súbory   → backups/local-files-$STAMP.tgz"
# obnova: cat backups/local-db-….sql | docker compose exec -T db psql -U opravovator opravovator
