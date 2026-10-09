# Opravovač

Webový editor na opravovanie PDF riešení korešpondenčných seminárov. Node.js + SQLite, žiadny build krok.

## Spustenie

```bash
npm install
npm start            # http://localhost:3000
```

Alebo Docker:

```bash
docker build -t opravovac .
docker run -p 3000:3000 -v opravovac-data:/data -e GOOGLE_CLIENT_ID=... opravovac
```

Nastavenia cez premenné prostredia sú v `.env.example`.
Všetky dáta (databáza `opravovac.db` aj súbory úloh) sú v `DATA_DIR` – na hostingu ho daj na perzistentný disk a zálohuj.

## Google prihlásenie (voliteľné)

1. Google Cloud Console → APIs & Services → Credentials → Create OAuth client ID → Web application.
2. Do Authorized JavaScript origins pridaj adresu servera (napr. `https://opravovac.trojsten.sk`, na test `http://localhost:3000`).
3. Client ID nastav do `GOOGLE_CLIENT_ID`. Server overí token a pustí len overené e-maily `@trojsten.sk`.

## Štruktúra zipu

```
Názov úlohy/
  xxx-meno-priezvisko-ID/
    meno-priezvisko.pdf
    body.txt                       ← finálne body, jedno číslo (napr. 4.5)
    komentar.txt                   ← komentár úlohy, rovnaký pre všetky riešenia
    original-meno-priezvisko.pdf   ← vznikne pri prvej úprave
```

`xxx` sa berie ako ročník (dá sa zmeniť dvojklikom na odznak v zozname).
Ak zip obsahuje `komentár.txt`/`komentar.txt`, použije sa jeho názov aj obsah.

## Ukladanie

- Anotácie sú v databáze ako objekty, takže sa dajú kedykoľvek presúvať a meniť.
- Po každej akcii (s ~0,5 s oneskorením) server vypáli anotácie do `meno-priezvisko.pdf` a zapíše `body.txt` aj `komentar.txt`.
- Výsledok sa vždy generuje z pôvodného PDF, opravy sa teda nevrstvia.
- „Stiahnuť zip" vráti priečinok úlohy v pôvodnej štruktúre.

## Skratky v editore

| Kláves | Akcia |
|---|---|
| V / T / A / L / R / E / I / B | výber, text, šípka, čiara, obdĺžnik, elipsa, obrázok, body |
| Shift pri ťahaní | štvorec/kruh, čiary po 45° |
| Dvojklik / Enter na texte | úprava textu (Ctrl+Enter alebo Esc ukončí) |
| Delete | zmazať označené |
| Šípky (so Shift) | posun o 1 (10) bodov |
| Ctrl+Z / Ctrl+Y | späť / znova |
| Ctrl+C / Ctrl+V | kopírovať objekt, aj do iného riešenia na to isté miesto |
| 1–9 | zaškrtnúť položku bodovania |
| Alt+↓ / Alt+↑ | ďalšie / predchádzajúce riešenie |

## Testovacie dáta

`node scripts/mk-test-zip.js test.zip` vytvorí zip so štyrmi vzorovými riešeniami.

## Veľké zipy

Zip sa nahrá na disk (`DATA_DIR/tmp`) a rozbaľuje sa po súboroch, takže veľkosť pamäť nezaťaží. Limit je `MAX_UPLOAD_MB` (predvolene 4096).
Ak beží aplikácia za nginx, zvýš aj tam limit a timeouty:

```nginx
client_max_body_size 4g;
proxy_request_buffering off;
proxy_read_timeout 600s;
```
