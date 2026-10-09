/* global pdfjsLib, Shared, api, h */
pdfjsLib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.js';

const $ = s => document.querySelector(s);
const SVGNS = 'http://www.w3.org/2000/svg';
const TASK_ID = new URLSearchParams(location.search).get('task');
const SWATCHES = ['#e0218a', '#e5231b', '#1f6feb', '#138a36', '#f08c00', '#000000'];
const STYLE_KEY = 'opravovac-style';

const st = {
  me: null, task: null, sols: [], fonts: [], fontById: {}, assets: [],
  cur: null, pdf: null, pages: [], zoom: 1, fit: true,
  tool: 'select', selected: null, drag: null, editing: null,
  undo: [], redo: [], clipboard: null, imageAsset: null,
  filter: { q: '', rocnik: null }, rubricEdit: false,
  style: Object.assign({ font: 'bebas', size: 20, color: '#e0218a', width: 2, stampSize: 40 },
    (() => { try { return JSON.parse(localStorage.getItem(STYLE_KEY)) || {}; } catch { return {}; } })()),
};
let loadToken = 0;

const uid = () => 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const clone = o => JSON.parse(JSON.stringify(o));
const anns = () => (st.cur ? st.cur.annotations : []);
const findAnn = id => anns().find(a => a.id === id);
const font = id => st.fontById[id] || st.fonts[0];
const saveStyle = () => { try { localStorage.setItem(STYLE_KEY, JSON.stringify(st.style)); } catch { /* */ } };
const snapshot = () => JSON.stringify(anns());

/* ================= načítanie ================= */

async function init() {
  if (!TASK_ID) { location.href = '/'; return; }
  const [me, fonts, task, assets] = await Promise.all([
    api('/api/auth/me'), api('/api/fonts'), api('/api/tasks/' + TASK_ID), api('/api/assets'),
  ]);
  st.me = me; st.fonts = fonts; st.assets = assets;
  fonts.forEach(f => { st.fontById[f.id] = f; });
  await Promise.all(fonts.map(f => document.fonts.load(`20px "${f.family}"`).catch(() => {})));
  setTask(task);
  buildToolbar();
  bindGlobal();
  const fromHash = Number((location.hash.match(/sol=(\d+)/) || [])[1]);
  const first = st.sols.find(s => s.id === fromHash) || st.sols[0];
  if (first) openSolution(first.id);
  else $('#pages').innerHTML = '<div class="loading">Táto úloha neobsahuje žiadne riešenia.</div>';
}

function setTask(task) {
  st.task = task;
  st.sols = task.solutions;
  document.title = task.name + ' – Opravovač';
  $('#taskName').textContent = task.name;
  $('#downloadBtn').href = `/api/tasks/${task.id}/download`;
  renderChips();
  renderSols();
  renderRubric();
}

async function reloadTask() {
  const t = await api('/api/tasks/' + TASK_ID);
  setTask(t);
}

/* ================= bočný panel ================= */

function renderChips() {
  const box = $('#chips');
  box.innerHTML = '';
  const vals = [...new Set(st.sols.map(s => s.rocnik).filter(Boolean))];
  if (vals.length < 2) return;
  const order = ['5', '6', '7', '8', '9', 'Pri', 'Sek', 'Ter', 'Kva'];
  vals.sort((a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99) || a.localeCompare(b, 'sk', { numeric: true }));
  box.append(h('button', { class: 'chip' + (st.filter.rocnik === null ? ' on' : ''), onclick: () => { st.filter.rocnik = null; renderChips(); renderSols(); } }, 'Všetky'));
  for (const v of vals) {
    const n = st.sols.filter(s => s.rocnik === v).length;
    box.append(h('button', { class: 'chip' + (st.filter.rocnik === v ? ' on' : ''), onclick: () => { st.filter.rocnik = v; renderChips(); renderSols(); } }, `${v} (${n})`));
  }
}

function visibleSols() {
  const q = st.filter.q.trim().toLocaleLowerCase('sk').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  return st.sols.filter(s => {
    if (st.filter.rocnik !== null && s.rocnik !== st.filter.rocnik) return false;
    if (!q) return true;
    const hay = (s.display_name + ' ' + s.folder + ' ' + s.rocnik).toLocaleLowerCase('sk').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    return hay.includes(q);
  });
}

function renderSols() {
  const box = $('#sols');
  box.innerHTML = '';
  for (const s of visibleSols()) {
    const graded = s.points !== null && s.points !== undefined;
    const el = h('div', { class: 'sol' + (st.cur && st.cur.id === s.id ? ' on' : ''), 'data-sol': s.id, onclick: () => openSolution(s.id) },
      h('span', { class: 'n' }, s.idx),
      h('span', { class: 'who', title: s.folder }, s.display_name),
      h('span', { class: 'pts' + (graded ? ' done' : '') }, graded ? Shared.formatPoints(s.points) + 'B' : '?B'),
      h('span', { class: 'sub' },
        h('span', {
          class: 'badge edit', title: 'Ročník – dvojklikom zmeníš',
          ondblclick: e => { e.stopPropagation(); editRocnik(s); },
        }, s.rocnik || '—'),
        s.annotated ? h('span', { title: 'Má opravy v PDF' }, '✎ opravené') : null));
    box.append(el);
  }
}

async function editRocnik(s) {
  const v = prompt(`Ročník pre ${s.display_name}:`, s.rocnik || '');
  if (v === null) return;
  if (st.cur && st.cur.id === s.id) await flushSave();
  const r = await api('/api/solutions/' + s.id, { method: 'PUT', body: { rocnik: v } });
  s.rocnik = r.rocnik;
  renderChips(); renderSols();
}

function stepSolution(dir) {
  const list = visibleSols();
  if (!list.length) return;
  const i = st.cur ? list.findIndex(s => s.id === st.cur.id) : -1;
  const next = list[Math.min(list.length - 1, Math.max(0, i + dir))];
  if (next && (!st.cur || next.id !== st.cur.id)) openSolution(next.id);
}

/* ================= otvorenie riešenia ================= */

