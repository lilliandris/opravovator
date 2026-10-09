// Zdieľané medzi prehliadačom a serverom – geometria a výpočet bodov,
// aby náhľad v editore sedel s tým, čo sa vypáli do PDF.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Shared = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const LINE_HEIGHT = 1.2;
  const STAMP_NAME_RATIO = 0.42;

  function arrowGeometry(x1, y1, x2, y2, width) {
    const dx = x2 - x1, dy = y2 - y1;
    const len = Math.hypot(dx, dy) || 1;
    let L = Math.max(9, width * 4.2);
    if (L > len * 0.7) L = len * 0.7;
    const hw = L * 0.55;
    const ux = dx / len, uy = dy / len;
    const bx = x2 - ux * L, by = y2 - uy * L;
    const nx = -uy, ny = ux;
    return {
      shaft: [x1, y1, x2 - ux * L * 0.8, y2 - uy * L * 0.8],
      head: [[x2, y2], [bx + nx * hw, by + ny * hw], [bx - nx * hw, by - ny * hw]],
    };
  }

  function round2(n) { return Math.round(n * 100) / 100; }

  function computePoints(rubric, checks, manual, maxPoints) {
    let p;
    if (manual !== null && manual !== undefined && manual !== '' && !isNaN(Number(manual))) {
      p = Number(manual);
    } else {
      const set = new Set(checks || []);
      const items = (rubric || []).filter(i => set.has(i.id));
      if (!items.length) return null;
      p = items.reduce((s, i) => s + Number(i.points || 0), 0);
    }
    if (p < 0) p = 0;
    if (maxPoints !== null && maxPoints !== undefined && maxPoints !== '' && p > Number(maxPoints)) p = Number(maxPoints);
    return round2(p);
  }

  function formatPoints(p) {
    if (p === null || p === undefined) return '';
    return String(round2(p));
  }

  function hexToRgb(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
    const v = m ? parseInt(m[1], 16) : 0;
    return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
  }

  return { LINE_HEIGHT, STAMP_NAME_RATIO, arrowGeometry, computePoints, formatPoints, hexToRgb, round2 };
});
