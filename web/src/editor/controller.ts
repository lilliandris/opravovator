import { pdfjs } from '../pdf';
import {
  A4, FONTS, HIGHLIGHT_COLOR, HIGHLIGHT_OPACITY, LINE_HEIGHT, MAX_IMAGE_BYTES, MAX_IMAGE_MB, DEFAULT_COLOR, arrowGeometry, computePoints, fold, fontById, fontFamily,
  mergeStates, normBias, normBox, normPages, normScores, pageTransformed, rangeOf, scaleAnn, rectsBox, rotatedPlacement, same, themePen, solState, solutionFlags, stampLayout, textLines, translateAnn,
  type AddSolutionsResult, type PresenceItem, type PresenceResult, type SolState, type Annotation, type AnnType, type SaveResult, type SolutionDetail, type SolutionListItem,
  type SolutionSave, type TaskDetail, type User, type RubricItem, type RubricMode, type BoxAnn, type Bias, type PageSpec, type Rect, type Sig, type Signer, type StampAnn,
} from '@opravovator/shared';
import { api, isNetworkError, uploadWithProgress } from '../api';
import { outbox } from '../offline';
import { getSession, saveMe } from '../local/session';
import { addLocalAsset, addLocalSolutions, deleteLocalAsset, listLocalAssets, localAssetUrl, localPdfBlob } from '../local/ops';
import { cacheServerAsset } from '../local/sync';
import { registerSaver } from '../status';

export type Tool = 'select' | 'text' | 'arrow' | 'line' | 'rect' | 'ellipse' | 'highlight' | 'underline' | 'image' | 'stamp';
// color '' = farba témy (mení sa spolu s farbou zvýraznenia); fill '' = bez výplne; hlColor = farba zvýrazňovača
export interface Style {
  font: string; size: number; color: string; width: number; stampSize: number;
  fill: string; fillOpacity: number; underline: boolean; hlColor: string;
}
export type StyleKey = 'font' | 'size' | 'color' | 'width' | 'fill' | 'fillOpacity' | 'underline';
export interface Asset { id: number; name: string }
type SaveState = { cls: '' | 'saving' | 'saved' | 'err' | 'offline'; text: string };

// page = pôvodná strana PDF (null = pridaná prázdna), spec = ako sa ukazuje (otočenie, výrez)
interface PageView {
  index: number; page: pdfjs.PDFPageProxy | null; spec: PageSpec; doc: pdfjs.PDFDocumentProxy; w: number; h: number;
  el: HTMLDivElement; canvas: HTMLCanvasElement; svg: SVGSVGElement;
  renderedZoom: number; task: pdfjs.RenderTask | null; visible: boolean;
  /** vrstva textu PDF (označovanie, kopírovanie) a odkazov – len pri neotočených stranách */ textDone: boolean;
}
/** Označený text v PDF, ku ktorému sa ukazuje ponuka (zvýrazniť / podčiarknuť). */
export interface TextSel { x: number; y: number; parts: { page: number; rects: Rect[] }[] }
type BBox = { x: number; y: number; w: number; h: number };
interface Drag {
  mode: 'move' | 'resize' | 'create'; handle?: string; id: string; page: number;
  start: { x: number; y: number }; orig?: Annotation; snap: string; box?: BBox; moved?: boolean;
}
interface Editing { a: Extract<Annotation, { type: 'text' }>; isNew: boolean; snap: string; ta: HTMLTextAreaElement; place: () => void }

const SVGNS = 'http://www.w3.org/2000/svg';
const STYLE_KEY = 'opravovator-style';
const MAX_CANVAS_PIXELS = 10e6;
export const SWATCHES = ['#e0218a', '#e5231b', '#1f6feb', '#138a36', '#f08c00', '#000000'];
export const HL_SWATCHES = [HIGHLIGHT_COLOR, '#7ee36b', '#6cd1ff', '#ff8ad8', '#ffa94d'];
/** nástroje, pri ktorých sa dá v PDF označovať text (a klikať na odkazy) */
const TEXT_TOOLS: Tool[] = ['select', 'highlight', 'underline'];

const URL_IN_TEXT = /\b(?:https?:\/\/|www\.)[^\s<>"]+[^\s<>".,;:!?)\]]/i;
const uid = () => 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const clone = <T,>(o: T): T => JSON.parse(JSON.stringify(o));
const hasPoints = (p: number | null | undefined): p is number => p !== null && p !== undefined;

function svgEl(tag: string, attrs: Record<string, string | number | undefined>) {
  const el = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined) el.setAttribute(k, String(v));
  return el;
}

function loadStyle(): Style {
  const def: Style = { font: 'bebas', size: 20, color: '', width: 2, stampSize: 40, fill: '', fillOpacity: 0.3, underline: false, hlColor: HIGHLIGHT_COLOR };
  try {
    const s: Style = { ...def, ...JSON.parse(localStorage.getItem(STYLE_KEY) || '{}') };
    // pôvodná predvolená ružová sa ukladala aj bez výberu → teraz predvolená = farba témy
    if (s.color.toLowerCase() === DEFAULT_COLOR) s.color = '';
    return s;
  } catch { return def; }
}

/**
 * Stav a logika editora. Strany PDF a vrstvu anotácií spravuje priamo v DOM (kvôli
 * výkonu pri veľkých skenoch), React komponenty čítajú stav cez subscribe/getVersion.
 */
export class EditorController {
  me!: User;
  task!: TaskDetail;
  sols: SolutionListItem[] = [];
  assets: Asset[] = [];
  cur: SolutionDetail | null = null;
  tool: Tool = 'select';
  selected: string | null = null;
  style: Style = loadStyle();
  zoom = 1;
  fit = true;
  filter = { q: '', rocnik: null as string | null };
  saveState: SaveState = { cls: '', text: '' };
  notice: string | null = null;
  message: string | null = 'Načítavam…';
  imageMenu = false;
  imageAsset: { id: number; ratio: number } | null = null;
  canUndo = false;
  canRedo = false;

  private pdf: pdfjs.PDFDocumentProxy | null = null;
  private loading: pdfjs.PDFDocumentLoadingTask | null = null;
  private pages: PageView[] = [];
  private drag: Drag | null = null;
  private editing: Editing | null = null;
  /**
   * Dotyk/pero: textové pole sa otvára až v `click` (nie v pointerdown) – inak ho prehliadač
   * hneď po ťuknutí odfokusuje (klávesnica preblikne a prázdne pole zmizne) a iOS klávesnicu
   * vôbec neukáže, lebo fokus nie je z „používateľského gesta“.
   */
  private tap: { pi: number; pt: { x: number; y: number }; snap: string; edit?: Editing['a'] } | null = null;
  private undoStack: string[] = [];
  private redoStack: string[] = [];
  private clipboard: { ann: Annotation; solId: number } | null = null;
  private loadToken = 0;
  private viewer: HTMLElement | null = null;
  private pagesEl: HTMLElement | null = null;
  private observer: IntersectionObserver | null = null;
  private renderQueue: PageView[] = [];
  private renderBusy = false;
  private bboxes = new Map<string, BBox>();
  private saveTimer: ReturnType<typeof setTimeout> | undefined;
  private pendingId: number | null = null;
  /** posledný stav otvoreného riešenia, ktorý pozná server (základ na zlúčenie pri súbehu) */
  private base: { rev: number; state: SolState } | null = null;
  private saving = false;
  /** kto iný má otvorenú túto úlohu (a ktoré riešenie) */
  others: PresenceItem[] = [];
  /** podpisy ľudí v zdieľanej úlohe (podľa ich nastavení) */
  signers: Signer[] = [];
  /** označený text v PDF s ponukou zvýrazniť / podčiarknuť */
  textSel: TextSel | null = null;
  private buildToken = 0;
  private scrollToPage: number | null = null;
  private inflight: Promise<unknown> = Promise.resolve();
  private measureCtx = document.createElement('canvas').getContext('2d')!;
  private listeners = new Set<() => void>();
  private version = 0;
  private disposers: (() => void)[] = [];

  constructor(public taskId: number) {}

  /** lokálna úloha (v zariadení, záporné id) – všetko beží v prehliadači, bez servera */
  get local() { return this.taskId < 0; }

  /* ================= React prepojenie ================= */

  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  getVersion = () => this.version;
  private emit() { this.version++; this.listeners.forEach(l => l()); }

  /* ================= načítanie ================= */

  async init(viewer: HTMLElement, pagesEl: HTMLElement, initialSol: number | null) {
    this.viewer = viewer;
    this.pagesEl = pagesEl;
    this.observer = new IntersectionObserver(entries => {
      for (const en of entries) {
        const p = this.pages.find(x => x.el === en.target);
        if (!p) continue;
        p.visible = en.isIntersecting;
        if (p.visible) this.queueRender(p); else this.releasePage(p);
      }
    }, { root: viewer, rootMargin: '400px 0px' });

    const [session, task, assets] = await Promise.all([
      getSession(), api<TaskDetail>(`/api/tasks/${this.taskId}`),
      this.local ? listLocalAssets() : api<Asset[]>('/api/assets'),
    ]);
    this.me = session.me; this.task = task; this.sols = task.solutions; this.assets = assets;
    await Promise.all([this.loadSignature(), this.loadSigners()]);
    await Promise.all(FONTS.map(f => document.fonts.load(`20px "${fontFamily(f.id)}"`).catch(() => {})));
    this.bindGlobal();
    this.startPresence();
    const first = this.sols.find(s => s.id === initialSol) || this.sols[0];
    if (first) await this.openSolution(first.id);
    else { this.message = 'Táto úloha neobsahuje žiadne riešenia.'; this.emit(); }
  }

  dispose() {
    this.flushSave();
    this.disposers.forEach(d => d());
    this.releaseAllPages();
    this.loading?.destroy();
    this.observer?.disconnect();
  }

  async reloadTask() {
    const t = await api<TaskDetail>(`/api/tasks/${this.taskId}`);
    const old = new Map(this.sols.map(s => [s.id, s]));
    // zachovaj lokálne (ešte neuložené) body a stav; nové (dodatočné) riešenia pribudnú, poradie podľa servera
    this.sols = t.solutions.map(n => {
      const s = old.get(n.id);
      if (!s) return n;
      if (s.id !== this.pendingId) Object.assign(s, n); else s.idx = n.idx;
      return s;
    });
    Object.assign(this.task, { ...t, solutions: this.sols });
    this.recompute();
    this.drawAll();
    this.emit();
  }

  /* ================= zoznam riešení ================= */

  visibleSols() {
    const q = fold(this.filter.q.trim());
    return this.sols.filter(s => {
      if (this.filter.rocnik !== null && s.rocnik !== this.filter.rocnik) return false;
      return !q || fold(`${s.display_name} ${s.folder} ${s.rocnik}`).includes(q);
    });
  }

  setMe(u: User) { this.me = u; this.emit(); void this.loadSignature(); void this.loadSigners(); }

  /** Farba témy pre pero (podľa zvolenej farby zvýraznenia). */
  themeColor() { return themePen(this.me?.accent); }

  private penSaveTimer = 0;
  /** Vlastná farba: hneď sa použije a (s oneskorením, kým sa ťahá vo výbere farby) uloží do profilu. */
  setPenColor(c: string) {
    this.me = { ...this.me, pen_color: c };
    this.applyStyle('color', c);
    clearTimeout(this.penSaveTimer);
    this.penSaveTimer = window.setTimeout(() => {
      saveMe({ pen_color: c }).then(u => { if (this.me.pen_color === u.pen_color) this.setMe(u); }).catch(() => {});
    }, 600);
  }