async function openSolution(id) {
  commitTextEdit();
  await flushSave();
  const token = ++loadToken;
  st.selected = null; st.undo = []; st.redo = []; st.drag = null;
  history.replaceState(null, '', '#sol=' + id);
  const listItem = st.sols.find(s => s.id === id);
  st.cur = null;
  renderSols();
  $('#pages').innerHTML = '<div class="loading">Načítavam PDF…</div>';
  const sol = await api('/api/solutions/' + id);
  if (token !== loadToken) return;
  st.cur = sol;
  renderSols();
  renderRubric();
  const active = document.querySelector(`.sol[data-sol="${id}"]`);
  if (active) active.scrollIntoView({ block: 'nearest' });
  releaseAllPages();
  if (st.pdf) { st.pdf.destroy(); st.pdf = null; }
  st.pages = [];
  if (!sol.pdf_name) {
    $('#pages').innerHTML = '<div class="loading">V priečinku tohto riešenia nie je PDF.</div>';
    return;
  }
  let pdf;
  try {
    pdf = await pdfjsLib.getDocument({
      url: `/api/solutions/${id}/pdf`, withCredentials: true,
      disableAutoFetch: true, isEvalSupported: false, maxImageSize: 64e6,
    }).promise;
  } catch (e) {
    if (token === loadToken) $('#pages').innerHTML = '<div class="loading">PDF sa nepodarilo otvoriť.</div>';
    return;
  }
  if (token !== loadToken) { pdf.destroy(); return; }
  st.pdf = pdf;
  const pagesEl = $('#pages');
  pagesEl.innerHTML = '';
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    if (token !== loadToken) return;
    const vp = page.getViewport({ scale: 1 });
    const canvas = h('canvas');
    const svg = document.createElementNS(SVGNS, 'svg');
    svg.setAttribute('class', 'ov');
    svg.setAttribute('viewBox', `0 0 ${vp.width} ${vp.height}`);
    const el = h('div', { class: 'page', 'data-page': i - 1 }, canvas, h('span', { class: 'pno' }, i));
    el.append(svg);
    pagesEl.append(el);
    const p = { index: i - 1, page, doc: pdf, w: vp.width, h: vp.height, el, canvas, svg, renderedZoom: 0, task: null, visible: false };
    st.pages.push(p);
    svg.addEventListener('pointerdown', e => onDown(e, p.index));
    svg.addEventListener('pointermove', e => onMove(e));
    svg.addEventListener('pointerup', e => onUp(e));
    svg.addEventListener('pointercancel', e => onUp(e));
    observer.observe(el);
  }
  if (listItem) listItem.annotated = sol.annotations.length > 0;
  applyZoom();
}

/* ================= vykresľovanie strán ================= */

// Vykresľujú sa len strany pri viditeľnej časti, po jednej. Strany mimo obrazovky
// sa uvoľnia (canvas aj dekódované obrázky skenov), inak prehliadač pri veľkých
// skenoch zaberie gigabajty pamäte.
const MAX_CANVAS_PIXELS = 10e6;
const renderQueue = [];
let renderBusy = false;

const observer = new IntersectionObserver(entries => {
  for (const en of entries) {
    const p = st.pages.find(x => x.el === en.target);
    if (!p) continue;
    p.visible = en.isIntersecting;
    if (p.visible) queueRender(p); else releasePage(p);
  }
}, { root: $('#viewer'), rootMargin: '400px 0px' });

function queueRender(p) {
  if (p.renderedZoom === st.zoom || renderQueue.includes(p)) return;
  renderQueue.push(p);
  pumpRender();
}

async function pumpRender() {
  if (renderBusy) return;
  renderBusy = true;
  try {
    while (renderQueue.length) {
      const p = renderQueue.shift();
      if (p.doc !== st.pdf || !p.visible || p.renderedZoom === st.zoom) continue;
      await renderPage(p);
    }
  } finally {
    renderBusy = false;
  }
}

function releasePage(p) {
  if (p.task) { try { p.task.cancel(); } catch { /* */ } p.task = null; }
  if (p.renderedZoom) {
    p.canvas.width = 0; p.canvas.height = 0;
    p.renderedZoom = 0;
  }
  try { p.page.cleanup(); } catch { /* */ }
}

function releaseAllPages() {
  renderQueue.length = 0;
  for (const p of st.pages) { observer.unobserve(p.el); releasePage(p); }
}

function computeFit() {
  if (!st.pages.length) return 1;
  const maxW = Math.max(...st.pages.map(p => p.w));
  const avail = $('#viewer').clientWidth - 48 - 40;
  return Math.max(0.3, Math.min(2.5, avail / maxW));
}

function applyZoom() {
  commitTextEdit();
  if (st.fit) st.zoom = computeFit();
  $('#zoomVal').textContent = Math.round(st.zoom * 100) + '%';
  for (const p of st.pages) {
    p.el.style.width = p.w * st.zoom + 'px';
    p.el.style.height = p.h * st.zoom + 'px';
    if (p.visible) queueRender(p);
  }
  drawAll();
}

async function renderPage(p) {
  const zoom = st.zoom;
  let scale = zoom * Math.min(window.devicePixelRatio || 1, 2);
  if (p.w * p.h * scale * scale > MAX_CANVAS_PIXELS) scale = Math.sqrt(MAX_CANVAS_PIXELS / (p.w * p.h));
  const vp = p.page.getViewport({ scale });
  const c = document.createElement('canvas');
  c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
  p.task = p.page.render({ canvasContext: c.getContext('2d', { alpha: false }), viewport: vp });
  try {
    await p.task.promise;
    if (p.doc !== st.pdf || !p.visible) { c.width = 0; c.height = 0; return; }
    const old = p.canvas;
    p.el.replaceChild(c, old);
    old.width = 0; old.height = 0;
    p.canvas = c;
    p.renderedZoom = zoom;
    if (zoom !== st.zoom) queueRender(p);
  } catch {
    c.width = 0; c.height = 0;
  } finally {
    p.task = null;
    try { p.page.cleanup(); } catch { /* */ } // zahodí dekódované obrázky skenu
  }
}

