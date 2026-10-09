const {
  PDFDocument, rgb, degrees, pushGraphicsState, popGraphicsState, setLineWidth,
  setStrokingRgbColor, setFillingRgbColor, moveTo, lineTo, appendBezierCurve, closePath,
  stroke, fill, setLineCap, setLineJoin, LineCapStyle, LineJoinStyle,
} = require('pdf-lib');
const fontkit = require('@pdf-lib/fontkit');
const fonts = require('./fonts');
const S = require('../public/js/shared');

// Mapovanie z "vizuálnych" súradníc (ako ich vidí pdf.js: ľavý horný roh,
// otočenie stránky aplikované) do súradníc PDF stránky.
function mapper(page) {
  const box = page.getCropBox();
  const { x: x0, y: y0, width: W, height: H } = box;
  const r = (((page.getRotation().angle || 0) % 360) + 360) % 360;
  const map = (vx, vy) => {
    switch (r) {
      case 90: return [x0 + vy, y0 + vx];
      case 180: return [x0 + W - vx, y0 + vy];
      case 270: return [x0 + W - vy, y0 + H - vx];
      default: return [x0 + vx, y0 + H - vy];
    }
  };
  return { map, r };
}

function strokePath(page, color, width, build, close) {
  const [r, g, b] = S.hexToRgb(color);
  const ops = [pushGraphicsState(), setStrokingRgbColor(r, g, b), setLineWidth(width),
    setLineCap(LineCapStyle.Round), setLineJoin(LineJoinStyle.Round), ...build()];
  if (close) ops.push(closePath());
  ops.push(stroke(), popGraphicsState());
  page.pushOperators(...ops);
}

async function renderPdf(baseBytes, annotations, ctx) {
  const doc = await PDFDocument.load(baseBytes, { ignoreEncryption: true });
  doc.registerFontkit(fontkit);
  const pages = doc.getPages();
  const fontCache = {};
  const font = async id => {
    const f = fonts.get(id);
    if (!fontCache[f.id]) fontCache[f.id] = await doc.embedFont(f.bytes, { subset: true });
    return { pdf: fontCache[f.id], meta: f };
  };
  const imgCache = {};

  for (const a of annotations || []) {
    const page = pages[a.page];
    if (!page) continue;
    const { map, r } = mapper(page);
    const color = a.color || '#e0218a';
    const w = Math.max(0.3, Number(a.width) || 2);

    if (a.type === 'text') {
      const { pdf, meta } = await font(a.font);
      const size = Number(a.size) || 16;
      const [cr, cg, cb] = S.hexToRgb(color);
      String(a.text || '').split('\n').forEach((line, i) => {
        if (!line) return;
        const [px, py] = map(a.x, a.y + meta.ascent * size + i * size * S.LINE_HEIGHT);
        page.drawText(line, { x: px, y: py, size, font: pdf, color: rgb(cr, cg, cb), rotate: degrees(r) });
      });
    } else if (a.type === 'stamp') {
      if (ctx.points === null || ctx.points === undefined) continue;
      const { pdf, meta } = await font(a.font);
      const size = Number(a.size) || 40;
      const [cr, cg, cb] = S.hexToRgb(color);
      const lines = [[S.formatPoints(ctx.points) + 'B', size]];
      const nm = a.name !== undefined ? a.name : ctx.correctorName;
      if (nm) lines.push([nm, size * S.STAMP_NAME_RATIO]);
      let top = a.y;
      for (const [txt, sz] of lines) {
        const tw = pdf.widthOfTextAtSize(txt, sz);
        const [px, py] = map(a.x - tw / 2, top + meta.ascent * sz);
        page.drawText(txt, { x: px, y: py, size: sz, font: pdf, color: rgb(cr, cg, cb), rotate: degrees(r) });
        top += sz * 1.05;
      }
    } else if (a.type === 'line' || a.type === 'arrow') {
      if (a.type === 'line') {
        strokePath(page, color, w, () => [moveTo(...map(a.x1, a.y1)), lineTo(...map(a.x2, a.y2))]);
      } else {
        const g = S.arrowGeometry(a.x1, a.y1, a.x2, a.y2, w);
        strokePath(page, color, w, () => [moveTo(...map(g.shaft[0], g.shaft[1])), lineTo(...map(g.shaft[2], g.shaft[3]))]);
        const [cr, cg, cb] = S.hexToRgb(color);
        page.pushOperators(pushGraphicsState(), setFillingRgbColor(cr, cg, cb),
          moveTo(...map(...g.head[0])), lineTo(...map(...g.head[1])), lineTo(...map(...g.head[2])),
          closePath(), fill(), popGraphicsState());
      }
    } else if (a.type === 'rect') {
      const { x, y, w: rw, h: rh } = a;
      strokePath(page, color, w, () => [moveTo(...map(x, y)), lineTo(...map(x + rw, y)),
        lineTo(...map(x + rw, y + rh)), lineTo(...map(x, y + rh))], true);
    } else if (a.type === 'ellipse') {
      const rx = a.w / 2, ry = a.h / 2, cx = a.x + rx, cy = a.y + ry, k = 0.5522847498;
      strokePath(page, color, w, () => [
        moveTo(...map(cx + rx, cy)),
        appendBezierCurve(...map(cx + rx, cy + k * ry), ...map(cx + k * rx, cy + ry), ...map(cx, cy + ry)),
        appendBezierCurve(...map(cx - k * rx, cy + ry), ...map(cx - rx, cy + k * ry), ...map(cx - rx, cy)),
        appendBezierCurve(...map(cx - rx, cy - k * ry), ...map(cx - k * rx, cy - ry), ...map(cx, cy - ry)),
        appendBezierCurve(...map(cx + k * rx, cy - ry), ...map(cx + rx, cy - k * ry), ...map(cx + rx, cy)),
      ], true);
    } else if (a.type === 'image') {
      const asset = ctx.getAsset(a.assetId);
      if (!asset) continue;
      if (!imgCache[a.assetId]) {
        imgCache[a.assetId] = asset.mime === 'image/jpeg' ? await doc.embedJpg(asset.data) : await doc.embedPng(asset.data);
      }
      const [px, py] = map(a.x, a.y + a.h);
      page.drawImage(imgCache[a.assetId], { x: px, y: py, width: a.w, height: a.h, rotate: degrees(r) });
    }
  }
  return Buffer.from(await doc.save());
}

module.exports = { renderPdf };
