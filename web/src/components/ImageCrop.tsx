import { useEffect, useRef, useState } from 'react';
import { Dialog } from './common';

interface Rect { x: number; y: number; w: number; h: number }
type Grip = 'move' | 'nw' | 'ne' | 'sw' | 'se';

const MIN = 8;

/** Obdĺžnik okolo nepriehľadných pixelov (+ malý okraj); prázdny obrázok = celý. */
function autoTrim(c: HTMLCanvasElement): Rect {
  const { width: w, height: h } = c;
  const px = c.getContext('2d')!.getImageData(0, 0, w, h).data;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (px[(y * w + x) * 4 + 3] > 24) {
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return { x: 0, y: 0, w, h };
  const pad = Math.round(Math.max(x1 - x0, y1 - y0) * 0.03) + 2;
  x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad);
  x1 = Math.min(w - 1, x1 + pad); y1 = Math.min(h - 1, y1 + pad);
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/**
 * Orezanie obrázka ťahaním (presun obdĺžnika a rohy). Na začiatku navrhne orez tesne okolo kresby,
 * takže podpis s veľkým prázdnym okrajom nebude na pečiatke drobný.
 */
export function ImageCropDialog({ blob, onDone, onCancel }: {
  blob: Blob; onDone: (b: Blob) => void; onCancel: () => void;
}) {
  const [canvas, setCanvas] = useState<HTMLCanvasElement | null>(null);
  const [url, setUrl] = useState('');
  const [crop, setCrop] = useState<Rect | null>(null);
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const drag = useRef<{ grip: Grip; sx: number; sy: number; start: Rect } | null>(null);

  useEffect(() => {
    const u = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = img.naturalWidth; c.height = img.naturalHeight;
      c.getContext('2d')!.drawImage(img, 0, 0);
      setCanvas(c); setUrl(u); setCrop(autoTrim(c));
    };
    img.src = u;
    return () => URL.revokeObjectURL(u);
  }, [blob]);

  // mierka: pixely obrázka → pixely na obrazovke
  const scale = () => (box.current && canvas ? box.current.clientWidth / canvas.width : 1);

  function down(e: React.PointerEvent, grip: Grip) {
    if (!crop) return;
    e.preventDefault(); e.stopPropagation();
    (e.target as Element).setPointerCapture(e.pointerId);
    drag.current = { grip, sx: e.clientX, sy: e.clientY, start: crop };
  }

  function move(e: React.PointerEvent) {
    const d = drag.current;
    if (!d || !canvas) return;
    const k = scale();
    const dx = (e.clientX - d.sx) / k, dy = (e.clientY - d.sy) / k;
    const W = canvas.width, H = canvas.height, s = d.start;
    let { x, y, w, h } = s;
    if (d.grip === 'move') {
      x = Math.min(Math.max(0, s.x + dx), W - s.w);
      y = Math.min(Math.max(0, s.y + dy), H - s.h);
    } else {
      let l = s.x, t = s.y, r = s.x + s.w, b = s.y + s.h;
      if (d.grip.includes('w')) l = Math.min(Math.max(0, l + dx), r - MIN);
      if (d.grip.includes('e')) r = Math.max(Math.min(W, r + dx), l + MIN);
      if (d.grip.includes('n')) t = Math.min(Math.max(0, t + dy), b - MIN);
      if (d.grip.includes('s')) b = Math.max(Math.min(H, b + dy), t + MIN);
      x = l; y = t; w = r - l; h = b - t;
    }
    setCrop({ x, y, w, h });
  }

  function apply() {
    if (!canvas || !crop) return;
    setBusy(true);
    const c = document.createElement('canvas');
    c.width = Math.round(crop.w); c.height = Math.round(crop.h);
    c.getContext('2d')!.drawImage(canvas, Math.round(crop.x), Math.round(crop.y), c.width, c.height, 0, 0, c.width, c.height);
    c.toBlob(b => { setBusy(false); if (b) onDone(b); }, 'image/png');
  }

  const k = canvas ? 100 / canvas.width : 0, kh = canvas ? 100 / canvas.height : 0;
  return (
    <Dialog open onClose={onCancel} title="Orezať obrázok" wide>
      <p className="hint">Potiahni rohy rámika alebo celý rámik. Čo je mimo neho, sa odreže.</p>
      <div className="crop-wrap">
        {url && canvas && crop && (
          <div className="crop-box" ref={box} onPointerMove={move} onPointerUp={() => { drag.current = null; }}
            style={{ aspectRatio: `${canvas.width} / ${canvas.height}`, '--ar': canvas.width / canvas.height } as React.CSSProperties}>
            <img src={url} alt="" draggable={false} />
            {/* stmavenie všetkého mimo rámika */}
            <i className="crop-dim" style={{ left: 0, top: 0, width: '100%', height: `${crop.y * kh}%` }} />
            <i className="crop-dim" style={{ left: 0, top: `${(crop.y + crop.h) * kh}%`, width: '100%', bottom: 0 }} />
            <i className="crop-dim" style={{ left: 0, top: `${crop.y * kh}%`, width: `${crop.x * k}%`, height: `${crop.h * kh}%` }} />
            <i className="crop-dim" style={{ left: `${(crop.x + crop.w) * k}%`, right: 0, top: `${crop.y * kh}%`, height: `${crop.h * kh}%` }} />
            <div className="crop-rect" onPointerDown={e => down(e, 'move')}
              style={{ left: `${crop.x * k}%`, top: `${crop.y * kh}%`, width: `${crop.w * k}%`, height: `${crop.h * kh}%` }}>
              {(['nw', 'ne', 'sw', 'se'] as Grip[]).map(g => <span key={g} className={'crop-grip ' + g} onPointerDown={e => down(e, g)} />)}
            </div>
          </div>
        )}
      </div>
      <div className="row">
        <button type="button" className="btn" disabled={!canvas} onClick={() => canvas && setCrop({ x: 0, y: 0, w: canvas.width, h: canvas.height })}>Celý obrázok</button>
        <button type="button" className="btn" disabled={!canvas} onClick={() => canvas && setCrop(autoTrim(canvas))}>Orezať automaticky</button>
        <span className="grow" />
        <button type="button" className="btn" onClick={onCancel}>Zrušiť</button>
        <button type="button" className="btn primary" disabled={!crop || busy} onClick={apply}>Použiť</button>
      </div>
    </Dialog>
  );
}