/* ================= anotácie v SVG ================= */

function svgEl(tag, attrs) {
  const el = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) el.setAttribute(k, v);
  return el;
}

function drawAll() { st.pages.forEach(p => drawPage(p.index)); }

function drawPage(i) {
  const p = st.pages[i];
  if (!p) return;
  p.svg.innerHTML = '';
  for (const a of anns()) {
    if (a.page !== i || (st.editing && st.editing.a === a)) continue;
    p.svg.append(renderAnn(a, p));
  }
  const sel = st.selected && findAnn(st.selected);
  if (sel && sel.page === i && !(st.editing && st.editing.a === sel)) drawSelection(sel, p);
}

function textLines(a, g, f) {
  const size = Number(a.size);
  String(a.text || '').split('\n').forEach((line, i) => {
    if (!line) return;
    const t = svgEl('text', {
      x: a.x, y: a.y + f.ascent * size + i * size * Shared.LINE_HEIGHT,
      'font-family': f.family, 'font-size': size, fill: a.color,
    });
    t.setAttribute('xml:space', 'preserve');
    t.textContent = line;
    g.append(t);
  });
}

function stampLines(a) {
  const pts = st.cur ? st.cur.points : null;
  const lines = [[(pts === null || pts === undefined ? '?' : Shared.formatPoints(pts)) + 'B', Number(a.size)]];
  if (a.name) lines.push([a.name, a.size * Shared.STAMP_NAME_RATIO]);
  return lines;
}

function renderAnn(a, p) {
  const g = svgEl('g', { 'data-id': a.id });
  const w = Number(a.width) || 2;
  const hitW = w + 10 / st.zoom;
  if (a.type === 'text') {
    textLines(a, g, font(a.font));
  } else if (a.type === 'stamp') {
    const f = font(a.font);
    let top = a.y;
    const pts = st.cur ? st.cur.points : null;
    for (const [txt, sz] of stampLines(a)) {
      const t = svgEl('text', { x: a.x, y: top + f.ascent * sz, 'font-family': f.family, 'font-size': sz, fill: a.color, 'text-anchor': 'middle' });
      if (pts === null || pts === undefined) t.setAttribute('opacity', '0.45');
      t.textContent = txt;
      g.append(t);
      top += sz * 1.05;
    }
  } else if (a.type === 'line' || a.type === 'arrow') {
    const common = { stroke: a.color, 'stroke-width': w, 'stroke-linecap': 'round', fill: 'none' };
    if (a.type === 'line') {
      g.append(svgEl('line', { x1: a.x1, y1: a.y1, x2: a.x2, y2: a.y2, ...common }));
    } else {
      const geo = Shared.arrowGeometry(a.x1, a.y1, a.x2, a.y2, w);
      g.append(svgEl('line', { x1: geo.shaft[0], y1: geo.shaft[1], x2: geo.shaft[2], y2: geo.shaft[3], ...common }));
      g.append(svgEl('polygon', { points: geo.head.map(q => q.join(',')).join(' '), fill: a.color }));
    }
    g.append(svgEl('line', { x1: a.x1, y1: a.y1, x2: a.x2, y2: a.y2, class: 'hit', 'stroke-width': hitW }));
  } else if (a.type === 'rect' || a.type === 'ellipse') {
    const b = normBox(a);
    const mk = extra => a.type === 'rect'
      ? svgEl('rect', { x: b.x, y: b.y, width: b.w, height: b.h, ...extra })
      : svgEl('ellipse', { cx: b.x + b.w / 2, cy: b.y + b.h / 2, rx: b.w / 2, ry: b.h / 2, ...extra });
    g.append(mk({ stroke: a.color, 'stroke-width': w, fill: 'none', 'stroke-linejoin': 'round' }));
    g.append(mk({ class: 'hit', 'stroke-width': hitW }));
  } else if (a.type === 'image') {
    const b = normBox(a);
    g.append(svgEl('image', { href: '/api/assets/' + a.assetId, x: b.x, y: b.y, width: b.w, height: b.h, preserveAspectRatio: 'none' }));
    g.append(svgEl('rect', { x: b.x, y: b.y, width: b.w, height: b.h, class: 'hitfill' }));
  }
  if (a.type === 'text' || a.type === 'stamp') {
    // priehľadná plocha na chytenie textu
    p.svg.append(g);
    let bb;
    try { bb = g.getBBox(); } catch { bb = { x: a.x, y: a.y, width: 20, height: 20 }; }
    g.remove();
    const rect = svgEl('rect', { x: bb.x, y: bb.y, width: Math.max(bb.width, 8), height: Math.max(bb.height, 8), class: 'hitfill' });
    g.insertBefore(rect, g.firstChild);
    a._bb = { x: bb.x, y: bb.y, w: Math.max(bb.width, 8), h: Math.max(bb.height, 8) };
  }
  return g;
}

function normBox(a) {
  return { x: Math.min(a.x, a.x + a.w), y: Math.min(a.y, a.y + a.h), w: Math.abs(a.w), h: Math.abs(a.h) };
}

function annBox(a) {
  if (a.type === 'line' || a.type === 'arrow') return { x: Math.min(a.x1, a.x2), y: Math.min(a.y1, a.y2), w: Math.abs(a.x2 - a.x1), h: Math.abs(a.y2 - a.y1) };
  if (a.type === 'text' || a.type === 'stamp') return a._bb || { x: a.x, y: a.y, w: 20, h: 20 };
  return normBox(a);
}

function drawSelection(a, p) {
  const z = st.zoom, pad = 3 / z, r = 5 / z;
  const handle = (x, y, name) => p.svg.append(svgEl('circle', { cx: x, cy: y, r, class: 'handle', 'data-handle': name, 'data-for': a.id, 'stroke-width': 1.5 / z }));
  if (a.type === 'line' || a.type === 'arrow') {
    handle(a.x1, a.y1, 'p1'); handle(a.x2, a.y2, 'p2');
    return;
  }
  const b = annBox(a);
  p.svg.append(svgEl('rect', { x: b.x - pad, y: b.y - pad, width: b.w + 2 * pad, height: b.h + 2 * pad, class: 'selbox', 'data-sel': a.id, 'stroke-width': 1 / z }));
  if (a.type === 'text' || a.type === 'stamp') {
    handle(b.x + b.w + pad, b.y + b.h + pad, 'scale');
  } else {
    handle(b.x - pad, b.y - pad, 'nw'); handle(b.x + b.w + pad, b.y - pad, 'ne');
    handle(b.x - pad, b.y + b.h + pad, 'sw'); handle(b.x + b.w + pad, b.y + b.h + pad, 'se');
  }
}

