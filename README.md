# Opravovátor

Webová aplikácia na opravovanie PDF riešení korešpondenčných seminárov. Nahráš zip z hromadného opravovania,
kreslíš a píšeš priamo do PDF, obodovávaš a stiahneš zip späť v rovnakej štruktúre, pripravený na nahratie.
Dá sa nainštalovať ako aplikácia do počítača (PWA) a funguje aj offline.

- **TypeScript**: server Fastify + PostgreSQL, frontend React + Vite
- geometria anotácií a výpočet bodov sú spoločné (`shared/`), takže náhľad v editore presne sedí s výsledným PDF
- bez limitov na veľkosť zipu, počet riešení, strán či obrázkov

## Funkcie

- editor: text (8 písiem, podčiarknutie, nastaviteľná šírka poľa so zalamovaním), šípka, čiara, obdĺžnik a elipsa (aj s výplňou a priehľadnosťou),
  zvýrazňovač a podčiarknutie textu v PDF (alebo ručne natiahnuté na skene), obrázky/podpisy (s odstránením bieleho pozadia), pečiatka s bodmi a podpisom
- text PDF sa dá označiť a kopírovať, odkazy v PDF sa dajú otvoriť kliknutím (nástroj Výber); adresy v komentároch sú vo výslednom PDF klikateľné
- **nastavenia strany:** pridanie prázdnej strany A4, zmenšenie obsahu strany na stred (okraje na písanie), otočenie naskenovanej strany (strana ostane na výšku, sken – to, čo nie je biele – sa otočí a zmestí na ňu); pôvodné PDF sa nemení
- bodovanie: položky rubriky – zaškrtávanie (klávesy 1–9) alebo **intervaly** (každá položka 0 až jej body, posuvník), ručné body, maximum, spoločný komentár úlohy
- body pri exporte (body.txt, CSV, pečiatka v PDF) sú vždy **celé číslo**, zaokrúhlené normálne (0,5 nahor)
- body v PDF: stále rovnaké písmo, farba a veľkosť z nastavení (nezávisle od práve zvoleného pera)
- podpis pod bodmi: text alebo obrázok, stále rovnaké písmo a farba z nastavení, poloha pod / nad / vľavo / vpravo od bodov;
  v zdieľanej úlohe môže byť pod bodmi viac podpisov vedľa seba (Nastavenia úlohy), každý podľa nastavení daného vedúceho
- **interné bodovanie** (len pre vedúcich, nejde do PDF): Správnosť / Úsilie / AI a podvádzanie (predvolené 0 / 5 / 5, sivé, kým sa nezmenia; odporúčané max. 9) a interný komentár; v exporte ako `bias.txt` („S U P“) a `bias_komentar.txt` v priečinku každého riešiteľa
- **história verzií** každého riešenia s možnosťou obnoviť hocijakú staršiu verziu
- **zdieľanie**: každý vidí svoje úlohy a tie, ktoré mu niekto nazdieľal e-mailom
- **offline**: tlačidlo „Offline“ stiahne celú úlohu do zariadenia; zmeny bez internetu sa uložia lokálne a po pripojení odošlú
- **miniatúry** prvej strany v zozname riešení (s opravami)
- **export**: zip v pôvodnej štruktúre, CSV tabuľka bodov
- prihlásenie cez **Google**, povolené domény nastaviteľné

## Admin panel

Na adrese **`/admin`** (nikde naň nevedie tlačidlo, treba ho napísať ručne). Prístup majú len admini podľa e-mailu,
prvý je `patrik.bukovsky@trojsten.sk` (z migrácie `010_admin.sql`), ďalších pridáva admin priamo v paneli.

- **Vedúci:** každý, kto sa aspoň raz prihlásil (prvé a posledné prihlásenie), pod ním jeho úlohy na serveri.
  Úlohu môže admin otvoriť v editore, upraviť (názov, maximum, komentár, zdieľanie) alebo zmazať, vždy cez potvrdzovacie okno.
- **Hľadanie** vo vedúcich, úlohách aj v riešeniach (meno riešiteľa, priečinok, ID), bez ohľadu na diakritiku.
- **Logy:** prihlásenie/odhlásenie, nahratie úlohy, otvorenie a zavretie úlohy, stiahnutie do zariadenia / zipu / CSV,
  zdieľanie, mazanie, nahratie obrázka a všetky akcie adminov. Filtrovanie podľa vedúceho, akcie a textu.
- **Admini:** pridanie a odobratie (seba odobrať nejde).

## Lokálny režim (bez servera a účtu)

