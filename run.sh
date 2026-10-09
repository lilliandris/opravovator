#!/usr/bin/env bash
# Spustí opravOVÁTOR lokálne cez Docker Compose (aplikácia + PostgreSQL) a počká, kým nabehne.
# Dáta (databáza, PDF) sú v Docker volumes a zostávajú aj po zastavení.  Použitie: ./run.sh
set -euo pipefail
cd "$(dirname "$0")"
source scripts/compose.sh

if [ ! -f .env ]; then
  cp .env.example .env
  echo "Vytvoril som .env z .env.example – doplň GOOGLE_CLIENT_ID (na lokálne skúšanie stačí DEV_LOGIN=1)."
fi

"${COMPOSE[@]}" up -d
echo -n "Čakám na aplikáciu"
for _ in $(seq 1 60); do
  if curl -fsS "http://localhost:$PORT/api/health" >/dev/null 2>&1; then
    echo; echo "opravOVÁTOR $VERSION beží na http://localhost:$PORT"; exit 0
  fi
  echo -n "."; sleep 2
done
echo; echo "Aplikácia neodpovedá – pozri: ${COMPOSE[*]} logs app" >&2; exit 1
