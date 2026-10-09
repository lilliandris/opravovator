// Rozbor zipu z hromadného opravovania – rovnaký na serveri aj v prehliadači (lokálny režim).

export const POINTS_FILENAME = 'body.txt';
export const COMMENT_FILENAME = 'komentar.txt';
export const COMMENTED_SUFFIX = '.komentar.pdf';
/** interné body (S U P) a interný komentár – neodovzdávajú sa riešiteľom */
export const BIAS_FILENAME = 'bias.txt';
export const BIAS_COMMENT_FILENAME = 'bias_komentar.txt';
export const COMMENT_RE = /^koment[aá]r\.txt$/i;
export const COMMENTED_RE = /\.komentar\.pdf$/i;

export function safeSeg(s: string) {
  const v = String(s).replace(/[\\/\0]/g, '_').trim();
  return !v || v === '.' || v === '..' ? '_' : v;
}

export const commentedName = (pdfName: string) => pdfName.replace(/\.pdf$/i, '') + COMMENTED_SUFFIX;

const sortSk = (a: string, b: string) => a.localeCompare(b, 'sk', { numeric: true });

function titleCase(s: string) {
  return s.split(/[-_\s]+/).filter(Boolean).map(w => w.charAt(0).toLocaleUpperCase('sk') + w.slice(1)).join(' ');
}

// "xxx-meno-priezvisko-ID" → ročník, meno, ID
function parseFolder(folder: string) {
  const parts = folder.split('-');
  if (parts.length >= 3) return { prefix: parts[0], nameParts: parts.slice(1, -1).join('-'), id: parts[parts.length - 1] };
  return { prefix: '', nameParts: folder, id: '' };
}

export interface ZipPlan {
  /** súbory na rozbalenie: index v pôvodnom zozname a cesta bez koreňového priečinka */
  files: { index: number; rel: string[] }[];
  rootFolder: string | null;
  /** priečinky riešení (relatívne), zoradené */
  folders: string[];
}

/**
 * Z ciest v zipe určí riešenia: priečinok riešenia je ten, v ktorom je PDF alebo body.txt.
 * Spoločný koreňový priečinok (napr. „Názov úlohy/“) sa odstráni, zip ho mať nemusí.
 */
export function planZip(paths: string[], pointsFilename = POINTS_FILENAME): ZipPlan {
  const entries = paths.map((p, index) => ({ index, parts: p.replace(/\\/g, '/').split('/').filter(Boolean), dir: /\/$/.test(p) }))
    .filter(x => !x.dir && x.parts.length && !x.parts.includes('__MACOSX') && !x.parts[x.parts.length - 1].startsWith('.'));
  if (!entries.length) throw new Error('Zip je prázdny.');

  const solDirs = new Map<string, string[]>();
  for (const x of entries) {
    const file = x.parts[x.parts.length - 1];
    if (x.parts.length < 2) continue;
    if (/\.pdf$/i.test(file) || file.toLowerCase() === pointsFilename) {
      solDirs.set(x.parts.slice(0, -1).join('/'), x.parts.slice(0, -1));
    }
  }
  if (!solDirs.size) throw new Error('V zipe som nenašiel žiadne riešenia (priečinky s PDF).');

  const dirs = [...solDirs.values()];
  let common = dirs[0].slice(0, -1);
  for (const d of dirs) {
    let i = 0;
    while (i < common.length && i < d.length - 1 && common[i] === d[i]) i++;
    common = common.slice(0, i);
  }
  const files = entries.map(x => ({ index: x.index, rel: x.parts.slice(common.length).map(safeSeg) })).filter(f => f.rel.length);
  const folders = dirs.map(d => d.slice(common.length).join('/')).filter(rel => rel && !rel.includes('/')).sort(sortSk);
  return { files, rootFolder: common.length ? common[common.length - 1] : null, folders };
}