Na prihlasovacej obrazovke je tlačidlo **„Pracovať lokálne“**. Všetko potom beží v prehliadači, aj bez internetu:
import zipu, opravy, bodovanie, História, miniatúry, výsledné PDF, export zipu a CSV. Dáta sú uložené
v prehliadači daného zariadenia (IndexedDB) a vypaľovanie do PDF používa ten istý kód ako server.

Google účet je potrebný len na prácu so serverom:

- **Nahrať na server:** lokálna úloha sa nahrá ako nová úloha na serveri a ostane s ňou prepojená.
- **Do zariadenia:** úloha zo servera sa stiahne do zariadenia aj s opravami a dá sa opravovať úplne offline.
- **Synchronizovať:** zmeny z oboch strán sa zlúčia po objektoch, rovnako ako keď dvaja opravujú naraz.

Po prihlásení sa pri novej úlohe dá vybrať, či pôjde **na server** alebo **do zariadenia**.

## Rýchly štart (skripty)

| Skript | Čo robí |
|---|---|
| `./run.sh` | spustí aplikáciu (Docker/Podman Compose) a počká, kým nabehne; ak chýba `.env`, vytvorí ho z `.env.example` |
| `./stop.sh` | zastaví aplikáciu, dáta ostávajú (`--down` odstráni aj kontajnery, volumes s dátami nikdy) |
| `./build.sh` | kontrola typov → záloha → zostavenie najnovšieho image (`opravovator:<verzia>` a `:latest`) → reštart; `--save` uloží image ako jeden súbor `images/opravovator-<verzia>.tar.gz`, `--no-restart`, `--no-backup` |
| `./backup.sh` | záloha lokálnej databázy a súborov do `backups/` |
| `scripts/deploy.sh` | aktualizácia na Fly.io s upozornením online ľudí (pozri nižšie) |

## Spustenie cez Docker (odporúčané)

Potrebuješ Docker s `docker compose` (alebo Podman s `podman compose`).

```bash
cp .env.example .env      # doplň GOOGLE_CLIENT_ID, zmeň POSTGRES_PASSWORD
docker compose up -d --build
```

Aplikácia beží na `http://localhost:3000` (port zmeníš cez `PORT` v `.env`).
Pri štarte si sama vytvorí tabuľky v databáze.

Aktualizácia na novú verziu: `docker compose up -d --build`. Dáta ostávajú vo volumes.

### Google prihlásenie

