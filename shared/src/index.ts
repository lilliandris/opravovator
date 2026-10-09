// Zdieľané medzi prehliadačom a serverom – typy, geometria a výpočet bodov,
// aby náhľad v editore presne sedel s tým, čo sa vypáli do PDF.

export const LINE_HEIGHT = 1.2;
export const STAMP_NAME_RATIO = 0.42;
export const STAMP_LINE_GAP = 1.05;

/* ================= typy ================= */

interface AnnBase {
  id: string;
  page: number;
  color?: string;
}
// w = šírka textového poľa (text sa zalamuje), bez nej sa nezalamuje; underline = podčiarknutý text
export interface TextAnn extends AnnBase { type: 'text'; x: number; y: number; text: string; font: string; size: number; w?: number; underline?: boolean }
/** Jeden podpis pod bodmi: text (name, nameFont, color), alebo obrázok (assetId, ratio = výška / šírka, imgScale). */
export interface Sig { name?: string; nameFont?: string; color?: string; assetId?: number; ratio?: number; imgScale?: number }
/** Kde je podpis voči bodom. */
export type SigPos = 'below' | 'above' | 'left' | 'right';
export const SIG_POSITIONS: [SigPos, string][] = [['below', 'Pod bodmi'], ['above', 'Nad bodmi'], ['left', 'Vľavo'], ['right', 'Vpravo']];
export const isSigPos = (v: unknown): v is SigPos => SIG_POSITIONS.some(([p]) => p === v);
// nameFont = písmo podpisu pod bodmi (inak rovnaké ako body), nameColor = farba podpisu (inak ako body);
// assetId = podpis ako obrázok namiesto textu, ratio = jeho výška / šírka, imgScale = jeho veľkosť (1 = predvolená);
// sigs = viac podpisov vedľa seba (zdieľaná úloha) – ak je, name/assetId sa nepoužijú; sigPos = poloha podpisu (predvolene pod)
export interface StampAnn extends AnnBase {
  type: 'stamp'; x: number; y: number; font: string; size: number; name?: string; nameFont?: string; assetId?: number; ratio?: number; imgScale?: number;
  nameColor?: string; sigPos?: SigPos; sigs?: Sig[];
}
export interface LineAnn extends AnnBase { type: 'line' | 'arrow'; x1: number; y1: number; x2: number; y2: number; width: number }
// fill = farba výplne (bez nej prázdne), fillOpacity = jej krytie 0–1
export interface BoxAnn extends AnnBase { type: 'rect' | 'ellipse'; x: number; y: number; w: number; h: number; width: number; fill?: string; fillOpacity?: number }
export interface ImageAnn extends AnnBase { type: 'image'; x: number; y: number; w: number; h: number; assetId: number }
export interface Rect { x: number; y: number; w: number; h: number }
/** Zvýraznenie (priesvitný marker) alebo podčiarknutie – riadky označeného textu v PDF, alebo ručne natiahnutý obdĺžnik. */
export interface MarkAnn extends AnnBase { type: 'highlight' | 'underline'; rects: Rect[]; opacity?: number; width?: number }
export type Annotation = TextAnn | StampAnn | LineAnn | BoxAnn | ImageAnn | MarkAnn;
export type AnnType = Annotation['type'];

export interface RubricItem { id: string; label: string; points: number }
/** checks = zaškrtávanie položiek, range = každá položka je interval 0 až `points` (posuvník) */
export type RubricMode = 'checks' | 'range';
export const normRubricMode = (v: unknown): RubricMode => (v === 'range' ? 'range' : 'checks');

/**
 * Strana výsledného PDF: src = index strany v pôvodnom PDF (null = pridaná prázdna strana),
 * rot = otočenie obsahu v smere hodinových ručičiek (strana ostáva rovnako veľká, obsah sa do nej zmestí),
 * crop = časť pôvodnej strany, ktorá je naozaj riešenie (sken), w/h = rozmer prázdnej strany.
 */
export interface PageSpec { src: number | null; rot?: number; crop?: Rect; w?: number; h?: number; scale?: number }
/** scale = veľkosť obsahu strany (< 1 = obsah zmenšený na stred, okolo sú voľné okraje na písanie) */
export const PAGE_SCALES = [1, 0.9, 0.8, 0.7, 0.6, 0.5];
/** Strana sa vykresľuje inak ako v pôvodnom PDF (otočená alebo zmenšená). */
export const pageTransformed = (p: PageSpec) => !!p.rot || (!!p.scale && p.scale !== 1);
export const A4 = { w: 595.28, h: 841.89 };

