#!/usr/bin/env bash
# Bezpečná aktualizácia na Fly.io bez straty dát:
#  1. kontrola a zostavenie novej verzie (image sa pripraví VOPRED, server ešte beží)
#  2. zálohy: snímka disku s PDF + (ak je nastavené DATABASE_URL) pg_dump databázy
#  3. oznámenie reštartu všetkým online – odpočet, ich zmeny sa samy uložia (hneď aj tesne pred reštartom)
#  4. po odpočte nasadenie pripraveného image; server dokončí rozbehnuté ukladanie,
#     čo sa počas reštartu nepodarí odoslať, počká v zariadeniach a odošle sa po štarte
#  5. kontrola, že beží nová verzia
#
# Použitie:  DEPLOY_TOKEN=… ./scripts/deploy.sh [minúty=5] ["správa pre vedúcich"]
# DEPLOY_TOKEN musí byť rovnaký ako na serveri:  fly secrets set DEPLOY_TOKEN=…
set -euo pipefail
cd "$(dirname "$0")/.."

MIN="${1:-5}"
MSG="${2:-}"
APP=$(awk -F'"' '/^app *=/{print $2; exit}' fly.toml)
URL="${APP_URL:-https://$APP.fly.dev}"
: "${DEPLOY_TOKEN:?Nastav DEPLOY_TOKEN (rovnaký ako vo fly secrets)}"
VERSION=$(node -e "const s=require('fs').readFileSync('shared/src/changelog.ts','utf8');console.log(s.match(/version: '([^']+)'/)[1])")
AUTH=(-H "Authorization: Bearer $DEPLOY_TOKEN")

echo "== Verzia $VERSION → $URL"
RUNNING=$(curl -fsS "$URL/api/status" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).version))" || echo "?")
echo "   na serveri beží: $RUNNING"
if [ "$RUNNING" = "$VERSION" ]; then
  echo "!! Na serveri už beží $VERSION – pridaj nový záznam na začiatok shared/src/changelog.ts (inak sa vedúcim neukáže Aktualizácia)."
  read -r -p "Pokračovať aj tak? [a/N] " ok; [ "$ok" = "a" ] || exit 1
fi

echo "== 1/5 Kontrola a zostavenie"
npm run typecheck
fly deploy -a "$APP" --build-only --push --image-label "v$VERSION"
IMAGE="registry.fly.io/$APP:v$VERSION"

echo "== 2/5 Zálohy"
VOL=$(fly volumes list -a "$APP" --json | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d)[0].id))")
fly volumes snapshots create "$VOL" -a "$APP"
if [ -n "${DATABASE_URL:-}" ]; then
  mkdir -p backups
  F="backups/db-$(date +%Y%m%d-%H%M%S).sql"
  pg_dump "$DATABASE_URL" > "$F" && echo "   databáza → $F"
else
  echo "   (bez DATABASE_URL – databázu chráni obnova k času v Neone)"
fi

echo "== 3/5 Oznámenie reštartu o $MIN min"
# keď niečo zlyhá, oznámenie sa zruší, aby ľudia nečakali na reštart, ktorý nepríde
trap 'echo "!! Chyba – ruším oznámenie"; curl -fsS -X DELETE "$URL/api/admin/maintenance" "${AUTH[@]}" >/dev/null || true' ERR
BODY=$(MIN="$MIN" MSG="$MSG" node -e "console.log(JSON.stringify({minutes:Number(process.env.MIN),message:process.env.MSG}))")
curl -fsS -X POST "$URL/api/admin/maintenance" "${AUTH[@]}" -H 'Content-Type: application/json' -d "$BODY" >/dev/null
END=$(( $(date +%s) + MIN * 60 ))
while [ "$(date +%s)" -lt "$END" ]; do
  ONLINE=$(curl -fsS "$URL/api/admin/maintenance" "${AUTH[@]}" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const o=JSON.parse(d).online;console.log(o.length?o.join(', '):'nikto')})" || echo "?")
  echo "   zostáva $(( (END - $(date +%s)) ))s, online: $ONLINE"
  sleep 30
done
# rezerva na posledné uloženie v prehliadačoch (robí sa 20 s pred reštartom)
sleep 15

echo "== 4/5 Nasadenie"
fly deploy -a "$APP" --image "$IMAGE"
trap - ERR

echo "== 5/5 Kontrola"
for _ in $(seq 1 60); do
  if curl -fsS "$URL/api/status" | grep -q "\"version\":\"$VERSION\""; then echo "Hotovo, beží $VERSION."; exit 0; fi
  sleep 5
done
echo "!! Nová verzia neodpovedá – pozri fly logs"; exit 1
