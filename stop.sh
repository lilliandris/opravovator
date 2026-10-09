#!/usr/bin/env bash
# Zastaví lokálny opravOVÁTOR. Dáta (databáza, PDF) ostávajú v Docker volumes – nič sa nemaže.
# Použitie: ./stop.sh          zastaví kontajnery
#           ./stop.sh --down   zastaví a odstráni kontajnery (volumes s dátami ostanú)
set -euo pipefail
cd "$(dirname "$0")"
source scripts/compose.sh

if [ "${1:-}" = "--down" ]; then
  "${COMPOSE[@]}" down          # zámerne bez -v: volumes s dátami sa nikdy nemažú
else
  "${COMPOSE[@]}" stop
fi
echo "opravOVÁTOR je zastavený, dáta sú zachované."