/* ================= interakcia ================= */

function toPage(e, i) {
  const p = st.pages[i];
  const r = p.svg.getBoundingClientRect();
  return { x: (e.clientX - r.left) * p.w / r.width, y: (e.clientY - r.top) * p.h / r.height };
}

function select(id) {
  st.selected = id;
  const a = id && findAnn(id);
  if (a) syncControls(a);
  drawAll();
}

function onDown(e, pi) {
  if (e.button !== 0 || !st.cur) return;
  if (st.editing) { commitTextEdit(); return; }
  closeImageMenu();
  const pt = toPage(e, pi);
  const t = e.target;
  const handleName = t.getAttribute && t.getAttribute('data-handle');
  const idEl = t.closest && t.closest('[data-id]');
  const id = handleName ? t.getAttribute('data-for') : (idEl ? idEl.getAttribute('data-id') : (t.getAttribute && t.getAttribute('data-sel')));
  const snap = snapshot();

  if (id) {
    const a = findAnn(id);
    if (!a) return;
    if (st.selected !== id) select(id);
    if (!handleName && e.detail >= 2 && a.type === 'text') { startTextEdit(a, false); return; }
    st.drag = { mode: handleName ? 'resize' : 'move', handle: handleName, id, page: pi, start: pt, orig: clone(a), snap, box: annBox(a) };
    st.pages[pi].svg.setPointerCapture(e.pointerId);
    e.preventDefault();
    return;
  }

  const s = st.style;
  switch (st.tool) {
    case 'select':
      select(null);
      return;
    case 'text': {
      const f = font(s.font);
      const a = { id: uid(), type: 'text', page: pi, x: pt.x, y: pt.y - s.size * f.ascent * 0.7, text: '', font: s.font, size: s.size, color: s.color };
      st.cur.annotations.push(a);
      startTextEdit(a, true, snap);
      e.preventDefault();
      return;
    }
    case 'arrow': case 'line': {
      const a = { id: uid(), type: st.tool, page: pi, x1: pt.x, y1: pt.y, x2: pt.x, y2: pt.y, color: s.color, width: s.width };
      st.cur.annotations.push(a);
      st.selected = a.id;
      st.drag = { mode: 'create', id: a.id, page: pi, start: pt, snap };
      break;
    }
    case 'rect': case 'ellipse': {
      const a = { id: uid(), type: st.tool, page: pi, x: pt.x, y: pt.y, w: 0, h: 0, color: s.color, width: s.width };
      st.cur.annotations.push(a);
      st.selected = a.id;
      st.drag = { mode: 'create', id: a.id, page: pi, start: pt, snap };
      break;
    }
    case 'image': {
      if (!st.imageAsset) { openImageMenu(); return; }
      const w = 140, hh = w * st.imageAsset.ratio;
      const a = { id: uid(), type: 'image', page: pi, x: pt.x - w / 2, y: pt.y - hh / 2, w, h: hh, assetId: st.imageAsset.id };
      st.cur.annotations.push(a);
      commit(snap);
      setTool('select');
      select(a.id);
      return;
    }
    case 'stamp': {
      const a = { id: uid(), type: 'stamp', page: pi, x: pt.x, y: pt.y - s.stampSize * 0.45, size: s.stampSize, color: s.color, font: s.font, name: st.me.name };
      st.cur.annotations.push(a);
      commit(snap);
      setTool('select');
      select(a.id);
      return;
    }
    default: return;
  }
  st.pages[pi].svg.setPointerCapture(e.pointerId);
  drawPage(pi);
  e.preventDefault();
}

function onMove(e) {
  const d = st.drag;
  if (!d) return;
  const a = findAnn(d.id);
  if (!a) return;
  const pt = toPage(e, d.page);
  const dx = pt.x - d.start.x, dy = pt.y - d.start.y;
  d.moved = d.moved || Math.hypot(dx, dy) > 0.5;

  if (d.mode === 'move') {
    const o = d.orig;
    if ('x1' in o) { a.x1 = o.x1 + dx; a.y1 = o.y1 + dy; a.x2 = o.x2 + dx; a.y2 = o.y2 + dy; } else { a.x = o.x + dx; a.y = o.y + dy; }
  } else if (d.mode === 'create') {
    if (a.type === 'line' || a.type === 'arrow') {
      let x2 = pt.x, y2 = pt.y;
      if (e.shiftKey) {
        const ang = Math.round(Math.atan2(y2 - a.y1, x2 - a.x1) / (Math.PI / 4)) * (Math.PI / 4);
        const len = Math.hypot(x2 - a.x1, y2 - a.y1);
        x2 = a.x1 + Math.cos(ang) * len; y2 = a.y1 + Math.sin(ang) * len;
      }
      a.x2 = x2; a.y2 = y2;
    } else {
      let w = dx, hh = dy;
      if (e.shiftKey) { const m = Math.max(Math.abs(w), Math.abs(hh)); w = Math.sign(w || 1) * m; hh = Math.sign(hh || 1) * m; }
      a.w = w; a.h = hh;
    }
  } else if (d.mode === 'resize') {
    const o = d.orig;
    if (d.handle === 'p1') { a.x1 = pt.x; a.y1 = pt.y; } else if (d.handle === 'p2') { a.x2 = pt.x; a.y2 = pt.y; } else if (d.handle === 'scale') {
      const k = Math.max(0.1, (pt.y - d.box.y) / d.box.h);
      a.size = Math.max(4, Math.round(o.size * k * 2) / 2);
      syncControls(a);
    } else {
      const b = normBox(o);
      let x1 = b.x, y1 = b.y, x2 = b.x + b.w, y2 = b.y + b.h;
      if (d.handle.includes('w')) x1 = pt.x; else x2 = pt.x;
      if (d.handle.includes('n')) y1 = pt.y; else y2 = pt.y;
      if (a.type === 'image' && !e.shiftKey) {
        const ratio = b.h / b.w || 1;
        const w = Math.abs(x2 - x1);
        const hh = w * ratio;
        if (d.handle.includes('n')) y1 = y2 - hh; else y2 = y1 + hh;
      }
      a.x = Math.min(x1, x2); a.y = Math.min(y1, y2); a.w = Math.abs(x2 - x1); a.h = Math.abs(y2 - y1);
    }
  }
  drawPage(d.page);
}

