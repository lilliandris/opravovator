import { useEffect, useRef, useState } from 'react';
import { ACCENTS, FONTS, SIG_POSITIONS, STAMP_IMAGE_SCALE, accentById, fontFamily, themePen, type SigPos, type User } from '@opravovator/shared';
import { api } from '../api';
import { prepareImage } from '../editor/controller';
import { addLocalAsset, listLocalAssets, localAssetUrl } from '../local/ops';
import { getSession, saveMe } from '../local/session';
import { applyAccent, setTheme, useResolvedTheme, useThemeChoice, type ThemeChoice } from '../theme';
import { Dialog } from './common';
import { ImageCropDialog } from './ImageCrop';

const THEMES: [ThemeChoice, string][] = [['auto', 'Podľa systému'], ['light', 'Svetlá'], ['dark', 'Tmavá']];

interface Img { id: number; name: string; url: string }

/** Knižnica obrázkov používateľa (zo servera, alebo bez účtu zo zariadenia) + nahratie nového. */
function useImages(enabled: boolean) {
  const [imgs, setImgs] = useState<Img[] | null>(null);
  const local = useRef(false);
  useEffect(() => {
    if (!enabled || imgs) return;
    (async () => {
      local.current = !(await getSession()).server;
      const list = local.current ? await listLocalAssets() : await api<{ id: number; name: string }[]>('/api/assets');
      setImgs(await Promise.all(list.map(async a => ({ ...a, url: (local.current ? await localAssetUrl(a.id) : `/api/assets/${a.id}`) || '' }))));
    })().catch(() => setImgs([]));
  }, [enabled, imgs]);

  /** Nahrá hotový (spracovaný a orezaný) obrázok ako nový v knižnici. */
  async function upload(blob: Blob, name: string): Promise<number> {
    let id: number, url: string;
    if (local.current) {
      id = await addLocalAsset(blob, name);
      url = (await localAssetUrl(id)) || '';
    } else {
      const fd = new FormData();
      fd.append('file', blob, name.replace(/\.[^.]+$/, '') + '.png');
      id = (await api<{ id: number }>('/api/assets', { method: 'POST', body: fd })).id;
      url = `/api/assets/${id}`;
    }
    setImgs(l => [{ id, name, url }, ...(l || [])]);
    return id;
  }
  return { imgs, upload };
}