/** Interné body [Správnosť, Úsilie, AI a podvádzanie] – vidia ich len vedúci, do PDF sa nedostanú. */
export type Bias = [number, number, number];

// ascent = fontkit ascent / unitsPerEm (server ho počíta rovnako zo súboru)
export interface FontInfo { id: string; label: string; file: string; ascent: number }
export const FONTS: FontInfo[] = [
  { id: 'bebas', label: 'Bebas Neue', file: 'BebasNeue-Regular.ttf', ascent: 0.9 },
  { id: 'lato', label: 'Lato', file: 'Lato-Regular.ttf', ascent: 0.987 },
  { id: 'lato-bold', label: 'Lato Bold', file: 'Lato-Bold.ttf', ascent: 0.987 },
  { id: 'ptserif', label: 'PT Serif', file: 'PT_Serif-Web-Regular.ttf', ascent: 1.039 },
  { id: 'patrick', label: 'Patrick Hand', file: 'PatrickHand-Regular.ttf', ascent: 1.042 },
  { id: 'kalam', label: 'Kalam', file: 'Kalam-Regular.ttf', ascent: 1.063 },
  { id: 'caveat', label: 'Caveat Brush', file: 'CaveatBrush-Regular.ttf', ascent: 0.96 },
  { id: 'mono', label: 'IBM Plex Mono', file: 'IBMPlexMono-Regular.ttf', ascent: 1.025 },
];
export const fontById = (id: string) => FONTS.find(f => f.id === id) || FONTS[0];
export const fontFamily = (id: string) => 'pdf-' + id;

/* ================= API typy ================= */

// stamp_name/stamp_font = predvolený podpis pod bodmi (prezývka a písmo)
export interface User {
  id: number; email: string; name: string; picture: string | null; stamp_name: string | null; stamp_font: string | null;
  /** farba tlačidiel a názvu (id z ACCENTS), null = predvolená */
  accent: string | null;
  /** vlastná farba pera (#rrggbb), null = zatiaľ nevybraná */
  pen_color: string | null;
  /** podpis pod bodmi ako obrázok (id z knižnice obrázkov), null = textový podpis */
  stamp_image: number | null;
  /** veľkosť obrázkového podpisu, null = 1 */
  stamp_image_scale: number | null;
  /** farba textového podpisu (#rrggbb), null = rovnaká ako body */
  stamp_color: string | null;
  /** poloha podpisu voči bodom, null = pod bodmi */
  stamp_pos: SigPos | null;
  /** stále rovnaké písmo, farba a veľkosť bodov v PDF, null = podľa práve nastaveného pera */
  stamp_points_font: string | null;
  stamp_points_color: string | null;
  stamp_points_size: number | null;
}

/** Podpis jedného z ľudí, ktorí opravujú zdieľanú úlohu (podľa jeho nastavení). */
export interface Signer { id: number; name: string; email: string; sig: Sig }