function onUp() {
  const d = st.drag;
  if (!d) return;
  st.drag = null;
  const a = findAnn(d.id);
  if (!a) return;
  if (d.mode === 'create') {
    const small = (a.type === 'line' || a.type === 'arrow')
      ? Math.hypot(a.x2 - a.x1, a.y2 - a.y1) < 3
      : Math.abs(a.w) < 3 || Math.abs(a.h) < 3;
    if (small) {
      st.cur.annotations = st.cur.annotations.filter(x => x !== a);
      st.selected = null;
      drawPage(d.page);
      return;
    }
    if ('w' in a) Object.assign(a, normBox(a));
    commit(d.snap);
    select(a.id);
  } else if (d.moved) {
    commit(d.snap);
  }
}

/* ================= textové pole ================= */

const measureCtx = document.createElement('canvas').getContext('2d');

function startTextEdit(a, isNew, snap) {
  const p = st.pages[a.page];
  const f = font(a.font);
  const ta = h('textarea', { class: 'texted', spellcheck: 'false' });
  ta.value = a.text || '';
  st.editing = { a, isNew, snap: snap || snapshot(), ta };
  st.selected = a.id;
  const place = () => {
    const z = st.zoom;
    ta.style.left = a.x * z + 'px';
    ta.style.top = a.y * z + 'px';
    ta.style.fontFamily = `"${font(a.font).family}"`;
    ta.style.fontSize = a.size * z + 'px';
    ta.style.color = a.color;
    measureCtx.font = `${a.size * z}px "${font(a.font).family}"`;
    const lines = ta.value.split('\n');
    const w = Math.max(...lines.map(l => measureCtx.measureText(l || ' ').width));
    ta.style.width = Math.ceil(w + a.size * z * 0.8) + 'px';
    ta.style.height = Math.ceil(lines.length * a.size * z * Shared.LINE_HEIGHT + 4) + 'px';
  };
  st.editing.place = place;
  ta.addEventListener('input', place);
  ta.addEventListener('keydown', e => {
    e.stopPropagation();
    if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) { e.preventDefault(); commitTextEdit(); }
  });
  ta.addEventListener('blur', () => setTimeout(() => { if (st.editing && st.editing.ta === ta && document.activeElement !== ta) commitTextEdit(); }, 0));
  ta.addEventListener('pointerdown', e => e.stopPropagation());
  p.el.append(ta);
  place();
  drawPage(a.page);
  syncControls(a);
  void f;
  setTimeout(() => ta.focus(), 0);
}

function commitTextEdit() {
  const ed = st.editing;
  if (!ed) return;
  st.editing = null;
  const { a, ta, snap, isNew } = ed;
  const text = ta.value.replace(/\s+$/, '');
  ta.remove();
  if (!text) {
    st.cur.annotations = st.cur.annotations.filter(x => x !== a);
    st.selected = null;
    if (!isNew) commit(snap); else drawPage(a.page);
    return;
  }
  const changed = text !== a.text;
  a.text = text;
  if (changed || isNew || snap !== snapshot()) commit(snap);
  select(a.id);
}

/* ================= história a ukladanie ================= */

function commit(prevSnap) {
  st.undo.push(prevSnap);
  if (st.undo.length > 200) st.undo.shift();
  st.redo = [];
  const item = st.sols.find(s => s.id === st.cur.id);
  if (item) { item.annotated = st.cur.annotations.length > 0; }
  drawAll();
  scheduleSave();
}

function undo() {
  commitTextEdit();
  if (!st.undo.length) return;
  st.redo.push(snapshot());
  st.cur.annotations = JSON.parse(st.undo.pop());
  if (st.selected && !findAnn(st.selected)) st.selected = null;
  drawAll(); scheduleSave();
}
function redo() {
  if (!st.redo.length) return;
  st.undo.push(snapshot());
  st.cur.annotations = JSON.parse(st.redo.pop());
  if (st.selected && !findAnn(st.selected)) st.selected = null;
  drawAll(); scheduleSave();
}

let saveTimer = null, pendingId = null, inflight = Promise.resolve();
function setSaveState(cls, text) {
  const el = $('#saveState');
  el.className = 'save-state ' + cls;
  el.textContent = text;
}
function payloadFor() {
  return {
    annotations: JSON.parse(JSON.stringify(st.cur.annotations, (k, v) => (k.startsWith('_') ? undefined : v))),
    checks: st.cur.checks,
    manual_points: st.cur.manual_points,
  };
}
function scheduleSave() {
  if (!st.cur) return;
  pendingId = st.cur.id;
  setSaveState('saving', 'Neuložené…');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 450);
}
function flushSave() {
  clearTimeout(saveTimer);
  if (!pendingId || !st.cur || pendingId !== st.cur.id) { pendingId = null; return inflight; }
  const id = pendingId;
  const body = payloadFor();
  pendingId = null;
  setSaveState('saving', 'Ukladám…');
  inflight = inflight.catch(() => {}).then(() => api('/api/solutions/' + id, { method: 'PUT', body }))
    .then(r => {
      const item = st.sols.find(s => s.id === id);
      if (item) { item.points = r.points; item.annotated = body.annotations.length > 0; }
      renderSols();
      if (!pendingId) setSaveState('saved', 'Uložené');
    })
    .catch(() => {
      setSaveState('err', 'Chyba ukladania, skúšam znova…');
      if (st.cur && st.cur.id === id && !pendingId) { pendingId = id; saveTimer = setTimeout(flushSave, 3000); }
    });
  return inflight;
}
window.addEventListener('beforeunload', e => {
  if (pendingId && st.cur && pendingId === st.cur.id) {
    fetch('/api/solutions/' + pendingId, { method: 'PUT', keepalive: true, credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payloadFor()) });
    e.preventDefault();
    e.returnValue = '';
  }
});

