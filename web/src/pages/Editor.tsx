import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useParams } from 'react-router';
import {
  BIAS_LABELS, BIAS_SOFT_MAX, DEFAULT_BIAS, FONTS, PAGE_SCALES, SIG_POSITIONS, STAMP_IMAGE_SCALE, commentedName, exportPoints, fontFamily, formatPoints, normBias,
  rangeOf, round2, type RubricItem, type SigPos, type SolutionListItem, type VersionItem,
} from '@opravovator/shared';
import { api } from '../api';
import { onOutboxSaved } from '../offline';
import { EditorController, HL_SWATCHES, SWATCHES, prepareImage, type Tool } from '../editor/controller';
import { ImageCropDialog } from '../components/ImageCrop';
import { Brand, Dialog, NetStatus, ThemeButton, formatDate, useConfirm } from '../components/common';
import { GearIcon, SettingsDialog } from '../components/Settings';
import { applyAccent } from '../theme';
import { downloadBlob, localCsv, localExportZip, localResult, localThumb } from '../local/ops';
import { getSession } from '../local/session';
import { syncTask } from '../local/sync';
import type { LocalTask } from '../local/store';

/**
 * Adresa PDF so správnym názvom súboru. `blob:` adresy názov nemajú (prehliadač by pri stiahnutí
 * ponúkol náhodný), preto sa PDF vloží do cache service workera pod /local-pdf/…/meno.komentar.pdf.
 */