export interface TaskSummary {
  id: number; name: string; created_at: string;
  /** posledná zmena v úlohe (opravy, body, nastavenia) */ updated_at: string;
  owner: string; owner_email: string;
  is_owner: boolean; total: number; graded: number; annotated: number;
  /** súčet rev všetkých riešení – kópia v zariadení podľa neho zistí, či sú na serveri novšie zmeny */ revs: number;
}
export interface SolutionListItem {
  id: number; idx: number; folder: string; pdf_name: string | null; display_name: string;
  rocnik: string; student_id: string; points: number | null; annotated: boolean; rev: number;
  updated_at: string | null;
  /** interné body S U P */ bias: Bias;
  /** má v PDF opravu okrem pečiatky */ commented: boolean;
  /** má v PDF pečiatku s bodmi */ stamped: boolean;
}
export interface TaskDetail {
  id: number; name: string; root_folder: string | null; comment_text: string; comment_filename: string;
  max_points: number | null; rubric: RubricItem[]; is_owner: boolean; shares: string[];
  solutions: SolutionListItem[];
  /** spôsob bodovania (zaškrtávanie / intervaly) */ rubric_mode: RubricMode;
  /** zdieľaná úloha: čie podpisy sa dajú pod body (id používateľov, prázdne = len môj) */ signers: number[];
}
export interface SolutionDetail {
  id: number; task_id: number; idx: number; folder: string; pdf_name: string | null; display_name: string;
  rocnik: string; student_id: string; annotations: Annotation[]; checks: string[];
  manual_points: number | null; points: number | null; rev: number;
  updated_at: string | null; updated_by: string | null;
  bias: Bias; bias_comment: string;
  pages: PageSpec[] | null; scores: Scores;
}
/** Upraviteľný stav riešenia (to, čo sa zlučuje pri súbehu). */
/** body za položky v intervalovom bodovaní (id položky → body) */
export type Scores = Record<string, number>;
export interface SolState {
  annotations: Annotation[]; checks: string[]; manual_points: number | null; rocnik: string;
  /** interné body a interný komentár (bias.txt, bias_komentar.txt) */ bias: Bias; bias_comment: string;
  /** strany výsledného PDF (pridané prázdne, otočené), null = ako v pôvodnom PDF */ pages: PageSpec[] | null;
  /** intervalové bodovanie */ scores: Scores;
}
export interface SolutionSave {
  annotations?: Annotation[]; checks?: string[]; manual_points?: number | null; rocnik?: string;
  bias?: Bias; bias_comment?: string; pages?: PageSpec[] | null; scores?: Scores;
  /** rev a stav na serveri, z ktorého tieto zmeny vychádzajú (na zlúčenie pri súbehu) */
  baseRev?: number; base?: SolState;
}
export interface SaveResult {
  ok: true; points: number | null; rocnik: string; rev: number; conflict: boolean;
  /** pri súbehu: výsledok zlúčenia s cudzími zmenami a kto ich urobil */
  merged?: SolState | null; mergedWith?: string | null;
}
/** Kto má otvorené ktoré riešenie. */
export interface PresenceItem { user_id: number; name: string; sol_id: number | null }
export interface PresenceResult { others: PresenceItem[]; rev: number | null }
export interface VersionItem {
  id: number; rev: number; created_at: string; user: string | null; points: number | null; count: number;
  /** počet zmien v tejto verzii (aj úprava textu existujúceho objektu) */ changes: number;
}

/* ================= admin ================= */

export const ACTIVITY_LABELS = {
  login: 'prihlásil sa',
  logout: 'odhlásil sa',
  task_upload: 'nahral úlohu',
  task_open: 'otvoril úlohu',
  task_close: 'zavrel úlohu',
  task_download_device: 'stiahol úlohu do zariadenia',
  task_download_zip: 'stiahol zip',
  task_download_csv: 'stiahol CSV',
  task_share: 'nazdieľal úlohu',
  task_unshare: 'zrušil zdieľanie',
  task_delete: 'zmazal úlohu',
  task_add_solutions: 'pridal riešenia',
  asset_upload: 'nahral obrázok',
  admin_task_edit: 'admin: upravil úlohu',
  admin_task_delete: 'admin: zmazal úlohu',
  admin_add: 'admin: pridal admina',
  admin_remove: 'admin: odobral admina',
  admin_maintenance: 'oznámil reštart servera',
} as const;
export type ActivityAction = keyof typeof ACTIVITY_LABELS;

export interface AdminTask {
  id: number; name: string; created_at: string; updated_at: string;
  total: number; graded: number; annotated: number; shares: string[];
  comment_text: string; max_points: number | null;
}
export interface AdminUser {
  id: number; email: string; name: string; picture: string | null;
  created_at: string; last_login_at: string | null; is_admin: boolean;
  tasks: AdminTask[];
}
export interface AdminSolutionHit {
  id: number; display_name: string; folder: string; rocnik: string; points: number | null;
  task_id: number; task_name: string; owner: string; owner_email: string;
}
export interface ActivityItem {
  id: number; at: string; user_id: number | null; user: string | null; email: string | null;
  action: ActivityAction; task_id: number | null; task_name: string | null; details: string;
}
export interface AdminStats { db_bytes: number; /** null = bez limitu */ db_limit_bytes: number | null }
export interface AdminEntry { email: string; added_by: string | null; created_at: string; name: string | null }

/* ================= geometria ================= */

export function arrowGeometry(x1: number, y1: number, x2: number, y2: number, width: number) {
  const dx = x2 - x1, dy = y2 - y1;
  const len = Math.hypot(dx, dy) || 1;
  let L = Math.max(9, width * 4.2);
  if (L > len * 0.7) L = len * 0.7;
  const hw = L * 0.55;
  const ux = dx / len, uy = dy / len;
  const bx = x2 - ux * L, by = y2 - uy * L;
  const nx = -uy, ny = ux;
  return {
    shaft: [x1, y1, x2 - ux * L * 0.8, y2 - uy * L * 0.8] as [number, number, number, number],
    head: [[x2, y2], [bx + nx * hw, by + ny * hw], [bx - nx * hw, by - ny * hw]] as [number, number][],
  };
}