/* ================= bodovanie ================= */

function recompute() {
  if (!st.cur) return;
  st.cur.points = Shared.computePoints(st.task.rubric, st.cur.checks, st.cur.manual_points, st.task.max_points);
  const big = $('#totalPts');
  const has = st.cur.points !== null && st.cur.points !== undefined;
  big.textContent = has ? Shared.formatPoints(st.cur.points) + 'B' : '–';
  big.classList.toggle('none', !has);
  $('#ofPts').textContent = st.task.max_points !== null && st.task.max_points !== undefined ? `z ${Shared.formatPoints(st.task.max_points)}` : '';
  const item = st.sols.find(s => s.id === st.cur.id);
  if (item) item.points = st.cur.points;
}

function gradeChanged() {
  recompute();
  renderSols();
  drawAll();
  scheduleSave();
}

function renderRubric() {
  const ul = $('#items');
  ul.innerHTML = '';
  ul.classList.toggle('editing', st.rubricEdit);
  $('#editRubric').textContent = st.rubricEdit ? 'Uložiť bodovanie' : 'Upraviť bodovanie';
  if (st.rubricEdit) {
    st.draftRubric.forEach((it, i) => {
      ul.append(h('li', {},
        h('input', { type: 'number', step: '0.5', value: it.points, title: 'Body (záporné = strhnutie)', oninput: e => { it.points = e.target.value; } }),
        h('input', { value: it.label, placeholder: 'Za čo', oninput: e => { it.label = e.target.value; } }),
        h('button', { class: 'tool', title: 'Odstrániť', onclick: () => { st.draftRubric.splice(i, 1); renderRubric(); } }, '×')));
    });
    ul.append(h('li', {}, h('button', {
      class: 'btn', style: 'grid-column: span 3', onclick: () => {
        st.draftRubric.push({ id: uid(), label: '', points: 1 }); renderRubric();
        const inputs = ul.querySelectorAll("input"); inputs[inputs.length - 1].focus();
      },
    }, '+ Pridať položku')));
    ul.append(h('li', {}, h('button', { class: 'btn', style: 'grid-column: span 3', onclick: () => { st.rubricEdit = false; renderRubric(); } }, 'Zrušiť úpravy')));
  } else {
    if (!st.task.rubric.length) ul.append(h('li', { class: 'hint' }, 'Zatiaľ žiadne položky. Klikni na „Upraviť bodovanie" a pridaj, za čo sa dávajú body.'));
    st.task.rubric.forEach((it, i) => {
      const checked = !!(st.cur && st.cur.checks.includes(it.id));
      const p = Number(it.points);
      ul.append(h('li', {}, h('label', {},
        h('input', { type: 'checkbox', checked, disabled: !st.cur, onchange: e => toggleItem(it.id, e.target.checked) }),
        h('span', { class: 'key' }, i < 9 ? i + 1 : ''),
        h('span', {}, it.label || '(bez popisu)')),
      h('span', { class: 'pbadge' + (p < 0 ? ' neg' : '') }, (p > 0 ? '+' : '') + Shared.formatPoints(p))));
    });
  }
  $('#manualIn').value = st.cur && st.cur.manual_points !== null && st.cur.manual_points !== undefined ? st.cur.manual_points : '';
  $('#manualIn').disabled = !st.cur;
  recompute();
}

function toggleItem(id, on) {
  if (!st.cur) return;
  const set = new Set(st.cur.checks);
  if (on === undefined) on = !set.has(id);
  if (on) set.add(id); else set.delete(id);
  st.cur.checks = [...set];
  renderRubric();
  gradeChanged();
}

/* ================= nástroje a štýl ================= */

function setTool(t) {
  commitTextEdit();
  st.tool = t;
  document.querySelectorAll('[data-tool]').forEach(b => b.classList.toggle('on', b.dataset.tool === t));
  $('#viewer').className = 'viewer t-' + t;
  if (t !== 'image') closeImageMenu();
}

function syncControls(a) {
  if (a.font) $('#fontSel').value = a.font;
  if (a.size) $('#sizeIn').value = a.size;
  if (a.width) $('#widthIn').value = a.width;
  if (a.color) setColorUI(a.color);
}

function setColorUI(c) {
  $('#colorIn').value = c;
  document.querySelectorAll('.swatch').forEach(s => s.classList.toggle('on', s.dataset.c.toLowerCase() === c.toLowerCase()));
}

// zmena štýlu: uloží sa ako predvolený a aplikuje sa na označený objekt
function applyStyle(key, value) {
  if (key === 'size') st.style.size = value;
  else st.style[key] = value;
  saveStyle();
  const target = st.editing ? st.editing.a : (st.selected && findAnn(st.selected));
  if (!target) return;
  const allowed = {
    text: ['font', 'size', 'color'], stamp: ['font', 'size', 'color'],
    arrow: ['color', 'width'], line: ['color', 'width'], rect: ['color', 'width'], ellipse: ['color', 'width'], image: [],
  }[target.type] || [];
  if (!allowed.includes(key) || target[key] === value) return;
  if (st.editing) { target[key] = value; st.editing.place(); return; }
  const snap = snapshot();
  target[key] = value;
  if (target.type === 'stamp' && key === 'size') { st.style.stampSize = value; saveStyle(); }
  commit(snap);
}