async function namedPdfUrl(blob: Blob, name: string): Promise<string> {
  if (!('caches' in window) || !navigator.serviceWorker?.controller) return URL.createObjectURL(blob);
  const cache = await caches.open('local-pdfs');
  for (const req of await cache.keys()) await cache.delete(req); // držať len posledné
  const url = `/local-pdf/${Date.now()}/${encodeURIComponent(name)}`;
  await cache.put(url, new Response(blob, {
    headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(name)}` },
  }));
  return url;
}

type C = EditorController;

function useCtl(ctl: C) {
  useSyncExternalStore(ctl.subscribe, ctl.getVersion);
  return ctl;
}

export function Editor() {
  const { id } = useParams();
  const [ctl] = useState(() => new EditorController(Number(id)));
  const viewer = useRef<HTMLElement>(null);
  const pages = useRef<HTMLDivElement>(null);
  const [error, setError] = useState('');
  const [settings, setSettings] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [pagesOpen, setPagesOpen] = useState(false);
  const [settingsUser, setSettingsUser] = useState(false);
  const [rubricOpen, setRubricOpen] = useState(true);
  const [panels, setPanels] = useState(loadPanels);
  const refit = useRef(0);
  // pri „na šírku“ prispôsob zoom novej šírke stredu (najviac raz za snímku)
  const onPanelResize = (p: Panels) => {
    setPanels(p);
    cancelAnimationFrame(refit.current);
    refit.current = requestAnimationFrame(() => { if (ctl.fit) ctl.applyZoom(); });
  };
  useCtl(ctl);

  useEffect(() => {
    const initial = Number((location.hash.match(/sol=(\d+)/) || [])[1]) || null;
    ctl.init(viewer.current!, pages.current!, initial).catch(e => setError((e as Error).message));
    const off = onOutboxSaved((sid, r, sent) => ctl.applySaved(sid, r, sent));
    return () => { off(); ctl.dispose(); };
  }, [ctl]);

  useEffect(() => { ctl.modalOpen = settings || historyOpen || settingsUser || pagesOpen; }, [ctl, settings, historyOpen, settingsUser, pagesOpen]);
  useEffect(() => { if (ctl.me) applyAccent(ctl.me.accent); }, [ctl.me]);
  useEffect(() => { if (ctl.task) document.title = `${ctl.task.name} – Opravovátor`; }, [ctl.task]);
  useEffect(() => { if (ctl.fit) setTimeout(() => ctl.applyZoom(), 0); }, [ctl, rubricOpen]);

  const [busy, setBusy] = useState<string | null>(null);
  const [canSync, setCanSync] = useState(false);
  const remote = (ctl.task as (typeof ctl.task & { remote?: LocalTask['remote'] }) | undefined)?.remote;
  useEffect(() => { if (ctl.local && remote) getSession().then(s => setCanSync(!!s.server)); }, [ctl.local, remote]);

  async function openResult() {
    if (!ctl.cur) return;
    await ctl.flushSave();
    const name = ctl.cur.pdf_name
      ? (ctl.cur.annotations.length ? commentedName(ctl.cur.pdf_name) : ctl.cur.pdf_name)
      : 'riesenie.pdf';
    if (!ctl.local) {
      window.open(`/api/solutions/${ctl.cur.id}/result/${encodeURIComponent(name)}?t=${Date.now()}`, '_blank');
      return;
    }
    const w = window.open('', '_blank');
    const blob = await localResult(ctl.cur.id);
    if (blob && w) w.location.href = await namedPdfUrl(blob, name);
  }

  // lokálna úloha: súbory sa vyrábajú v prehliadači
  async function localDownload(kind: 'zip' | 'csv') {
    await ctl.flushSave();
    try {
      if (kind === 'csv') downloadBlob(await localCsv(ctl.taskId), `${ctl.task.name} – body.csv`);
      else {
        setBusy('Balím zip…');
        downloadBlob(await localExportZip(ctl.taskId, (d, n) => setBusy(`Vypaľujem ${d}/${n}`)), `${ctl.task.root_folder || ctl.task.name}.zip`);
      }
    } catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  }

  async function sync() {
    await ctl.flushSave();
    try {
      const st = await syncTask(ctl.taskId, setBusy);
      await ctl.reloadTask();
      if (ctl.cur) await ctl.openSolution(ctl.cur.id);
      setBusy(`Synchronizované ↑${st.pushed} ↓${st.pulled}${st.merged ? ` · zlúčené ${st.merged}` : ''}`);
      setTimeout(() => setBusy(null), 3000);
    } catch (e) { setBusy(null); setError((e as Error).message); }
  }

  return (
    <div className="editor">
      <header className="top">
        <Brand title="Späť na úlohy" />
        <span className="taskname">{ctl.task?.name}</span>
        {ctl.local && <span className="where-chip" title={remote ? 'Úloha je v zariadení a prepojená so serverom' : 'Úloha je len v tomto zariadení'}>{remote ? 'V zariadení ⇄ server' : 'V zariadení'}</span>}
        <span className={'save-state ' + ctl.saveState.cls}>{ctl.saveState.text}</span>
        <NetStatus />
        <Presence ctl={ctl} />
        <span className="spacer" />
        <button className="btn" onClick={() => ctl.stepSolution(-1)} title="Predchádzajúce riešenie (Alt+↑)">‹ Predch.</button>
        <button className="btn" onClick={() => ctl.stepSolution(1)} title="Ďalšie riešenie (Alt+↓)">Ďalšie ›</button>
        <button className="btn" onClick={openResult} disabled={!ctl.cur} title="Otvorí meno.komentar.pdf presne tak, ako sa odovzdá">Výsledné PDF</button>
        <button className="btn" onClick={() => setHistoryOpen(true)} disabled={!ctl.cur}>História</button>
        <button className="btn" onClick={() => setPagesOpen(true)} disabled={!ctl.cur?.pdf_name || !!ctl.message}
          title="Pridať prázdnu stranu, otočiť naskenovanú stranu">Nastavenia strany</button>
        <button className="btn" onClick={() => setSettings(true)} disabled={!ctl.task}>Nastavenia úlohy</button>
        {ctl.local ? <>
          {busy && <span className="net sync">{busy}</span>}
          {remote && canSync && <button className="btn" onClick={sync} disabled={!!busy && busy.includes('/')}>Synchronizovať</button>}
          <button className="btn" onClick={() => localDownload('csv')}>CSV</button>
          <button className="btn" onClick={() => localDownload('zip')} disabled={!!busy}>Stiahnuť zip</button>
        </> : <>
          <a className="btn" href={`/api/tasks/${ctl.taskId}/points.csv`}>CSV</a>
          <a className="btn" href={`/api/tasks/${ctl.taskId}/download`} onClick={() => ctl.flushSave()}>Stiahnuť zip</a>
        </>}
        <ThemeButton />
        <button className="btn theme-btn settings-btn" onClick={() => setSettingsUser(true)} disabled={!ctl.me} title="Nastavenia" aria-label="Nastavenia"><GearIcon /></button>
      </header>

      <Toolbar ctl={ctl} />

      <div className="work" style={{ '--left-w': panels.left + 'px', '--right-w': panels.right + 'px' } as React.CSSProperties}>
        <SolutionList ctl={ctl} resizer={<Resizer side="left" panels={panels} onResize={onPanelResize} />} />
        {ctl.notice && <div className="notice" role="status">{ctl.notice}<button className="tool" onClick={() => ctl.dismissNotice()}>×</button></div>}
        <section className={'viewer t-' + ctl.tool} ref={viewer}>
          {(error || ctl.message) && <div className="loading">{error ? 'Chyba: ' + error : ctl.message}</div>}
          <div className="pages" ref={pages} />
        </section>
        <Rubric ctl={ctl} open={rubricOpen} onToggle={() => setRubricOpen(o => !o)}
          resizer={rubricOpen && <Resizer side="right" panels={panels} onResize={onPanelResize} />} />
      </div>

      {ctl.task && <TaskSettingsDialog ctl={ctl} open={settings} onClose={() => setSettings(false)} />}
      {historyOpen && ctl.cur && <HistoryDialog ctl={ctl} onClose={() => setHistoryOpen(false)} />}
      {pagesOpen && ctl.cur && <PagesDialog ctl={ctl} onClose={() => setPagesOpen(false)} />}
      {ctl.textSel && <TextSelMenu ctl={ctl} />}
      {settingsUser && ctl.me && <SettingsDialog open me={ctl.me} onClose={() => setSettingsUser(false)} onSaved={u => ctl.setMe(u)} />}
    </div>
  );
}

/** Kto iný je v úlohe; zvýrazní, ak má otvorené to isté riešenie. */
function Presence({ ctl }: { ctl: C }) {
  if (!ctl.others.length) return null;
  const here = ctl.others.filter(o => ctl.cur && o.sol_id === ctl.cur.id);
  if (here.length) {
    return <span className="presence same" title="Zmeny sa zlučujú automaticky, ale radšej sa dohodnite, kto opraví toto riešenie.">
      ● Toto riešenie má otvorené aj {here.map(o => o.name).join(', ')}
    </span>;
  }
  return <span className="presence" title="Ďalší ľudia v tejto úlohe">V úlohe aj: {ctl.others.map(o => o.name).join(', ')}</span>;
}

/* ================= šírka bočných panelov ================= */

interface Panels { left: number; right: number }
const PANELS_KEY = 'opravovator-panels';
const PANELS_DEFAULT: Panels = { left: 290, right: 300 };
const LIMITS = { left: [170, 640], right: [220, 640] } as const;

function loadPanels(): Panels {
  try { return { ...PANELS_DEFAULT, ...JSON.parse(localStorage.getItem(PANELS_KEY) || '{}') }; } catch { return PANELS_DEFAULT; }
}

/** Ťahateľná hrana panela; dvojklik vráti predvolenú šírku. */
function Resizer({ side, panels, onResize }: { side: 'left' | 'right'; panels: Panels; onResize: (p: Panels) => void }) {
  const [active, setActive] = useState(false);
  const clamp = (w: number) => Math.round(Math.max(LIMITS[side][0], Math.min(LIMITS[side][1], w)));
  const save = (p: Panels) => { try { localStorage.setItem(PANELS_KEY, JSON.stringify(p)); } catch { /* */ } };

  function down(e: React.PointerEvent<HTMLDivElement>) {
    if (e.button !== 0) return;
    e.preventDefault();
    const el = e.currentTarget, startX = e.clientX, startW = panels[side];
    let last = panels;
    el.setPointerCapture(e.pointerId);
    setActive(true);
    document.body.classList.add('resizing');
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      last = { ...panels, [side]: clamp(side === 'left' ? startW + dx : startW - dx) };
      onResize(last);
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      setActive(false);
      document.body.classList.remove('resizing');
      save(last);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  }

  return <div className={'resizer' + (active ? ' active' : '')} role="separator" aria-orientation="vertical"
    title="Ťahaním zmeníš šírku, dvojklikom vrátiš pôvodnú" onPointerDown={down}
    onDoubleClick={() => { const p = { ...panels, [side]: PANELS_DEFAULT[side] }; onResize(p); save(p); }} />;
}

/* ================= panel nástrojov ================= */

const I = {
  select: <path d="M5 3l14 8-6 2-3 6z" />,
  text: <path d="M5 5h14M12 5v14M9 19h6" />,
  arrow: <path d="M5 19L19 5M10 5h9v9" />,
  line: <path d="M5 19L19 5" />,
  rect: <rect x="4" y="6" width="16" height="12" rx="1" />,
  ellipse: <ellipse cx="12" cy="12" rx="8" ry="6" />,
  highlight: <><path d="M14.5 4.5l5 5-8 8H6.5v-5z" /><path d="M4 20h7" strokeWidth="3" /></>,
  underline: <><path d="M7 4v6a5 5 0 0010 0V4" /><path d="M5 20h14" /></>,
  image: <><rect x="3" y="5" width="18" height="14" rx="1" /><path d="M3 16l5-5 4 4 3-3 6 6" /><circle cx="16" cy="9" r="1.5" /></>,
  stamp: <path d="M7 4h4a3 3 0 010 6H7zM7 10h5a3.5 3.5 0 010 7H7zM7 4v16" />,
  undo: <path d="M9 7L4 12l5 5M4 12h11a5 5 0 010 10h-2" />,
  redo: <path d="M15 7l5 5-5 5M20 12H9a5 5 0 000 10h2" />,
  del: <path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13" />,
  fit: <path d="M4 12h16M4 12l3-3M4 12l3 3M20 12l-3-3M20 12l-3 3" />,
};
const Svg = ({ children }: { children: React.ReactNode }) => <svg viewBox="0 0 24 24">{children}</svg>;

const TOOLS: [Tool, string][] = [
  ['select', 'Výber a presun (V)'], ['text', 'Text (T)'], ['arrow', 'Šípka (A)'], ['line', 'Čiara (L)'],
  ['rect', 'Obdĺžnik (R)'], ['ellipse', 'Elipsa (E)'],
  ['highlight', 'Zvýrazňovač (H) – označ text v PDF, alebo natiahni obdĺžnik (sken)'], ['underline', 'Podčiarknuť (U) – označ text v PDF, alebo natiahni čiaru'],
  ['image', 'Obrázok / podpis (I)'], ['stamp', 'Vložiť body do PDF (B)'],
];

/** Farba témy (predvolená), pevné farby a vlastná farba uložená v profile. */
function Swatches({ ctl, color }: { ctl: C; color: string }) {
  const hl = ctl.isHighlighting();
  const theme = hl ? HL_SWATCHES[0] : ctl.themeColor();
  const cur = (color || theme).toLowerCase();
  const mine = ctl.me?.pen_color || null;
  return (
    <div className="swatches">
      <button className={'swatch theme' + (cur === theme ? ' on' : '')} style={{ background: theme }}
        title={hl ? 'Žltý zvýrazňovač (predvolený)' : 'Farba témy (predvolená)'} onClick={() => ctl.applyStyle('color', '')} />
      <span className="swatch-sep" />
      {(hl ? HL_SWATCHES.slice(1) : SWATCHES).filter(c => c !== theme).map(c => (
        <button key={c} className={'swatch' + (cur === c ? ' on' : '')} style={{ background: c }} title={c}
          onClick={() => ctl.applyStyle('color', c)} />
      ))}
      <span className="swatch-sep" />
      <label className={'swatch custom' + (mine ? '' : ' empty') + (mine && cur === mine ? ' on' : '')}
        style={mine ? { background: mine } : undefined}
        title={mine ? `Moja farba (${mine}) – klikni na zmenu` : 'Moja farba – vyber si ju, uloží sa do profilu'}
        onClick={() => { if (mine) ctl.applyStyle('color', mine); }}>
        {!mine && '+'}
        <input type="color" value={mine || cur} onChange={e => ctl.setPenColor(e.target.value)} tabIndex={-1} />
      </label>
    </div>
  );
}

function Toolbar({ ctl }: { ctl: C }) {
  const s = ctl.shownStyle();
  return (
    <div className="toolbar">
      {TOOLS.map(([t, title]) => (
        <button key={t} className={'tool' + (ctl.tool === t ? ' on' : '')} title={title} data-tool={t}
          onClick={() => { ctl.setTool(t); if (t === 'image') ctl.setImageMenu(!ctl.imageMenu); }}>
          <Svg>{I[t]}</Svg>
        </button>
      ))}
      {ctl.imageMenu && <ImageMenu ctl={ctl} />}
      <span className="sep" />
      <span className="lbl">Písmo</span>
      <select value={s.font} onChange={e => ctl.applyStyle('font', e.target.value)} title="Typ písma">
        {FONTS.map(f => <option key={f.id} value={f.id} style={{ fontFamily: fontFamily(f.id) }}>{f.label}</option>)}
      </select>
      <NumberInput value={s.size} min={4} max={400} step={1} title="Veľkosť písma" onChange={v => ctl.applyStyle('size', v)} />
      {(ctl.selectedType() === 'text' || (!ctl.selected && ctl.tool === 'text')) &&
        <button className={'tool' + (s.underline ? ' on' : '')} title="Podčiarknutý text" aria-pressed={s.underline}
          onClick={() => ctl.applyStyle('underline', !s.underline)}><Svg>{I.underline}</Svg></button>}
      {ctl.selectedType() === 'stamp' && <StampControls ctl={ctl} />}
      {!['stamp', 'text', 'image', 'highlight'].includes(ctl.selectedType() || '') && ctl.tool !== 'highlight' && <>
        <span className="sep" />
        <span className="lbl">Hrúbka</span>
        <NumberInput value={s.width} min={0.5} max={40} step={0.5} title="Hrúbka čiary" onChange={v => ctl.applyStyle('width', v)} />
      </>}
      {(['rect', 'ellipse'].includes(ctl.selectedType() || '') || (!ctl.selected && (ctl.tool === 'rect' || ctl.tool === 'ellipse'))) &&
        <FillControls ctl={ctl} fill={s.fill} opacity={s.fillOpacity} />}
      <span className="sep" />
      <Swatches ctl={ctl} color={s.color} />
      <span className="sep" />
      <button className="tool" disabled={!ctl.canUndo} onClick={() => ctl.undo()} title="Späť (Ctrl+Z)"><Svg>{I.undo}</Svg></button>
      <button className="tool" disabled={!ctl.canRedo} onClick={() => ctl.redo()} title="Znova (Ctrl+Y)"><Svg>{I.redo}</Svg></button>
      <button className="tool" disabled={!ctl.selected} onClick={() => ctl.deleteSelected()} title="Zmazať označené (Delete)"><Svg>{I.del}</Svg></button>
      <span className="sep" />
      <button className="tool" onClick={() => ctl.zoomBy(1 / 1.2)} title="Oddialiť">−</button>
      <span className="zoomval">{Math.round(ctl.zoom * 100)}%</span>
      <button className="tool" onClick={() => ctl.zoomBy(1.2)} title="Priblížiť">+</button>
      <button className={'tool' + (ctl.fit ? ' on' : '')} onClick={() => ctl.zoomFit()} title="Na šírku"><Svg>{I.fit}</Svg></button>
    </div>
  );
}

/** Podpis na označenej pečiatke: prezývka a jej písmo. */
function StampControls({ ctl }: { ctl: C }) {
  const a = ctl.selectedAnn();
  const [name, setName] = useState(a?.type === 'stamp' ? a.name || '' : '');
  useEffect(() => { if (a?.type === 'stamp') setName(a.name || ''); }, [a?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!a || a.type !== 'stamp') return null;
  const commit = () => ctl.updateStamp({ name: name.trim() });
  const pos = <>
    <select value={a.sigPos || 'below'} title="Poloha podpisu voči bodom"
      onChange={e => ctl.updateStamp({ sigPos: e.target.value === 'below' ? undefined : e.target.value as SigPos })}>
      {SIG_POSITIONS.map(([p, label]) => <option key={p} value={p}>Podpis: {label.toLowerCase()}</option>)}
    </select>
    <button className="tool" title="Podpis podľa nastavení (profil, podpisy zdieľanej úlohy)" onClick={() => ctl.refreshStampSignature()}>↻</button>
  </>;
  if (a.sigs) return <>
    <span className="sep" />
    <span className="lbl" title={a.sigs.map(x => x.name || 'obrázok').join(', ')}>Podpisy: {a.sigs.length}</span>
    {pos}
  </>;
  if (a.assetId) return <>
    <span className="sep" />
    <span className="lbl">Podpis: obrázok</span>
    <NumberInput value={Math.round((a.imgScale || 1) * 100)} min={STAMP_IMAGE_SCALE.min * 100} max={STAMP_IMAGE_SCALE.max * 100} step={10}
      title="Veľkosť podpisu v %" onChange={v => ctl.updateStamp({ imgScale: v / 100 })} />
    <span className="lbl">%</span>
    <button className="btn" title="Nahradiť obrázok textovým podpisom"
      onClick={() => ctl.updateStamp({ assetId: undefined, ratio: undefined, name: ctl.me.stamp_name || ctl.me.name })}>Zmeniť na text</button>
    {pos}
  </>;
  return <>
    <span className="sep" />
    <span className="lbl">Podpis</span>
    <input className="sig" value={name} placeholder="bez podpisu" title="Prezývka pod bodmi"
      onChange={e => setName(e.target.value)} onBlur={commit}
      onKeyDown={e => { if (e.key === 'Enter') { commit(); (e.target as HTMLInputElement).blur(); } }} />
    <select value={a.nameFont || ''} title="Písmo podpisu" onChange={e => ctl.updateStamp({ nameFont: e.target.value || undefined })}>
      <option value="">písmo ako body</option>
      {FONTS.map(f => <option key={f.id} value={f.id} style={{ fontFamily: fontFamily(f.id) }}>{f.label}</option>)}
    </select>
    {pos}
  </>;
}

/** Výplň obdĺžnika / elipsy: farba (alebo bez) a krytie. */
function FillControls({ ctl, fill, opacity }: { ctl: C; fill: string; opacity: number }) {
  const colors = [ctl.themeColor(), '#e5231b', '#1f6feb', '#138a36', '#ffd400', '#000000', '#ffffff'].filter((c, i, l) => l.indexOf(c) === i);
  const custom = !!fill && !colors.some(c => c.toLowerCase() === fill.toLowerCase());
  return <>
    <span className="sep" />
    <span className="lbl">Výplň</span>
    <div className="swatches fill">
      <button className={'swatch none' + (!fill ? ' on' : '')} title="Bez výplne" onClick={() => ctl.applyStyle('fill', '')} />
      {colors.map(c => (
        <button key={c} className={'swatch' + (fill.toLowerCase() === c.toLowerCase() ? ' on' : '')} style={{ background: c }} title={c}
          onClick={() => ctl.applyStyle('fill', c)} />
      ))}
      {/* vlastná farba – rovnako ako vlastná farba pera */}
      <span className="swatch-sep" />
      <label className={'swatch custom' + (custom ? ' on' : ' empty')} style={custom ? { background: fill } : undefined}
        title={custom ? `Vlastná výplň (${fill}) – klikni na zmenu` : 'Vlastná farba výplne'}>
        {!custom && '+'}
        <input type="color" value={custom ? fill : '#ffd400'} onChange={e => ctl.applyStyle('fill', e.target.value)} tabIndex={-1} />
      </label>
    </div>
    <input type="range" className="opacity" min={5} max={100} step={5} value={Math.round(opacity * 100)} disabled={!fill}
      title={`Krytie výplne ${Math.round(opacity * 100)} %`} aria-label="Krytie výplne"
      onChange={e => ctl.applyStyle('fillOpacity', Number(e.target.value) / 100)} />
    <span className="lbl opacity-val">{Math.round(opacity * 100)} %</span>
  </>;
}

/** Číselné pole, ktoré sa potvrdí až po dopísaní (Enter / opustenie). */
function NumberInput({ value, min, max, step, title, onChange }: {
  value: number; min: number; max: number; step: number; title: string; onChange: (v: number) => void;
}) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const commit = () => {
    const v = Math.max(min, Math.min(max, Number(text) || value));
    setText(String(v));
    if (v !== value) onChange(v);
  };
  return <input type="number" min={min} max={max} step={step} title={title} value={text}
    onChange={e => setText(e.target.value)} onBlur={commit}
    onKeyDown={e => { if (e.key === 'Enter') commit(); }}
    onMouseUp={() => setTimeout(commit, 0)} />;
}

function ImageMenu({ ctl }: { ctl: C }) {
  const ref = useRef<HTMLDivElement>(null);
  const fileIn = useRef<HTMLInputElement>(null);
  const [removeBg, setRemoveBg] = useState(true);
  const [busy, setBusy] = useState(false);
  const [crop, setCrop] = useState<{ blob: Blob; name: string } | null>(null);
  const [ask, confirmNode] = useConfirm();

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const t = e.target as Element;
      if (ref.current?.contains(t) || t.closest('[data-tool="image"]') || t.closest('svg.ov')) return;
      ctl.setImageMenu(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [ctl]);

  return (
    <div className="menu" ref={ref}>
      <strong>Obrázky a podpisy</strong>
      {/* potvrdenie je vnútri menu, aby klik doň menu nezavrel */}
      {confirmNode}
      <div className="imgs">
        {ctl.assets.map(a => (
          <button key={a.id} className={ctl.imageAsset?.id === a.id ? 'on' : ''} title={a.name} onClick={() => ctl.chooseAsset(a.id)}>
            <img src={ctl.assetHref(a.id) || undefined} alt={a.name} />
            <span className="del" title="Zmazať z knižnice" onClick={async e => {
              e.stopPropagation();
              if (await ask({
                title: 'Zmazať obrázok z knižnice?',
                body: <p>Obrázok <b>{a.name}</b> zmizne z knižnice. V už urobených opravách zostane.</p>,
                ok: 'Zmazať', danger: true,
              })) ctl.deleteAsset(a.id);
            }}>×</span>
          </button>
        ))}
      </div>
      <label className="hint check"><input type="checkbox" checked={removeBg} onChange={e => setRemoveBg(e.target.checked)} />Pri nahratí odstrániť biele pozadie</label>
      <button className="btn full" disabled={busy} onClick={() => fileIn.current?.click()}>{busy ? 'Nahrávam…' : 'Nahrať obrázok'}</button>
      <input ref={fileIn} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={async e => {
        const f = e.target.files?.[0];
        e.target.value = '';
        if (!f) return;
        setBusy(true);
        try { setCrop({ blob: await prepareImage(f, removeBg), name: f.name }); } catch (err) { alert((err as Error).message); } finally { setBusy(false); }
      }} />
      {crop && <ImageCropDialog blob={crop.blob} onCancel={() => setCrop(null)} onDone={async b => {
        const name = crop.name;
        setCrop(null); setBusy(true);
        try { await ctl.uploadAsset(b, name); } catch (err) { alert((err as Error).message); } finally { setBusy(false); }
      }} />}
    </div>
  );
}

/* ================= zoznam riešení ================= */

const ROCNIK_ORDER = ['5', '6', '7', '8', '9', 'Pri', 'Sek', 'Ter', 'Kva'];

function SolutionList({ ctl, resizer }: { ctl: C; resizer: React.ReactNode }) {
  const [thumbs, setThumbs] = useState(() => localStorage.getItem('opravovator-thumbs') !== '0');
  const [adding, setAdding] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const curId = ctl.cur?.id;

  useEffect(() => {
    listRef.current?.querySelector('.sol.on')?.scrollIntoView({ block: 'nearest' });
  }, [curId]);

  const vals = [...new Set(ctl.sols.map(s => s.rocnik).filter(Boolean))];
  vals.sort((a, b) => (ROCNIK_ORDER.indexOf(a) + 1 || 99) - (ROCNIK_ORDER.indexOf(b) + 1 || 99) || a.localeCompare(b, 'sk', { numeric: true }));
  const visible = ctl.task ? ctl.visibleSols() : [];

  async function editRocnik(s: SolutionListItem) {
    const v = prompt(`Ročník pre ${s.display_name}:`, s.rocnik || '');
    if (v !== null) await ctl.editRocnik(s, v);
  }

  return (
    <aside className="side">
      {resizer}
      <div className="search">
        <input className="input" placeholder="Hľadať v riešeniach" value={ctl.filter.q} onChange={e => ctl.setFilter({ q: e.target.value })} />
        <div className="chips">
          {vals.length > 1 && <>
            <button className={'chip' + (ctl.filter.rocnik === null ? ' on' : '')} onClick={() => ctl.setFilter({ rocnik: null })}>Všetky</button>
            {vals.map(v => (
              <button key={v} className={'chip' + (ctl.filter.rocnik === v ? ' on' : '')} onClick={() => ctl.setFilter({ rocnik: v })}>
                {v} ({ctl.sols.filter(s => s.rocnik === v).length})
              </button>
            ))}
          </>}
          <label className="chip toggle" title="Zobraziť náhľady prvej strany">
            <input type="checkbox" checked={thumbs} onChange={e => { setThumbs(e.target.checked); localStorage.setItem('opravovator-thumbs', e.target.checked ? '1' : '0'); }} />
            Náhľady
          </label>
        </div>
      </div>
      <div className={'sols' + (thumbs ? ' with-thumbs' : '')} ref={listRef}>
        {visible.map(s => {
          const graded = s.points !== null && s.points !== undefined;
          return (
            <div key={s.id} className={'sol' + (curId === s.id ? ' on' : '')} onClick={() => ctl.openSolution(s.id)}>
              {thumbs && (
                <span className="thumb">
                  {s.pdf_name && (ctl.local
                    ? <LocalThumb id={s.id} v={s.annotated ? s.rev : 0} />
                    : <img loading="lazy" alt="" src={`/api/solutions/${s.id}/thumb?v=${s.annotated ? s.rev : 0}`}
                      onError={e => { (e.target as HTMLImageElement).style.visibility = 'hidden'; }} />)}
                </span>
              )}
              <span className="n">{s.idx}</span>
              <span className="who" title={s.folder}>{s.display_name}</span>
              <span className="score">
                <span className={'pts' + (graded ? ' done' : '')}>{graded ? formatPoints(s.points) + 'B' : '?B'}</span>
                <span className="bias" title="Interné body: Správnosť, Úsilie, AI a podvádzanie">
                  {normBias(s.bias).map((v, i) => (
                    <span key={i} className={'b-' + BIAS_LABELS[i].key.toLowerCase() + (v === DEFAULT_BIAS[i] ? ' base' : '')}>{BIAS_LABELS[i].key}: {formatPoints(v)}</span>
                  ))}
                </span>
              </span>
              <span className="sub">
                <span className="badge edit" title="Ročník – dvojklikom zmeníš" onDoubleClick={e => { e.stopPropagation(); editRocnik(s); }}>{s.rocnik || '—'}</span>
                {ctl.others.filter(o => o.sol_id === s.id).map(o => (
                  <span key={o.user_id} className="viewer-chip" title={`${o.name} má toto riešenie práve otvorené`}>● {o.name}</span>
                ))}
              </span>
              <span className="flags">
                <Flag ok={s.commented} label="komentár" title={s.commented ? 'V PDF je oprava / komentár' : 'V PDF zatiaľ nie je žiadna oprava'} />
                <Flag ok={s.stamped && graded} label="body"
                  title={s.stamped && graded ? 'Body sú vložené do PDF' : !graded ? 'Riešenie ešte nemá body' : 'Body nie sú vložené do PDF (pečiatka)'} />
              </span>
            </div>
          );
        })}
        {ctl.task && (
          <div className={'sol add' + (ctl.linkedLocal ? ' disabled' : '')} role="button" tabIndex={0}
            title={ctl.linkedLocal ? 'Úloha je prepojená so serverom – riešenia pridaj na serveri a potom synchronizuj' : 'Pridať riešenia, ktoré prišli dodatočne (zip)'}
            onClick={() => { if (!ctl.linkedLocal) setAdding(true); }}
            onKeyDown={e => { if (e.key === 'Enter' && !ctl.linkedLocal) setAdding(true); }}>
            <span className={thumbs ? 'thumb add-thumb' : 'add-plus'} aria-hidden>+</span>
            {thumbs && <span className="n" />}
            <span className="who">Pridať riešenia</span>
            <span className="sub">dodatočné riešenia zo zipu</span>
          </div>
        )}
      </div>
      {adding && <AddSolutionsDialog ctl={ctl} onClose={() => setAdding(false)} />}
    </aside>
  );
}

/** Dodatočné riešenia: zip sa porovná s úlohou podľa ID riešiteľa, pribudnú len nové. */
function AddSolutionsDialog({ ctl, onClose }: { ctl: C; onClose: () => void }) {
  const fileIn = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [result, setResult] = useState<Awaited<ReturnType<C['addSolutions']>> | null>(null);
  const [over, setOver] = useState(false);

  async function upload(f: File) {
    setError(''); setResult(null); setBusy('Spracúvam zip…');
    try { setResult(await ctl.addSolutions(f, setBusy)); } catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  }

  return (
    <Dialog open onClose={() => { if (!busy) onClose(); }} title="Pridať dodatočné riešenia" wide>
      <p>Nahraj zip z hromadného opravovania – pokojne <b>celé nové hromadné opravovanie</b> (aj s riešeniami, ktoré už tu sú),
        alebo len zip s novými priečinkami.</p>
      <ul className="hint add-rules">
        <li>Riešenia sa porovnajú podľa <b>ID riešiteľa</b> (číslo na konci priečinka, napr. …-tomas-lang-<b>1032</b>), nie podľa poradia.</li>
        <li>Riešenia, ktoré už v úlohe sú, ostanú presne tak, ako sú – aj s opravami, bodmi a históriou. Pribudnú len nové.</li>
        <li>Poradie sa zoradí podľa ID (menšie ID skôr) a pri exporte budú mať priečinky správne poradové čísla.</li>
      </ul>
      {!result && (
        <div className={'dropzone' + (over ? ' over' : '')}
          onDragOver={e => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
          onDrop={e => { e.preventDefault(); setOver(false); const f = e.dataTransfer.files[0]; if (f && !busy) upload(f); }}>
          <button className="btn primary" disabled={!!busy} onClick={() => fileIn.current?.click()}>{busy || 'Vybrať zip'}</button>
          <p className="drop-hint muted">alebo sem zip potiahni myšou</p>
          <input ref={fileIn} type="file" accept=".zip,application/zip" hidden onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) upload(f); }} />
        </div>
      )}
      {result && (
        <div className="add-result">
          {result.added.length
            ? <p className="okc"><b>Pridané: {result.added.length}</b> – {result.added.join(', ')}</p>
            : <p><b>Žiadne nové riešenie</b> – všetky riešenia zo zipu už v úlohe sú.</p>}
          <p className="muted">Ponechané bez zmeny (už boli v úlohe): {result.kept}</p>
          {result.changedPdf.length > 0 && <p className="warnc">V novom zipe je iné PDF pri: {result.changedPdf.join(', ')}. Ponechal som pôvodné
            (opravy sú urobené naň). Ak treba nové, skontroluj to v hromadnom opravovaní.</p>}
        </div>
      )}
      <p className="error">{error}</p>
      <div className="row">
        {result && <button className="btn" onClick={() => setResult(null)}>Pridať ďalší zip</button>}
        <button className="btn primary" disabled={!!busy} onClick={onClose}>{result ? 'Hotovo' : 'Zavrieť'}</button>
      </div>
    </Dialog>
  );
}

/** Miniatúra lokálneho riešenia – vyrobí sa v prehliadači, až keď je v zozname vidieť. */
function LocalThumb({ id, v }: { id: number; v: number }) {
  const ref = useRef<HTMLImageElement>(null);
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let url: string | null = null, alive = true;
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(([en]) => {
      if (!en.isIntersecting) return;
      io.disconnect();
      localThumb(id).then(b => { if (b && alive) { url = URL.createObjectURL(b); setSrc(url); } }).catch(() => {});
    });
    io.observe(el);
    return () => { alive = false; io.disconnect(); if (url) URL.revokeObjectURL(url); };
  }, [id, v]);
  return <img ref={ref} alt="" src={src || undefined} style={src ? undefined : { visibility: 'hidden' }} />;
}

function Flag({ ok, label, title }: { ok: boolean; label: string; title: string }) {
  return <span className={'flag ' + (ok ? 'yes' : 'no')} title={title}>{label}: {ok ? '✓' : '✗'}</span>;
}

/* ================= bodovanie ================= */

const rid = () => Math.random().toString(36).slice(2, 10);

function Rubric({ ctl, open, onToggle, resizer }: { ctl: C; open: boolean; onToggle: () => void; resizer: React.ReactNode }) {
  const [draft, setDraft] = useState<(Omit<RubricItem, 'points'> & { points: string })[] | null>(null);
  const cur = ctl.cur, task = ctl.task;
  const has = cur && cur.points !== null && cur.points !== undefined;

  async function saveRubric() {
    const rubric = draft!.filter(i => i.label.trim() || Number(i.points))
      .map(i => ({ id: i.id, label: i.label.trim(), points: Number(i.points) || 0 }));
    await ctl.saveTask({ rubric });
    setDraft(null);
  }

  return (
    <aside className={'rubric' + (open ? '' : ' closed')}>
      {resizer}
      <div className="rb-head">
        <button className="tool" onClick={onToggle} title="Skryť/zobraziť bodovanie">⇥</button>
        <h3>Bodovanie</h3>
      </div>
      {open && task && <div className="rb-body">
        <div className="total">
          <span className={'big' + (has ? '' : ' none')}>{has ? formatPoints(cur!.points) + 'B' : '–'}</span>
          <span className="of">{task.max_points !== null ? `z ${formatPoints(task.max_points)}` : ''}</span>
          {has && round2(cur!.points!) !== exportPoints(cur!.points!) &&
            <span className="export-pts" title="Do body.txt, CSV aj do PDF idú body ako celé číslo (zaokrúhlené, 0,5 nahor)">→ {exportPoints(cur!.points!)}B v exporte</span>}
        </div>
        <div className="seg narrow rb-mode" role="radiogroup" aria-label="Spôsob bodovania">
          {([['checks', 'Zaškrtávanie'], ['range', 'Intervaly']] as const).map(([m, label]) => (
            <button key={m} type="button" role="radio" aria-checked={task.rubric_mode === m} className={task.rubric_mode === m ? 'on' : ''} disabled={!!draft}
              title={m === 'range' ? 'Každá položka má interval 0 až jej body, ťahá sa posuvníkom' : 'Položky sa zaškrtávajú (body sa sčítajú)'}
              onClick={() => { if (task.rubric_mode !== m) ctl.saveTask({ rubric_mode: m }).catch(e => alert((e as Error).message)); }}>{label}</button>
          ))}
        </div>
        <div className="manual">
          <span>Body ručne</span>
          <input className="input" type="number" step="0.5" placeholder="auto" disabled={!cur}
            value={cur?.manual_points ?? ''} onChange={e => ctl.setManual(e.target.value === '' ? null : Number(e.target.value))} />
        </div>
        {draft ? (
          <ul className="items editing">
            {draft.map((it, i) => (
              <li key={it.id}>
                <input type="number" step="0.5" value={it.points} title={task.rubric_mode === 'range' ? 'Maximum (interval 0 až toto číslo)' : 'Body (záporné = strhnutie)'}
                  onChange={e => setDraft(d => d!.map((x, j) => j === i ? { ...x, points: e.target.value } : x))} />
                <input value={it.label} placeholder="Za čo" autoFocus={!it.label}
                  onChange={e => setDraft(d => d!.map((x, j) => j === i ? { ...x, label: e.target.value } : x))} />
                <button className="tool" title="Odstrániť" onClick={() => setDraft(d => d!.filter((_, j) => j !== i))}>×</button>
              </li>
            ))}
            <li><button className="btn span3" onClick={() => setDraft(d => [...d!, { id: rid(), label: '', points: '1' }])}>+ Pridať položku</button></li>
            <li><button className="btn span3" onClick={() => setDraft(null)}>Zrušiť úpravy</button></li>
          </ul>
        ) : task.rubric_mode === 'range' ? (
          <ul className="items range">
            {task.rubric.map((it, i) => {
              const [lo, hi] = rangeOf(it);
              const v = cur?.scores[it.id];
              const set = (x: number) => ctl.setScore(it.id, x);
              return (
                <li key={it.id}>
                  <div className="range-head">
                    <span className="key">{i < 9 ? i + 1 : ''}</span>
                    <span className="range-label">{it.label || '(bez popisu)'}</span>
                    <span className={'pbadge' + (v === undefined ? ' unset' : '') + (lo < 0 ? ' neg' : '')}>
                      {v === undefined ? '–' : formatPoints(v)} / {formatPoints(lo < 0 ? lo : hi)}
                    </span>
                    {v !== undefined && <button className="tool clear" title="Nehodnotiť túto položku" onClick={() => ctl.setScore(it.id, null)}>×</button>}
                  </div>
                  <input type="range" min={lo} max={hi} step={0.5} value={v ?? (lo < 0 ? 0 : lo)} disabled={!cur}
                    className={v === undefined ? 'unset' : ''} aria-label={it.label}
                    onChange={e => set(Number(e.target.value))}
                    onPointerUp={e => { if (v === undefined) set(Number(e.currentTarget.value)); }} />
                </li>
              );
            })}
          </ul>
        ) : (
          <ul className="items">
            {task.rubric.map((it, i) => {
              const p = Number(it.points);
              return (
                <li key={it.id}>
                  <label>
                    <input type="checkbox" checked={!!cur?.checks.includes(it.id)} disabled={!cur} onChange={e => ctl.toggleItem(it.id, e.target.checked)} />
                    <span className="key">{i < 9 ? i + 1 : ''}</span>
                    <span>{it.label || '(bez popisu)'}</span>
                  </label>
                  <span className={'pbadge' + (p < 0 ? ' neg' : '')}>{(p > 0 ? '+' : '') + formatPoints(p)}</span>
                </li>
              );
            })}
          </ul>
        )}
        <div className="rb-actions">
          {draft
            ? <button className="btn primary" onClick={saveRubric}>Uložiť bodovanie</button>
            : <button className="btn" onClick={() => setDraft(task.rubric.map(r => ({ ...r, points: String(r.points) })))}>Upraviť bodovanie</button>}
          <button className="btn danger" onClick={() => ctl.clearGrade()} disabled={!cur}>Zrušiť hodnotenie</button>
        </div>
        <div className="rb-actions">
          <button className="btn primary" onClick={() => ctl.setTool('stamp')}>Vložiť body do PDF</button>
        </div>
        <InternalGrading ctl={ctl} />
        {cur && <p className="hint">
          {cur.folder}{cur.student_id ? ` · ID ${cur.student_id}` : ''}
          {cur.updated_by && <><br />Naposledy upravil(a) {cur.updated_by}, {formatDate(cur.updated_at)}</>}
        </p>}
      </div>}
    </aside>
  );
}

/** Interné body a komentár – len pre vedúcich, uložia sa do bias.txt / bias_komentar.txt, nie do PDF. */
function InternalGrading({ ctl }: { ctl: C }) {
  const cur = ctl.cur;
  const bias = cur ? normBias(cur.bias) : DEFAULT_BIAS;
  return (
    <section className="internal">
      <h4>Interné bodovanie</h4>
      {BIAS_LABELS.map((b, i) => (
        <div key={b.key} className="bias-row">
          <span className="bias-label">{b.label} <span className={'bias-key b-' + b.key.toLowerCase() + (bias[i] === DEFAULT_BIAS[i] ? ' base' : '')}>({b.key})</span></span>
          <BiasInput value={bias[i]} base={DEFAULT_BIAS[i]} disabled={!cur} label={b.label} onChange={v => ctl.setBias(i, v)} />
        </div>
      ))}
      <label className="bias-comment">
        <span>Interný komentár <span className="muted">(nepovinný)</span></span>
        <textarea className="input" disabled={!cur}
          value={cur?.bias_comment ?? ''} onChange={e => ctl.setBiasComment(e.target.value)} />
      </label>
    </section>
  );
}

/** Číslo so šípkami hore / dole; nad odporúčaným maximom sa zvýrazní, ale dá sa zadať. */
function BiasInput({ value, base, disabled, label, onChange }: {
  value: number; base: number; disabled: boolean; label: string; onChange: (v: number) => void;
}) {
  const [text, setText] = useState(formatPoints(value));
  useEffect(() => setText(formatPoints(value)), [value]);
  const over = value > BIAS_SOFT_MAX;
  return (
    <span className={'bias-input' + (over ? ' over' : '') + (value === base ? ' base' : '')}
      title={over ? `Nad odporúčaným maximom ${BIAS_SOFT_MAX}` : `Predvolené: ${base}, odporúčané maximum: ${BIAS_SOFT_MAX}`}>
      <button className="tool" disabled={disabled || value <= 0} aria-label={`${label} −1`} onClick={() => onChange(value - 1)}>▼</button>
      <input type="number" step="1" min="0" disabled={disabled} value={text} aria-label={label}
        onChange={e => { setText(e.target.value); if (e.target.value.trim() !== '') onChange(Number(e.target.value)); }}
        onBlur={() => setText(formatPoints(value))} />
      <button className="tool" disabled={disabled} aria-label={`${label} +1`} onClick={() => onChange(value + 1)}>▲</button>
    </span>
  );
}

/* ================= dialógy ================= */

function TaskSettingsDialog({ ctl, open, onClose }: { ctl: C; open: boolean; onClose: () => void }) {
  const t = ctl.task;
  const [error, setError] = useState('');
  const [signers, setSigners] = useState<number[]>(t.signers);
  useEffect(() => { if (open) { setSigners(ctl.task.signers); void ctl.loadSigners(); } }, [open, ctl]);
  async function save(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const max = String(f.get('max_points') || '');
    try {
      await ctl.saveTask({
        name: String(f.get('name')), max_points: max === '' ? null : Number(max), comment_text: String(f.get('comment_text')),
        ...(ctl.shared ? { signers } : {}),
      });
      onClose();
    } catch (err) { setError((err as Error).message); }
  }
  return (
    <Dialog open={open} onClose={onClose} title="Nastavenia úlohy">
      <form onSubmit={save} key={String(open)}>
        <label className="field"><span>Názov úlohy</span><input className="input" name="name" defaultValue={t.name} required /></label>
        <label className="field"><span>Maximum bodov</span><input className="input" name="max_points" type="number" step="0.5" min="0" defaultValue={t.max_points ?? ''} /></label>
        <label className="field"><span>Komentár</span><textarea className="input" name="comment_text" defaultValue={t.comment_text} /></label>
        {ctl.shared && <SignersField ctl={ctl} value={signers} onChange={setSigners} />}
        <p className="error">{error}</p>
        <div className="row"><button type="button" className="btn" onClick={onClose}>Zrušiť</button><button className="btn primary">Uložiť</button></div>
      </form>
    </Dialog>
  );
}

/** Zdieľaná úloha: čie podpisy idú pod body (vedľa seba, každý podľa nastavení daného človeka). */
function SignersField({ ctl, value, onChange }: { ctl: C; value: number[]; onChange: (v: number[]) => void }) {
  const toggle = (id: number, on: boolean) => {
    const set = new Set(on ? [...value, id] : value.filter(x => x !== id));
    onChange(ctl.signers.map(x => x.id).filter(x => set.has(x)));
  };
  return (
    <div className="field signers"><span>Podpisy pod bodmi (zdieľaná úloha)</span>
      {!ctl.signers.length && <p className="hint">Načítavam…</p>}
      <ul>
        {ctl.signers.map(x => (
          <li key={x.id}>
            <label className="check">
              <input type="checkbox" checked={value.includes(x.id)} onChange={e => toggle(x.id, e.target.checked)} />
              <span className="who">{x.name}{x.id === ctl.me.id ? ' (ja)' : ''}</span>
              {x.sig.assetId
                ? <img src={ctl.assetHref(x.sig.assetId) || undefined} alt="podpis" className="sig-thumb" />
                : <span className="sig-text" style={{ fontFamily: fontFamily(x.sig.nameFont || 'bebas'), color: x.sig.color || undefined }}>{x.sig.name}</span>}
            </label>
          </li>
        ))}
      </ul>
      <p className="hint">Nič nevybraté = len podpis toho, kto vkladá body (ako doteraz). Každý podpis je taký, ako si ho daný človek nastavil
        (text alebo obrázok). Platí pre nové pečiatky – existujúcu prepíšeš tlačidlom ↻ pri označenej pečiatke.</p>
    </div>
  );
}

/** Nastavenia strán výsledného PDF: pridať prázdnu stranu A4, otočiť naskenovanú stranu. */
function PagesDialog({ ctl, onClose }: { ctl: C; onClose: () => void }) {
  const [ask, confirmNode] = useConfirm();
  const [busy, setBusy] = useState(false);
  const [cur] = useState(() => ctl.currentPageIndex());
  const layout = ctl.layout();

  async function rot(i: number, d: number) {
    setBusy(true);
    try { await ctl.rotatePage(i, d); } finally { setBusy(false); }
  }
  async function remove(i: number) {
    const n = ctl.annsOnPage(i);
    if (n && !await ask({ title: 'Odstrániť stranu?', body: <p>Na strane {i + 1} je {n} {n === 1 ? 'objekt' : n < 5 ? 'objekty' : 'objektov'}, zmiznú s ňou (dá sa vrátiť cez Späť).</p>, ok: 'Odstrániť', danger: true })) return;
    ctl.removePage(i);
  }
  async function reset() {
    const n = layout.reduce((k, p, i) => k + (p.src === null ? ctl.annsOnPage(i) : 0), 0);
    if (!await ask({
      title: 'Vrátiť pôvodné strany?',
      body: <p>Pridané prázdne strany zmiznú{n ? <> aj s {n} objektmi na nich</> : null} a otočené strany budú zase ako v pôvodnom PDF. Dá sa vrátiť cez Späť.</p>,
      ok: 'Vrátiť', danger: true,
    })) return;
    ctl.resetPages();
  }

  return (
    <Dialog open onClose={onClose} title="Nastavenia strany" wide>
      {confirmNode}
      <p className="hint">Pôvodné PDF sa nemení, zmeny sa prejavia v editore a vo výslednom PDF. Pri otočení ostane strana na výšku –
        naskenované riešenie (to, čo nie je biele) sa otočí a zmestí na celú stranu. <b>Obsah</b> pod 100 % zmenší riešenie na stred
        strany a okolo vzniknú voľné okraje na písanie (objekty na strane sa zmenšia s ním).</p>
      <ul className="pagelist">
        {layout.map((p, i) => (
          <li key={i} className={i === cur ? 'cur' : ''}>
            <span className="pg-n">{i + 1}.</span>
            <span className="pg-what">
              {p.src === null ? 'prázdna strana A4' : `pôvodná strana ${p.src + 1}`}
              {p.rot ? <b> · otočená o {p.rot}°</b> : null}
              {p.scale ? <b> · obsah {Math.round(p.scale * 100)} %</b> : null}
              {ctl.annsOnPage(i) ? <span className="muted"> · {ctl.annsOnPage(i)} obj.</span> : null}
            </span>
            <span className="pg-actions">
              {p.src !== null && <>
                <button className="btn small" disabled={busy} title="Otočiť o 90° doprava (v smere hodín)" onClick={() => rot(i, 90)}>↻ 90°</button>
                <button className="btn small" disabled={busy} title="Otočiť o 90° doľava" onClick={() => rot(i, -90)}>↺ 90°</button>
                <button className="btn small" disabled={busy} title="Otočiť hore nohami" onClick={() => rot(i, 180)}>180°</button>
                <select className="pg-scale" disabled={busy} value={String(p.scale || 1)} title="Veľkosť obsahu – menšia = väčšie okraje na písanie"
                  onChange={e => ctl.setPageScale(i, Number(e.target.value))}>
                  {PAGE_SCALES.map(k => <option key={k} value={String(k)}>{k === 1 ? 'Obsah 100 %' : `Obsah ${Math.round(k * 100)} %`}</option>)}
                </select>
              </>}
              <button className="btn small" disabled={busy} title="Pridať prázdnu stranu A4 za túto" onClick={() => ctl.addBlankPage(i)}>+ prázdna za</button>
              {p.src === null && <button className="btn small danger" disabled={busy} onClick={() => remove(i)}>Odstrániť</button>}
            </span>
          </li>
        ))}
      </ul>
      <div className="row">
        {ctl.cur?.pages && <button className="btn danger" disabled={busy} onClick={reset}>Pôvodné strany</button>}
        <span className="grow" />
        <select className="pg-scale" disabled={busy} value="" title="Rovnaké okraje na všetkých stranách" onChange={e => { if (e.target.value) ctl.setPageScale('all', Number(e.target.value)); }}>
          <option value="">Okraje pre všetky strany…</option>
          {PAGE_SCALES.map(k => <option key={k} value={String(k)}>{k === 1 ? 'Bez okrajov (100 %)' : `Obsah ${Math.round(k * 100)} %`}</option>)}
        </select>
        <button className="btn" disabled={busy} onClick={() => ctl.addBlankPage(layout.length - 1)}>+ Prázdna A4 na koniec</button>
        <button className="btn primary" onClick={onClose}>Hotovo</button>
      </div>
    </Dialog>
  );
}

/** Ponuka pri označenom texte v PDF. */
function TextSelMenu({ ctl }: { ctl: C }) {
  const t = ctl.textSel!;
  return (
    <div className="selmenu" style={{ left: t.x, top: t.y + 8 }} onPointerDown={e => e.preventDefault()}>
      <button className="btn small" onClick={() => ctl.markSelection('highlight')}>Zvýrazniť</button>
      <button className="btn small" onClick={() => ctl.markSelection('underline')}>Podčiarknuť</button>
      <button className="btn small" onClick={() => ctl.copySelection()}>Kopírovať</button>
    </div>
  );
}

function HistoryDialog({ ctl, onClose }: { ctl: C; onClose: () => void }) {
  const [versions, setVersions] = useState<VersionItem[] | null>(null);
  const [error, setError] = useState('');
  const sol = ctl.cur!;
  useEffect(() => {
    ctl.flushSave().then(() => api<VersionItem[]>(`/api/solutions/${sol.id}/versions`)).then(setVersions).catch(e => setError(e.message));
  }, [ctl, sol.id]);

  async function restore(v: VersionItem) {
    if (!confirm('Obnoviť túto verziu? Súčasný stav ostane v histórii, takže sa k nemu dá vrátiť.')) return;
    try { await ctl.restoreVersion(v.id); onClose(); } catch (e) { setError((e as Error).message); }
  }

  return (
    <Dialog open onClose={onClose} title={`História – ${sol.display_name}`} wide>
      {!versions && !error && <p className="muted">Načítavam…</p>}
      {versions && !versions.length && <p className="muted">Žiadne verzie</p>}
      {versions && versions.length > 0 && (
        <table className="versions">
          <thead><tr><th>Kedy</th><th>Kto</th><th>Body</th><th>Zmeny</th><th>Objekty</th><th /></tr></thead>
          <tbody>
            {versions.map((v, i) => (
              <tr key={v.id}>
                <td>{formatDate(v.created_at)}</td>
                <td>{v.user || '—'}</td>
                <td>{v.points === null ? '–' : formatPoints(v.points)}</td>
                <td>{v.changes}</td>
                <td>{v.count}</td>
                <td>{i === 0 ? <span className="muted small">aktuálna</span> : <button className="btn small" onClick={() => restore(v)}>Obnoviť</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="error">{error}</p>
      <div className="row"><button className="btn" onClick={onClose}>Zavrieť</button></div>
    </Dialog>
  );
}