export function normBox(a: { x: number; y: number; w: number; h: number }) {
  return { x: Math.min(a.x, a.x + a.w), y: Math.min(a.y, a.y + a.h), w: Math.abs(a.w), h: Math.abs(a.h) };
}

export const STAMP_IMAGE_SCALE = { min: 0.3, max: 3 };
export const clampImgScale = (v: unknown) =>
  Math.min(STAMP_IMAGE_SCALE.max, Math.max(STAMP_IMAGE_SCALE.min, Number(v) || 1));

/** šírka textu v bodoch strany: (text, veľkosť písma, id písma) → šírka */
export type Measure = (text: string, size: number, font: string) => number;

/** Podpisy na pečiatke – staršie pečiatky majú jeden podpis priamo v name / assetId. */
export function stampSigs(a: StampAnn, correctorName = ''): Sig[] {
  if (a.sigs) return a.sigs;
  if (a.assetId) return [{ assetId: a.assetId, ratio: a.ratio, imgScale: a.imgScale }];
  const name = a.name !== undefined ? a.name : correctorName;
  return name ? [{ name, nameFont: a.nameFont, color: a.nameColor }] : [];
}

export type StampPart =
  | { kind: 'text'; text: string; size: number; font: string; color: string; cx: number; top: number }
  | { kind: 'image'; assetId: number; x: number; y: number; w: number; h: number };

/**
 * Rozloženie pečiatky: body (vycentrované na a.x, horný okraj a.y) a podpisy vedľa seba
 * pod, nad, vľavo alebo vpravo od bodov. Jeden podpis pod bodmi je presne ako v starších verziách.
 */
export function stampLayout(a: StampAnn, points: number | null, correctorName: string, measure: Measure): StampPart[] {
  const size = Number(a.size) || 40;
  const color = a.color || DEFAULT_COLOR;
  const ptsText = (points === null ? '?' : formatPoints(exportPoints(points))) + 'B';
  const parts: StampPart[] = [{ kind: 'text', text: ptsText, size, font: a.font, color, cx: a.x, top: a.y }];
  const items = stampSigs(a, correctorName).map(sg => {
    if (sg.assetId) {
      const ratio = Number(sg.ratio) || 0.4;
      const k = sg.imgScale ? clampImgScale(sg.imgScale) : 1;
      let h = size * 0.9 * k, w = h / ratio;
      if (w > size * 4 * k) { w = size * 4 * k; h = w * ratio; }
      return { sg, w, h };
    }
    const sz = size * STAMP_NAME_RATIO;
    return { sg, w: measure(sg.name || '', sz, sg.nameFont || a.font), h: sz };
  }).filter(it => it.sg.assetId || it.sg.name);
  if (!items.length) return parts;

  const gap = size * 0.25;
  const rowW = items.reduce((n, it) => n + it.w, 0) + gap * (items.length - 1);
  const rowH = Math.max(...items.map(it => it.h));
  const pos = a.sigPos || 'below';
  let left: number, cy: number;
  if (pos === 'below' || pos === 'above') {
    left = a.x - rowW / 2;
    const top = pos === 'below' ? a.y + size * STAMP_LINE_GAP : a.y + size * 0.12 - rowH;
    cy = top + rowH / 2;
  } else {
    const pw = measure(ptsText, size, a.font);
    left = pos === 'right' ? a.x + pw / 2 + size * 0.2 : a.x - pw / 2 - size * 0.2 - rowW;
    cy = a.y + size * 0.55;
  }
  for (const it of items) {
    if (it.sg.assetId) {
      parts.push({ kind: 'image', assetId: it.sg.assetId, x: left, y: cy - it.h / 2, w: it.w, h: it.h });
    } else {
      parts.push({ kind: 'text', text: it.sg.name!, size: it.h, font: it.sg.nameFont || a.font, color: it.sg.color || color, cx: left + it.w / 2, top: cy - it.h / 2 });
    }
    left += it.w + gap;
  }
  return parts;
}