function buildToolbar() {
  const fs = $('#fontSel');
  for (const f of st.fonts) fs.append(h('option', { value: f.id, style: `font-family:"${f.family}"` }, f.label));
  fs.value = st.style.font;
  $('#sizeIn').value = st.style.size;
  $('#widthIn').value = st.style.width;
  const sw = $('#swatches');
  for (const c of SWATCHES) sw.append(h('button', { class: 'swatch', 'data-c': c, style: `background:${c}`, title: c, onclick: () => { setColorUI(c); applyStyle('color', c); } }));
  setColorUI(st.style.color);

  fs.onchange = () => applyStyle('font', fs.value);
  $('#sizeIn').onchange = e => { const v = Math.max(4, Math.min(200, Number(e.target.value) || 20)); applyStyle('size', v); };
  $('#widthIn').onchange = e => { const v = Math.max(0.5, Math.min(20, Number(e.target.value) || 2)); applyStyle('width', v); };
  $('#colorIn').oninput = e => { setColorUI(e.target.value); applyStyle('color', e.target.value); };

  document.querySelectorAll('[data-tool]').forEach(b => {
    b.onclick = () => {
      if (b.dataset.tool === 'image') { setTool('image'); openImageMenu(); return; }
      setTool(b.dataset.tool);
    };
  });
  $('#undoBtn').onclick = undo;
  $('#redoBtn').onclick = redo;
  $('#delBtn').onclick = deleteSelected;
  $('#zoomIn').onclick = () => { st.fit = false; st.zoom = Math.min(4, st.zoom * 1.2); applyZoom(); };
  $('#zoomOut').onclick = () => { st.fit = false; st.zoom = Math.max(0.25, st.zoom / 1.2); applyZoom(); };
  $('#zoomFit').onclick = () => { st.fit = true; applyZoom(); };
  $('#stampBtn').onclick = () => setTool('stamp');
  $('#prevBtn').onclick = () => stepSolution(-1);
  $('#nextBtn').onclick = () => stepSolution(1);
  $('#resultBtn').onclick = async () => {
    if (!st.cur) return;
    await flushSave();
    window.open(`/api/solutions/${st.cur.id}/pdf?variant=result&t=${Date.now()}`, '_blank');
  };
  $('#rbToggle').onclick = () => { $('#rubric').classList.toggle('closed'); if (st.fit) setTimeout(applyZoom, 0); };

  $('#editRubric').onclick = async () => {
    if (!st.rubricEdit) {
      st.draftRubric = clone(st.task.rubric);
      st.rubricEdit = true;
      renderRubric();
      return;
    }
    const rubric = st.draftRubric.filter(i => i.label.trim() || Number(i.points))
      .map(i => ({ id: i.id, label: i.label.trim(), points: Number(i.points) || 0 }));
    await flushSave();
    const t = await api('/api/tasks/' + st.task.id, { method: 'PUT', body: { rubric } });
    st.task.rubric = t.rubric;
    st.rubricEdit = false;
    await refreshSolsMeta();
    renderRubric(); drawAll();
  };
  $('#clearGrade').onclick = () => {
    if (!st.cur) return;
    st.cur.checks = []; st.cur.manual_points = null;
    renderRubric(); gradeChanged();
  };
  $('#manualIn').oninput = e => {
    if (!st.cur) return;
    st.cur.manual_points = e.target.value === '' ? null : Number(e.target.value);
    gradeChanged();
  };
  $('#search').oninput = e => { st.filter.q = e.target.value; renderSols(); };

  $('#settingsBtn').onclick = () => {
    const f = $('#settingsForm');
    f.name.value = st.task.name;
    f.max_points.value = st.task.max_points ?? '';
    f.comment_text.value = st.task.comment_text;
    $('#commentLbl').textContent = `Komentár (${st.task.comment_filename}) – rovnaký pre všetky riešenia`;
    $('#settings').showModal();
  };
  $('#settingsForm').onsubmit = async e => {
    e.preventDefault();
    const f = e.target;
    await flushSave();
    const t = await api('/api/tasks/' + st.task.id, { method: 'PUT', body: { name: f.name.value, max_points: f.max_points.value, comment_text: f.comment_text.value } });
    Object.assign(st.task, t);
    $('#taskName').textContent = t.name;
    $('#settings').close();
    await refreshSolsMeta();
    renderRubric(); drawAll();
  };
}

async function refreshSolsMeta() {
  const t = await api('/api/tasks/' + TASK_ID);
  const byId = Object.fromEntries(t.solutions.map(s => [s.id, s]));
  st.sols.forEach(s => { if (byId[s.id]) Object.assign(s, byId[s.id]); });
  renderSols();
}

function deleteSelected() {
  const a = st.selected && findAnn(st.selected);
  if (!a) return;
  const snap = snapshot();
  st.cur.annotations = st.cur.annotations.filter(x => x !== a);
  st.selected = null;
  commit(snap);
}

function currentPageIndex() {
  const viewer = $('#viewer').getBoundingClientRect();
  const mid = viewer.top + viewer.height / 2;
  let best = 0, bestD = Infinity;
  st.pages.forEach(p => {
    const r = p.el.getBoundingClientRect();
    const d = mid < r.top ? r.top - mid : mid > r.bottom ? mid - r.bottom : 0;
    if (d < bestD) { bestD = d; best = p.index; }
  });
  return best;
}

function paste() {
  if (!st.clipboard || !st.cur || !st.pages.length) return;
  const snap = snapshot();
  const a = clone(st.clipboard.ann);
  a.id = uid();
  const samePlace = st.clipboard.solId === st.cur.id;
  a.page = samePlace ? currentPageIndex() : Math.min(a.page, st.pages.length - 1);
  if (samePlace) {
    const off = 12;
    if ('x1' in a) { a.x1 += off; a.y1 += off; a.x2 += off; a.y2 += off; } else { a.x += off; a.y += off; }
    st.clipboard.ann = clone(a);
  }
  if (a.type === 'stamp') a.name = st.me.name;
  st.cur.annotations.push(a);
  commit(snap);
  select(a.id);
}

function nudge(dx, dy) {
  const a = st.selected && findAnn(st.selected);
  if (!a) return;
  const snap = snapshot();
  if ('x1' in a) { a.x1 += dx; a.y1 += dy; a.x2 += dx; a.y2 += dy; } else { a.x += dx; a.y += dy; }
  commit(snap);
}