1. [Google Cloud Console](https://console.cloud.google.com/) → APIs & Services → Credentials → **Create credentials → OAuth client ID** → typ **Web application**.
2. Do **Authorized JavaScript origins** pridaj adresu servera, napr. `https://opravovator.trojsten.sk` (na lokálne testovanie `http://localhost:3000`).
3. Client ID daj do `.env` ako `GOOGLE_CLIENT_ID`.
4. `ALLOWED_DOMAINS=trojsten.sk` pustí len účty `@trojsten.sk`. Viac domén oddeľ čiarkou, prázdne znamená hocijaký Google účet.

Na lokálne skúšanie bez Google je `DEV_LOGIN=1` (prihlásenie zadaním e-mailu). **Na verejnom serveri ho nikdy nezapínaj.**

## Nastavenia (`.env`)

| Premenná | Predvolené | Význam |
|---|---|---|
| `PORT` | `3000` | port na hostiteľovi |
| `GOOGLE_CLIENT_ID` | – | OAuth Client ID |
| `ALLOWED_DOMAINS` | – | povolené domény e-mailov, čiarkou oddelené; prázdne = všetky |
| `POSTGRES_PASSWORD` | `opravovator` | heslo do databázy |
| `COOKIE_SECURE` | `auto` | `auto` = Secure cookie pri HTTPS (aj za proxy) |
| `DEV_LOGIN` | `0` | testovacie prihlásenie bez Google |
| `SESSION_DAYS` | `60` | ako dlho platí prihlásenie |
| `DB_LIMIT_MB` | – | limit databázy v MB, admin panel ukáže zaplnenie (na Fly 512 = bezplatný Neon) |
| `DATABASE_URL` | nastaví compose | pri vlastnej PostgreSQL |

## Nasadenie na Fly.io (+ databáza Neon)

Aplikácia beží na [Fly.io](https://fly.io) (Frankfurt, s diskom na PDF), databáza v [Neon](https://neon.tech)
(bezplatný plán). HTTPS certifikát dá Fly zadarmo, takže funguje aj inštalácia appky a offline režim.
Konfigurácia je v `fly.toml`.

**Cena (orientačne, over na fly.io/docs/about/pricing):** Fly nemá bezplatný plán, platí sa za využitie.
Pri uspávaní (predvolené) ~0,5–1,5 $ mesačne, hlavne za 3 GB disk (0,15 $/GB; zväčšiť: `fly volumes extend <id> --size N`, zmenšiť sa nedá). Stále zapnutý ~7–8 $.
Neon je v bezplatnom pláne (0,5 GB – odhadom tisíce opravených riešení).

1. **Databáza (Neon):** zaregistruj sa na neon.tech, vytvor projekt v regióne **AWS Europe Central 1 (Frankfurt)**
   a skopíruj *connection string* **bez** `-pooler` v názve hosta (priame pripojenie), napr.
   `postgresql://user:heslo@ep-xxx.eu-central-1.aws.neon.tech/neondb?sslmode=require`.

2. **Fly CLI:** nainštaluj `flyctl` (https://fly.io/docs/flyctl/install/) a prihlás sa:
   ```bash
   fly auth login
   ```

3. **Appka a disk** (v priečinku projektu; ak je názov `opravovator` obsadený, zmeň `app` vo `fly.toml`):
   ```bash
   fly apps create opravovator
   fly volumes create opravovator_data --region fra --size 3
   ```

4. **Tajné nastavenia:**
   ```bash
   fly secrets set DATABASE_URL='postgresql://…?sslmode=require' GOOGLE_CLIENT_ID='….apps.googleusercontent.com'
   ```

5. **Nasadenie** (aj každá ďalšia aktualizácia):
   ```bash
   fly deploy
   ```

6. **Google:** do *Authorized JavaScript origins* pridaj `https://opravovator.fly.dev` (alebo tvoj názov appky).

7. **Vlastná doména (voliteľné):** `fly certs add opravovator.trojsten.sk`, u správcu domény nastav
   záznamy podľa výpisu a doménu pridaj aj do Google origins.

### Aktualizácia bez straty dát

Pred každou aktualizáciou pridaj nový záznam **na začiatok** `shared/src/changelog.ts` (verzia + zoznam zmien).
Po nasadení sa vedúcim na hlavnej stránke vedľa loga ukáže farebné tlačidlo **Aktualizácia** so zoznamom zmien
a časom nasadenia (len ak bola nasadená nová verzia od ich prihlásenia a zoznam ešte neotvorili).

Jednorazovo: `fly secrets set DEPLOY_TOKEN=$(openssl rand -hex 24)` (ten istý kľúč si ulož u seba). Potom:

```bash
DEPLOY_TOKEN=… ./scripts/deploy.sh 5 "Nová verzia s intervalovým bodovaním"
```

Skript: skontroluje a zostaví image (server ešte beží) → urobí snímku disku a pri nastavenom `DATABASE_URL` aj `pg_dump`
do `backups/` → **oznámi reštart o 5 minút** všetkým online (odpočet v appke, ich zmeny sa uložia hneď a ešte raz
20 s pred reštartom, vrátane rozpísaného textu) → počas čakania vypisuje, kto je online → nasadí pripravený image →
overí, že beží nová verzia. Keď niečo zlyhá, oznámenie zruší.

Ručne sa dá reštart oznámiť aj v admin paneli (`/admin` → **Reštart**), kde vidno aj to, kto je práve online.

Čo chráni dáta počas reštartu: server po SIGTERM nové požiadavky neprijíma a rozbehnuté ukladanie dokončí
(`kill_timeout = 30s` vo `fly.toml`); zmeny, ktoré sa počas reštartu nepodarí odoslať (aj chyby 502/503 z proxy),
počkajú v zariadení v offline fronte a odošlú sa po štarte; po aktualizácii appka ponúkne obnovenie stránky
až po uložení všetkého. Migrácie databázy len pridávajú stĺpce/tabuľky, nič nemažú.

Užitočné: `fly logs` (logy), `fly status`, `fly ssh console` (príkazový riadok v stroji).
Stále zapnutý server: vo `fly.toml` nastav `auto_stop_machines = "off"` a `min_machines_running = 1`.

**Zálohy:** Fly robí denné snímky disku (`fly volumes snapshots list`), Neon má obnovu databázy k času v minulosti.
Ručná záloha databázy: `pg_dump "$DATABASE_URL" > zaloha.sql`.

**Obmedzenie:** appka musí bežať na **jednom stroji** (disk s PDF je len jeden a prehľad „kto má čo otvorené“
je v pamäti). `fly deploy` to tak nechá; nespúšťaj `fly scale count 2`.

## Nasadenie na server s HTTPS

Inštalácia ako aplikácia a offline režim fungujú len cez **HTTPS** (alebo na `localhost`).
Pred aplikáciu daj reverse proxy s certifikátom. Aby neplatili limity na veľkosť zipu, vypni ich aj v proxy.

**Caddy** (certifikát si vybaví sám):

```
opravovator.example.sk {
  reverse_proxy localhost:3000
}
```

**nginx**:

```nginx
location / {
  proxy_pass http://127.0.0.1:3000;
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto $scheme;
  client_max_body_size 0;          # bez limitu veľkosti
  proxy_request_buffering off;
  proxy_read_timeout 3600s;
  proxy_send_timeout 3600s;
}
```

## Inštalácia ako aplikácia

V Chrome/Edge klikni na „Nainštalovať appku“ v hlavičke (alebo na ikonu inštalácie v adresnom riadku).
Opravovátor sa potom otvára vo vlastnom okne a má ikonu v systéme.

## Zálohovanie

Dáta sú v dvoch Docker volumes:

- `db-data`: databáza (úlohy, anotácie, body, história, používatelia)
- `app-data`: nahraté PDF, vypálené opravy, obrázky

```bash
# databáza
docker compose exec db pg_dump -U opravovator opravovator > zaloha.sql
# súbory
docker run --rm -v opravovator_app-data:/data -v "$PWD":/backup alpine tar czf /backup/data.tgz -C /data .
```

## Štruktúra zipu

```
[Názov úlohy/]                          ← nepovinný koreňový priečinok
  000-meno-priezvisko-ID/
    meno-priezvisko.pdf                 ← riešenie (nikdy sa neprepíše)
    meno-priezvisko.komentar.pdf        ← vznikne z opráv pri exporte
    body.txt                            ← body, pri exporte vždy celé číslo, napr. 5.00
    komentar.txt                        ← komentár úlohy, rovnaký pre všetky riešenia
```

- Ak zip obsahuje `body.txt`, jeho hodnota sa načíta ako ručne zadané body.
- Ak zip obsahuje `komentar.txt`/`komentár.txt`, použije sa jeho obsah aj názov súboru.
- Predpona priečinka sa berie ako ročník (napr. `Sek-…`), okrem poradových čísel `000`, `001`, … Ročník sa dá zmeniť dvojklikom v zozname.
- **Dodatočné riešenia:** v editore na konci zoznamu riešení tlačidlo „+“ → zip (celé nové hromadné opravovanie alebo len nové priečinky).
  Riešenia sa párujú podľa ID riešiteľa (číslo na konci priečinka); existujúce ostanú aj s opravami, pribudnú len nové,
  poradie sa zoradí podľa ID a priečinky v exporte dostanú poradové čísla podľa ID (ako v hromadnom opravovaní).
- Pri exporte sa `meno.komentar.pdf` vytvorí vždy z pôvodného PDF, opravy sa teda nevrstvia.
  Riešenia bez opráv si ponechajú to, čo bolo v zipe.

## Skratky v editore

| Kláves | Akcia |
|---|---|
| V / T / A / L / R / E / H / U / I / B | výber, text, šípka, čiara, obdĺžnik, elipsa, zvýrazňovač, podčiarknutie, obrázok, pečiatka s bodmi |
| Ťahanie úchytu vpravo na texte | šírka textového poľa (zalamovanie), dvojklik naň = bez zalamovania |
| Shift pri ťahaní | štvorec/kruh, čiary po 45°, obrázok bez zachovania pomeru |
| Dvojklik / Enter na texte | úprava textu (Ctrl+Enter alebo Esc ukončí) |
| Delete | zmazať označené |
| Šípky (so Shift) | posun o 1 (10) bodov |
| Ctrl+Z / Ctrl+Y | späť / znova |
| Ctrl+C / Ctrl+V | kopírovať objekt, aj do iného riešenia na to isté miesto |
| 1–9 | zaškrtnúť položku bodovania (pri intervaloch plný počet ↔ 0) |
| Alt+↓ / Alt+↑ | ďalšie / predchádzajúce riešenie |

## Vývoj

Potrebuješ Node.js 22+, PostgreSQL a na miniatúry `pdftoppm` (balík `poppler-utils`).

```bash
npm install
docker run -d --name opravovator-db -p 5432:5432 -e POSTGRES_USER=opravovator \
  -e POSTGRES_PASSWORD=opravovator -e POSTGRES_DB=opravovator postgres:17-alpine
echo "DEV_LOGIN=1" > .env
npm run dev          # server na :3000, frontend s hot reloadom na http://localhost:5173
npm run typecheck
npm run build && npm start   # produkčný build na :3000
```

```
shared/   spoločné typy, geometria, body (prehliadač aj server)
server/   Fastify API, import/export zipov, vypaľovanie do PDF (pdf-lib), migrácie SQL
web/      React aplikácia, editor (pdf.js), service worker (offline, inštalácia)
legacy/   pôvodná verzia (Node.js + SQLite), len na porovnanie
```

## Licencia

[GNU General Public License v3.0](LICENSE) alebo novšia (GPL-3.0-or-later).