/** Zalomenie textu na danú šírku (po slovách; príliš dlhé slovo sa rozdelí). */
export function wrapText(text: string, maxW: number, width: (s: string) => number): string[] {
  const out: string[] = [];
  for (const para of String(text || '').split('\n')) {
    let line = '';
    for (const word of para.split(/(?<=\s)(?=\S)/)) {
      const cand = line + word;
      if (!line || width(cand.trimEnd()) <= maxW) { line = cand; }
      else { out.push(line.trimEnd()); line = word; }
      // slovo dlhšie ako celý riadok → po znakoch
      while (width(line.trimEnd()) > maxW && line.trimEnd().length > 1) {
        let i = line.length - 1;
        while (i > 1 && width(line.slice(0, i)) > maxW) i--;
        out.push(line.slice(0, i));
        line = line.slice(i);
      }
    }
    out.push(line.trimEnd());
  }
  return out;
}

/** Riadky textovej poznámky (so zalomením, ak má nastavenú šírku). */
export function textLines(a: TextAnn, measure: Measure): string[] {
  const size = Number(a.size) || 16;
  if (!a.w) return String(a.text || '').split('\n');
  return wrapText(a.text, a.w, t => measure(t, size, a.font));
}

/** Obal obdĺžnikov zvýraznenia. */
export function rectsBox(rects: Rect[]): Rect {
  if (!rects.length) return { x: 0, y: 0, w: 0, h: 0 };
  const x1 = Math.min(...rects.map(r => r.x)), y1 = Math.min(...rects.map(r => r.y));
  const x2 = Math.max(...rects.map(r => r.x + r.w)), y2 = Math.max(...rects.map(r => r.y + r.h));
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

/** Zmenšenie / zväčšenie anotácie okolo bodu (cx, cy) – keď sa mení veľkosť obsahu strany. */
export function scaleAnn(a: Annotation, cx: number, cy: number, r: number) {
  const X = (x: number) => cx + (x - cx) * r, Y = (y: number) => cy + (y - cy) * r;
  if ('x1' in a) { a.x1 = X(a.x1); a.y1 = Y(a.y1); a.x2 = X(a.x2); a.y2 = Y(a.y2); }
  else if ('rects' in a) a.rects = a.rects.map(q => ({ x: X(q.x), y: Y(q.y), w: q.w * r, h: q.h * r }));
  else { a.x = X(a.x); a.y = Y(a.y); }
  if ('w' in a && a.w !== undefined) a.w *= r;
  if ('h' in a && typeof a.h === 'number') a.h *= r;
  if ('size' in a) a.size = Math.round(a.size * r * 2) / 2;
  if ('width' in a && a.width !== undefined) a.width = Math.max(0.3, Math.round(a.width * r * 10) / 10);
}

/** Posun ľubovoľnej anotácie (z pôvodnej polohy `from`). */
export function translateAnn(a: Annotation, dx: number, dy: number, from: Annotation = a) {
  if ('x1' in a && 'x1' in from) { a.x1 = from.x1 + dx; a.y1 = from.y1 + dy; a.x2 = from.x2 + dx; a.y2 = from.y2 + dy; }
  else if ('rects' in a && 'rects' in from) a.rects = from.rects.map(r => ({ ...r, x: r.x + dx, y: r.y + dy }));
  else if ('x' in a && 'x' in from) { a.x = from.x + dx; a.y = from.y + dy; }
}

/* ================= strany ================= */

/**
 * Otočená / zmenšená strana: obsah (pri otočení výrez `crop` pôvodnej strany W×H) sa otočí o `rot` a zmenší,
 * aby sa zmestil na stranu rovnakej veľkosti W×H, vycentrovaný; `scale` < 1 ho zmenší ešte viac (okraje na písanie).
 * Vráti mierku a ľavý horný roh obsahu.
 */
export function rotatedPlacement(spec: PageSpec, W: number, H: number) {
  const rot = (((spec.rot || 0) % 360) + 360) % 360;
  // výrez skenu platí len pri otočení; zmenšenie obsahu (okraje) berie celú stranu
  const c = (rot && spec.crop) || { x: 0, y: 0, w: W, h: H };
  const [rw, rh] = rot % 180 ? [c.h, c.w] : [c.w, c.h];
  const k = Math.min(W / rw, H / rh) * (spec.scale && spec.scale > 0 && spec.scale < 1 ? spec.scale : 1);
  return { rot, crop: c, k, ox: (W - rw * k) / 2, oy: (H - rh * k) / 2, rw: rw * k, rh: rh * k };
}

/** Kontrola strán zo vstupu (server, zariadenie): neplatné → null = pôvodné strany. */
export function normPages(v: unknown): PageSpec[] | null {
  if (!Array.isArray(v) || !v.length) return null;
  const fin = (x: unknown) => Number.isFinite(Number(x));
  const out: PageSpec[] = [];
  for (const p of v) {
    if (!p || typeof p !== 'object') return null;
    const o = p as Record<string, unknown>;
    if (o.src === null) {
      out.push({ src: null, w: fin(o.w) && Number(o.w) > 10 ? Number(o.w) : A4.w, h: fin(o.h) && Number(o.h) > 10 ? Number(o.h) : A4.h });
      continue;
    }
    if (!Number.isInteger(o.src) || (o.src as number) < 0) return null;
    const spec: PageSpec = { src: o.src as number };
    const rot = ((Math.round(Number(o.rot) / 90) * 90) % 360 + 360) % 360;
    if (rot) spec.rot = rot;
    const c = o.crop as Record<string, unknown> | undefined;
    if (c && fin(c.x) && fin(c.y) && Number(c.w) > 1 && Number(c.h) > 1) spec.crop = { x: Number(c.x), y: Number(c.y), w: Number(c.w), h: Number(c.h) };
    const sc = Math.round(Number(o.scale) * 100) / 100;
    if (sc >= 0.3 && sc < 1) spec.scale = sc;
    out.push(spec);
  }
  return out;
}

export function normScores(v: unknown): Scores {
  const out: Scores = {};
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    for (const [k, x] of Object.entries(v)) if (isNum(x)) out[String(k).slice(0, 40)] = round2(Number(x));
  }
  return out;
}