/** Údaje riešenia z názvu priečinka a zoznamu jeho súborov. */
export function solutionMeta(folder: string, fileNames: string[], pointsFilename = POINTS_FILENAME) {
  const files = [...fileNames].sort(sortSk);
  const pdfName = files.find(f => /\.pdf$/i.test(f) && !COMMENTED_RE.test(f) && !f.startsWith('original-')) || null;
  const pf = parseFolder(folder);
  return {
    pdf_name: pdfName,
    display_name: titleCase(pdfName ? pdfName.replace(/\.pdf$/i, '') : pf.nameParts) || folder,
    // „000“, „001“… sú len poradové čísla exportu, nie ročník
    rocnik: pf.prefix && pf.prefix.length <= 4 && !/^0\d{2,}$/.test(pf.prefix) ? pf.prefix : '',
    student_id: pf.id,
    bodyFile: files.find(f => f.toLowerCase() === pointsFilename) || null,
    biasFile: files.find(f => f.toLowerCase() === BIAS_FILENAME) || null,
    biasCommentFile: files.find(f => f.toLowerCase() === BIAS_COMMENT_FILENAME) || null,
  };
}

/** Obsah body.txt → číslo (akceptuje aj desatinnú čiarku), prázdne → null. */
export function parsePointsText(t: string): number | null {
  const v = t.trim().replace(',', '.');
  return v !== '' && !Number.isNaN(Number(v)) ? Number(v) : null;
}

/* ================= dodatočné riešenia a poradie ================= */

const numId = (id: string) => (/^\d+$/.test(id) ? Number(id) : null);

/**
 * Poradie riešení ako v hromadnom opravovaní: podľa ID riešiteľa (číslo na konci priečinka),
 * riešenia bez ID na koniec v doterajšom poradí.
 */
export function orderByStudentId<T extends { student_id: string; idx: number }>(list: T[]): T[] {
  return [...list].sort((a, b) => {
    const x = numId(a.student_id), y = numId(b.student_id);
    if (x !== null && y !== null && x !== y) return x - y;
    if ((x === null) !== (y === null)) return x === null ? 1 : -1;
    return a.idx - b.idx;
  });
}

/**
 * Názvy priečinkov pri exporte. Priečinky sa ukladajú pod názvom, s akým prišli; po pridaní dodatočných
 * riešení ale poradové čísla na začiatku (000, 001, …) nesedia s poradím podľa ID – vtedy sa prečíslujú
 * (od najmenšieho pôvodného čísla), aby export vyzeral ako nové hromadné opravovanie. Inak ostanú bez zmeny.
 */
export function exportFolderNames(list: { folder: string; idx: number; export_folder?: string | null }[]): Map<string, string> {
  // folder = priečinok na disku (nemení sa), export_folder = názov z najnovšieho hromadného opravovania
  const sorted = [...list].sort((a, b) => a.idx - b.idx).map(s => ({ key: s.folder, name: safeSeg(s.export_folder || s.folder) }));
  const out = new Map(sorted.map(s => [s.key, s.name]));
  const numbered = sorted.filter(s => s.name.split('-').length >= 3 && /^\d{3,}$/.test(s.name.split('-')[0]));
  if (!numbered.length) return out;
  const nums = numbered.map(s => Number(s.name.split('-')[0]));
  if (nums.every((n, i) => i === 0 || n > nums[i - 1])) return out; // poradie sedí
  const start = Math.min(...nums);
  const width = Math.max(3, ...numbered.map(s => s.name.split('-')[0].length), String(start + numbered.length - 1).length);
  numbered.forEach((s, i) => {
    const rest = s.name.slice(s.name.indexOf('-'));
    out.set(s.key, String(start + i).padStart(width, '0') + rest);
  });
  return out;
}

/** Výsledok pridania riešení zo zipu do existujúcej úlohy. */
export interface AddSolutionsResult {
  /** nové riešenia (mená) */ added: string[];
  /** riešenia, ktoré už v úlohe sú (podľa ID) – ostali aj s opravami */ kept: number;
  /** z nich v novom zipe iné PDF (ponechané pôvodné, opravy sa naň viažu) */ changedPdf: string[];
}
