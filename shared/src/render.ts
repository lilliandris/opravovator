// Vypálenie anotácií do PDF – rovnaké na serveri aj v prehliadači (lokálny režim).
import {
  PDFDocument, PDFFont, PDFImage, PDFPage, PDFString, rgb, degrees, pushGraphicsState, popGraphicsState, setLineWidth,
  setStrokingRgbColor, setFillingRgbColor, setGraphicsState, moveTo, lineTo, appendBezierCurve, closePath,
  stroke, fill, setLineCap, setLineJoin, LineCapStyle, LineJoinStyle, type PDFOperator,
} from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import {
  LINE_HEIGHT, DEFAULT_COLOR, HIGHLIGHT_OPACITY, arrowGeometry, pageTransformed, fontById, hexToRgb, rotatedPlacement, stampLayout, stampSigs, textLines,
  type Annotation, type PageSpec,
} from './index';

// pri týchto písmach pdf-lib/fontkit pri podmnožine (subset) stratí tvary znakov → vkladajú sa celé
const NO_SUBSET = new Set(['kalam', 'caveat']);
const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"]+[^\s<>".,;:!?)\]]/gi;

// Mapovanie z „vizuálnych“ súradníc (ako ich vidí pdf.js: ľavý horný roh,
// otočenie stránky aplikované) do súradníc PDF stránky.
function mapper(page: PDFPage) {
  const { x: x0, y: y0, width: W, height: H } = page.getCropBox();
  const r = (((page.getRotation().angle || 0) % 360) + 360) % 360;
  const map = (vx: number, vy: number): [number, number] => {
    switch (r) {
      case 90: return [x0 + vy, y0 + vx];
      case 180: return [x0 + W - vx, y0 + vy];
      case 270: return [x0 + W - vy, y0 + H - vx];
      default: return [x0 + vx, y0 + H - vy];
    }
  };
  // rozmer strany tak, ako ju vidí pdf.js
  const [vw, vh] = r % 180 ? [H, W] : [W, H];
  return { map, r, vw, vh };
}

function strokePath(page: PDFPage, color: string, width: number, ops: PDFOperator[], close = false) {
  const [r, g, b] = hexToRgb(color);
  const all = [pushGraphicsState(), setStrokingRgbColor(r, g, b), setLineWidth(width),
    setLineCap(LineCapStyle.Round), setLineJoin(LineJoinStyle.Round), ...ops];
  if (close) all.push(closePath());
  all.push(stroke(), popGraphicsState());
  page.pushOperators(...all);
}

/** Výplň cesty s priehľadnosťou (multiply = ako zvýrazňovač, text pod ním ostane čitateľný). */
function fillPath(page: PDFPage, color: string, opacity: number, ops: PDFOperator[], multiply = false) {
  const [r, g, b] = hexToRgb(color);
  const gs = page.doc.context.obj({ Type: 'ExtGState', ca: opacity, CA: opacity, ...(multiply ? { BM: 'Multiply' } : {}) });
  const name = page.node.newExtGState('GS', gs);
  page.pushOperators(pushGraphicsState(), setGraphicsState(name), setFillingRgbColor(r, g, b), ...ops, closePath(), fill(), popGraphicsState());
}

/** Klikateľný odkaz na mieste (vizuálne súradnice). */
function addLink(page: PDFPage, map: (x: number, y: number) => [number, number], x: number, y: number, w: number, h: number, url: string) {
  const [ax, ay] = map(x, y), [bx, by] = map(x + w, y + h);
  const ctx = page.doc.context;
  const href = /^www\./i.test(url) ? 'https://' + url : url;
  const annot = ctx.register(ctx.obj({
    Type: 'Annot', Subtype: 'Link', Rect: [Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by)],
    Border: [0, 0, 0], A: { Type: 'Action', S: 'URI', URI: PDFString.of(href) },
  }));
  page.node.addAnnot(annot);
}

const isIdentity = (specs: PageSpec[], n: number) =>
  specs.length === n && specs.every((p, i) => p.src === i && !pageTransformed(p));

/**
 * Strany výsledného PDF podľa nastavení strán: pridané prázdne strany, otočené a zmenšené strany
 * (obsah sa zmestí na stred strany rovnakej veľkosti). Nezmenené strany sa skopírujú celé.
 */