  dismissNotice() { this.notice = null; this.emit(); }

  setFilter(f: Partial<EditorController['filter']>) { Object.assign(this.filter, f); this.emit(); }

  stepSolution(dir: number) {
    const list = this.visibleSols();
    if (!list.length) return;
    const i = this.cur ? list.findIndex(s => s.id === this.cur!.id) : -1;
    const next = list[Math.min(list.length - 1, Math.max(0, i + dir))];
    if (next && (!this.cur || next.id !== this.cur.id)) this.openSolution(next.id);
  }

  async editRocnik(s: SolutionListItem, value: string) {
    if (this.cur && this.cur.id === s.id) {
      this.cur.rocnik = value;
      this.scheduleSave();
      await this.flushSave();
    } else {
      await this.saveRemote(s.id, { rocnik: value, baseRev: s.rev });
    }
    s.rocnik = value.trim();
    this.emit();
  }

  /** lokálna úloha prepojená so serverom – riešenia sa pridávajú na serveri */
  get linkedLocal() { return this.local && !!(this.task as TaskDetail & { remote?: unknown })?.remote; }

  /** Dodatočné riešenia zo zipu (páruje sa podľa ID riešiteľa, existujúce ostanú aj s opravami). */
  async addSolutions(zip: File, progress: (text: string) => void): Promise<AddSolutionsResult> {
    await this.flushSave();
    let r: AddSolutionsResult;
    if (this.local) r = await addLocalSolutions(this.taskId, zip);
    else {
      const fd = new FormData();
      fd.append('zip', zip, zip.name);
      r = await uploadWithProgress<AddSolutionsResult>(`/api/tasks/${this.taskId}/solutions`, fd,
        (l, n) => progress(l < n ? `Nahrávam ${Math.round(l / n * 100)} %` : 'Server porovnáva riešenia…'));
    }
    await this.reloadTask();
    return r;
  }

  /* ================= otvorenie riešenia ================= */

  async openSolution(id: number) {
    this.commitTextEdit();
    this.flushSave();
    const token = ++this.loadToken;
    this.selected = null; this.undoStack = []; this.redoStack = []; this.drag = null; this.notice = null;
    history.replaceState(null, '', `#sol=${id}`);
    this.cur = null;
    this.releaseAllPages();
    this.loading?.destroy(); this.loading = null; this.pdf = null;
    this.pages = [];
    this.pagesEl!.innerHTML = '';
    this.message = 'Načítavam PDF…';
    this.emit();

    let sol: SolutionDetail;
    try {
      sol = await api<SolutionDetail>(`/api/solutions/${id}`);
    } catch (e) {
      if (token === this.loadToken) { this.message = isNetworkError(e) ? 'Offline – toto riešenie nie je stiahnuté v zariadení.' : String((e as Error).message); this.emit(); }
      return;
    }
    const serverRev = sol.rev, serverState = clone(solState(sol));
    // neodoslané offline zmeny majú prednosť
    const pending = await outbox.get(id);
    if (pending) Object.assign(sol, pending.body);
    sol.bias = normBias(sol.bias); sol.bias_comment ??= '';
    sol.pages = normPages(sol.pages); sol.scores = normScores(sol.scores);
    if (token !== this.loadToken) return;
    this.cur = sol;
    const item = this.sols.find(s => s.id === id);
    if (item && !pending) item.rev = sol.rev;
    if (item) Object.assign(item, solutionFlags(sol.annotations, sol.pages));
    this.base = pending?.body.base && typeof pending.body.baseRev === 'number'
      ? { rev: pending.body.baseRev, state: solState(pending.body.base) }
      : { rev: serverRev, state: serverState };
    this.recompute();
    this.syncUndo();
    this.pingPresence();
    this.emit();

    if (!sol.pdf_name) { this.message = 'V priečinku tohto riešenia nie je PDF.'; this.emit(); return; }
    let pdf: pdfjs.PDFDocumentProxy;
    let task: pdfjs.PDFDocumentLoadingTask | null = null;
    try {
      let data: ArrayBuffer;
      if (this.local) {
        const blob = await localPdfBlob(id);
        if (!blob) throw new Error();
        data = await blob.arrayBuffer();
      } else {
        const res = await fetch(`/api/solutions/${id}/pdf`, { credentials: 'same-origin' });
        if (!res.ok) throw new Error();
        data = await res.arrayBuffer();
      }
      if (token !== this.loadToken) return;
      task = pdfjs.getDocument({ data, maxImageSize: -1 });
      pdf = await task.promise;
    } catch {
      task?.destroy();
      if (token === this.loadToken) { this.message = navigator.onLine ? 'PDF sa nepodarilo otvoriť.' : 'Offline – PDF tohto riešenia nie je stiahnuté.'; this.emit(); }
      return;
    }
    if (token !== this.loadToken) { task.destroy(); return; }
    this.loading = task;
    this.pdf = pdf;
    this.message = null;
    await this.buildPages(token);
    this.emit();
  }

  /** Strany riešenia: podľa nastavení strán (pridané prázdne, otočené), inak ako v PDF. */
  layout(): PageSpec[] {
    if (this.cur?.pages) return this.cur.pages;
    return Array.from({ length: this.pdf?.numPages || 0 }, (_, i) => ({ src: i }));
  }

  /** Vytvorí strany v editore podľa layout() (pri otvorení riešenia aj po zmene strán). */
  private async buildPages(token = this.loadToken) {
    const pdf = this.pdf;
    if (!pdf || !this.pagesEl) return;
    const bt = ++this.buildToken;
    const scrollTop = this.viewer?.scrollTop ?? 0;
    this.releaseAllPages();
    this.pages = [];
    const specs = this.layout();
    const views: PageView[] = [];
    for (const [i, spec] of specs.entries()) {
      const page = spec.src === null ? null : await pdf.getPage(spec.src + 1).catch(() => null);
      if (token !== this.loadToken || bt !== this.buildToken || pdf !== this.pdf) return;
      let w = spec.w || A4.w, h = spec.h || A4.h;
      if (page) { const vp = page.getViewport({ scale: 1 }); w = vp.width; h = vp.height; }
      const canvas = document.createElement('canvas');
      const svg = svgEl('svg', { class: 'ov', viewBox: `0 0 ${w} ${h}` }) as SVGSVGElement;
      const el = document.createElement('div');
      el.className = 'page';
      el.dataset.page = String(i);
      const pno = document.createElement('span');
      pno.className = 'pno';
      pno.textContent = String(i + 1);
      if (!page) pno.title = 'Pridaná prázdna strana';
      else if (pageTransformed(spec)) pno.title = [spec.rot ? `otočená o ${spec.rot}°` : '', spec.scale ? `obsah ${Math.round(spec.scale * 100)} %` : ''].filter(Boolean).join(', ');
      if (!page || pageTransformed(spec)) pno.classList.add('mod');
      el.append(canvas, pno, svg);
      const p: PageView = { index: i, page, spec: page ? spec : { src: null, w, h }, doc: pdf, w, h, el, canvas, svg, renderedZoom: 0, task: null, visible: false, textDone: false };
      views.push(p);
      svg.addEventListener('pointerdown', e => this.onDown(e, p.index));
      svg.addEventListener('pointermove', e => this.onMove(e));
      svg.addEventListener('pointerup', () => this.onUp());
      svg.addEventListener('pointercancel', () => { this.tap = null; this.onUp(); });
      svg.addEventListener('click', () => this.onTap());
      svg.addEventListener('dblclick', e => this.onDblClick(e));
      // mimo objektov pri výbere / zvýrazňovači: označovanie textu PDF a odkazy (SVG vtedy udalosti púšťa ďalej)
      // composedPath: kliknutý objekt sa pri označení prekreslí (vypadne z DOM), cesta udalosti ostane
      const fromSvg = (e: Event) => e.composedPath().includes(svg);
      el.addEventListener('pointerdown', e => { if (!fromSvg(e)) this.onPageDown(e, p.index); });
      el.addEventListener('pointermove', e => { if (!fromSvg(e)) this.onMove(e); });
      el.addEventListener('pointerup', e => { if (!fromSvg(e)) this.onUp(); });
    }
    this.pagesEl.replaceChildren(...views.map(v => v.el));
    this.pages = views;
    for (const v of views) this.observer!.observe(v.el);
    this.applyZoom();
    if (this.viewer) this.viewer.scrollTop = scrollTop;
    if (this.scrollToPage !== null) {
      this.pages[this.scrollToPage]?.el.scrollIntoView({ block: 'center' });
      this.scrollToPage = null;
    }
  }

  /* ================= vykresľovanie strán ================= */

  // Vykresľujú sa len strany pri viditeľnej časti, po jednej. Strany mimo obrazovky
  // sa uvoľnia (canvas aj dekódované obrázky skenov), inak prehliadač pri veľkých
  // skenoch zaberie gigabajty pamäte.
  private queueRender(p: PageView) {
    if (p.renderedZoom === this.zoom || this.renderQueue.includes(p)) return;
    this.renderQueue.push(p);
    this.pumpRender();
  }

  private async pumpRender() {
    if (this.renderBusy) return;
    this.renderBusy = true;
    try {
      while (this.renderQueue.length) {
        const p = this.renderQueue.shift()!;
        if (p.doc !== this.pdf || !p.visible || p.renderedZoom === this.zoom || !this.pages.includes(p)) continue;
        await this.renderPage(p);
      }
    } finally {
      this.renderBusy = false;
    }
  }

  private releasePage(p: PageView) {
    if (p.task) { try { p.task.cancel(); } catch { /* */ } p.task = null; }
    if (p.renderedZoom) { p.canvas.width = 0; p.canvas.height = 0; p.renderedZoom = 0; }
    try { p.page?.cleanup(); } catch { /* */ }
  }

  private releaseAllPages() {
    this.renderQueue.length = 0;
    for (const p of this.pages) { this.observer?.unobserve(p.el); this.releasePage(p); }
  }

  private computeFit() {
    if (!this.pages.length || !this.viewer) return 1;
    const maxW = Math.max(...this.pages.map(p => p.w));
    const avail = this.viewer.clientWidth - 48 - 40;
    return Math.max(0.3, Math.min(2.5, avail / maxW));
  }

  applyZoom() {
    // rozpísaný text sa neukončí, len sa presunie – na mobile otvorenie klávesnice zmení veľkosť
    // okna (resize), čo predtým textové pole hneď zavrelo a prázdne zmazalo
    if (this.fit) this.zoom = this.computeFit();
    for (const p of this.pages) {
      p.el.style.width = p.w * this.zoom + 'px';
      p.el.style.height = p.h * this.zoom + 'px';
      p.el.style.setProperty('--total-scale-factor', String(this.zoom));
      const tl = p.el.querySelector<HTMLElement>('.textLayer[data-k]');
      if (tl) tl.style.setProperty('--total-scale-factor', String(this.zoom * Number(tl.dataset.k)));
      if (p.visible) this.queueRender(p);
    }
    this.drawAll();
    this.editing?.place();
    this.emit();
  }

  zoomBy(k: number) { this.fit = false; this.zoom = Math.max(0.25, Math.min(4, this.zoom * k)); this.applyZoom(); }
  zoomFit() { this.fit = true; this.applyZoom(); }

