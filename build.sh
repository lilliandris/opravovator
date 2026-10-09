#!/usr/bin/env bash
# Zostaví najnovší Docker image opravOVÁTORA a lokálne ho nasadí.
#  1. kontrola typov (ak sú nainštalované závislosti)
#  2. záloha lokálnych dát (ak aplikácia beží)
#  3. docker build s najnovšími základnými image (--pull), značky opravovator:<verzia> a :latest
#  4. reštart aplikácie s novým image (migrácie databázy sa spustia samy)
#
# Použitie: ./build.sh [--save] [--no-restart] [--no-backup]
#   --save        uloží image aj ako jeden súbor images/opravovator-<verzia>.tar.gz (docker load < …)
#   --no-restart  len zostaví, bežiacu aplikáciu nechá tak
#   --no-backup   bez zálohy pred reštartom
# Na server (Fly.io) sa nasadzuje cez scripts/deploy.sh.
set -euo pipefail
cd "$(dirname "$0")"
source scripts/compose.sh

SAVE=0; RESTART=1; BACKUP=1
for a in "$@"; do
  case "$a" in
    --save) SAVE=1 ;;
    --no-restart) RESTART=0 ;;
    --no-backup) BACKUP=0 ;;
    *) echo "Neznáma voľba: $a" >&2; exit 1 ;;
  esac
done

echo "== opravOVÁTOR $VERSION"
if [ -d node_modules ]; then
  echo "== Kontrola typov"; npm run typecheck
fi

RUNNING=0
"${COMPOSE[@]}" ps --status running --services 2>/dev/null | grep -q '^db$' && RUNNING=1
if [ "$RESTART" = 1 ] && [ "$BACKUP" = 1 ] && [ "$RUNNING" = 1 ]; then
  echo "== Záloha pred reštartom"; ./backup.sh
fi

echo "== Zostavujem image"
"${COMPOSE[@]}" build --pull app
"$ENGINE" tag opravovator:latest "opravovator:$VERSION"

if [ "$SAVE" = 1 ]; then
  mkdir -p images
  "$ENGINE" save "opravovator:$VERSION" | gzip > "images/opravovator-$VERSION.tar.gz"
  echo "== Image ako súbor: images/opravovator-$VERSION.tar.gz ($(du -h "images/opravovator-$VERSION.tar.gz" | cut -f1))"
fi

if [ "$RESTART" = 1 ]; then
  echo "== Reštart s novým image"; ./run.sh
else
  echo "Hotovo: opravovator:$VERSION (aplikácia nereštartovaná)"
fi
