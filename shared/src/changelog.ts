// Zoznam zmien – ukazuje sa vedúcim po aktualizácii (tlačidlo „Aktualizácia“ na hlavnej stránke).
// Nová verzia = nový záznam NA ZAČIATOK zoznamu; čas nasadenia si server zapíše pri prvom štarte tejto verzie.

export interface ChangeItem { area: string; text: string }
export interface Release { version: string; items: ChangeItem[] }

export const CHANGELOG: Release[] = [
  {
    version: '2.1.0',
    items: [
      { area: 'Editor', text: 'Nastavenia strany v hornej lište: pridanie prázdnej strany A4 a otočenie naskenovanej strany (strana ostane na výšku, sken sa otočí a zmestí na ňu).' },
      { area: 'Editor', text: 'Okraje na písanie: v Nastaveniach strany sa dá obsah strany zmenšiť na stred (100 – 50 %), jednotlivo alebo pre všetky strany.' },
      { area: 'Editor', text: 'Zvýrazňovač (H) a podčiarknutie (U) – označením textu v PDF alebo natiahnutím na skene; podčiarknutý text v komentároch.' },
      { area: 'Editor', text: 'Text v PDF sa dá označiť a kopírovať, odkazy v PDF sa dajú otvoriť kliknutím. Adresy v komentároch sú vo výslednom PDF klikateľné.' },
      { area: 'Editor', text: 'Výplň obdĺžnikov a elíps farbou s nastaviteľnou priehľadnosťou.' },
      { area: 'Editor', text: 'Šírka textového poľa sa dá zmeniť úchytom vpravo – text sa zalamuje; dlhý text sa sám zalomí na okraji strany.' },
      { area: 'Riešenia', text: 'Dodatočné riešenia: tlačidlo „+“ na konci zoznamu riešení nahrá zip (aj celé nové hromadné opravovanie). Riešenia sa porovnajú podľa ID riešiteľa – existujúce ostanú aj s opravami, pribudnú nové a poradie aj priečinky v exporte budú podľa ID.' },
      { area: 'Bodovanie', text: 'Intervalový režim: každá položka má interval 0 až jej body a nastavuje sa posuvníkom.' },
      { area: 'Bodovanie', text: 'Interné body sú sivé, kým sú na predvolených hodnotách (0 / 5 / 5), farebné až po zmene.' },
      { area: 'Export', text: 'Body v exporte (body.txt, CSV, pečiatka v PDF) sú vždy celé číslo, zaokrúhlené normálne (0,5 nahor).' },
      { area: 'Body v PDF', text: 'V nastaveniach stále rovnaké písmo, farba a veľkosť bodov – vložené body sa už neriadia práve zvoleným perom.' },
      { area: 'Podpis', text: 'V nastaveniach stále rovnaké písmo a farba podpisu a jeho poloha pod / nad / vľavo / vpravo od bodov.' },
      { area: 'Zdieľanie', text: 'V zdieľanej úlohe môže byť pod bodmi viac podpisov vedľa seba, každý podľa nastavení daného vedúceho (Nastavenia úlohy).' },
      { area: 'Aktualizácie', text: 'Pred reštartom servera sa všetkým online zobrazí upozornenie s odpočtom a zmeny sa samy uložia; zmeny počas reštartu počkajú v zariadení.' },
      { area: 'Aktualizácie', text: 'Tlačidlo „Aktualizácia“ na hlavnej stránke s týmto zoznamom zmien a časom nasadenia.' },
    ],
  },
];

export const APP_VERSION = CHANGELOG[0].version;

/** Plánovaný reštart servera (oznámenie pre online používateľov). */
export interface Maintenance { at: string; message: string }
/** Stav servera pre prehliadač (zisťuje sa pravidelne). */
export interface ServerStatus {
  version: string; deployed_at: string | null; maintenance: Maintenance | null;
  /** prihlásený: od jeho prihlásenia bola nasadená nová verzia a zoznam zmien ešte nevidel */ update: boolean;
}
export interface ReleaseInfo extends Release { deployed_at: string | null }