/** Nastavenia používateľa: profil, podpis pod bodmi, téma a farba rozhrania. */
export function SettingsDialog({ open, me, onClose, onSaved }: {
  open: boolean; me: User; onClose: () => void; onSaved: (u: User) => void;
}) {
  const [error, setError] = useState('');
  const [name, setName] = useState(me.name);
  const [stampName, setStampName] = useState(me.stamp_name || '');
  const [stampFont, setStampFont] = useState(me.stamp_font || '');
  const [sigImage, setSigImage] = useState(!!me.stamp_image);
  const [stampImage, setStampImage] = useState<number | null>(me.stamp_image);
  const [imgScale, setImgScale] = useState(me.stamp_image_scale || 1);
  const [stampColor, setStampColor] = useState(me.stamp_color || '');
  const [stampPos, setStampPos] = useState<SigPos>(me.stamp_pos || 'below');
  const [ptsFont, setPtsFont] = useState(me.stamp_points_font || '');
  const [ptsColor, setPtsColor] = useState(me.stamp_points_color || '');
  const [ptsSize, setPtsSize] = useState<number | ''>(me.stamp_points_size || '');
  const [busy, setBusy] = useState(false);
  // obrázok na orezanie (nový z disku, alebo úprava existujúceho – uloží sa ako nový, staré opravy sa nezmenia)
  const [crop, setCrop] = useState<{ blob: Blob; name: string } | null>(null);
  const fileIn = useRef<HTMLInputElement>(null);
  const { imgs, upload } = useImages(sigImage);
  const selImg = imgs?.find(a => a.id === stampImage) || null;
  const theme = useThemeChoice();
  const resolved = useResolvedTheme();
  const accent = accentById(me.accent);

  // farba sa prejaví a uloží hneď, aby bolo vidno, ako vyzerá
  async function pickAccent(id: string) {
    applyAccent(id);
    try { onSaved(await saveMe({ accent: id })); } catch (e) { setError((e as Error).message); }
  }

  async function save(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (sigImage && !stampImage) { setError('Vyber obrázok podpisu, alebo prepni na textový podpis.'); return; }
    try {
      const u = await saveMe({
        name, stamp_name: stampName || null, stamp_font: stampFont || null, stamp_image: sigImage ? stampImage : null,
        stamp_image_scale: imgScale === 1 ? null : imgScale, stamp_color: stampColor || null, stamp_pos: stampPos === 'below' ? null : stampPos,
        stamp_points_font: ptsFont || null, stamp_points_color: ptsColor || null, stamp_points_size: ptsSize === '' ? null : ptsSize,
      });
      onSaved(u);
      onClose();
    } catch (err) { setError((err as Error).message); }
  }

  return (
    <Dialog open={open} onClose={onClose} title="Nastavenia" wide>
      <form onSubmit={save} className="settings">
        <h4>Vzhľad</h4>
        <div className="seg" role="radiogroup" aria-label="Téma">
          {THEMES.map(([t, label]) => (
            <button type="button" key={t} role="radio" aria-checked={theme === t} className={theme === t ? 'on' : ''} onClick={() => setTheme(t)}>{label}</button>
          ))}
        </div>
        <div className="accents" role="radiogroup" aria-label="Farba tlačidiel a názvu">
          {ACCENTS.map(a => (
            <button type="button" key={a.id} role="radio" aria-checked={accent.id === a.id}
              className={'accent' + (accent.id === a.id ? ' on' : '')} onClick={() => pickAccent(a.id)}>
              <i style={{ background: resolved === 'light' ? a.light.pen : a.dark.pen }} />{a.label}
            </button>
          ))}
        </div>

        <h4>Profil</h4>
        {me.email && <p className="muted small">{me.email}</p>}
        <label className="field"><span>Meno</span><input className="input" value={name} onChange={e => setName(e.target.value)} required /></label>
        <h4>Body v PDF</h4>
        <p className="hint">Keď sú nastavené, „Vložiť body do PDF“ ich použije vždy rovnako – nezávisle od toho, aké pero máš práve zvolené.</p>
        <label className="field"><span>Písmo bodov</span>
          <select className="input" value={ptsFont} onChange={e => setPtsFont(e.target.value)}>
            <option value="">Podľa práve zvoleného písma</option>
            {FONTS.map(f => <option key={f.id} value={f.id} style={{ fontFamily: fontFamily(f.id) }}>{f.label}</option>)}
          </select></label>
        <div className="field"><span>Farba bodov</span>
          <div className="sig-color">
            <div className="seg narrow" role="radiogroup" aria-label="Farba bodov">
              <button type="button" role="radio" aria-checked={!ptsColor} className={!ptsColor ? 'on' : ''} onClick={() => setPtsColor('')}>Podľa pera</button>
              <button type="button" role="radio" aria-checked={!!ptsColor} className={ptsColor ? 'on' : ''} onClick={() => setPtsColor(ptsColor || themePen(me.accent))}>Vlastná</button>
            </div>
            {ptsColor && <input type="color" value={ptsColor} onChange={e => setPtsColor(e.target.value)} aria-label="Vlastná farba bodov" />}
          </div>
        </div>
        <div className="field"><span>Veľkosť bodov</span>
          <div className="sig-color">
            <div className="seg narrow" role="radiogroup" aria-label="Veľkosť bodov">
              <button type="button" role="radio" aria-checked={ptsSize === ''} className={ptsSize === '' ? 'on' : ''} onClick={() => setPtsSize('')}>Podľa poslednej</button>
              <button type="button" role="radio" aria-checked={ptsSize !== ''} className={ptsSize !== '' ? 'on' : ''} onClick={() => setPtsSize(ptsSize || 40)}>Pevná</button>
            </div>
            {ptsSize !== '' && <input className="input pts-size" type="number" min={6} max={400} value={ptsSize} aria-label="Veľkosť bodov"
              onChange={e => setPtsSize(Math.max(6, Math.min(400, Number(e.target.value) || 40)))} />}
          </div>
        </div>

        <div className="field"><span>Podpis pod bodmi</span>
          <div className="seg narrow" role="radiogroup" aria-label="Druh podpisu">
            <button type="button" role="radio" aria-checked={!sigImage} className={!sigImage ? 'on' : ''} onClick={() => setSigImage(false)}>Text</button>
            <button type="button" role="radio" aria-checked={sigImage} className={sigImage ? 'on' : ''} onClick={() => setSigImage(true)}>Obrázok</button>
          </div>
        </div>
        {!sigImage ? <>
          <label className="field"><span>Text podpisu</span>
            <input className="input" value={stampName} placeholder={name} onChange={e => setStampName(e.target.value)} /></label>
          <label className="field"><span>Písmo podpisu (vždy rovnaké)</span>
            <select className="input" value={stampFont} onChange={e => setStampFont(e.target.value)}>
              <option value="">Rovnaké ako body</option>
              {FONTS.map(f => <option key={f.id} value={f.id} style={{ fontFamily: fontFamily(f.id) }}>{f.label}</option>)}
            </select></label>
          <div className="field"><span>Farba podpisu (vždy rovnaká)</span>
            <div className="sig-color">
              <div className="seg narrow" role="radiogroup" aria-label="Farba podpisu">
                <button type="button" role="radio" aria-checked={!stampColor} className={!stampColor ? 'on' : ''} onClick={() => setStampColor('')}>Ako body</button>
                <button type="button" role="radio" aria-checked={!!stampColor} className={stampColor ? 'on' : ''} onClick={() => setStampColor(stampColor || '#000000')}>Vlastná</button>
              </div>
              {stampColor && <input type="color" value={stampColor} onChange={e => setStampColor(e.target.value)} aria-label="Vlastná farba podpisu" />}
            </div>
          </div>
        </> : <>
          <div className="sig-imgs" role="radiogroup" aria-label="Obrázok podpisu">
            {imgs === null && <span className="hint">Načítavam…</span>}
            {imgs?.length === 0 && <span className="hint">Zatiaľ nemáš žiadne obrázky – nahraj podpis.</span>}
            {imgs?.map(a => (
              <button type="button" key={a.id} role="radio" aria-checked={stampImage === a.id} title={a.name}
                className={stampImage === a.id ? 'on' : ''} onClick={() => setStampImage(a.id)}>
                <img src={a.url} alt={a.name} />
              </button>
            ))}
          </div>
          <div className="sig-actions">
            <button type="button" className="btn" disabled={busy} onClick={() => fileIn.current?.click()}>{busy ? 'Nahrávam…' : 'Nahrať podpis'}</button>
            <button type="button" className="btn" disabled={busy || !selImg} title="Orezať vybraný obrázok (uloží sa ako nový)" onClick={async () => {
              if (!selImg) return;
              try { setCrop({ blob: await (await fetch(selImg.url)).blob(), name: selImg.name }); } catch (err) { setError((err as Error).message); }
            }}>Orezať vybraný</button>
          </div>
          <p className="hint">Biele pozadie sa pri nahratí odstráni. Najlepšie je tmavé perom na bielom papieri.</p>
          <div className="sig-scale">
            <span className="hint">Veľkosť</span>
            <input type="range" min={STAMP_IMAGE_SCALE.min} max={STAMP_IMAGE_SCALE.max} step={0.05} value={imgScale}
              onChange={e => setImgScale(Number(e.target.value))} aria-label="Veľkosť podpisu" />
            <button type="button" className="btn" title="Predvolená veľkosť" onClick={() => setImgScale(1)}>{Math.round(imgScale * 100)} %</button>
          </div>
          <input ref={fileIn} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={async e => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (!f) return;
            setBusy(true); setError('');
            try { setCrop({ blob: await prepareImage(f, true), name: f.name }); } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
          }} />
          {crop && <ImageCropDialog blob={crop.blob} onCancel={() => setCrop(null)} onDone={async b => {
            const n = crop.name;
            setCrop(null); setBusy(true); setError('');
            try { setStampImage(await upload(b, n)); } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
          }} />}
        </>}
        <div className="field"><span>Poloha podpisu voči bodom</span>
          <div className="seg" role="radiogroup" aria-label="Poloha podpisu">
            {SIG_POSITIONS.map(([p, label]) => (
              <button type="button" key={p} role="radio" aria-checked={stampPos === p} className={stampPos === p ? 'on' : ''} onClick={() => setStampPos(p)}>{label}</button>
            ))}
          </div>
        </div>
        <div className={'stamp-preview pos-' + stampPos} style={{ color: ptsColor || themePen(me.accent) }}>
          <span style={{ fontFamily: fontFamily(ptsFont || 'bebas'), fontSize: 44 }}>9B</span>
          {sigImage
            ? selImg && <img src={selImg.url} alt="podpis" style={{ height: 40 * imgScale, maxHeight: 'none', maxWidth: 160 * imgScale, objectFit: 'contain' }} />
            : <span style={{ fontFamily: fontFamily(stampFont || ptsFont || 'bebas'), fontSize: 19, color: stampColor || undefined }}>{stampName || name}</span>}
        </div>
        <p className="error">{error}</p>
        <div className="row"><button type="button" className="btn" onClick={onClose}>Zavrieť</button><button className="btn primary">Uložiť profil</button></div>
      </form>
    </Dialog>
  );
}

export const GearIcon = () => (
  <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z" /></svg>
);