/** Stav riešenia pre príznaky v zozname. */
export function solutionFlags(annotations: Annotation[], pages?: PageSpec[] | null) {
  return {
    annotated: annotations.length > 0 || !!pages,
    commented: annotations.some(a => a.type !== 'stamp'),
    stamped: annotations.some(a => a.type === 'stamp'),
  };
}

/* ================= body ================= */

export const round2 = (n: number) => Math.round(n * 100) / 100;

const isNum = (v: unknown) => v !== null && v !== undefined && v !== '' && !Number.isNaN(Number(v));

/** Interval položky v intervalovom bodovaní (záporné body = strhnutie až do …). */
export const rangeOf = (i: RubricItem): [number, number] => {
  const p = Number(i.points) || 0;
  return p < 0 ? [p, 0] : [0, p];
};

export function computePoints(
  rubric: RubricItem[], checks: string[], manual: number | null | undefined, maxPoints: number | null | undefined,
  scores?: Scores | null, mode?: RubricMode | null,
): number | null {
  let p: number;
  if (isNum(manual)) {
    p = Number(manual);
  } else if (mode === 'range') {
    const items = (rubric || []).filter(i => scores && isNum(scores[i.id]));
    if (!items.length) return null;
    p = items.reduce((s, i) => {
      const [lo, hi] = rangeOf(i);
      return s + Math.min(hi, Math.max(lo, Number(scores![i.id])));
    }, 0);
  } else {
    const set = new Set(checks || []);
    const items = (rubric || []).filter(i => set.has(i.id));
    if (!items.length) return null;
    p = items.reduce((s, i) => s + Number(i.points || 0), 0);
  }
  if (p < 0) p = 0;
  if (isNum(maxPoints) && p > Number(maxPoints)) p = Number(maxPoints);
  return round2(p);
}

export function formatPoints(p: number | null | undefined): string {
  if (p === null || p === undefined) return '';
  return String(round2(p));
}

/** Body pri exporte (body.txt, CSV, pečiatka v PDF) sú celé číslo – zaokrúhlené normálne (0,5 hore). */
export const exportPoints = (p: number) => Math.floor(round2(p) + 0.5);

/** Formát do body.txt – rovnaký ako v exporte hromadného opravovania (napr. „9.00“), vždy celé číslo. */
export function formatPointsFile(p: number): string {
  return exportPoints(p).toFixed(2);
}

/* ================= interné body ================= */

export const BIAS_LABELS = [
  { key: 'S', label: 'Správnosť' },
  { key: 'U', label: 'Úsilie' },
  { key: 'P', label: 'AI a podvádzanie' },
] as const;
/** predvolené interné body S U P */
export const DEFAULT_BIAS: Bias = [0, 5, 5];
/** odporúčané maximum interných bodov (dá sa prekročiť) */
export const BIAS_SOFT_MAX = 9;