async function layoutDoc(src: PDFDocument, specs: PageSpec[] | null | undefined): Promise<PDFDocument> {
  const srcPages = src.getPages();
  if (!specs || isIdentity(specs, srcPages.length)) return src;
  const out = await PDFDocument.create({ updateMetadata: false });
  for (const spec of specs) {
    if (spec.src === null) { out.addPage([spec.w || 595.28, spec.h || 841.89]); continue; }
    const sp = srcPages[spec.src];
    if (!sp) continue;
    if (!pageTransformed(spec)) { const [cp] = await out.copyPages(src, [spec.src]); out.addPage(cp); continue; }
    const { map, r, vw: W, vh: H } = mapper(sp);
    const pl = rotatedPlacement(spec, W, H);
    const [ax, ay] = map(pl.crop.x, pl.crop.y), [bx, by] = map(pl.crop.x + pl.crop.w, pl.crop.y + pl.crop.h);
    const box = { left: Math.min(ax, bx), bottom: Math.min(ay, by), right: Math.max(ax, bx), top: Math.max(ay, by) };
    const emb = await out.embedPage(sp, box);
    const page = out.addPage([W, H]);
    // obsah stránky je v PDF neotočený, pdf.js ho ukazuje otočený o r → spolu o r + rot v smere hodín
    const T = (r + pl.rot) % 360;
    const bw = (box.right - box.left) * pl.k, bh = (box.top - box.bottom) * pl.k;
    const left = pl.ox, bottom = H - pl.oy - pl.rh;
    const [x, y] = T === 90 ? [left, bottom + bw] : T === 180 ? [left + bw, bottom + bh] : T === 270 ? [left + bh, bottom] : [left, bottom];
    page.drawPage(emb, { x, y, xScale: pl.k, yScale: pl.k, rotate: degrees(-T) });
  }
  return out;
}

export interface RenderCtx {
  points: number | null;
  correctorName: string;
  /** obsah TTF súboru písma podľa jeho názvu súboru (FontInfo.file) */
  fontBytes: (file: string) => Promise<Uint8Array>;
  getAsset: (id: number) => Promise<{ mime: string; data: Uint8Array } | null>;
  /** strany výsledného PDF (null = ako v pôvodnom) */
  pages?: PageSpec[] | null;
}