  private async renderPage(p: PageView) {
    const zoom = this.zoom;
    let scale = zoom * Math.min(window.devicePixelRatio || 1, 2);
    if (p.w * p.h * scale * scale > MAX_CANVAS_PIXELS) scale = Math.sqrt(MAX_CANVAS_PIXELS / (p.w * p.h));
    const c = document.createElement('canvas');
    c.width = Math.floor(p.w * scale); c.height = Math.floor(p.h * scale);
    const ctx = c.getContext('2d', { alpha: false })!;
    let tmp: HTMLCanvasElement | null = null;
    try {
      if (!p.page) {
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, c.width, c.height);
      } else if (!pageTransformed(p.spec)) {
        p.task = p.page.render({ canvas: c, canvasContext: ctx, viewport: p.page.getViewport({ scale }) });
        await p.task.promise;
      } else {
        // otočená / zmenšená strana: výrez so skenom sa vykreslí zvlášť a (otočený) sa vloží na stred strany
        const pl = rotatedPlacement(p.spec, p.w, p.h);
        const ss = scale * pl.k;
        tmp = document.createElement('canvas');
        tmp.width = Math.max(1, Math.floor(pl.crop.w * ss)); tmp.height = Math.max(1, Math.floor(pl.crop.h * ss));
        p.task = p.page.render({
          canvas: tmp, canvasContext: tmp.getContext('2d', { alpha: false })!, viewport: p.page.getViewport({ scale: ss }),
          transform: [1, 0, 0, 1, -pl.crop.x * ss, -pl.crop.y * ss],
        });
        await p.task.promise;
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, c.width, c.height);
        ctx.save();
        ctx.translate((pl.ox + pl.rw / 2) * scale, (pl.oy + pl.rh / 2) * scale);
        ctx.rotate(pl.rot * Math.PI / 180);
        ctx.drawImage(tmp, -pl.crop.w * ss / 2, -pl.crop.h * ss / 2, pl.crop.w * ss, pl.crop.h * ss);
        ctx.restore();
      }
      if (p.doc !== this.pdf || !p.visible || !this.pages.includes(p)) { c.width = 0; c.height = 0; return; }
      const old = p.canvas;
      p.el.replaceChild(c, old);
      old.width = 0; old.height = 0;
      p.canvas = c;
      p.renderedZoom = zoom;
      if (zoom !== this.zoom) this.queueRender(p);
      if (!p.textDone && p.page && !p.spec.rot) void this.buildTextLayer(p);
    } catch {
      c.width = 0; c.height = 0;
    } finally {
      if (tmp) { tmp.width = 0; tmp.height = 0; }
      p.task = null;
      try { p.page?.cleanup(); } catch { /* */ } // zahodí dekódované obrázky skenu
    }
  }

  /** Vrstva textu PDF (dá sa označiť, kopírovať, zvýrazniť) a klikateľné odkazy. */
  private async buildTextLayer(p: PageView) {
    p.textDone = true;
    const page = p.page!;
    const tl = document.createElement('div');
    tl.className = 'textLayer';
    const links = document.createElement('div');
    links.className = 'linkLayer';
    p.el.insertBefore(tl, p.svg);
    p.el.insertBefore(links, p.svg);
    // zmenšená strana: text a odkazy sú na zmenšenom obsahu v strede
    if (p.spec.scale) {
      const pl = rotatedPlacement(p.spec, p.w, p.h);
      for (const el of [tl, links]) Object.assign(el.style, {
        inset: 'auto', left: pl.ox / p.w * 100 + '%', top: pl.oy / p.h * 100 + '%', width: pl.rw / p.w * 100 + '%', height: pl.rh / p.h * 100 + '%',
      });
      tl.dataset.k = String(pl.k);
      tl.style.setProperty('--total-scale-factor', String(this.zoom * pl.k));
    }
    const vp = page.getViewport({ scale: 1 });
    try {
      await new pdfjs.TextLayer({ textContentSource: page.streamTextContent(), container: tl, viewport: vp }).render();
      // adresy napísané v texte (bez odkazu v PDF) sa dajú otvoriť kliknutím
      for (const span of tl.querySelectorAll('span')) {
        const m = (span.textContent || '').match(URL_IN_TEXT);
        if (m) { span.classList.add('url'); span.dataset.href = /^www\./i.test(m[0]) ? 'https://' + m[0] : m[0]; span.title = 'Otvoriť ' + m[0]; }
      }
      tl.addEventListener('click', e => {
        const span = (e.target as Element).closest?.('span.url') as HTMLElement | null;
        if (!span?.dataset.href || !document.getSelection()?.isCollapsed) return;
        window.open(span.dataset.href, '_blank', 'noopener');
      });
    } catch { /* PDF bez textu (sken) */ }
    try {
      for (const an of await page.getAnnotations()) {
        const url = an.subtype === 'Link' ? (an.url || an.unsafeUrl) : null;
        if (!url || !/^(https?:|mailto:)/i.test(url)) continue;
        const [x1, y1] = vp.convertToViewportPoint(an.rect[0], an.rect[1]);
        const [x2, y2] = vp.convertToViewportPoint(an.rect[2], an.rect[3]);
        const a = document.createElement('a');
        a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.title = url;
        Object.assign(a.style, {
          left: Math.min(x1, x2) / p.w * 100 + '%', top: Math.min(y1, y2) / p.h * 100 + '%',
          width: Math.abs(x2 - x1) / p.w * 100 + '%', height: Math.abs(y2 - y1) / p.h * 100 + '%',
        });
        links.append(a);
      }
    } catch { /* */ }
  }

  /* ================= anotácie v SVG ================= */

  private anns(): Annotation[] { return this.cur ? this.cur.annotations : []; }
  private findAnn(id: string | null) { return id ? this.anns().find(a => a.id === id) : undefined; }
  /** stav na krok späť: objekty aj strany */
  private snapshot() { return JSON.stringify({ a: this.anns(), p: this.cur?.pages ?? null }); }
  private restoreSnapshot(snap: string) {
    const c = this.cur!, o = JSON.parse(snap) as { a: Annotation[]; p: PageSpec[] | null };
    const pagesChanged = !same(c.pages, o.p);
    c.annotations = o.a; c.pages = o.p;
    if (this.selected && !this.findAnn(this.selected)) this.selected = null;
    if (pagesChanged) void this.buildPages();
  }

  /** Šírka textu v bodoch strany (rovnaké písma ako v PDF). */
  private measure = (text: string, size: number, font: string) => {
    this.measureCtx.font = `100px "${fontFamily(fontById(font).id)}"`;
    return this.measureCtx.measureText(text).width * size / 100;
  };

  private drawAll() { this.pages.forEach(p => this.drawPage(p.index)); }

  private drawPage(i: number) {
    const p = this.pages[i];
    if (!p) return;
    p.svg.innerHTML = '';
    for (const a of this.anns()) {
      if (a.page !== i || (this.editing && this.editing.a === a)) continue;
      p.svg.append(this.renderAnn(a, p));
    }
    const sel = this.findAnn(this.selected);
    if (sel && sel.page === i && !(this.editing && this.editing.a === sel)) this.drawSelection(sel, p);
  }

  private renderAnn(a: Annotation, p: PageView) {
    const g = svgEl('g', { 'data-id': a.id });
    const color = a.color || DEFAULT_COLOR;
    const hitW = (('width' in a && Number(a.width)) || 2) + 10 / this.zoom;
    if (a.type === 'text') {
      const f = fontById(a.font), size = Number(a.size);
      textLines(a, this.measure).forEach((line, i) => {
        if (!line) return;
        const base = a.y + f.ascent * size + i * size * LINE_HEIGHT;
        const t = svgEl('text', { x: a.x, y: base, 'font-family': fontFamily(f.id), 'font-size': size, fill: color });
        t.setAttribute('xml:space', 'preserve');
        t.textContent = line;
        g.append(t);
        if (a.underline) {
          const uy = base + size * 0.12;
          g.append(svgEl('line', { x1: a.x, y1: uy, x2: a.x + this.measure(line, size, a.font), y2: uy, stroke: color, 'stroke-width': Math.max(0.5, size * 0.06), 'stroke-linecap': 'round' }));
        }
      });
    } else if (a.type === 'stamp') {
      const pts = this.cur ? this.cur.points : null;
      for (const part of stampLayout(a, pts, '', this.measure)) {
        let el: SVGElement;
        if (part.kind === 'text') {
          const f = fontById(part.font);
          el = svgEl('text', { x: part.cx, y: part.top + f.ascent * part.size, 'font-family': fontFamily(f.id), 'font-size': part.size, fill: part.color, 'text-anchor': 'middle' });
          el.textContent = part.text;
        } else {
          el = svgEl('image', { href: this.assetHref(part.assetId), x: part.x, y: part.y, width: part.w, height: part.h, preserveAspectRatio: 'none' });
        }
        if (!hasPoints(pts)) el.setAttribute('opacity', '0.45');
        g.append(el);
      }
    } else if (a.type === 'line' || a.type === 'arrow') {
      const w = Number(a.width) || 2;
      const common = { stroke: color, 'stroke-width': w, 'stroke-linecap': 'round', fill: 'none' };
      if (a.type === 'line') {
        g.append(svgEl('line', { x1: a.x1, y1: a.y1, x2: a.x2, y2: a.y2, ...common }));
      } else {
        const geo = arrowGeometry(a.x1, a.y1, a.x2, a.y2, w);
        g.append(svgEl('line', { x1: geo.shaft[0], y1: geo.shaft[1], x2: geo.shaft[2], y2: geo.shaft[3], ...common }));
        g.append(svgEl('polygon', { points: geo.head.map(q => q.join(',')).join(' '), fill: color }));
      }
      g.append(svgEl('line', { x1: a.x1, y1: a.y1, x2: a.x2, y2: a.y2, class: 'hit', 'stroke-width': hitW }));
    } else if (a.type === 'rect' || a.type === 'ellipse') {
      const b = normBox(a);
      const mk = (extra: Record<string, string | number | undefined>) => a.type === 'rect'
        ? svgEl('rect', { x: b.x, y: b.y, width: b.w, height: b.h, ...extra })
        : svgEl('ellipse', { cx: b.x + b.w / 2, cy: b.y + b.h / 2, rx: b.w / 2, ry: b.h / 2, ...extra });
      g.append(mk({
        stroke: color, 'stroke-width': Number(a.width) || 2, 'stroke-linejoin': 'round',
        fill: a.fill || 'none', 'fill-opacity': a.fill ? a.fillOpacity ?? 1 : undefined,
      }));
      // vyplnený tvar sa dá chytiť aj vnútri
      g.append(mk({ class: a.fill ? 'hitfill' : 'hit', 'stroke-width': hitW }));
    } else if (a.type === 'image') {
      const b = normBox(a);
      g.append(svgEl('image', { href: this.assetHref(a.assetId), x: b.x, y: b.y, width: b.w, height: b.h, preserveAspectRatio: 'none' }));
      g.append(svgEl('rect', { x: b.x, y: b.y, width: b.w, height: b.h, class: 'hitfill' }));
    } else if (a.type === 'highlight') {
      for (const q of a.rects) {
        g.append(svgEl('rect', { x: q.x, y: q.y, width: q.w, height: q.h, fill: color, 'fill-opacity': a.opacity ?? HIGHLIGHT_OPACITY, class: 'mark' }));
        g.append(svgEl('rect', { x: q.x, y: q.y, width: q.w, height: q.h, class: 'hitfill' }));
      }
    } else if (a.type === 'underline') {
      const w = Number(a.width) || 1.5;
      for (const q of a.rects) {
        g.append(svgEl('line', { x1: q.x, y1: q.y + q.h, x2: q.x + q.w, y2: q.y + q.h, stroke: color, 'stroke-width': w, 'stroke-linecap': 'round' }));
        g.append(svgEl('line', { x1: q.x, y1: q.y + q.h, x2: q.x + q.w, y2: q.y + q.h, class: 'hit', 'stroke-width': hitW }));
      }
    }
    if (a.type === 'text' || a.type === 'stamp') {
      // priehľadná plocha na chytenie textu
      p.svg.append(g);
      let bb: { x: number; y: number; width: number; height: number };
      try { bb = (g as SVGGraphicsElement).getBBox(); } catch { bb = { x: a.x, y: a.y, width: 20, height: 20 }; }
      g.remove();
      const box = { x: bb.x, y: bb.y, w: Math.max(bb.width, 8), h: Math.max(bb.height, 8) };
      // text so šírkou: plocha je celá šírka poľa
      if (a.type === 'text' && a.w) { box.x = a.x; box.w = Math.max(a.w, bb.x + bb.width - a.x); }
      g.insertBefore(svgEl('rect', { x: box.x, y: box.y, width: box.w, height: box.h, class: 'hitfill' }), g.firstChild);
      this.bboxes.set(a.id, box);
    }
    return g;
  }

  private annBox(a: Annotation): BBox {
    if (a.type === 'line' || a.type === 'arrow') return { x: Math.min(a.x1, a.x2), y: Math.min(a.y1, a.y2), w: Math.abs(a.x2 - a.x1), h: Math.abs(a.y2 - a.y1) };
    if (a.type === 'text' || a.type === 'stamp') return this.bboxes.get(a.id) || { x: a.x, y: a.y, w: 20, h: 20 };
    if (a.type === 'highlight' || a.type === 'underline') return rectsBox(a.rects);
    return normBox(a as BoxAnn);
  }

  private drawSelection(a: Annotation, p: PageView) {
    const z = this.zoom, pad = 3 / z, r = 5 / z;
    // úchyty ostanú na strane, aj keď objekt (napr. dlhý text) presahuje cez okraj
    const handle = (x: number, y: number, name: string) => p.svg.append(svgEl('circle', {
      cx: Math.min(p.w - r, Math.max(r, x)), cy: Math.min(p.h - r, Math.max(r, y)), r, class: 'handle', 'data-handle': name, 'data-for': a.id, 'stroke-width': 1.5 / z,
    }));
    if (a.type === 'line' || a.type === 'arrow') { handle(a.x1, a.y1, 'p1'); handle(a.x2, a.y2, 'p2'); return; }
    const b = this.annBox(a);
    p.svg.append(svgEl('rect', { x: b.x - pad, y: b.y - pad, width: b.w + 2 * pad, height: b.h + 2 * pad, class: 'selbox', 'data-sel': a.id, 'stroke-width': 1 / z }));
    if (a.type === 'text' || a.type === 'stamp') {
      handle(b.x + b.w + pad, b.y + b.h + pad, 'scale');
      // šírka textového poľa (dvojklik = bez zalamovania)
      if (a.type === 'text') handle(b.x + b.w + pad, b.y + b.h / 2, 'w');
    } else if (a.type === 'highlight' || a.type === 'underline') {
      // len posun
    } else {
      handle(b.x - pad, b.y - pad, 'nw'); handle(b.x + b.w + pad, b.y - pad, 'ne');
      handle(b.x - pad, b.y + b.h + pad, 'sw'); handle(b.x + b.w + pad, b.y + b.h + pad, 'se');
    }
  }

  /* ================= interakcia ================= */

  private toPage(e: PointerEvent, i: number) {
    const p = this.pages[i];
    const r = p.svg.getBoundingClientRect();
    return { x: (e.clientX - r.left) * p.w / r.width, y: (e.clientY - r.top) * p.h / r.height };
  }

  select(id: string | null) {
    this.selected = id;
    this.drawAll();
    this.emit();
  }

  private onDown(e: PointerEvent, pi: number) {
    if (e.button !== 0 || !this.cur) return;
    this.tap = null;
    if (this.editing) { this.commitTextEdit(); return; }
    const touch = e.pointerType !== 'mouse';
    this.setImageMenu(false);
    const pt = this.toPage(e, pi);
    const t = e.target as Element;
    const handleName = t.getAttribute?.('data-handle');
    const idEl = t.closest?.('[data-id]');
    const id = handleName ? t.getAttribute('data-for') : (idEl ? idEl.getAttribute('data-id') : t.getAttribute?.('data-sel'));
    const snap = this.snapshot();

    if (id) {
      const a = this.findAnn(id);
      if (!a) return;
      // dotyk: ťuknutie na už vybraný text ho otvorí na úpravu (dvojklik na dotyku nefunguje)
      if (touch && !handleName && a.type === 'text' && this.selected === id) this.tap = { pi, pt, snap, edit: a };
      if (this.selected !== id) this.select(id);
      if (!handleName && e.detail >= 2 && a.type === 'text') { e.preventDefault(); this.startTextEdit(a, false); return; }
      this.drag = { mode: handleName ? 'resize' : 'move', handle: handleName || undefined, id, page: pi, start: pt, orig: clone(a), snap, box: this.annBox(a) };
      this.pages[pi].svg.setPointerCapture(e.pointerId);
      e.preventDefault();
      return;
    }

    const s = this.style;
    const color = s.color || this.themeColor();
    switch (this.tool) {
      case 'select': case 'highlight': case 'underline':
        this.select(null);
        return;
      case 'text': {
        if (touch) { this.tap = { pi, pt, snap }; return; }
        this.addText(pi, pt, snap);
        e.preventDefault();
        return;
      }
      case 'arrow': case 'line': {
        const a: Annotation = { id: uid(), type: this.tool, page: pi, x1: pt.x, y1: pt.y, x2: pt.x, y2: pt.y, color, width: s.width };
        this.cur.annotations.push(a);
        this.selected = a.id;
        this.drag = { mode: 'create', id: a.id, page: pi, start: pt, snap };
        break;
      }
      case 'rect': case 'ellipse': {
        const a: Annotation = { id: uid(), type: this.tool, page: pi, x: pt.x, y: pt.y, w: 0, h: 0, color, width: s.width };
        if (s.fill) { a.fill = s.fill; a.fillOpacity = s.fillOpacity; }
        this.cur.annotations.push(a);
        this.selected = a.id;
        this.drag = { mode: 'create', id: a.id, page: pi, start: pt, snap };
        break;
      }
      case 'image': {
        if (!this.imageAsset) { this.setImageMenu(true); return; }
        const w = 140, hh = w * this.imageAsset.ratio;
        const a: Annotation = { id: uid(), type: 'image', page: pi, x: pt.x - w / 2, y: pt.y - hh / 2, w, h: hh, assetId: this.imageAsset.id };
        this.cur.annotations.push(a);
        this.commit(snap);
        this.setTool('select');
        this.select(a.id);
        return;
      }
      case 'stamp': {
        // body majú stále rovnaký štýl z nastavení (ak je nastavený), nie práve zvolené pero
        const size = this.me.stamp_points_size || s.stampSize;
        const a: Annotation = clone({
          id: uid(), type: 'stamp', page: pi, x: pt.x, y: pt.y - size * 0.45, size,
          color: this.me.stamp_points_color || color, font: this.me.stamp_points_font || s.font, ...this.signature(),
        });
        this.cur.annotations.push(a);
        this.commit(snap);
        this.setTool('select');
        this.select(a.id);
        return;
      }
    }
    this.pages[pi].svg.setPointerCapture(e.pointerId);
    this.drawPage(pi);
    e.preventDefault();
  }

  private addText(pi: number, pt: { x: number; y: number }, snap: string) {
    const s = this.style, f = fontById(s.font);
    const a: Annotation = {
      id: uid(), type: 'text', page: pi, x: pt.x, y: pt.y - s.size * f.ascent * 0.7, text: '', font: s.font, size: s.size,
      color: s.color || this.themeColor(),
    };
    if (s.underline) a.underline = true;
    this.cur!.annotations.push(a);
    this.startTextEdit(a, true, snap);
  }

  /**
   * Klik na stranu mimo objektov pri výbere / zvýrazňovači (SVG vtedy udalosti púšťa ďalej):
   * na texte PDF sa text označuje, inde (sken, prázdne miesto) zvýrazňovač natiahne obdĺžnik.
   */
  private onPageDown(e: PointerEvent, pi: number) {
    const p = this.pages[pi];
    if (e.button !== 0 || !this.cur || !p) return;
    this.tap = null;
    if (this.textSel) { this.textSel = null; this.emit(); }
    if (this.editing) this.commitTextEdit();
    this.setImageMenu(false);
    if (this.tool === 'select') { if (this.selected) this.select(null); return; }
    if (this.tool !== 'highlight' && this.tool !== 'underline') return;
    if ((e.target as Element).closest?.('.textLayer span:not(:empty), .linkLayer a')) return;
    e.preventDefault();
    const pt = this.toPage(e, pi);
    const snap = this.snapshot();
    const a = this.newMark(this.tool, pi, [{ x: pt.x, y: pt.y, w: 0, h: 0 }]);
    this.cur.annotations.push(a);
    this.selected = a.id;
    this.drag = { mode: 'create', id: a.id, page: pi, start: pt, snap };
    p.el.setPointerCapture(e.pointerId);
    this.drawPage(pi);
  }

  private newMark(kind: 'highlight' | 'underline', page: number, rects: Rect[]): Annotation {
    return kind === 'highlight'
      ? { id: uid(), type: 'highlight', page, rects, color: this.style.hlColor || HIGHLIGHT_COLOR, opacity: HIGHLIGHT_OPACITY }
      : { id: uid(), type: 'underline', page, rects, color: this.style.color || this.themeColor(), width: Math.max(0.5, this.style.width * 0.75) };
  }

  /** Po označení textu v PDF: zvýrazňovač hneď zvýrazní, pri výbere sa ukáže ponuka. */
  checkTextSelection() {
    if (!this.cur || !TEXT_TOOLS.includes(this.tool) || this.drag) return;
    const sel = document.getSelection();
    const range = sel && !sel.isCollapsed && sel.rangeCount ? sel.getRangeAt(0) : null;
    const parts: TextSel['parts'] = [];
    if (range) {
      for (const p of this.pages) {
        const tl = p.el.querySelector('.textLayer');
        if (!tl || !range.intersectsNode(tl)) continue;
        const box = p.svg.getBoundingClientRect(), kx = p.w / box.width, ky = p.h / box.height;
        const rects: Rect[] = [];
        for (const r of range.getClientRects()) {
          const q = { x: (r.left - box.left) * kx, y: (r.top - box.top) * ky, w: r.width * kx, h: r.height * ky };
          // prázdne, mimo strany, alebo celé bloky (nie riadky textu)
          if (q.w < 0.5 || q.h < 0.5 || q.x + q.w < 0 || q.y + q.h < 0 || q.x > p.w || q.y > p.h || q.h > 60) continue;
          rects.push(q);
        }
        const merged = mergeLineRects(rects);
        if (merged.length) parts.push({ page: p.index, rects: merged });
      }
    }
    if (!parts.length) {
      if (this.textSel) { this.textSel = null; this.emit(); }
      return;
    }
    if (this.tool === 'highlight' || this.tool === 'underline') { this.markSelection(this.tool, parts); return; }
    const r = range!.getBoundingClientRect();
    this.textSel = { x: r.left + r.width / 2, y: r.bottom, parts };
    this.emit();
  }

  /** Zvýrazní / podčiarkne označený text (z ponuky alebo zvýrazňovačom). */
  markSelection(kind: 'highlight' | 'underline', parts = this.textSel?.parts) {
    if (!this.cur || !parts?.length) return;
    const snap = this.snapshot();
    let last: string | null = null;
    for (const part of parts) {
      const a = this.newMark(kind, part.page, part.rects);
      this.cur.annotations.push(a);
      last = a.id;
    }
    this.textSel = null;
    document.getSelection()?.removeAllRanges();
    this.commit(snap);
    this.select(last);
  }

  copySelection() {
    const t = document.getSelection()?.toString();
    if (t) navigator.clipboard?.writeText(t).catch(() => {});
    this.textSel = null;
    this.emit();
  }

  /** Dokončenie ťuknutia (dotyk/pero) – tu už fokus textového poľa vydrží a ukáže klávesnicu. */
  private onTap() {
    const t = this.tap;
    this.tap = null;
    if (!t || !this.cur || this.editing) return;
    if (t.edit) {
      const a = this.findAnn(t.edit.id);
      if (a?.type === 'text') this.startTextEdit(a, false);
      return;
    }
    if (this.tool === 'text') this.addText(t.pi, t.pt, t.snap);
  }

  /** Dvojklik na text ho otvorí na úpravu (pointerdown nemá v každom prehliadači počet kliknutí). */
  private onDblClick(e: MouseEvent) {
    if (this.editing || this.drag || !this.cur) return;
    const t = e.target as Element;
    const hd = t.getAttribute?.('data-handle');
    if (hd === 'w') {
      // dvojklik na úchyt šírky: text sa prestane zalamovať
      const a = this.findAnn(this.selected);
      if (a?.type === 'text' && a.w) { const snap = this.snapshot(); delete a.w; this.commit(snap); }
      return;
    }
    if (hd) return;
    const id = t.closest?.('[data-id]')?.getAttribute('data-id') || t.getAttribute?.('data-sel') || this.selected;
    const a = this.findAnn(id ?? null);
    if (a?.type !== 'text') return;
    e.preventDefault();
    this.startTextEdit(a, false);
  }

  private onMove(e: PointerEvent) {
    const d = this.drag;
    if (!d) return;
    const a = this.findAnn(d.id);
    if (!a) return;
    const pt = this.toPage(e, d.page);
    const dx = pt.x - d.start.x, dy = pt.y - d.start.y;
    // ťuknutie prstom sa trocha chveje – kým je to ťuknutie na úpravu textu, objekt sa nehýbe
    if (this.tap && !d.moved && Math.hypot(dx, dy) < 4) return;
    d.moved = d.moved || Math.hypot(dx, dy) > 0.5;

    if (d.mode === 'move') {
      translateAnn(a, dx, dy, d.orig!);
    } else if (d.mode === 'create') {
      if (a.type === 'line' || a.type === 'arrow') {
        let x2 = pt.x, y2 = pt.y;
        if (e.shiftKey) {
          const ang = Math.round(Math.atan2(y2 - a.y1, x2 - a.x1) / (Math.PI / 4)) * (Math.PI / 4);
          const len = Math.hypot(x2 - a.x1, y2 - a.y1);
          x2 = a.x1 + Math.cos(ang) * len; y2 = a.y1 + Math.sin(ang) * len;
        }
        a.x2 = x2; a.y2 = y2;
      } else if (a.type === 'rect' || a.type === 'ellipse') {
        let w = dx, hh = dy;
        if (e.shiftKey) { const m = Math.max(Math.abs(w), Math.abs(hh)); w = Math.sign(w || 1) * m; hh = Math.sign(hh || 1) * m; }
        a.w = w; a.h = hh;
      } else if (a.type === 'highlight' || a.type === 'underline') {
        a.rects = [{ x: Math.min(d.start.x, pt.x), y: Math.min(d.start.y, pt.y), w: Math.abs(dx), h: Math.abs(dy) }];
      }
    } else if (d.mode === 'resize') {
      const o = d.orig!;
      if (a.type === 'line' || a.type === 'arrow') {
        if (d.handle === 'p1') { a.x1 = pt.x; a.y1 = pt.y; } else { a.x2 = pt.x; a.y2 = pt.y; }
      } else if (d.handle === 'w' && a.type === 'text') {
        a.w = Math.max(a.size, Math.round(pt.x - a.x));
      } else if (d.handle === 'scale' && (a.type === 'text' || a.type === 'stamp') && 'size' in o) {
        const k = Math.max(0.1, (pt.y - d.box!.y) / d.box!.h);
        a.size = Math.max(4, Math.round(o.size * k * 2) / 2);
        this.emit();
      } else if ((a.type === 'rect' || a.type === 'ellipse' || a.type === 'image') && (o.type === 'rect' || o.type === 'ellipse' || o.type === 'image')) {
        const b = normBox(o);
        let x1 = b.x, y1 = b.y, x2 = b.x + b.w, y2 = b.y + b.h;
        const hd = d.handle || '';
        if (hd.includes('w')) x1 = pt.x; else x2 = pt.x;
        if (hd.includes('n')) y1 = pt.y; else y2 = pt.y;
        if (a.type === 'image' && !e.shiftKey) {
          const ratio = b.h / b.w || 1;
          const hh = Math.abs(x2 - x1) * ratio;
          if (hd.includes('n')) y1 = y2 - hh; else y2 = y1 + hh;
        }
        a.x = Math.min(x1, x2); a.y = Math.min(y1, y2); a.w = Math.abs(x2 - x1); a.h = Math.abs(y2 - y1);
      }
    }
    this.drawPage(d.page);
  }

  private onUp() {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    if (d.moved) this.tap = null;
    const a = this.findAnn(d.id);
    if (!a || !this.cur) return;
    if (d.mode === 'create') {
      const small = (a.type === 'line' || a.type === 'arrow') ? Math.hypot(a.x2 - a.x1, a.y2 - a.y1) < 3
        : a.type === 'highlight' ? a.rects[0].w < 3 || a.rects[0].h < 3
        : a.type === 'underline' ? a.rects[0].w < 3
        : (a.type === 'rect' || a.type === 'ellipse') && (Math.abs(a.w) < 3 || Math.abs(a.h) < 3);
      if (small) {
        this.cur.annotations = this.cur.annotations.filter(x => x !== a);
        this.selected = null;
        this.drawPage(d.page);
        return;
      }
      if (a.type === 'rect' || a.type === 'ellipse') Object.assign(a, normBox(a));
      this.commit(d.snap);
      this.select(a.id);
    } else if (d.moved) {
      this.commit(d.snap);
    }
  }

  /* ================= textové pole ================= */

  private startTextEdit(a: Editing['a'], isNew: boolean, snap?: string) {
    const p = this.pages[a.page];
    const ta = document.createElement('textarea');
    ta.className = 'texted';
    ta.spellcheck = false;
    ta.value = a.text || '';
    const place = () => {
      const z = this.zoom, fam = fontFamily(fontById(a.font).id);
      ta.style.left = a.x * z + 'px';
      ta.style.top = a.y * z + 'px';
      ta.style.fontFamily = `"${fam}"`;
      ta.style.fontSize = a.size * z + 'px';
      ta.style.color = a.color || DEFAULT_COLOR;
      ta.style.textDecoration = a.underline ? 'underline' : '';
      // písaný text by išiel cez pravý okraj strany → zalomí sa na okraji (šírka sa dá potom zmeniť úchytom)
      if (!a.w && ta.value.split('\n').some(l => a.x + this.measure(l, a.size, a.font) > p.w - 12)) {
        a.w = Math.max(a.size * 2, Math.floor(p.w - 12 - a.x));
      }
      ta.classList.toggle('wrap', !!a.w);
      if (a.w) {
        // pevná šírka: zalamuje sa ako vo výsledku
        const n = textLines({ ...a, text: ta.value }, this.measure).length;
        ta.style.width = Math.ceil(a.w * z + a.size * z * 0.15) + 'px';
        ta.style.height = Math.ceil(n * a.size * z * LINE_HEIGHT + 4) + 'px';
        return;
      }
      this.measureCtx.font = `${a.size * z}px "${fam}"`;
      const lines = ta.value.split('\n');
      const w = Math.max(...lines.map(l => this.measureCtx.measureText(l || ' ').width));
      ta.style.width = Math.ceil(w + a.size * z * 0.8) + 'px';
      ta.style.height = Math.ceil(lines.length * a.size * z * LINE_HEIGHT + 4) + 'px';
    };
    this.editing = { a, isNew, snap: snap || this.snapshot(), ta, place };
    this.selected = a.id;
    ta.addEventListener('input', place);
    ta.addEventListener('keydown', e => {
      e.stopPropagation();
      if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) { e.preventDefault(); this.commitTextEdit(); }
    });
    ta.addEventListener('blur', () => setTimeout(() => {
      if (this.editing && this.editing.ta === ta && document.activeElement !== ta) this.commitTextEdit();
    }, 0));
    ta.addEventListener('pointerdown', e => e.stopPropagation());
    p.el.append(ta);
    place();
    // focus hneď, aby písanie nespustilo klávesové skratky nástrojov
    ta.focus({ preventScroll: true });
    this.drawPage(a.page);
    this.emit();
    setTimeout(() => { if (this.editing?.ta === ta) ta.focus({ preventScroll: true }); }, 0);
  }

  commitTextEdit() {
    const ed = this.editing;
    if (!ed || !this.cur) return;
    this.editing = null;
    const { a, ta, snap, isNew } = ed;
    const text = ta.value.replace(/\s+$/, '');
    ta.remove();
    if (!text) {
      this.cur.annotations = this.cur.annotations.filter(x => x !== a);
      this.selected = null;
      if (!isNew) this.commit(snap); else this.drawPage(a.page);
      return;
    }
    const changed = text !== a.text;
    a.text = text;
    if (changed || isNew || snap !== this.snapshot()) this.commit(snap);
    this.select(a.id);
  }

  /* ================= história úprav a ukladanie ================= */

  private syncUndo() { this.canUndo = this.undoStack.length > 0; this.canRedo = this.redoStack.length > 0; }

  private commit(prevSnap: string) {
    this.undoStack.push(prevSnap);
    if (this.undoStack.length > 500) this.undoStack.shift();
    this.redoStack = [];
    this.syncUndo();
    const item = this.sols.find(s => s.id === this.cur!.id);
    if (item) Object.assign(item, solutionFlags(this.cur!.annotations, this.cur!.pages));
    this.drawAll();
    this.scheduleSave();
  }

  undo() {
    this.commitTextEdit();
    if (!this.undoStack.length || !this.cur) return;
    this.redoStack.push(this.snapshot());
    this.restoreSnapshot(this.undoStack.pop()!);
    this.syncUndo(); this.afterRestore();
  }

  redo() {
    if (!this.redoStack.length || !this.cur) return;
    this.undoStack.push(this.snapshot());
    this.restoreSnapshot(this.redoStack.pop()!);
    this.syncUndo(); this.afterRestore();
  }

  private afterRestore() {
    const item = this.sols.find(s => s.id === this.cur!.id);
    if (item) Object.assign(item, solutionFlags(this.cur!.annotations, this.cur!.pages));
    this.drawAll(); this.scheduleSave(); this.emit();
  }

  private setSaveState(cls: SaveState['cls'], text: string) { this.saveState = { cls, text }; this.emit(); }

  private payload(): SolutionSave {
    const c = this.cur!;
    return {
      annotations: clone(c.annotations), checks: [...c.checks], manual_points: c.manual_points, rocnik: c.rocnik,
      bias: [...c.bias], bias_comment: c.bias_comment, pages: c.pages ? clone(c.pages) : null, scores: { ...c.scores },
    };
  }

  scheduleSave() {
    if (!this.cur) return;
    this.pendingId = this.cur.id;
    this.setSaveState('saving', 'Neuložené…');
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.flushSave(), 450);
  }

  /** Uloží na server; pri výpadku siete do zariadenia (outbox). */
  private async saveRemote(id: number, body: SolutionSave): Promise<SaveResult | null> {
    try {
      const r = await api<SaveResult>(`/api/solutions/${id}`, { method: 'PUT', body });
      await outbox.remove(id);
      this.applySaved(id, r, body);
      return r;
    } catch (e) {
      if (!isNetworkError(e)) throw e;
      await outbox.put({ solId: id, taskId: this.taskId, body, at: Date.now() });
      this.setSaveState('offline', 'Offline – uložené v zariadení');
      return null;
    }
  }

  private curState(): SolState {
    const c = this.cur!;
    return clone({
      annotations: c.annotations, checks: c.checks, manual_points: c.manual_points, rocnik: c.rocnik, bias: c.bias, bias_comment: c.bias_comment,
      pages: c.pages, scores: c.scores,
    });
  }

  /** Nahradí stav otvoreného riešenia (po zlúčení s cudzími zmenami) a prekreslí. */
  private replaceState(st: SolState) {
    const c = this.cur!;
    const pagesChanged = !same(c.pages, st.pages);
    Object.assign(c, clone(st));
    if (this.selected && !this.findAnn(this.selected)) this.selected = null;
    // staré kroky späť by mohli potichu zmazať cudzie zmeny
    this.undoStack = []; this.redoStack = []; this.syncUndo();
    const item = this.sols.find(s => s.id === c.id);
    if (item) Object.assign(item, solutionFlags(c.annotations, c.pages), { rocnik: c.rocnik, bias: [...c.bias] });
    this.recompute();
    if (pagesChanged) void this.buildPages();
    this.drawAll();
  }

  /** Server potvrdil uloženie (aj z offline fronty). `sent` = čo sme poslali. */
  applySaved(id: number, r: SaveResult, sent?: SolutionSave) {
    const item = this.sols.find(s => s.id === id);
    if (item) { item.points = r.points; item.rev = r.rev; item.rocnik = r.rocnik; }
    if (this.cur && this.cur.id === id) {
      this.cur.rev = r.rev;
      if (sent && Array.isArray(sent.annotations)) {
        const sentState = solState(sent as SolState);
        if (r.merged) {
          // do výsledku zlúčenia pridaj aj to, čo som medzitým (po odoslaní) zmenil
          this.replaceState(mergeStates(sentState, this.curState(), r.merged));
          this.notice = `${r.mergedWith || 'Niekto iný'} medzitým upravil(a) toto riešenie – zmeny oboch sa zlúčili.`;
        }
        this.base = { rev: r.rev, state: clone(r.merged || sentState) };
      }
      if (item) Object.assign(item, solutionFlags(this.cur.annotations, this.cur.pages));
    }
    if (this.saveState.cls === 'offline' && !this.pendingId) this.saveState = { cls: 'saved', text: 'Uložené (po pripojení)' };
    this.emit();
  }

  /* ================= prítomnosť a cudzie zmeny ================= */

  private presenceTimer: ReturnType<typeof setInterval> | undefined;
  private presenceTicks = 0;

  startPresence() {
    if (this.local) return; // lokálne úlohy nikto iný nevidí
    this.presenceTimer = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      this.pingPresence();
      // zoznam (body, príznaky ostatných riešení) raz za pol minúty
      if (++this.presenceTicks % 6 === 0) this.reloadTask().catch(() => {});
    }, 5000);
    this.disposers.push(() => {
      clearInterval(this.presenceTimer);
      fetch(`/api/tasks/${this.taskId}/presence`, {
        method: 'POST', keepalive: true, credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ leave: true }),
      }).catch(() => {});
    });
  }

  async pingPresence() {
    const solId = this.cur?.id ?? null;
    let r: PresenceResult;
    try {
      r = await api<PresenceResult>(`/api/tasks/${this.taskId}/presence`, { method: 'POST', body: { solId } });
    } catch { return; }
    this.others = r.others;
    this.emit();
    if (r.rev !== null && this.cur && this.cur.id === solId && this.base && r.rev > this.base.rev) await this.pullRemote();
  }

  /** Niekto iný uložil otvorené riešenie → načítaj a zlúč do obrazovky. */
  private async pullRemote() {
    if (!this.cur || !this.base || this.pendingId || this.saving || this.drag || this.editing) return;
    const id = this.cur.id;
    let remote: SolutionDetail;
    try { remote = await api<SolutionDetail>(`/api/solutions/${id}`); } catch { return; }
    if (!this.cur || this.cur.id !== id || this.pendingId || this.saving || this.drag || this.editing) return;
    if (remote.rev <= this.base.rev) return;
    const remoteState = solState(remote);
    this.replaceState(mergeStates(this.base.state, this.curState(), remoteState));
    this.base = { rev: remote.rev, state: clone(remoteState) };
    this.cur.rev = remote.rev;
    const item = this.sols.find(s => s.id === id);
    if (item) item.rev = remote.rev;
    this.setSaveState('saved', `Aktualizované (${remote.updated_by || 'niekto iný'})`);
  }

  flushSave(): Promise<unknown> {
    clearTimeout(this.saveTimer);
    if (!this.pendingId || !this.cur || this.pendingId !== this.cur.id) { this.pendingId = null; return this.inflight; }
    const id = this.pendingId;
    const body = this.payload();
    this.pendingId = null;
    this.setSaveState('saving', 'Ukladám…');
    this.inflight = this.inflight.catch(() => {}).then(async () => {
      // základ určím až tesne pred odoslaním – predchádzajúce uloženie ho mohlo posunúť
      if (this.base && this.cur?.id === id) { body.baseRev = this.base.rev; body.base = this.base.state; }
      else body.baseRev = this.sols.find(s => s.id === id)?.rev;
      this.saving = true;
      try {
        const r = await this.saveRemote(id, body);
        if (r && !this.pendingId) this.setSaveState('saved', 'Uložené');
      } catch (e) {
        this.setSaveState('err', 'Chyba ukladania: ' + (e as Error).message);
        if (this.cur && this.cur.id === id && !this.pendingId) { this.pendingId = id; this.saveTimer = setTimeout(() => this.flushSave(), 3000); }
      } finally {
        this.saving = false;
      }
    });
    return this.inflight;
  }

  /** Pri zatváraní okna: neuložené zmeny odošli (keepalive) a zálohuj do zariadenia. */
  hasUnsaved() { return !!(this.pendingId && this.cur && this.pendingId === this.cur.id); }
  saveOnUnload() {
    if (!this.hasUnsaved()) return;
    if (this.local) { this.flushSave(); return; }
    const body: SolutionSave = { ...this.payload(), baseRev: this.base?.rev, base: this.base?.state };
    outbox.put({ solId: this.cur!.id, taskId: this.taskId, body, at: Date.now() });
    fetch(`/api/solutions/${this.cur!.id}`, {
      method: 'PUT', keepalive: true, credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }).catch(() => {});
  }

  /* ================= bodovanie ================= */

  recompute() {
    if (!this.cur) return;
    this.cur.points = computePoints(this.task.rubric, this.cur.checks, this.cur.manual_points, this.task.max_points, this.cur.scores, this.task.rubric_mode);
    const item = this.sols.find(s => s.id === this.cur!.id);
    if (item) item.points = this.cur.points;
  }

  private gradeChanged() {
    this.recompute();
    this.drawAll();
    this.scheduleSave();
    this.emit();
  }

  toggleItem(id: string, on?: boolean) {
    if (!this.cur) return;
    const set = new Set(this.cur.checks);
    if (on === undefined) on = !set.has(id);
    if (on) set.add(id); else set.delete(id);
    this.cur.checks = [...set];
    this.gradeChanged();
  }

  setManual(v: number | null) {
    if (!this.cur) return;
    this.cur.manual_points = v;
    this.gradeChanged();
  }

  /** Intervalové bodovanie: body za položku (null = nehodnotené). */
  setScore(id: string, v: number | null) {
    if (!this.cur) return;
    const scores = { ...this.cur.scores };
    if (v === null || !Number.isFinite(v)) delete scores[id];
    else {
      const it = this.task.rubric.find(i => i.id === id);
      const [lo, hi] = it ? rangeOf(it) : [0, Infinity];
      scores[id] = Math.min(hi, Math.max(lo, Math.round(v * 100) / 100));
    }
    if (same(scores, this.cur.scores)) return;
    this.cur.scores = scores;
    this.gradeChanged();
  }

  clearGrade() {
    if (!this.cur) return;
    this.cur.checks = []; this.cur.manual_points = null; this.cur.scores = {};
    this.gradeChanged();
  }

  /** Interné body (0 = Správnosť, 1 = Úsilie, 2 = AI a podvádzanie) – do PDF sa nedostanú. */
  setBias(i: number, v: number) {
    if (!this.cur || !Number.isFinite(v)) return;
    const bias = [...this.cur.bias] as Bias;
    bias[i] = Math.max(0, Math.round(v * 100) / 100);
    if (bias[i] === this.cur.bias[i]) return;
    this.cur.bias = bias;
    const item = this.sols.find(s => s.id === this.cur!.id);
    if (item) item.bias = [...bias];
    this.scheduleSave();
    this.emit();
  }

  setBiasComment(v: string) {
    if (!this.cur) return;
    this.cur.bias_comment = v;
    this.scheduleSave();
    this.emit();
  }

  async saveTask(patch: { name?: string; max_points?: number | null; comment_text?: string; rubric?: RubricItem[]; rubric_mode?: RubricMode; signers?: number[] }) {
    await this.flushSave();
    await api(`/api/tasks/${this.taskId}`, { method: 'PUT', body: patch });
    await this.reloadTask();
  }

  /** zdieľaná úloha (iní ľudia ju opravujú tiež) */
  get shared() { return !this.local && !!this.task && (!this.task.is_owner || this.task.shares.length > 0); }

  /* ================= nástroje a štýl ================= */

  setTool(t: Tool) {
    this.commitTextEdit();
    this.tool = t;
    if (t !== 'image') this.imageMenu = false;
    if (!TEXT_TOOLS.includes(t)) { this.textSel = null; document.getSelection()?.removeAllRanges(); }
    this.emit();
  }

  setImageMenu(open: boolean) {
    if (this.imageMenu === open) return;
    this.imageMenu = open;
    this.emit();
  }

  /** Hodnoty, ktoré ukazuje panel nástrojov: označený objekt, inak predvolený štýl. */
  shownStyle(): Style {
    const a = this.editing ? this.editing.a : this.findAnn(this.selected);
    const s = { ...this.style };
    if (!a) {
      if (this.tool === 'highlight') s.color = this.style.hlColor;
      return s;
    }
    if ('font' in a) s.font = a.font;
    if (a.type === 'text') { s.size = a.size; s.underline = !!a.underline; }
    if (a.type === 'stamp') s.size = a.size;
    if ('width' in a && a.width !== undefined) s.width = a.width;
    if (a.color) s.color = a.color;
    if (a.type === 'rect' || a.type === 'ellipse') { s.fill = a.fill || ''; s.fillOpacity = a.fillOpacity ?? s.fillOpacity; }
    return s;
  }

  selectedType(): AnnType | null { return this.findAnn(this.selected)?.type || null; }

  /** Pracuje sa so zvýrazňovačom (jeho farby sú iné ako farby pera). */
  isHighlighting() {
    const a = this.editing ? null : this.findAnn(this.selected);
    return a ? a.type === 'highlight' : this.tool === 'highlight';
  }

  // zmena štýlu: uloží sa ako predvolený a aplikuje sa na označený objekt
  applyStyle<K extends StyleKey>(key: K, value: Style[K]) {
    const target = this.editing ? this.editing.a : this.findAnn(this.selected);
    const hl = key === 'color' && this.isHighlighting();
    if (hl) this.style.hlColor = (value as string) || HIGHLIGHT_COLOR;
    else this.style[key] = value;
    if (target?.type === 'stamp' && key === 'size') this.style.stampSize = value as number;
    try { localStorage.setItem(STYLE_KEY, JSON.stringify(this.style)); } catch { /* */ }
    this.emit();
    if (!target) return;
    const allowed: Record<AnnType, StyleKey[]> = {
      text: ['font', 'size', 'color', 'underline'], stamp: ['font', 'size', 'color'],
      arrow: ['color', 'width'], line: ['color', 'width'], rect: ['color', 'width', 'fill', 'fillOpacity'], ellipse: ['color', 'width', 'fill', 'fillOpacity'],
      image: [], highlight: ['color'], underline: ['color', 'width'],
    };
    const t = target as unknown as Record<string, unknown>;
    const v = key === 'color' && !value ? (hl ? HIGHLIGHT_COLOR : this.themeColor()) : value;
    if (!allowed[target.type].includes(key) || t[key] === v || (!v && t[key] === undefined)) return;
    if (key === 'fillOpacity' && !t.fill) return;
    const set = () => {
      // prázdna výplň / bez podčiarknutia = vlastnosť zmizne (staré dáta ju nemajú)
      if (v === '' || v === false) delete t[key]; else t[key] = v;
      if (key === 'fill') { if (v) t.fillOpacity ??= this.style.fillOpacity; else delete t.fillOpacity; }
    };
    if (this.editing) { set(); this.editing.place(); return; }
    const snap = this.snapshot();
    set();
    this.commit(snap);
    this.emit();
  }

  /**
   * Podpis pod bodmi pre nové pečiatky (z profilu): text, alebo obrázok, s farbou a polohou z nastavení.
   * V zdieľanej úlohe s vybranými podpismi viacerých ľudí: všetky vedľa seba, každý podľa nastavení toho človeka.
   */
  signature(): Partial<StampAnn> {
    const none = { name: undefined, nameFont: undefined, nameColor: undefined, assetId: undefined, ratio: undefined, imgScale: undefined, sigs: undefined };
    const sigPos = this.me.stamp_pos && this.me.stamp_pos !== 'below' ? this.me.stamp_pos : undefined;
    const multi = this.multiSigs();
    if (multi) return { ...none, sigs: multi, sigPos };
    const img = this.me.stamp_image;
    if (img) return { ...none, name: '', assetId: img, ratio: this.sigRatios.get(img) || 0.4, imgScale: this.me.stamp_image_scale || undefined, sigPos };
    return { ...none, name: this.me.stamp_name || this.me.name, nameFont: this.me.stamp_font || undefined, nameColor: this.me.stamp_color || undefined, sigPos };
  }

  /** Podpisy vybraných ľudí v zdieľanej úlohe (null = len môj, ako doteraz). */
  private multiSigs(): Sig[] | null {
    if (!this.shared || !this.task.signers.length) return null;
    const out = this.task.signers
      .map(id => this.signers.find(x => x.id === id))
      .filter((x): x is Signer => !!x)
      .map(x => (x.sig.assetId ? { ...x.sig, ratio: this.sigRatios.get(x.sig.assetId) || 0.4 } : x.sig));
    return out.length ? clone(out) : null;
  }

  private sigRatios = new Map<number, number>();
  /** Pomer strán obrázka podpisu (výška / šírka). */
  private async loadRatio(id: number) {
    if (this.sigRatios.has(id)) return;
    if (this.local && id > 0) await cacheServerAsset(id).catch(() => {});
    const src = this.local ? await localAssetUrl(id) : `/api/assets/${id}`;
    if (!src) return;
    await new Promise<void>(resolve => {
      const img = new Image();
      img.onload = () => { this.sigRatios.set(id, img.naturalHeight / img.naturalWidth || 0.4); resolve(); };
      img.onerror = () => resolve();
      img.src = src;
    });
  }
  /** Pomer strán obrázkového podpisu z profilu (pri lokálnej úlohe si serverový obrázok uloží do zariadenia). */
  private async loadSignature() {
    const id = this.me?.stamp_image;
    if (id) await this.loadRatio(id);
  }
  /** Podpisy ľudí v zdieľanej úlohe (podľa ich aktuálnych nastavení). */
  async loadSigners() {
    if (this.local) return;
    try { this.signers = await api<Signer[]>(`/api/tasks/${this.taskId}/signers`); } catch { return; }
    await Promise.all(this.signers.map(x => (x.sig.assetId ? this.loadRatio(x.sig.assetId) : null)));
    this.emit();
  }

  /** Označenú pečiatku prepíše podpismi podľa aktuálnych nastavení (profil / podpisy úlohy). */
  refreshStampSignature() {
    const a = this.findAnn(this.selected);
    if (a?.type !== 'stamp') return;
    this.updateStamp(this.signature());
  }

  selectedAnn() { return this.findAnn(this.selected); }

  /** Zmena podpisu na označenej pečiatke. */
  updateStamp(patch: Partial<Pick<StampAnn, 'name' | 'nameFont' | 'nameColor' | 'assetId' | 'ratio' | 'imgScale' | 'sigPos' | 'sigs'>>) {
    const a = this.findAnn(this.selected);
    if (!a || a.type !== 'stamp') return;
    const snap = this.snapshot();
    Object.assign(a, patch);
    for (const k of Object.keys(a) as (keyof typeof a)[]) if (a[k] === undefined) delete a[k];
    if (snap === this.snapshot()) return;
    this.commit(snap);
    this.emit();
  }

  deleteSelected() {
    const a = this.findAnn(this.selected);
    if (!a || !this.cur) return;
    const snap = this.snapshot();
    this.cur.annotations = this.cur.annotations.filter(x => x !== a);
    this.selected = null;
    this.commit(snap);
    this.emit();
  }

  currentPageIndex() {
    if (!this.viewer || !this.pages.length) return 0;
    const viewer = this.viewer!.getBoundingClientRect();
    const mid = viewer.top + viewer.height / 2;
    let best = 0, bestD = Infinity;
    this.pages.forEach(p => {
      const r = p.el.getBoundingClientRect();
      const d = mid < r.top ? r.top - mid : mid > r.bottom ? mid - r.bottom : 0;
      if (d < bestD) { bestD = d; best = p.index; }
    });
    return best;
  }

  private copy() {
    const a = this.findAnn(this.selected);
    if (a && this.cur) this.clipboard = { ann: clone(a), solId: this.cur.id };
    return !!a;
  }

  // vloženie do iného riešenia dá objekt na to isté miesto
  private paste() {
    if (!this.clipboard || !this.cur || !this.pages.length) return;
    const snap = this.snapshot();
    const a = clone(this.clipboard.ann);
    a.id = uid();
    const samePlace = this.clipboard.solId === this.cur.id;
    a.page = samePlace ? this.currentPageIndex() : Math.min(a.page, this.pages.length - 1);
    if (samePlace) {
      translateAnn(a, 12, 12);
      this.clipboard.ann = clone(a);
    }
    const b = a.type === 'stamp' ? clone(Object.assign(a, this.signature())) : a;
    this.cur.annotations.push(b);
    this.commit(snap);
    this.select(b.id);
  }

  private nudge(dx: number, dy: number) {
    const a = this.findAnn(this.selected);
    if (!a) return;
    const snap = this.snapshot();
    translateAnn(a, dx, dy);
    this.commit(snap);
  }

  /** Klávesové skratky; dialógy si ich blokujú cez `modalOpen`. */
  modalOpen = false;
  private bindGlobal() {
    const onResize = () => { if (this.fit) this.applyZoom(); };
    const onKey = (e: KeyboardEvent) => {
      const tag = ((e.target as HTMLElement).tagName || '').toLowerCase();
      const typing = tag === 'input' || tag === 'textarea' || tag === 'select';
      const mod = e.ctrlKey || e.metaKey;
      if (e.altKey && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) { e.preventDefault(); this.stepSolution(e.key === 'ArrowDown' ? 1 : -1); return; }
      if (typing || this.modalOpen) return;
      const k = e.key.toLowerCase();
      if (mod && k === 'z') { e.preventDefault(); if (e.shiftKey) this.redo(); else this.undo(); return; }
      if (mod && k === 'y') { e.preventDefault(); this.redo(); return; }
      if (mod && k === 'c') { if (this.copy()) e.preventDefault(); return; }
      if (mod && k === 'v') { e.preventDefault(); this.paste(); return; }
      if (mod || e.altKey) return;
      const sel = this.findAnn(this.selected);
      switch (e.key) {
        case 'Delete': case 'Backspace': if (sel) { e.preventDefault(); this.deleteSelected(); } return;
        case 'Escape': this.select(null); this.setTool('select'); return;
        case 'Enter': if (sel && sel.type === 'text') { e.preventDefault(); this.startTextEdit(sel, false); } return;
        case 'ArrowLeft': if (sel) { e.preventDefault(); this.nudge(e.shiftKey ? -10 : -1, 0); } return;
        case 'ArrowRight': if (sel) { e.preventDefault(); this.nudge(e.shiftKey ? 10 : 1, 0); } return;
        case 'ArrowUp': if (sel) { e.preventDefault(); this.nudge(0, e.shiftKey ? -10 : -1); } return;
        case 'ArrowDown': if (sel) { e.preventDefault(); this.nudge(0, e.shiftKey ? 10 : 1); } return;
      }
      const tools: Record<string, Tool> = { v: 'select', t: 'text', a: 'arrow', l: 'line', r: 'rect', e: 'ellipse', h: 'highlight', u: 'underline', b: 'stamp' };
      if (tools[k]) { this.setTool(tools[k]); return; }
      if (k === 'i') { this.setTool('image'); this.setImageMenu(true); return; }
      if (/^[1-9]$/.test(e.key)) {
        const item = this.task.rubric[Number(e.key) - 1];
        if (!item || !this.cur) return;
        if (this.task.rubric_mode !== 'range') { this.toggleItem(item.id); return; }
        // intervaly: plný počet ↔ 0
        const hi = rangeOf(item)[Number(item.points) < 0 ? 0 : 1];
        this.setScore(item.id, this.cur.scores[item.id] === hi ? 0 : hi);
      }
    };
    const onUnload = (e: BeforeUnloadEvent) => {
      if (!this.hasUnsaved()) return;
      this.saveOnUnload();
      e.preventDefault();
    };
    // označený text v PDF: po pustení myši (aj mimo strany)
    const onPointerUp = () => setTimeout(() => this.checkTextSelection(), 0);
    const onScroll = () => { if (this.textSel) { this.textSel = null; this.emit(); } };
    addEventListener('resize', onResize);
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerup', onPointerUp);
    this.viewer?.addEventListener('scroll', onScroll, { passive: true });
    addEventListener('beforeunload', onUnload);
    // pred reštartom servera: ulož (tesne pred ním aj rozpísaný text)
    this.disposers.push(registerSaver(async final => {
      if (final) this.commitTextEdit();
      await this.flushSave();
    }));
    this.disposers.push(() => {
      removeEventListener('resize', onResize);
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerup', onPointerUp);
      this.viewer?.removeEventListener('scroll', onScroll);
      removeEventListener('beforeunload', onUnload);
    });
  }

  /* ================= obrázky / podpisy ================= */

  /** Nahrá už spracovaný (a orezaný) obrázok do knižnice a vyberie ho. */
  async uploadAsset(blob: Blob, name: string) {
    const fd = new FormData();
    fd.append('file', blob, name.replace(/\.[^.]+$/, '') + '.png');
    const id = this.local
      ? await addLocalAsset(blob, name)
      : (await api<{ id: number }>('/api/assets', { method: 'POST', body: fd })).id;
    this.assets.unshift({ id, name });
    await this.chooseAsset(id);
  }

  async deleteAsset(id: number) {
    if (this.local) await deleteLocalAsset(id); else await api(`/api/assets/${id}`, { method: 'DELETE' });
    this.assets = this.assets.filter(x => x.id !== id);
    if (this.imageAsset?.id === id) this.imageAsset = null;
    this.emit();
  }

  private assetUrls = new Map<number, string>();
  private assetLoading = new Set<number>();
  /** Adresa obrázka: zo servera, alebo pri lokálnej úlohe z úložiska v zariadení (načíta sa na pozadí). */
  assetHref(id: number): string {
    if (!this.local) return `/api/assets/${id}`;
    const u = this.assetUrls.get(id);
    if (u) return u;
    if (!this.assetLoading.has(id)) {
      this.assetLoading.add(id);
      localAssetUrl(id).then(url => { if (url) { this.assetUrls.set(id, url); this.drawAll(); this.emit(); } });
    }
    return '';
  }

  async chooseAsset(id: number) {
    const src = this.local ? await localAssetUrl(id) : `/api/assets/${id}`;
    if (!src) return;
    return new Promise<void>(resolve => {
      const img = new Image();
      img.onload = () => {
        this.imageAsset = { id, ratio: img.naturalHeight / img.naturalWidth || 0.5 };
        this.imageMenu = false;
        this.setTool('image');
        resolve();
      };
      img.onerror = () => resolve();
      img.src = src;
    });
  }

  /* ================= strany (prázdne, otočené) ================= */

  /** Počet objektov na strane (pred odstránením strany). */
  annsOnPage(i: number) { return this.anns().filter(a => a.page === i).length; }

  private setPages(pages: PageSpec[] | null, anns: Annotation[], snap: string) {
    const c = this.cur!;
    // strany zhodné s pôvodným PDF = bez nastavení
    const n = this.pdf?.numPages || 0;
    c.pages = pages && !(pages.length === n && pages.every((p, i) => p.src === i && !pageTransformed(p))) ? pages : null;
    c.annotations = anns;
    if (this.selected && !this.findAnn(this.selected)) this.selected = null;
    this.commit(snap);
    void this.buildPages();
    this.emit();
  }

  /** Pridá prázdnu stranu A4 za stranu `after` (-1 = na začiatok); objekty na ďalších stranách sa posunú s nimi. */
  addBlankPage(after: number) {
    if (!this.cur || !this.pdf) return;
    this.commitTextEdit();
    const snap = this.snapshot();
    const pages = clone(this.layout());
    pages.splice(after + 1, 0, { src: null, w: A4.w, h: A4.h });
    const anns = this.cur.annotations.map(a => (a.page > after ? { ...a, page: a.page + 1 } : a));
    this.scrollToPage = after + 1;
    this.setPages(pages, anns, snap);
  }

  /** Odstráni pridanú prázdnu stranu (aj s objektmi na nej). Pôvodné strany riešenia sa odstrániť nedajú. */
  removePage(i: number) {
    if (!this.cur || this.layout()[i]?.src !== null) return;
    this.commitTextEdit();
    const snap = this.snapshot();
    const pages = clone(this.layout());
    pages.splice(i, 1);
    const anns = this.cur.annotations.filter(a => a.page !== i).map(a => (a.page > i ? { ...a, page: a.page - 1 } : a));
    this.setPages(pages, anns, snap);
  }

  /**
   * Otočí obsah strany o `delta` stupňov (v smere hodín). Strana ostane na výšku rovnako veľká;
   * pri prvom otočení sa nájde, kde je na strane naozaj sken (je sivší ako biele okolie), a ten sa zmestí na stranu.
   */
  async rotatePage(i: number, delta: number) {
    const cur = this.cur, spec = this.layout()[i];
    if (!cur || !spec || spec.src === null) return;
    this.commitTextEdit();
    const crop = spec.crop || (await this.detectCrop(spec.src)) || undefined;
    if (this.cur !== cur) return;
    const snap = this.snapshot();
    const pages = clone(this.layout());
    const rot = ((((pages[i].rot || 0) + delta) % 360) + 360) % 360;
    pages[i] = { src: spec.src, ...(rot ? { rot } : {}), ...(crop ? { crop } : {}), ...(spec.scale ? { scale: spec.scale } : {}) };
    this.scrollToPage = i;
    this.setPages(pages, cur.annotations, snap);
  }

  /**
   * Veľkosť obsahu strany (1 = celá strana, menej = obsah zmenšený na stred a okolo voľné okraje na písanie).
   * Objekty na strane sa zmenšia spolu s obsahom, aby ostali na svojom mieste.
   */
  setPageScale(i: number | 'all', scale: number) {
    const cur = this.cur;
    if (!cur) return;
    scale = Math.min(1, Math.max(0.3, scale));
    const pages = clone(this.layout());
    // pomer zmeny pre každú stranu (pridané prázdne strany sa nemenia)
    const ratio = new Map<number, number>();
    pages.forEach((p, j) => {
      if (p.src === null || (i !== 'all' && i !== j)) return;
      const old = p.scale || 1;
      if (Math.abs(old - scale) < 0.001) return;
      ratio.set(j, scale / old);
      if (scale < 1) p.scale = scale; else delete p.scale;
    });
    if (!ratio.size) return;
    this.commitTextEdit();
    const snap = this.snapshot();
    const anns = cur.annotations.map(a => {
      const r = ratio.get(a.page), v = this.pages[a.page];
      if (!r || !v) return a;
      const b = clone(a);
      scaleAnn(b, v.w / 2, v.h / 2, r);
      return b;
    });
    if (i !== 'all') this.scrollToPage = i;
    this.setPages(pages, anns, snap);
  }

  /** Pôvodné strany (bez pridaných, otočení a okrajov); objekty na pridaných stranách zmiznú. */
  resetPages() {
    if (!this.cur?.pages) return;
    this.commitTextEdit();
    const snap = this.snapshot();
    const specs = this.cur.pages;
    const anns = this.cur.annotations
      .filter(a => specs[a.page] && specs[a.page].src !== null)
      .map(a => {
        const b = { ...clone(a), page: specs[a.page].src! };
        // zo zmenšenej strany späť na celú: objekty sa zväčšia s obsahom
        const sc = specs[a.page].scale, v = this.pages[a.page];
        if (sc && v) scaleAnn(b, v.w / 2, v.h / 2, 1 / sc);
        return b;
      });
    this.setPages(null, anns, snap);
  }

  /** Časť strany, kde je naozaj riešenie: naskenovaný papier nie je úplne biely, okolie áno. */
  private async detectCrop(src: number): Promise<Rect | null> {
    const pdf = this.pdf;
    if (!pdf) return null;
    const c = document.createElement('canvas');
    try {
      const page = await pdf.getPage(src + 1);
      const vp1 = page.getViewport({ scale: 1 });
      const scale = 600 / Math.max(vp1.width, vp1.height);
      const vp = page.getViewport({ scale });
      c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
      const ctx = c.getContext('2d', { willReadFrequently: true })!;
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, c.width, c.height);
      await page.render({ canvas: c, canvasContext: ctx, viewport: vp }).promise;
      const W = c.width, H = c.height, px = ctx.getImageData(0, 0, W, H).data;
      const rows = new Uint32Array(H), cols = new Uint32Array(W);
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const k = (y * W + x) * 4;
          if (Math.min(px[k], px[k + 1], px[k + 2]) < 245) { rows[y]++; cols[x]++; }
        }
      }
      // riadok / stĺpec patrí riešeniu, ak v ňom nie je biela aspoň na 2 % (šum a prach sa nerátajú)
      const first = (a: Uint32Array, min: number) => a.findIndex(v => v > min);
      const last = (a: Uint32Array, min: number) => a.length - 1 - [...a].reverse().findIndex(v => v > min);
      const y0 = first(rows, W * 0.02), x0 = first(cols, H * 0.02);
      if (y0 < 0 || x0 < 0) return null;
      const y1 = last(rows, W * 0.02), x1 = last(cols, H * 0.02);
      const box = { x: x0 / scale, y: y0 / scale, w: (x1 - x0 + 1) / scale, h: (y1 - y0 + 1) / scale };
      if (box.w < vp1.width * 0.1 || box.h < vp1.height * 0.1) return null;
      if (box.w > vp1.width * 0.97 && box.h > vp1.height * 0.97) return null; // celá strana
      return box;
    } catch {
      return null;
    } finally {
      c.width = 0; c.height = 0;
    }
  }

  /* ================= verzie ================= */

  async restoreVersion(vid: number) {
    if (!this.cur) return;
    await this.flushSave();
    const id = this.cur.id;
    const r = await api<SaveResult>(`/api/solutions/${id}/versions/${vid}/restore`, { method: 'POST' });
    this.applySaved(id, r);
    await this.openSolution(id);
  }
}