/** Hocijaká hodnota (aj chýbajúca zo starších dát) → platné interné body. */
export function normBias(v: unknown): Bias {
  const a = Array.isArray(v) ? v : [];
  return DEFAULT_BIAS.map((d, i) => (isNum(a[i]) ? round2(Number(a[i])) : d)) as Bias;
}

/** Obsah bias.txt („S U P“, napr. „0 5 5“) → interné body. */
export function parseBiasText(t: string): Bias {
  return normBias(t.trim().split(/\s+/).map(x => x.replace(',', '.')));
}

/** Formát do bias.txt, napr. „0 5 5“. */
export function formatBiasFile(b: Bias): string {
  return normBias(b).map(formatPoints).join(' ');
}

export function hexToRgb(hex: string | undefined): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  const v = m ? parseInt(m[1], 16) : 0;
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}

export const DEFAULT_COLOR = '#e0218a';
/** predvolená farba a krytie zvýrazňovača */
export const HIGHLIGHT_COLOR = '#ffd400';
export const HIGHLIGHT_OPACITY = 0.4;
/** maximálna veľkosť nahrávaného obrázka / podpisu */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_IMAGE_MB = MAX_IMAGE_BYTES / 1048576;
/** maximum bodov za úlohu v seminári */
export const DEFAULT_MAX_POINTS = 9;