export async function renderPdf(baseBytes: Uint8Array | ArrayBuffer, annotations: Annotation[], ctx: RenderCtx): Promise<Uint8Array> {
  const base = await PDFDocument.load(baseBytes, { ignoreEncryption: true, updateMetadata: false });
  const doc = await layoutDoc(base, ctx.pages);
  doc.registerFontkit(fontkit);
  const pages = doc.getPages();
  const embedded: Record<string, PDFFont> = {};
  const font = async (id: string) => {
    const meta = fontById(id);
    if (!embedded[meta.id]) embedded[meta.id] = await doc.embedFont(await ctx.fontBytes(meta.file), { subset: !NO_SUBSET.has(meta.id) });
    return { pdf: embedded[meta.id], meta };
  };
  const measure = (t: string, size: number, id: string) => embedded[fontById(id).id].widthOfTextAtSize(t, size);
  const images: Record<number, PDFImage | null> = {};
  const image = async (id: number) => {
    if (!(id in images)) {
      const asset = await ctx.getAsset(id);
      images[id] = !asset ? null : asset.mime === 'image/jpeg' ? await doc.embedJpg(asset.data) : await doc.embedPng(asset.data);
    }
    return images[id];
  };

  for (const a of annotations) {
    const page = pages[a.page];
    if (!page) continue;
    const { map, r } = mapper(page);
    const color = a.color || DEFAULT_COLOR;

    if (a.type === 'text') {
      const { pdf, meta } = await font(a.font);
      const size = Number(a.size) || 16;
      const [cr, cg, cb] = hexToRgb(color);
      textLines(a, measure).forEach((line, i) => {
        if (!line) return;
        const top = a.y + i * size * LINE_HEIGHT, base = top + meta.ascent * size;
        const [px, py] = map(a.x, base);
        page.drawText(line, { x: px, y: py, size, font: pdf, color: rgb(cr, cg, cb), rotate: degrees(r) });
        if (a.underline) {
          const uy = base + size * 0.12;
          strokePath(page, color, Math.max(0.5, size * 0.06), [moveTo(...map(a.x, uy)), lineTo(...map(a.x + pdf.widthOfTextAtSize(line, size), uy))]);
        }
        for (const m of line.matchAll(URL_RE)) {
          const x = a.x + pdf.widthOfTextAtSize(line.slice(0, m.index), size);
          addLink(page, map, x, top, pdf.widthOfTextAtSize(m[0], size), size * LINE_HEIGHT, m[0]);
        }
      });
    } else if (a.type === 'stamp') {
      if (ctx.points === null) continue;
      await font(a.font);
      for (const sg of stampSigs(a, ctx.correctorName)) if (sg.name) await font(sg.nameFont || a.font);
      for (const part of stampLayout(a, ctx.points, ctx.correctorName, measure)) {
        if (part.kind === 'text') {
          const { pdf, meta } = await font(part.font);
          const [cr, cg, cb] = hexToRgb(part.color);
          const tw = pdf.widthOfTextAtSize(part.text, part.size);
          const [px, py] = map(part.cx - tw / 2, part.top + meta.ascent * part.size);
          page.drawText(part.text, { x: px, y: py, size: part.size, font: pdf, color: rgb(cr, cg, cb), rotate: degrees(r) });
        } else {
          const img = await image(part.assetId);
          if (!img) continue;
          const [px, py] = map(part.x, part.y + part.h);
          page.drawImage(img, { x: px, y: py, width: part.w, height: part.h, rotate: degrees(r) });
        }
      }
    } else if (a.type === 'line' || a.type === 'arrow') {
      const w = Math.max(0.3, Number(a.width) || 2);
      if (a.type === 'line') {
        strokePath(page, color, w, [moveTo(...map(a.x1, a.y1)), lineTo(...map(a.x2, a.y2))]);
      } else {
        const g = arrowGeometry(a.x1, a.y1, a.x2, a.y2, w);
        strokePath(page, color, w, [moveTo(...map(g.shaft[0], g.shaft[1])), lineTo(...map(g.shaft[2], g.shaft[3]))]);
        const [cr, cg, cb] = hexToRgb(color);
        page.pushOperators(pushGraphicsState(), setFillingRgbColor(cr, cg, cb),
          moveTo(...map(...g.head[0])), lineTo(...map(...g.head[1])), lineTo(...map(...g.head[2])),
          closePath(), fill(), popGraphicsState());
      }
    } else if (a.type === 'rect') {
      const w = Math.max(0.3, Number(a.width) || 2);
      const { x, y, w: rw, h: rh } = a;
      const path = [moveTo(...map(x, y)), lineTo(...map(x + rw, y)), lineTo(...map(x + rw, y + rh)), lineTo(...map(x, y + rh))];
      if (a.fill) fillPath(page, a.fill, a.fillOpacity ?? 1, path);
      strokePath(page, color, w, path, true);
    } else if (a.type === 'ellipse') {
      const w = Math.max(0.3, Number(a.width) || 2);
      const rx = a.w / 2, ry = a.h / 2, cx = a.x + rx, cy = a.y + ry, k = 0.5522847498;
      const path = [
        moveTo(...map(cx + rx, cy)),
        appendBezierCurve(...map(cx + rx, cy + k * ry), ...map(cx + k * rx, cy + ry), ...map(cx, cy + ry)),
        appendBezierCurve(...map(cx - k * rx, cy + ry), ...map(cx - rx, cy + k * ry), ...map(cx - rx, cy)),
        appendBezierCurve(...map(cx - rx, cy - k * ry), ...map(cx - k * rx, cy - ry), ...map(cx, cy - ry)),
        appendBezierCurve(...map(cx + k * rx, cy - ry), ...map(cx + rx, cy - k * ry), ...map(cx + rx, cy)),
      ];
      if (a.fill) fillPath(page, a.fill, a.fillOpacity ?? 1, path);
      strokePath(page, color, w, path, true);
    } else if (a.type === 'image') {
      const img = await image(a.assetId);
      if (!img) continue;
      const [px, py] = map(a.x, a.y + a.h);
      page.drawImage(img, { x: px, y: py, width: a.w, height: a.h, rotate: degrees(r) });
    } else if (a.type === 'highlight') {
      for (const q of a.rects) {
        fillPath(page, color, a.opacity ?? HIGHLIGHT_OPACITY,
          [moveTo(...map(q.x, q.y)), lineTo(...map(q.x + q.w, q.y)), lineTo(...map(q.x + q.w, q.y + q.h)), lineTo(...map(q.x, q.y + q.h))], true);
      }
    } else if (a.type === 'underline') {
      const w = Math.max(0.3, Number(a.width) || 1.5);
      for (const q of a.rects) strokePath(page, color, w, [moveTo(...map(q.x, q.y + q.h)), lineTo(...map(q.x + q.w, q.y + q.h))]);
    }
  }
  return doc.save();
}