/** Obdĺžniky označeného textu (po spanoch) spojí do riadkov. */
function mergeLineRects(rects: Rect[]): Rect[] {
  const out: Rect[] = [];
  for (const r of [...rects].sort((a, b) => a.y + a.h / 2 - (b.y + b.h / 2) || a.x - b.x)) {
    const l = out[out.length - 1];
    const sameLine = l && Math.abs(l.y + l.h / 2 - (r.y + r.h / 2)) < Math.min(l.h, r.h) / 2;
    if (sameLine && r.x <= l.x + l.w + Math.max(l.h, r.h) * 0.8) {
      const x1 = Math.min(l.x, r.x), y1 = Math.min(l.y, r.y);
      const x2 = Math.max(l.x + l.w, r.x + r.w), y2 = Math.max(l.y + l.h, r.y + r.h);
      Object.assign(l, { x: x1, y: y1, w: x2 - x1, h: y2 - y1 });
    } else out.push({ ...r });
  }
  return out;
}

/** Zmenší obrázok a voliteľne zmení biele pozadie na priehľadné (podpisy). */
export function prepareImage(file: File, removeWhite: boolean): Promise<Blob> {
  return new Promise((resolve, reject) => {
    if (file.size > MAX_IMAGE_BYTES) {
      reject(new Error(`Obrázok je príliš veľký (${(file.size / 1048576).toFixed(1)} MB), maximum je ${MAX_IMAGE_MB} MB.`));
      return;
    }
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const max = 1600;
      const k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement('canvas');
      c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
      const ctx = c.getContext('2d')!;
      ctx.drawImage(img, 0, 0, c.width, c.height);
      if (removeWhite) {
        const d = ctx.getImageData(0, 0, c.width, c.height);
        const px = d.data;
        for (let i = 0; i < px.length; i += 4) {
          const m = Math.min(px[i], px[i + 1], px[i + 2]);
          if (m > 200) px[i + 3] = Math.round(px[i + 3] * Math.max(0, (255 - m) / 55));
        }
        ctx.putImageData(d, 0, 0);
      }
      URL.revokeObjectURL(url);
      c.toBlob(b => (b ? resolve(b) : reject(new Error('Obrázok sa nepodarilo spracovať.'))), 'image/png');
    };
    img.onerror = () => reject(new Error('Obrázok sa nepodarilo načítať.'));
    img.src = url;
  });
}