function bindGlobal() {
  window.addEventListener('resize', () => { if (st.fit) applyZoom(); });
  document.addEventListener('keydown', e => {
    const tag = (e.target.tagName || '').toLowerCase();
    const typing = tag === 'input' || tag === 'textarea' || tag === 'select';
    const mod = e.ctrlKey || e.metaKey;
    if (e.altKey && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) { e.preventDefault(); stepSolution(e.key === 'ArrowDown' ? 1 : -1); return; }
    if (typing || $('#settings').open) return;
    if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
    if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
    if (mod && e.key.toLowerCase() === 'c') {
      const a = st.selected && findAnn(st.selected);
      if (a) { st.clipboard = { ann: clone(a), solId: st.cur.id }; e.preventDefault(); }
      return;
    }
    if (mod && e.key.toLowerCase() === 'v') { e.preventDefault(); paste(); return; }
    if (mod) return;
    const sel = st.selected && findAnn(st.selected);
    switch (e.key) {
      case 'Delete': case 'Backspace': if (sel) { e.preventDefault(); deleteSelected(); } return;
      case 'Escape': select(null); setTool('select'); return;
      case 'Enter': if (sel && sel.type === 'text') { e.preventDefault(); startTextEdit(sel, false); } return;
      case 'ArrowLeft': if (sel) { e.preventDefault(); nudge(e.shiftKey ? -10 : -1, 0); } return;
      case 'ArrowRight': if (sel) { e.preventDefault(); nudge(e.shiftKey ? 10 : 1, 0); } return;
      case 'ArrowUp': if (sel) { e.preventDefault(); nudge(0, e.shiftKey ? -10 : -1); } return;
      case 'ArrowDown': if (sel) { e.preventDefault(); nudge(0, e.shiftKey ? 10 : 1); } return;
      default: break;
    }
    const tools = { v: 'select', t: 'text', a: 'arrow', l: 'line', r: 'rect', e: 'ellipse', b: 'stamp' };
    const k = e.key.toLowerCase();
    if (tools[k]) { setTool(tools[k]); return; }
    if (k === 'i') { setTool('image'); openImageMenu(); return; }
    if (/^[1-9]$/.test(e.key) && st.task.rubric[Number(e.key) - 1] && !st.rubricEdit) {
      toggleItem(st.task.rubric[Number(e.key) - 1].id);
    }
  });
}

/* ================= obrázky / podpisy ================= */

let imageMenu = null;
function closeImageMenu() { if (imageMenu) { imageMenu.remove(); imageMenu = null; } }

function openImageMenu() {
  closeImageMenu();
  const btn = document.querySelector('[data-tool="image"]');
  const r = btn.getBoundingClientRect();
  const fileIn = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', hidden: true });
  const removeBg = h('input', { type: 'checkbox', checked: true });
  const grid = h('div', { class: 'imgs' });
  const drawGrid = () => {
    grid.innerHTML = '';
    if (!st.assets.length) grid.append(h('span', { class: 'hint', style: 'grid-column: span 3' }, 'Nahraj podpis alebo iný obrázok. Ostane ti uložený.'));
    for (const a of st.assets) {
      const b = h('button', {
        class: st.imageAsset && st.imageAsset.id === a.id ? 'on' : '', title: a.name,
        onclick: () => chooseAsset(a.id),
      }, h('img', { src: '/api/assets/' + a.id, alt: a.name }),
      h('span', {
        class: 'del', title: 'Zmazať z knižnice',
        onclick: async e => {
          e.stopPropagation();
          if (!confirm('Zmazať obrázok z knižnice? V už uložených PDF zostane.')) return;
          await api('/api/assets/' + a.id, { method: 'DELETE' });
          st.assets = st.assets.filter(x => x.id !== a.id);
          if (st.imageAsset && st.imageAsset.id === a.id) st.imageAsset = null;
          drawGrid();
        },
      }, '×'));
      grid.append(b);
    }
  };
  fileIn.onchange = async () => {
    const f = fileIn.files[0];
    if (!f) return;
    try {
      const dataUrl = await prepareImage(f, removeBg.checked);
      const res = await api('/api/assets', { method: 'POST', body: { name: f.name, dataUrl } });
      st.assets.unshift({ id: res.id, name: f.name });
      drawGrid();
      chooseAsset(res.id);
    } catch (e) { alert(e.message); }
  };
  imageMenu = h('div', { class: 'menu', style: `left:${r.left}px; top:${r.bottom + 6}px` },
    h('strong', {}, 'Obrázky a podpisy'),
    grid,
    h('label', { class: 'hint', style: 'display:flex;gap:6px;align-items:center;margin-bottom:8px' }, removeBg, 'Pri nahratí odstrániť biele pozadie'),
    h('button', { class: 'btn', style: 'width:100%', onclick: () => fileIn.click() }, 'Nahrať obrázok'),
    fileIn,
    h('p', { class: 'hint', style: 'margin:8px 0 0' }, 'Vyber obrázok a klikni do PDF, kam ho chceš vložiť.'));
  drawGrid();
  document.body.append(imageMenu);
}

function chooseAsset(id) {
  const img = new Image();
  img.onload = () => {
    st.imageAsset = { id, ratio: img.naturalHeight / img.naturalWidth || 0.5 };
    setTool('image');
    closeImageMenu();
  };
  img.src = '/api/assets/' + id;
}

function prepareImage(file, removeWhite) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const max = 1200;
      const k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement('canvas');
      c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
      const ctx = c.getContext('2d');
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
      resolve(c.toDataURL('image/png'));
    };
    img.onerror = () => reject(new Error('Obrázok sa nepodarilo načítať.'));
    img.src = url;
  });
}

document.addEventListener('pointerdown', e => {
  if (imageMenu && !imageMenu.contains(e.target) && !e.target.closest('[data-tool="image"]') && !e.target.closest('svg.ov')) closeImageMenu();
});

init().catch(e => { console.error(e); $('#pages').innerHTML = `<div class="loading">Chyba: ${e.message}</div>`; });