/** Odstráni diakritiku a zmenší písmená – na vyhľadávanie. */
export function fold(s: string): string {
  return s.toLocaleLowerCase('sk').normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/* ================= zlučovanie pri súbehu ================= */

/** JSON so zoradenými kľúčmi (PostgreSQL jsonb poradie kľúčov mení). */
function stable(v: unknown): string {
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
  if (v && typeof v === 'object') {
    return '{' + Object.keys(v).filter(k => !k.startsWith('_')).sort()
      .map(k => JSON.stringify(k) + ':' + stable((v as Record<string, unknown>)[k])).join(',') + '}';
  }
  return JSON.stringify(v ?? null);
}
/** Porovnanie ignorujúce poradie kľúčov a pomocné polia začínajúce „_“. */
export const same = (a: unknown, b: unknown) => stable(a) === stable(b);

/**
 * Trojcestné zlúčenie: `base` je stav, z ktorého vychádzali obe strany, `local` moje
 * zmeny, `remote` cudzie zmeny. Anotácie sa zlučujú po objektoch (podľa id): zmena
 * vyhrá nad nezmeneným, úprava vyhrá nad zmazaním, pri úprave toho istého objektu
 * oboma stranami vyhrá `local`. Položky bodovania sa zlučujú ako množiny.
 */
export function mergeStates(base: SolState, local: SolState, remote: SolState): SolState {
  // stavy zo starších verzií (offline fronta, prepojenie so zariadením) nemusia mať nové polia
  base = solState(base); local = solState(local); remote = solState(remote);
  const baseMap = new Map(base.annotations.map(a => [a.id, a]));
  const localMap = new Map(local.annotations.map(a => [a.id, a]));
  const remoteIds = new Set(remote.annotations.map(a => a.id));
  const out: Annotation[] = [];
  for (const r of remote.annotations) {
    const b = baseMap.get(r.id), l = localMap.get(r.id);
    if (l) out.push(b && same(l, b) ? r : l);
    else if (!b || !same(r, b)) out.push(r); // pridané u nich, alebo upravené u nich a zmazané u mňa
  }
  for (const l of local.annotations) {
    if (remoteIds.has(l.id)) continue;
    const b = baseMap.get(l.id);
    if (!b || !same(l, b)) out.push(l); // pridané u mňa, alebo upravené u mňa a zmazané u nich
  }

  const bc = new Set(base.checks), lc = new Set(local.checks);
  const checks = new Set(remote.checks);
  for (const c of lc) if (!bc.has(c)) checks.add(c);
  for (const c of bc) if (!lc.has(c)) checks.delete(c);

  const pick = <K extends 'manual_points' | 'rocnik' | 'bias' | 'bias_comment' | 'pages'>(k: K) => (same(local[k], base[k]) ? remote[k] : local[k]);
  // intervalové body po položkách: moja zmena vyhrá, inak platí cudzia
  const scores: Scores = { ...remote.scores };
  for (const k of new Set([...Object.keys(base.scores), ...Object.keys(local.scores)])) {
    if (same(local.scores[k], base.scores[k])) continue;
    if (local.scores[k] === undefined) delete scores[k]; else scores[k] = local.scores[k];
  }
  return {
    annotations: out, checks: [...checks], manual_points: pick('manual_points'), rocnik: pick('rocnik'),
    bias: pick('bias'), bias_comment: pick('bias_comment'), pages: pick('pages'), scores,
  };
}

/**
 * Počet zmien medzi dvoma stavmi: každý pridaný, zmazaný alebo upravený objekt (napr. oprava
 * textu, posun, farba) je jedna zmena, rovnako zaškrtnutie položky, ručné body, ročník, každé interné číslo a interný komentár.
 */
export function countChanges(a: SolState, b: SolState): number {
  const am = new Map(a.annotations.map(x => [x.id, x]));
  let n = 0;
  for (const x of b.annotations) {
    const o = am.get(x.id);
    if (!o || !same(o, x)) n++;
    am.delete(x.id);
  }
  n += am.size;
  const ac = new Set(a.checks), bc = new Set(b.checks);
  for (const c of ac) if (!bc.has(c)) n++;
  for (const c of bc) if (!ac.has(c)) n++;
  if (!same(a.manual_points ?? null, b.manual_points ?? null)) n++;
  if ((a.rocnik ?? '') !== (b.rocnik ?? '')) n++;
  const ab = normBias(a.bias), bb = normBias(b.bias);
  for (let i = 0; i < ab.length; i++) if (ab[i] !== bb[i]) n++;
  if ((a.bias_comment ?? '') !== (b.bias_comment ?? '')) n++;
  if (!same(a.pages ?? null, b.pages ?? null)) n++;
  const as = a.scores || {}, bs = b.scores || {};
  for (const k of new Set([...Object.keys(as), ...Object.keys(bs)])) if (as[k] !== bs[k]) n++;
  return n;
}

// staršie dáta (verzie, offline fronta, lokálne úlohy) interné body, strany ani intervaly nemajú → predvolené
export const solState = (s: Partial<SolState> & Pick<SolState, 'annotations' | 'checks'>): SolState => ({
  annotations: s.annotations, checks: s.checks, manual_points: s.manual_points ?? null, rocnik: s.rocnik ?? '',
  bias: normBias(s.bias), bias_comment: s.bias_comment ?? '', pages: normPages(s.pages), scores: normScores(s.scores),
});

/* ================= farby rozhrania ================= */

/** pen = farba tlačidiel/názvu, on = text na tlačidle; zvlášť pre tmavú a svetlú tému (kvôli kontrastu). */
export interface Accent { id: string; label: string; dark: { pen: string; on: string }; light: { pen: string; on: string } }
export const ACCENTS: Accent[] = [
  { id: 'ruzova', label: 'Ružová', dark: { pen: '#e0218a', on: '#ffffff' }, light: { pen: '#d61c83', on: '#ffffff' } },
  { id: 'cervena', label: 'Červená', dark: { pen: '#ef4b4f', on: '#ffffff' }, light: { pen: '#c8262c', on: '#ffffff' } },
  { id: 'oranzova', label: 'Oranžová', dark: { pen: '#f59b23', on: '#1c1400' }, light: { pen: '#b85c00', on: '#ffffff' } },
  { id: 'zelena', label: 'Zelená', dark: { pen: '#3cc27a', on: '#06210f' }, light: { pen: '#18804a', on: '#ffffff' } },
  { id: 'tyrkysova', label: 'Tyrkysová', dark: { pen: '#1fc2b0', on: '#03211d' }, light: { pen: '#0b7f74', on: '#ffffff' } },
  { id: 'modra', label: 'Modrá', dark: { pen: '#4c8dff', on: '#ffffff' }, light: { pen: '#1f5fd6', on: '#ffffff' } },
  { id: 'fialova', label: 'Fialová', dark: { pen: '#a274ff', on: '#ffffff' }, light: { pen: '#7240d8', on: '#ffffff' } },
];
export const DEFAULT_ACCENT = 'tyrkysova';
export const accentById = (id: string | null | undefined) =>
  ACCENTS.find(a => a.id === id) || ACCENTS.find(a => a.id === DEFAULT_ACCENT)!;
/** Farba pera podľa témy – svetlý variant, lebo sa píše na biely papier. */
export const themePen = (accent: string | null | undefined) => accentById(accent).light.pen;
export const isHexColor = (v: unknown): v is string => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v);

export * from './zip';
export * from './changelog';
