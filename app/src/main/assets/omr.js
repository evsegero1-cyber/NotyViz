// Распознавание нотной записи (OMR) из PDF: обычные ноты — фортепиано на двух станах, партии
// инструментов, многостраничные и многодорожечные партитуры.
//
// Как работает:
// 1. Страница рисуется в изображение (pdf.js). По изображению находятся нотные станы (5 линий),
//    системы (станы, соединённые общей чертой), тактовые черты, штили, ребра и флажки.
// 2. Знаки (головки нот, паузы, ключи, знаки альтерации, точки, цифры размера, динамика) берутся:
//    • из текстового слоя PDF, если ноты набраны нотным шрифтом (Finale, Sibelius, MuseScore, Dorico…)
//      — тогда знак известен точно;
//    • иначе — из изображения (форма пятна: залитая/полая головка, размеры, отверстия).
// 3. По тактам собирается ритм. Сумма длительностей проверяется по размеру такта. Если не сходится —
//    такт помечается как неуверенный, ноты ставятся по положению на строке, и это видно в отчёте.
//    Ноты, которые не удалось определить, не придумываются.
import { PPQ } from './model.js';

// ---------- нотные шрифты ----------
const MUSIC_FONT = /maestro|petrucci|opus|sonata|jazz|engraver|bravura|leland|emmentaler|feta|gonville|leipzig|sebastian|petaluma|broadway|golden ?age|kousaku|musik|november|reprise|inkpen|lilyjazz|ashmusic|toccata|musescore|metdemo|tamburo|finale|fughetta|seville|norfolk|haydn|chopin|helsinki/i;
// Классическая раскладка Sonata/Maestro/Opus/Petrucci
const LEGACY = {
  '&': ['clef', 'G'], '?': ['clef', 'F'], 'B': ['clef', 'C'], 'V': ['clef', 'G8'],
  'œ': ['head', 1], 'Ï': ['head', 1], '˙': ['head', 2], 'w': ['head', 4], 'W': ['head', 8], 'Ó': ['rest', 2], '∑': ['rest', 'm'], 'î': ['rest', 4], '·': ['rest', 4],
  'Œ': ['rest', 1], '‰': ['rest', 0.5], '≈': ['rest', 0.25], '®': ['rest', 0.125], 'Ù': ['rest', 0.0625],
  '#': ['acc', 1], 'b': ['acc', -1], 'n': ['acc', 0], 'Ü': ['acc', 2], 'º': ['acc', -2],
  'J': ['flag', 1], 'j': ['flag', 1], 'K': ['flag', 2], 'k': ['flag', 2], '.': ['dot'], 'U': ['ferm'], 'u': ['ferm'], '>': ['accent'], '^': ['marc'],
  'c': ['tsig', 'C'], 'C': ['tsig', 'C|'], '¢': ['tsig', 'C|'],
  'p': ['dyn', 'p'], 'π': ['dyn', 'pp'], '∏': ['dyn', 'ppp'], 'P': ['dyn', 'mp'], 'F': ['dyn', 'mf'], 'f': ['dyn', 'f'], 'ƒ': ['dyn', 'ff'], 'Ï ': ['dyn', 'fff'], 'S': ['dyn', 'sf'], 'ß': ['dyn', 'sfz'], 'Z': ['dyn', 'fz'],
};
for (let d = 0; d <= 9; d++) LEGACY[String(d)] = ['digit', d];
// SMuFL (частная область Unicode)
const SMUFL = {
  0xE050: ['clef', 'G'], 0xE052: ['clef', 'G8'], 0xE062: ['clef', 'F'], 0xE05C: ['clef', 'C'],
  0xE0A4: ['head', 1], 0xE0A3: ['head', 2], 0xE0A2: ['head', 4], 0xE0A0: ['head', 8], 0xE1D2: ['head', 4],
  0xE262: ['acc', 1], 0xE260: ['acc', -1], 0xE261: ['acc', 0], 0xE263: ['acc', 2], 0xE264: ['acc', -2],
  0xE4E3: ['rest', 4], 0xE4E4: ['rest', 2], 0xE4E5: ['rest', 1], 0xE4E6: ['rest', 0.5], 0xE4E7: ['rest', 0.25], 0xE4E8: ['rest', 0.125], 0xE4EE: ['rest', 'm'],
  0xE240: ['flag', 1], 0xE241: ['flag', 1], 0xE242: ['flag', 2], 0xE243: ['flag', 2], 0xE244: ['flag', 3], 0xE245: ['flag', 3], 0xE246: ['flag', 4], 0xE247: ['flag', 4], 0xE1E7: ['dot'], 0xE4C0: ['ferm'], 0xE4C1: ['ferm'], 0xE4A0: ['accent'], 0xE4A1: ['accent'], 0xE4AC: ['marc'], 0xE4AD: ['marc'],
  0xE08A: ['tsig', 'C'], 0xE08B: ['tsig', 'C|'],
  0xE520: ['dyn', 'p'], 0xE521: ['dyn', 'm'], 0xE522: ['dyn', 'f'], 0xE52A: ['dyn', 'ppp'], 0xE52B: ['dyn', 'pp'], 0xE52C: ['dyn', 'mp'], 0xE52D: ['dyn', 'mf'], 0xE52F: ['dyn', 'ff'], 0xE530: ['dyn', 'fff'], 0xE536: ['dyn', 'sf'], 0xE539: ['dyn', 'sfz'], 0xE535: ['dyn', 'fz'],
};
for (let d = 0; d <= 9; d++) SMUFL[0xE080 + d] = ['digit', d];
const DYN_VEL = { ppp: 24, pp: 36, p: 50, mp: 64, mf: 78, f: 92, ff: 106, fff: 118, sf: 112, sfz: 116, fz: 112 };

// ---------- растровые помощники ----------
function binarize(img, W, H) {
  const d = img.data, b = new Uint8Array(W * H);
  for (let i = 0, j = 0; i < b.length; i++, j += 4) { const g = d[j] * 0.3 + d[j + 1] * 0.59 + d[j + 2] * 0.11; b[i] = g < 165 && d[j + 3] > 100 ? 1 : 0; }
  return b;
}
function integral(b, W, H) {
  const I = new Uint32Array((W + 1) * (H + 1));
  for (let y = 0; y < H; y++) { let s = 0; for (let x = 0; x < W; x++) { s += b[y * W + x]; I[(y + 1) * (W + 1) + x + 1] = I[y * (W + 1) + x + 1] + s; } }
  return I;
}
function boxSum(I, W, x0, y0, x1, y1) { // [x0,x1) [y0,y1)
  const w = W + 1; return I[y1 * w + x1] - I[y0 * w + x1] - I[y1 * w + x0] + I[y0 * w + x0];
}
// связные области (4-связность) на маске; ограничение области поиска
function components(b, W, H, rect, minPix = 3) {
  const [rx0, ry0, rx1, ry1] = rect.map(Math.round);
  const lab = new Int32Array(W * H).fill(0); const out = []; const st = [];
  for (let y = Math.max(0, ry0); y < Math.min(H, ry1); y++) for (let x = Math.max(0, rx0); x < Math.min(W, rx1); x++) {
    const i = y * W + x; if (!b[i] || lab[i]) continue;
    const id = out.length + 1; let n = 0, x0 = x, x1 = x, y0 = y, y1 = y; st.push(i); lab[i] = id;
    while (st.length) {
      const k = st.pop(); n++; const ky = (k / W) | 0, kx = k - ky * W;
      if (kx < x0) x0 = kx; if (kx > x1) x1 = kx; if (ky < y0) y0 = ky; if (ky > y1) y1 = ky;
      if (kx > rx0 && b[k - 1] && !lab[k - 1]) { lab[k - 1] = id; st.push(k - 1); }
      if (kx < rx1 - 1 && b[k + 1] && !lab[k + 1]) { lab[k + 1] = id; st.push(k + 1); }
      if (ky > ry0 && b[k - W] && !lab[k - W]) { lab[k - W] = id; st.push(k - W); }
      if (ky < ry1 - 1 && b[k + W] && !lab[k + W]) { lab[k + W] = id; st.push(k + W); }
    }
    out.push({ id, n, x0, y0, x1: x1 + 1, y1: y1 + 1 });
  }
  return { comps: out.filter(c => c.n >= minPix), lab };
}

// ---------- 1. нотные станы ----------
function findStaves(b, W, H) {
  const minRun = Math.max(10, Math.round(W * 0.008));
  const score = new Float32Array(H), rx0 = new Int32Array(H), rx1 = new Int32Array(H);
  for (let y = 0; y < H; y++) {
    let run = 0, s = 0, a = -1, z = -1;
    for (let x = 0; x <= W; x++) {
      if (x < W && b[y * W + x]) run++;
      else { if (run >= minRun) { s += run; if (a < 0) a = x - run; z = x; } run = 0; }
    }
    score[y] = s; rx0[y] = a; rx1[y] = z;
  }
  let mx = 0; for (let y = 0; y < H; y++) mx = Math.max(mx, score[y]);
  const lines = [];
  for (let y = 0; y < H; y++) {
    if (score[y] < mx * 0.3) continue;
    const L = lines[lines.length - 1];
    if (L && y - L.y1 <= 1) { L.y1 = y; L.x0 = Math.min(L.x0, rx0[y]); L.x1 = Math.max(L.x1, rx1[y]); }
    else lines.push({ y0: y, y1: y, x0: rx0[y], x1: rx1[y] });
  }
  lines.forEach(l => l.y = (l.y0 + l.y1) / 2);
  if (typeof window !== 'undefined' && window.__omrDbg) window.__omrDbg.lines = (window.__omrDbg.lines || []).concat([lines.map(l => [Math.round(l.y), l.y1 - l.y0 + 1, l.x0, l.x1])]);
  const staves = [];
  for (let i = 0; i + 4 < lines.length;) {
    const g = lines.slice(i, i + 5), d = [];
    for (let k = 0; k < 4; k++) d.push(g[k + 1].y - g[k].y);
    const m = d.reduce((a, c) => a + c, 0) / 4;
    // 6-я (или 4-я) линия с тем же шагом — это табулатура, а не нотный стан
    const nx = lines[i + 5], pv = lines[i - 1];
    const okStaff = m > 3 && d.every(v => Math.abs(v - m) < m * 0.2);
    const thMax = Math.max(...g.map(l => l.y1 - l.y0));
    const likeLine = l => l.y1 - l.y0 <= thMax && Math.abs(l.x0 - g[0].x0) < m * 2 && Math.abs(l.x1 - g[0].x1) < m * 2;
    const tab = okStaff && ((nx && Math.abs(nx.y - g[4].y - m) < m * 0.2 && likeLine(nx)) || (pv && Math.abs(g[0].y - pv.y - m) < m * 0.2 && likeLine(pv)));
    if (tab) {
      const j0 = (pv && Math.abs(g[0].y - pv.y - m) < m * 0.2) ? i - 1 : i; let j = i + 5;
      while (lines[j] && Math.abs(lines[j].y - lines[j - 1].y - m) < m * 0.2) j++;
      const L = lines.slice(j0, j);
      staves.push({ kind: 'tab', lines: L.map(l => l.y), th: Math.max(1, ...L.map(l => l.y1 - l.y0 + 1)), sp: m, x0: Math.max(...L.map(l => l.x0)), x1: Math.min(...L.map(l => l.x1)), top: L[0].y, bot: L[L.length - 1].y });
      i = j; continue;
    }
    if (m > 3 && d.every(v => Math.abs(v - m) < m * 0.2) && Math.abs(g[0].x0 - g[4].x0) < m * 3) {
      staves.push({ kind: 'staff', lines: g.map(l => l.y), th: Math.max(1, ...g.map(l => l.y1 - l.y0 + 1)), sp: m, x0: Math.max(...g.map(l => l.x0)), x1: Math.min(...g.map(l => l.x1)), top: g[0].y, bot: g[4].y });
      i += 5;
    } else i++;
  }
  return staves;
}
// стираем линии стана (оставляя пересекающие их знаки)
function removeStaffLines(b, W, H, staves) {
  const c = b.slice();
  for (const s of staves) {
    const th = s.th;
    for (const ly of s.lines) {
      const y0 = Math.round(ly - th / 2 - 0.5), y1 = Math.round(ly + th / 2 + 0.5);
      for (let x = Math.max(0, s.x0 - 2); x < Math.min(W, s.x1 + 2); x++) {
        // длина вертикального отрезка через линию
        let a = y0, z = y1;
        while (a > 0 && b[(a - 1) * W + x]) a--;
        while (z < H - 1 && b[(z + 1) * W + x]) z++;
        if (z - a + 1 <= th + 2) for (let y = a; y <= z; y++) c[y * W + x] = 0;
      }
    }
  }
  return c;
}
// для распознавания формы знаков: возвращаем пиксели линий там, где знак касается линии сверху или снизу
// (иначе бемоль или ключ распадаются на куски, если их перемычка лежит на линии)
function restoreTouching(b, c, W, H, staves) {
  const r = c.slice();
  for (const s of staves) {
    const th = s.th;
    for (const ly of s.lines) {
      const y0 = Math.round(ly - th / 2 - 0.5), y1 = Math.round(ly + th / 2 + 0.5);
      for (let x = Math.max(1, s.x0 - 2); x < Math.min(W - 1, s.x1 + 2); x++) {
        let touch = false;
        for (let dx = -1; dx <= 1 && !touch; dx++) if ((y0 > 0 && c[(y0 - 1) * W + x + dx]) || (y1 < H - 1 && c[(y1 + 1) * W + x + dx])) touch = true;
        if (touch) for (let y = y0; y <= y1; y++) if (b[y * W + x]) r[y * W + x] = 1;
      }
    }
  }
  return r;
}
// вертикальные линии (штили, тактовые черты)
function vlines(c, W, H, y0, y1, minLen, maxW) {
  const segs = [];
  for (let x = 0; x < W; x++) {
    let run = 0;
    for (let y = Math.max(0, y0); y <= Math.min(H, y1); y++) {
      if (y < y1 && c[y * W + x]) run++;
      else { if (run >= minLen) segs.push({ x, a: y - run, b: y - 1 }); run = 0; }
    }
  }
  // соединяем соседние столбцы
  segs.sort((p, q) => p.x - q.x || p.a - q.a);
  const out = [];
  for (const s of segs) {
    const o = out.find(v => s.x - v.x1 <= 1 && s.x - v.x1 >= 0 && Math.min(v.b, s.b) - Math.max(v.a, s.a) > minLen * 0.6);
    if (o) { o.x1 = s.x; o.a = Math.min(o.a, s.a); o.b = Math.max(o.b, s.b); o.n++; }
    else out.push({ x0: s.x, x1: s.x, a: s.a, b: s.b, n: 1 });
  }
  return out.filter(v => v.x1 - v.x0 + 1 <= maxW).map(v => ({ ...v, x: (v.x0 + v.x1) / 2 }));
}

// ---------- 2. знаки из текстового слоя ----------
// Точные позиции знаков нотного шрифта — из команд вывода текста PDF (матрицы текста и CTM)
async function musicGlyphs(page, vp, O) {
  const out = [];
  if (!O) return out;
  const ol = await page.getOperatorList();
  const mul = (m, n) => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
  let ctm = [1, 0, 0, 1, 0, 0]; const stack = [];
  let Tm = [1, 0, 0, 1, 0, 0], Tlm = Tm, font = null, size = 1, cs = 0, ws = 0, hs = 1, lead = 0, isMusic = false, fm = 0.001, rise = 0;
  const fontInfo = new Map();
  const getFont = id => {
    if (fontInfo.has(id)) return fontInfo.get(id);
    let f = null; try { if (page.commonObjs.has(id)) f = page.commonObjs.get(id); } catch (e) { }
    const name = f ? (f.name || f.loadedName || '') : '';
    const info = { name, music: MUSIC_FONT.test(name), fm: f && f.fontMatrix ? f.fontMatrix[0] : 0.001 };
    fontInfo.set(id, info); return info;
  };
  const show = (glyphs) => {
    for (const g of glyphs) {
      if (typeof g === 'number') { Tm = mul(Tm, [1, 0, 0, 1, -g / 1000 * size * hs, 0]); continue; }
      if (!g) continue;
      const ch = g.unicode || '';
      const code = ch.codePointAt(0) || 0;
      const t = (code >= 0xE000 && code <= 0xF8FF) ? SMUFL[code] : (isMusic ? LEGACY[ch] : null);
      if (t) {
        const M = mul(ctm, mul(Tm, [1, 0, 0, 1, 0, rise]));
        const [x, y] = vp.convertToViewportPoint(M[4], M[5]);
        const wv = (g.width || 0) * fm * size * Math.hypot(M[0], M[1]) * vp.scale;
        out.push({ type: t[0], val: t[1], x, y, w: wv, size: size * Math.hypot(M[0], M[1]) * vp.scale, ch });
      }
      const adv = ((g.width || 0) * fm * size + cs + (g.isSpace ? ws : 0)) * hs;
      Tm = mul(Tm, [1, 0, 0, 1, adv, 0]);
    }
  };
  for (let i = 0; i < ol.fnArray.length; i++) {
    const f = ol.fnArray[i], a = ol.argsArray[i];
    if (f === O.save) stack.push(ctm);
    else if (f === O.restore) { if (stack.length) ctm = stack.pop(); }
    else if (f === O.transform) ctm = mul(ctm, a);
    else if (f === O.paintFormXObjectBegin) { stack.push(ctm); if (a[0]) ctm = mul(ctm, a[0]); }
    else if (f === O.paintFormXObjectEnd) { if (stack.length) ctm = stack.pop(); }
    else if (f === O.beginText) { Tm = [1, 0, 0, 1, 0, 0]; Tlm = Tm; }
    else if (f === O.setFont) { const fi = getFont(a[0]); size = a[1]; isMusic = fi.music; fm = fi.fm; }
    else if (f === O.setTextMatrix) { Tm = a.slice(0, 6); Tlm = Tm; }
    else if (f === O.moveText) { Tlm = mul(Tlm, [1, 0, 0, 1, a[0], a[1]]); Tm = Tlm; }
    else if (f === O.setLeadingMoveText) { lead = -a[1]; Tlm = mul(Tlm, [1, 0, 0, 1, a[0], a[1]]); Tm = Tlm; }
    else if (f === O.setLeading) lead = a[0];
    else if (f === O.nextLine) { Tlm = mul(Tlm, [1, 0, 0, 1, 0, -lead]); Tm = Tlm; }
    else if (f === O.setCharSpacing) cs = a[0];
    else if (f === O.setWordSpacing) ws = a[0];
    else if (f === O.setHScale) hs = a[0] / 100;
    else if (f === O.setTextRise) rise = a[0];
    else if (f === O.showText || f === O.showSpacedText) show(a[0]);
    else if (f === O.nextLineShowText) { Tlm = mul(Tlm, [1, 0, 0, 1, 0, -lead]); Tm = Tlm; show(a[0]); }
    else if (f === O.nextLineSetSpacingShowText) { ws = a[0]; cs = a[1]; Tlm = mul(Tlm, [1, 0, 0, 1, 0, -lead]); Tm = Tlm; show(a[2]); }
  }
  return out;
}
async function textGlyphs(page, vp, O) {
  const music = await musicGlyphs(page, vp, O);
  const tc = await page.getTextContent();
  const texts = [];
  for (const it of tc.items) {
    if (!it.str || !it.str.trim()) continue;
    let fname = '';
    try { const f = page.commonObjs.has(it.fontName) ? page.commonObjs.get(it.fontName) : null; fname = (f && (f.name || f.loadedName)) || ''; } catch (e) { }
    if (MUSIC_FONT.test(fname)) continue;
    if ([...it.str].some(ch => { const c = ch.codePointAt(0); return c >= 0xE000 && c <= 0xF8FF; })) continue;
    const [a, bb, , , e, f] = it.transform;
    const [x, y] = vp.convertToViewportPoint(e, f);
    texts.push({ s: it.str.trim(), x, y, w: it.width * vp.scale, size: Math.hypot(a, bb) * vp.scale, font: fname });
  }
  return { music, texts };
}

// ---------- 3. растровые знаки (если нотного шрифта в тексте нет) ----------
function rasterHeads(c, I, W, H, st, stems) {
  const sp = st.sp, heads = [];
  const hw = Math.round(sp * 0.5), hh = Math.round(sp * 0.36);
  for (let k = -10; k <= 18; k++) {
    const y = Math.round(st.bot - k * sp / 2);
    if (y - hh < 0 || y + hh >= H) continue;
    let best = null;
    for (let x = st.x0; x < st.x1 - hw; x++) {
      const d = boxSum(I, W, x - hw, y - hh, x + hw, y + hh + 1) / ((2 * hw) * (2 * hh + 1));
      if (d > 0.82) {
        // ширина: слева и справа от головки — заметно меньше чернил (иначе это ребро или пауза)
        const L = boxSum(I, W, x - hw - Math.round(sp * 0.9), y - hh, x - hw - Math.round(sp * 0.3), y + hh + 1) / (Math.round(sp * 0.6) * (2 * hh + 1));
        const R = boxSum(I, W, x + hw + Math.round(sp * 0.3), y - hh, x + hw + Math.round(sp * 0.9), y + hh + 1) / (Math.round(sp * 0.6) * (2 * hh + 1));
        if (Math.min(L, R) > 0.55) { best = null; continue; }
        if (!best || x - best.xe > 2) { if (best) heads.push(best); best = { xs: x, xe: x, y, k, d }; }
        else { best.xe = x; best.d = Math.max(best.d, d); }
      } else if (best && x - best.xe > 2) { heads.push(best); best = null; }
    }
    if (best) heads.push(best);
  }
  // настоящая головка по высоте около интервала; конец ребра (около половины интервала) — не головка
  const vrun = (x, y) => { x = Math.round(x); let a = y, z = y; while (a > 0 && c[(a - 1) * W + x]) a--; while (z < H - 1 && c[(z + 1) * W + x]) z++; return z - a + 1; };
  return heads.filter(h => h.xe - h.xs < sp * 1.2 && Math.max(vrun((h.xs + h.xe) / 2, h.y), vrun((h.xs + h.xe) / 2 - sp * 0.25, h.y), vrun((h.xs + h.xe) / 2 + sp * 0.25, h.y)) >= sp * 0.78).map(h => ({ type: 'head', val: 1, x: (h.xs + h.xe) / 2 - sp * 0.55, w: sp * 1.15, y: h.y, k: h.k, raster: true, conf: Math.min(1, (h.d - 0.8) * 5) }));
}
function dedupeHeads(hs, sp) {
  // одна головка, найденная на соседних позициях (линия/промежуток) — оставляем более плотную
  hs.sort((a, z) => (z.conf || 0) - (a.conf || 0));
  const out = [];
  for (const h of hs) if (!out.some(o => Math.abs(o.cx - h.cx) < sp * 0.6 && Math.abs(o.k - h.k) <= 1 && (o.hollow === h.hollow || Math.abs(o.k - h.k) === 0))) out.push(h);
  return out;
}
function rasterHollow(c, W, H, st) {
  // отверстия: белые области, со всех сторон окружённые чернилами
  const sp = st.sp, out = [];
  const y0 = Math.max(0, Math.round(st.top - 6 * sp)), y1 = Math.min(H, Math.round(st.bot + 6 * sp));
  const inv = new Uint8Array(W * H);
  for (let y = y0; y < y1; y++) for (let x = st.x0; x < st.x1; x++) inv[y * W + x] = c[y * W + x] ? 0 : 1;
  const { comps } = components(inv, W, H, [st.x0, y0, st.x1, y1], 2);
  for (const h of comps) {
    const w = h.x1 - h.x0, hh = h.y1 - h.y0;
    if (w < sp * 0.3 || w > sp * 0.95 || hh < sp * 0.18 || hh > sp * 0.75 || w < hh * 1.05) continue; // отверстие головки вытянуто по горизонтали
    if (h.x0 <= st.x0 || h.y0 <= y0 || h.x1 >= st.x1 || h.y1 >= y1) continue;
    const cy = (h.y0 + h.y1) / 2, k = Math.round((st.bot - cy) / (sp / 2));
    if (Math.abs(st.bot - k * sp / 2 - cy) > sp * 0.22) continue;
    // кольцо вокруг отверстия: чернила по бокам, сверху и снизу
    const cx = (h.x0 + h.x1) / 2;
    const ink = (x, y) => c[Math.round(y) * W + Math.round(x)];
    let around = 0; for (const [dx, dy] of [[-0.45, 0], [0.45, 0], [0, -0.38], [0, 0.38]]) { let hit = 0; for (let t = 0.6; t <= 1.4; t += 0.2) if (ink(cx + dx * sp * t * (dx ? 1.1 : 1), cy + dy * sp * t)) hit = 1; around += hit; }
    if (around < 4) continue;
    out.push({ type: 'head', val: 2, x: cx - sp * 0.6, w: sp * 1.2, y: st.bot - k * sp / 2, k, raster: true, hollow: true, conf: 0.7 });
  }
  return out;
}

// ---------- 3б. классификация знаков по форме (шаблоны шрифта Bravura) ----------
const TPL_GLYPHS = [
  ['rest', 4, 0xE4E3], ['rest', 2, 0xE4E4], ['rest', 1, 0xE4E5], ['rest', 0.5, 0xE4E6], ['rest', 0.25, 0xE4E7], ['rest', 0.125, 0xE4E8],
  ['acc', 1, 0xE262], ['acc', -1, 0xE260], ['acc', 0, 0xE261], ['acc', 2, 0xE263],
  ['clef', 'G', 0xE050], ['clef', 'F', 0xE062], ['clef', 'C', 0xE05C],
  ...[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(d => ['digit', d, 0xE080 + d]), ['tsig', 'C', 0xE08A], ['tsig', 'C|', 0xE08B],
  ['flag', 1, 0xE240], ['flag', 1, 0xE241], ['flag', 2, 0xE242], ['flag', 2, 0xE243],
];
const GRID = 20;
let fontReady = null;
async function loadTplFont() {
  if (fontReady) return fontReady;
  fontReady = (async () => {
    try {
      const url = new URL('./lib/alphatab/font/Bravura.woff2', import.meta.url).href;
      const ff = new FontFace('OmrBravura', `url(${url})`); await ff.load();
      (typeof document !== 'undefined' ? document.fonts : self.fonts).add(ff); return true;
    } catch (e) { return false; }
  })();
  return fontReady;
}
const tplCache = new Map();
async function templates(sp) {
  const key = Math.round(sp * 2);
  if (tplCache.has(key)) return tplCache.get(key);
  if (!(await loadTplFont())) return null;
  const fs = sp * 4, size = Math.ceil(fs * 3);
  const cv = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(size, size) : Object.assign(document.createElement('canvas'), { width: size, height: size });
  const g = cv.getContext('2d', { willReadFrequently: true });
  const out = [];
  for (const [type, val, cp] of TPL_GLYPHS) {
    g.fillStyle = '#fff'; g.fillRect(0, 0, size, size); g.fillStyle = '#000'; g.font = `${fs}px OmrBravura`; g.textBaseline = 'alphabetic';
    const bx = Math.round(fs * 0.5), by = Math.round(fs * 1.5);
    g.fillText(String.fromCodePoint(cp), bx, by);
    const d = g.getImageData(0, 0, size, size).data;
    let x0 = size, y0 = size, x1 = -1, y1 = -1;
    const bin = new Uint8Array(size * size);
    for (let i = 0; i < size * size; i++) if (d[i * 4] < 128) { bin[i] = 1; const x = i % size, y = (i / size) | 0; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    if (x1 < 0) continue;
    // главная связная часть знака (у басового ключа — без двух точек): так знак выглядит и на странице
    { const { comps, lab } = components(bin, size, size, [x0, y0, x1 + 1, y1 + 1], 1); const big = comps.sort((a, z) => z.n - a.n)[0];
      if (big && big.n < comps.reduce((a, q) => a + q.n, 0) * 0.97) { const nb = new Uint8Array(size * size); for (let i = 0; i < nb.length; i++) nb[i] = lab[i] === big.id ? 1 : 0; bin.set(nb); x0 = big.x0; y0 = big.y0; x1 = big.x1 - 1; y1 = big.y1 - 1; } }
    out.push({ type, val, w: (x1 - x0 + 1) / sp, h: (y1 - y0 + 1) / sp, anchor: (by - y0) / (y1 - y0 + 1), grid: toGrid(bin, size, x0, y0, x1 + 1, y1 + 1, null) });
  }
  tplCache.set(key, out);
  return out;
}
function toGrid(bin, W, x0, y0, x1, y1, lab, id) {
  const gr = new Float32Array(GRID * GRID), w = x1 - x0, h = y1 - y0;
  for (let gy = 0; gy < GRID; gy++) for (let gx = 0; gx < GRID; gx++) {
    let n = 0, t = 0;
    const ya = y0 + Math.floor(gy * h / GRID), yb = Math.max(ya + 1, y0 + Math.floor((gy + 1) * h / GRID));
    const xa = x0 + Math.floor(gx * w / GRID), xb = Math.max(xa + 1, x0 + Math.floor((gx + 1) * w / GRID));
    for (let y = ya; y < yb; y++) for (let x = xa; x < xb; x++) { t++; const i = y * W + x; if (lab ? lab[i] === id : bin[i]) n++; }
    gr[gy * GRID + gx] = t ? n / t : 0;
  }
  return gr;
}
function gridScore(a, b) { let num = 0, den = 0; for (let i = 0; i < a.length; i++) { num += Math.min(a[i], b[i]); den += Math.max(a[i], b[i]); } return den ? num / den : 0; }
// знаки стана по изображению: паузы, знаки альтерации, ключи, цифры размера, точки
function rasterGlyphs(c, W, H, st, tpl, heads, V) {
  const sp = st.sp, out = [];
  const rect = [st.x0 - sp * 0.5, st.top - sp * 4, st.x1 + 2, st.bot + sp * 4];
  const { comps, lab } = components(c, W, H, rect, 3);
  for (const q of comps) {
    const w = (q.x1 - q.x0) / sp, h = (q.y1 - q.y0) / sp;
    if (w > 4 || h > 9 || (w < 0.12 && h > 1.5)) continue; // ребра, штили, длинные линии
    const cx = (q.x0 + q.x1) / 2, cy = (q.y0 + q.y1) / 2;
    // нота со штилем: головка внутри и вертикаль длиной от 2,2 интервала рядом с ней
    const hin = heads.filter(hd => hd.cx > q.x0 - 1 && hd.cx < q.x1 + 1 && hd.y > q.y0 - 1 && hd.y < q.y1 + 1);
    if (hin.length && V.some(v => v.x >= q.x0 - 1 && v.x <= q.x1 + 1 && v.b - v.a >= sp * 2.2 && v.a >= q.y0 - 2 && v.b <= q.y1 + 2 && hin.some(hd => Math.abs(hd.cx - v.x) < sp * 0.9))) continue;
    if (hin.length > 2) continue;
    // точки
    if (w >= 0.2 && w <= 0.7 && h >= 0.2 && h <= 0.7 && Math.abs(w - h) < 0.25 && q.n / ((q.x1 - q.x0) * (q.y1 - q.y0)) > 0.55) { out.push({ type: 'dot', x: q.x0, w: q.x1 - q.x0, y: cy, size: sp * 4, raster: true }); continue; }
    if (!tpl || w < 0.3 || h < 0.3) continue;
    // размер такта: две цифры, слипшиеся через среднюю линию, — делим по ней
    const midY = (st.top + st.bot) / 2;
    if (h > 3.3 && h < 4.8 && w > 0.7 && w < 2.8 && q.y0 < midY - sp && q.y1 > midY + sp && Math.abs((q.y0 + q.y1) / 2 - midY) < sp * 0.6) {
      const halves = [[q.y0, Math.round(midY)], [Math.round(midY), q.y1]];
      const got = halves.map(([ya, yb]) => {
        const gr = toGrid(null, W, q.x0, ya, q.x1, yb, lab, q.id);
        let bt = null, bsc = 0;
        for (const t of tpl) if (t.type === 'digit') { const sc = gridScore(gr, t.grid) - Math.abs(Math.log(((yb - ya) / sp) / t.h)) * 0.2; if (sc > bsc) { bsc = sc; bt = t; } }
        return { t: bt, sc: bsc, y: (ya + yb) / 2 };
      });
      if (got.every(g => g.t && g.sc > 0.42)) { for (const g of got) out.push({ type: 'digit', val: g.t.val, x: q.x0, w: q.x1 - q.x0, y: g.y, size: sp * 4, raster: true, score: g.sc, box: [q.x0, q.y0, q.x1, q.y1] }); continue; }
    }
    const grid = toGrid(null, W, q.x0, q.y0, q.x1, q.y1, lab, q.id);
    let best = null, bs = 0;
    for (const t of tpl) {
      const rw = w / t.w, rh = h / t.h;
      if (Math.abs(Math.log(rh)) > 0.32 || Math.abs(Math.log(rw)) > 0.45) {
        // мелкие ключи (смена ключа в строке) — около 0,7 от обычного
        if (!(t.type === 'clef' && Math.abs(Math.log(rh / 0.72)) < 0.2 && Math.abs(Math.log(rw / 0.72)) < 0.3)) continue;
      }
      const sc = gridScore(grid, t.grid) - Math.abs(Math.log(rh)) * 0.2;
      if (sc > bs) { bs = sc; best = t; }
    }
    if (typeof window !== 'undefined' && window.__omrDbg && q.x0 < st.x0 + sp * 12) (window.__omrDbg.cc = window.__omrDbg.cc || []).push([Math.round(q.x0), Math.round(q.y0), +w.toFixed(2), +h.toFixed(2), best && best.type, best && best.val, +bs.toFixed(2)]);
    if (!best || bs < 0.5) continue;
    const ay = q.y0 + best.anchor * (q.y1 - q.y0);
    out.push({ type: best.type, val: best.val, x: q.x0, w: q.x1 - q.x0, y: ay, size: sp * 4, raster: true, score: bs, box: [q.x0, q.y0, q.x1, q.y1] });
  }
  return out;
}

// ---------- 4. страница ----------
export async function analyzePage(page, pageNo, opts = {}) {
  const vp1 = page.getViewport({ scale: 1 });
  const render = async (scale) => {
    const vp = page.getViewport({ scale });
    const cv = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(Math.ceil(vp.width), Math.ceil(vp.height)) : Object.assign(document.createElement('canvas'), { width: Math.ceil(vp.width), height: Math.ceil(vp.height) });
    const g = cv.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, cv.width, cv.height);
    await page.render({ canvasContext: g, viewport: vp }).promise;
    return { vp, W: cv.width, H: cv.height, img: g.getImageData(0, 0, cv.width, cv.height) };
  };
  let R = await render(2);
  let b = binarize(R.img, R.W, R.H), staves = findStaves(b, R.W, R.H);
  if (staves.length) {
    const sp = staves.map(s => s.sp).sort((a, c) => a - c)[staves.length >> 1];
    const want = Math.max(1.2, Math.min(5, 2 * 15 / sp));
    if (Math.abs(want - 2) > 0.3) { R = await render(want); b = binarize(R.img, R.W, R.H); staves = findStaves(b, R.W, R.H); }
  }
  const { vp, W, H } = R;
  const tg = await textGlyphs(page, vp, opts.OPS);
  const res = { page: pageNo, scale: vp.scale, W, H, staves, systems: [], texts: tg.texts, musicFont: tg.music.filter(g => g.type === 'head').length > 4, debug: {} };
  if (!staves.length) return res;
  const c = removeStaffLines(b, W, H, staves);
  const I = integral(c, W, H);
  // системы: соседние станы, соединённые вертикальной чертой у левого края
  // тактовые черты каждого стана (для группировки в системы)
  const Vall = vlines(c, W, H, 0, H, Math.round(staves[0].sp * 1.6), Math.max(3, Math.round(staves[0].sp * 0.7)));
  for (const s of staves) s.barX = Vall.filter(v => v.a <= s.top + s.sp * 0.3 && v.b >= s.bot - s.sp * 0.3 && v.x > s.x0 + s.sp * 2 && v.x < s.x1 + 2 && (v.b - v.a) < (s.bot - s.top) + s.sp * 1.2 || (v.a <= s.top + s.sp * 0.3 && v.b >= s.bot - s.sp * 0.3 && Math.abs(v.x - s.x1) < 4)).map(v => v.x);
  const barsMatch = (p, q) => {
    const A = p.barX.filter(x => x < p.x1 - p.sp), B = q.barX.filter(x => x < q.x1 - q.sp);
    if (!A.length || !B.length) return false;
    const hit = A.filter(x => B.some(y => Math.abs(x - y) < p.sp * 0.6)).length;
    return hit >= Math.max(1, Math.min(A.length, B.length) * 0.6);
  };
  const sys = [];
  for (const s of staves) {
    const last = sys[sys.length - 1], prev = last && last[last.length - 1];
    let joined = false;
    if (prev && Math.abs(prev.x0 - s.x0) < s.sp * 1.5) {
      for (let x = Math.min(prev.x0, s.x0) - 2; x <= Math.max(prev.x0, s.x0) + 3 && !joined; x++) {
        let ink = 0, tot = 0; for (let y = Math.round(prev.bot); y <= Math.round(s.top); y++) { tot++; ink += b[y * W + x]; }
        if (tot && ink / tot > 0.9) joined = true;
      }
    }
    // без общей черты: тот же размер строки и тактовые черты на тех же местах (например, голос над фортепиано)
    if (!joined && prev && Math.abs(prev.x0 - s.x0) < s.sp * 1.5 && Math.abs(prev.x1 - s.x1) < s.sp * 1.5 && (s.top - prev.bot) < s.sp * 16 && barsMatch(prev, s)) joined = true;
    if (joined) last.push(s); else sys.push([s]);
  }
  // скобка-брейс (фортепиано): чернила слева от начала станов между двумя станами
  for (const S of sys) {
    S.forEach((s, i) => s.idx = i);
    for (let i = 0; i + 1 < S.length; i++) {
      const a = S[i], z = S[i + 1]; let ink = 0, tot = 0;
      for (let y = Math.round(a.bot); y <= Math.round(z.top); y += 2) { tot++; for (let x = Math.round(a.x0 - a.sp * 2.2); x < a.x0 - a.sp * 0.4; x++) if (b[y * W + x]) { ink++; break; } }
      a.braceNext = tot > 0 && ink / tot > 0.8 && (z.top - a.bot) < a.sp * 14;
    }
  }
  const gl = tg.music.slice();
  const rasterMode = tg.music.filter(g => g.type === 'head').length < 4;
  const tpl = rasterMode ? await templates(staves[0].sp) : null;
  let cR = null;
  for (const S of sys) {
    const sysTop = S[0].top, sysBot = S[S.length - 1].bot, sp = S[0].sp;
    // вертикали в пределах системы
    const V = vlines(c, W, H, Math.round(sysTop - sp * 5), Math.round(sysBot + sp * 5), Math.round(sp * 1.6), Math.max(3, Math.round(sp * 0.7)));
    if (rasterMode) for (const st of S) if (st.kind !== 'tab') {
      const hs = [...rasterHeads(c, I, W, H, st, []), ...rasterHollow(c, W, H, st)].map(h => ({ ...h, cx: h.x + h.w / 2 }));
      const rg = rasterGlyphs(cR || (cR = restoreTouching(b, c, W, H, staves)), W, H, st, tpl, hs, Vall);
      // отверстия внутри знаков (бемоли, диезы, цифры, ключи) — не головки
      st.rasterHeads = dedupeHeads(hs.filter(h => !rg.some(g => g.box && h.cx > g.box[0] && h.cx < g.box[2] && h.y > g.box[1] && h.y < g.box[3])), st.sp);
      gl.push(...rg);
      if (typeof window !== 'undefined' && window.__omrDbg) { const D = window.__omrDbg.gl = window.__omrDbg.gl || {}; for (const g of rg) { const k = g.type + ':' + g.val; D[k] = (D[k] || 0) + 1; } D.tpl = tpl ? tpl.length : 0; D.first = D.first || rg.filter(g => g.x < st.x0 + st.sp * 12).map(g => [g.type, g.val, Math.round(g.x), Math.round(g.y), +(g.score || 0).toFixed(2)]); }
    }
    const staffInfo = S.map(st => analyzeStaff(st, S, V, c, b, I, W, H, gl, tg.texts));
    // тактовые черты системы: общие для станов
    const bx = [];
    for (const si of staffInfo) for (const x of si.bars) bx.push(x);
    bx.sort((p, q) => p - q);
    const clusters = [];
    for (const x of bx) { const cl = clusters[clusters.length - 1]; if (cl && x - cl.x < sp * 0.8) { cl.n++; cl.x = (cl.x * (cl.n - 1) + x) / cl.n; } else clusters.push({ x, n: 1 }); }
    const need = Math.max(1, Math.ceil(S.length / 2));
    let bars = clusters.filter(cl => cl.n >= need).map(cl => cl.x);
    // концевая черта у правого края — в любом случае конец последнего такта
    const xEnd = Math.max(...S.map(s => s.x1));
    if (!bars.length || xEnd - bars[bars.length - 1] > sp * 2) bars.push(xEnd);
    // начало системы — после ключа/знаков
    res.systems.push({ staves: S.map((st, i) => ({ ...staffInfo[i], st })), bars, x0: Math.min(...S.map(s => s.x0)), top: sysTop, bot: sysBot, sp });
  }
  res.toPt = v => v / vp.scale;
  return res;
}

function analyzeStaff(st, S, V, c, b, I, W, H, gl, texts) {
  const sp = st.sp, mid = (st.top + st.bot) / 2;
  if (st.kind === 'tab') { // табулатура: только тактовые черты (ноты табулатуры этим модулем не читаются)
    const bars = V.filter(v => v.x > st.x0 + sp && v.x < st.x1 + 2 && v.a <= st.top + sp * 0.3 && v.b >= st.bot - sp * 0.3).map(v => v.x);
    return { tab: true, img: { c, W, H }, tupNums: [], bars, stems: [], heads: [], rests: [], accs: [], dots: [], clefs: [], digits: [], dyns: [], marks: [], ties: [] };
  }
  const inBand = (y) => y > st.top - sp * 6.5 && y < st.bot + sp * 6.5;
  // ближайший стан к точке (знак относится к нему)
  const near = y => { let best = null, bd = 1e9; for (const s of S) { const d = y < s.top ? s.top - y : y > s.bot ? y - s.bot : 0; if (d < bd) { bd = d; best = s; } } return best === st; };
  const G = gl.filter(g => g.x >= st.x0 - sp * 3 && g.x <= st.x1 + sp && inBand(g.y) && near(g.y));
  const fromText = !st.rasterHeads && G.filter(g => g.type === 'head').length > 0;
  // тактовые черты: вертикаль от верхней до нижней линии (или дальше — до соседнего стана)
  const bars = [];
  const stems = [];
  for (const v0 of V) {
    const v = { ...v0 }; // у каждого стана свои копии (штиль может проходить через несколько станов)
    if (v.x < st.x0 - 2 || v.x > st.x1 + 2) continue;
    const coversStaff = v.a <= st.top + sp * 0.25 && v.b >= st.bot - sp * 0.25;
    const outside = Math.max(st.top - v.a, v.b - st.bot);
    if (coversStaff && (outside < sp * 0.6 || S.some(s => s !== st && v.a <= Math.min(s.top, st.top) + sp && v.b >= Math.max(s.bot, st.bot) - sp))) bars.push(v);
    else if (v.b > st.top - sp * 6 && v.a < st.bot + sp * 6 && v.x1 - v.x0 < sp * 0.35) stems.push(v);
  }
  // головки
  // мелкие головки (форшлаги, подсказки) — меньше обычных; в ритм такта не входят
  const hs0 = G.filter(g => g.type === 'head'), medSize = hs0.length ? hs0.map(g => g.size).sort((a, z) => a - z)[hs0.length >> 1] : 0;
  let heads = fromText ? hs0.filter(g => g.size > medSize * 0.85).map(g => ({ ...g, k: Math.round((st.bot - g.y) / (sp / 2)) })) : (st.rasterHeads || []).map(h => ({ ...h }));
  heads = heads.filter(h => h.k >= -9 && h.k <= 17);
  for (const h of heads) { h.cx = h.x + h.w / 2; h.y = st.bot - h.k * sp / 2; }
  // черта, пересекающая головку, — это не тактовая черта (штиль аккорда)
  const realBars = bars.filter(v => !heads.some(h => Math.abs(h.cx - v.x) < h.w * 0.75 && h.y > v.a - sp && h.y < v.b + sp));
  for (const v of bars) if (!realBars.includes(v)) stems.push(v);
  // штили: головка у одного из концов
  for (const s of stems) {
    s.heads = heads.filter(h => Math.abs(h.y - s.b) < sp * 0.75 && Math.abs((h.x + h.w) - s.x) < sp * 0.45 || Math.abs(h.y - s.a) < sp * 0.75 && Math.abs(h.x - s.x) < sp * 0.45);
    // все головки аккорда вдоль штиля
    if (s.heads.length) {
      const up = s.heads.some(h => Math.abs(h.y - s.b) < sp * 0.75 && Math.abs((h.x + h.w) - s.x) < sp * 0.45);
      s.up = up;
      s.heads = heads.filter(h => h.y >= s.a - sp * 0.6 && h.y <= s.b + sp * 0.6 && (Math.abs((h.x + h.w) - s.x) < sp * 0.5 || Math.abs(h.x - s.x) < sp * 0.5 || (h.x < s.x && h.x + h.w > s.x)));
    }
  }
  const realStems = stems.filter(s => s.heads && s.heads.length && (s.b - s.a) > sp * 2.2);
  // ребра и флажки: число полос у свободного конца штиля
  for (const s of realStems) {
    const free = s.up ? s.a : s.b, dir = s.up ? 1 : -1;
    const maxL = Math.min(sp * 3.4, (s.b - s.a) - sp * 1.1);
    let best = 0;
    for (const side of [-1, 1]) {
      for (const off of [0.3, 0.55]) {
        const x = Math.round(side < 0 ? s.x0 - sp * off : s.x1 + sp * off);
        if (x < 0 || x >= W) continue;
        let cnt = 0, run = 0, gap = 0;
        for (let t = -Math.round(sp * 0.25); t <= maxL; t++) {
          const y = Math.round(free + dir * t); const ink = y >= 0 && y < H && c[y * W + x];
          if (ink) { run += 1 + gap; gap = 0; }
          else if (run && gap < 1) gap++; // разрыв в 1 пиксель (стёртая линия стана)
          else { if (run >= sp * 0.22 && run <= sp * 1.1) cnt++; run = 0; gap = 0; }
        }
        if (run >= sp * 0.22 && run <= sp * 1.1) cnt++;
        best = Math.max(best, cnt);
      }
    }
    s.beams = Math.min(4, best);
    // флажки нотного шрифта — точно
    const fl = G.filter(g => g.type === 'flag' && Math.abs(g.x - s.x) < sp * 0.8 && Math.abs(g.y - free) < sp * 1.5);
    if (fl.length) { s.beams = Math.max(...fl.map(f => f.val)); s.flag = true; }
  }
  // паузы, знаки, точки, ключи, размер
  const rests = G.filter(g => g.type === 'rest').map(g => ({ ...g, cx: g.x + g.w / 2 }));
  const accs = G.filter(g => g.type === 'acc').map(g => ({ ...g, k: Math.round((st.bot - g.y) / (sp / 2)), cx: g.x + g.w / 2 }));
  const dots = G.filter(g => g.type === 'dot').map(g => ({ ...g, cx: g.x + g.w / 2 }));
  const clefs = G.filter(g => g.type === 'clef').map(g => ({ ...g, cx: g.x + g.w / 2 }));
  const digits = G.filter(g => g.type === 'digit' || g.type === 'tsig').map(g => ({ ...g, cx: g.x + g.w / 2 }));
  const dyns = G.filter(g => g.type === 'dyn').map(g => ({ ...g, cx: g.x + g.w / 2 }));
  const marks = G.filter(g => ['ferm', 'accent', 'marc'].includes(g.type)).map(g => ({ ...g, cx: g.x + g.w / 2 }));
  // растровый ключ в начале стана, если нет текстового: высокий знак → скрипичный, невысокий в верхней части → басовый
  if (!clefs.length) {
    const { comps } = components(c, W, H, [st.x0, st.top - sp * 3, st.x0 + sp * 4.5, st.bot + sp * 3], 20);
    const big = comps.filter(q => q.x0 < st.x0 + sp * 3).sort((p, q) => (q.y1 - q.y0) - (p.y1 - p.y0))[0];
    if (big) {
      const h = (big.y1 - big.y0) / sp;
      if (h > 5) clefs.push({ type: 'clef', val: 'G', cx: (big.x0 + big.x1) / 2, raster: true });
      else if (h > 2.4 && h < 4 && big.y0 < st.top + sp * 0.6 && big.y1 < st.bot - sp * 0.5) clefs.push({ type: 'clef', val: 'F', cx: (big.x0 + big.x1) / 2, raster: true });
      else if (h >= 3.6 && h <= 5) clefs.push({ type: 'clef', val: 'C', cx: (big.x0 + big.x1) / 2, y: (big.y0 + big.y1) / 2, raster: true });
    }
  }
  // лиги (связующие): тонкие дуги между головками одной высоты
  const ties = findTies(c, W, H, st, heads);
  if (typeof window !== 'undefined' && window.__omrDbg) (window.__omrDbg[st.top | 0] = { stems: stems.map(s => [Math.round(s.x), Math.round(s.a), Math.round(s.b), s.x1 - s.x0 + 1, (s.heads || []).length, s.up]), heads: heads.map(h => [Math.round(h.x), Math.round(h.y), h.k, h.val]), sp, bars: bars.map(v => Math.round(v.x)) });
  // числа триолей/секстолей: цифры вне линий стана
  const tupNums = [...G.filter(g => g.type === 'digit' && g.val >= 3 && (g.y < st.top - sp * 0.4 || g.y > st.bot + sp * 0.4)).map(g => ({ x: g.x + g.w / 2, y: g.y - sp * 0.4, n: g.val })),
    ...texts.filter(t => /^[3-9]$/.test(t.s) && t.size < sp * 2.2 && t.x > st.x0 && t.x < st.x1 && t.y > st.top - sp * 6 && t.y < st.bot + sp * 6 && near(t.y)).map(t => ({ x: t.x + t.w / 2, y: t.y - t.size * 0.35, n: +t.s }))];
  return { img: { c, W, H }, tupNums, bars: realBars.map(v => v.x), stems: realStems, heads, rests, accs, dots, clefs, digits, dyns, marks, ties, raster: !fromText };
}
function findTies(c, W, H, st, heads) {
  const sp = st.sp, out = [];
  const byK = new Map(); for (const h of heads) { if (!byK.has(h.k)) byK.set(h.k, []); byK.get(h.k).push(h); }
  for (const [k, hs] of byK) {
    hs.sort((a, z) => a.cx - z.cx);
    for (let i = 0; i + 1 < hs.length; i++) {
      const a = hs[i], z = hs[i + 1]; const gap = z.x - (a.x + a.w);
      if (gap < sp * 0.25 || gap > sp * 14) continue;
      // дуга над или под головками: ищем тонкую полосу чернил в середине промежутка
      const xm = Math.round((a.x + a.w + z.x) / 2);
      for (const dir of [-1, 1]) {
        let found = false;
        for (let t = sp * 0.25; t <= sp * 1.8 && !found; t += 1) {
          const y = Math.round(a.y + dir * t); if (y < 0 || y >= H) continue;
          if (c[y * W + xm] && !c[(y - 1) * W + xm - Math.round(sp * 0.6)] !== undefined) {
            // полоса тянется в обе стороны на треть промежутка
            let l = 0, r = 0;
            for (let x = xm; x > xm - gap * 0.35; x--) { let ok = false; for (let d = -3; d <= 3; d++) if (c[(y + d) * W + x]) ok = true; if (ok) l++; }
            for (let x = xm; x < xm + gap * 0.35; x++) { let ok = false; for (let d = -3; d <= 3; d++) if (c[(y + d) * W + x]) ok = true; if (ok) r++; }
            let thick = 0; for (let d = -Math.round(sp); d <= Math.round(sp); d++) if (c[(y + d) * W + xm]) thick++;
            if (l >= gap * 0.3 && r >= gap * 0.3 && thick <= sp * 0.5) found = true;
          }
        }
        if (found) { out.push({ a, z }); break; }
      }
    }
  }
  return out;
}

// ---------- 5. сборка музыки ----------
const SHARPS = [3, 0, 4, 1, 5, 2, 6], FLATS = [6, 2, 5, 1, 4, 0, 3]; // ступени: C=0 … B=6
const STEP_SEMI = [0, 2, 4, 5, 7, 9, 11];
const CLEF_BOTTOM = { G: 30, G8: 23, F: 18, C: 24 }; // диатонический номер нижней линии (C4 = 28)
function dia2midi(D, alter) { const o = Math.floor(D / 7), s = ((D % 7) + 7) % 7; return 12 * (o + 1) + STEP_SEMI[s] + alter; }

export function assemble(pages, meta = {}) {
  const report = { pages: pages.length, systems: 0, staves: 0, measures: 0, notes: 0, unsure: 0, unsureMeasures: [], problems: [], musicFont: pages.some(p => p.musicFont), raster: pages.some(p => p.systems.some(s => s.staves.some(t => t.raster))) };
  // партии: по номеру стана в системе; фортепиано (брейс) — один инструмент из двух станов
  const allSys = []; for (const p of pages) for (const s of p.systems) { s.page = p; allSys.push(s); }
  report.systems = allSys.length;
  if (!allSys.length) return { song: null, report: Object.assign(report, { problems: ['Нотные станы не найдены. Возможно, это не ноты, скан плохого качества или только табулатура.'] }) };
  const nSt = Math.max(...allSys.map(s => s.staves.length));
  const ref = allSys.find(s => s.staves.length === nSt);
  // названия партий — текст слева от первой системы
  const names = ref.staves.map(si => {
    const t = ref.page.texts.filter(t => t.x + t.w < si.st.x0 - si.st.sp && Math.abs(t.y - (si.st.top + si.st.bot) / 2) < si.st.sp * 4);
    return t.map(x => x.s).join(' ').trim();
  });
  // группы станов: брейс связывает станы фортепиано
  const groups = []; for (let i = 0; i < nSt; i++) { const g = groups[groups.length - 1]; if (g && ref.staves[i - 1].st.braceNext) g.push(i); else groups.push([i]); }
  // темп: «= 120» в тексте
  let bpm = null, beatUnit = 1;
  for (const p of pages) for (const t of p.texts) { const m = /=\s*(\d{2,3})/.exec(t.s); if (m && !bpm) bpm = +m[1]; }
  // единица темпа по нотному знаку рядом (четверть с точкой и т. п.) — по глифам не всегда доступно
  const tempoGuess = !bpm;
  if (!bpm) bpm = 100;
  const tracks = groups.map((g, gi) => {
    const nm = names[g[0]] || names[g[g.length - 1]] || '';
    const piano = g.length >= 2 || /piano|фортеп|клав|pno|pf/i.test(nm);
    return { name: nm || (piano ? 'Фортепиано' : 'Партия ' + (gi + 1)), kind: piano ? 'piano' : 'other', program: piano ? 0 : guessProgram(nm), staffIdx: g, notes: [] };
  });
  const staffTrack = []; groups.forEach((g, gi) => g.forEach((si, k) => staffTrack[si] = { tr: gi, hand: g.length >= 2 ? (k === 0 ? 'R' : 'L') : null }));
  // состояние по станам: ключ, ключевые знаки, размер
  const state = Array.from({ length: nSt }, () => ({ clef: 'G', key: 0, sig: null, dyn: 80 }));
  const measures = []; let tick = 0; let mNo = 1;
  for (const S of allSys) {
    const sp = S.sp, toPt = S.page.toPt;
    // станы этой системы → номера партий (если станов меньше — скрытые пустые станы: по порядку сверху)
    const map = S.staves.length === nSt ? S.staves.map((x, i) => i) : matchStaves(S, ref, nSt);
    // начало системы: ключи, знаки, размер
    const xStartNotes = S.staves.map(si => firstContentX(si, S));
    S.staves.forEach((si, i) => {
      const s = state[map[i]];
      const cl = si.clefs.filter(c => c.cx < xStartNotes[i]).sort((a, z) => a.cx - z.cx)[0];
      if (cl) s.clef = cl.val;
      // ключевые знаки: знаки альтерации до первой ноты, без головок рядом
      const ks = si.accs.filter(a => a.cx < xStartNotes[i] && (!cl || a.cx > cl.cx));
      if (ks.length) s.key = ks[0].val > 0 ? ks.length : ks[0].val < 0 ? -ks.length : 0;
      else if (cl) s.key = s.keyPersist != null ? s.keyPersist : s.key;
      // размер: цифры в начале
      const dg = si.digits.filter(d => d.cx < xStartNotes[i] + sp);
      const sig = sigFrom(dg, si.st);
      if (sig) s.sig = sig;
    });
    // такты системы
    const bars = S.bars;
    const x0c = Math.min(...xStartNotes);
    let xPrev = x0c - sp * 0.5;
    const xs = [];
    for (const bx of bars) { if (bx < x0c + sp * 0.5) continue; if (bx - xPrev > sp * 1.2) xs.push([xPrev, bx]); xPrev = bx; }
    for (const [xa, xb] of xs) {
      // изменения размера/ключа/знаков посреди системы — в начале такта
      const sigNow = state.map(s => s.sig).find(Boolean) || [4, 4];
      S.staves.forEach((si, i) => { const dg = si.digits.filter(d => d.cx > xa && d.cx < xa + sp * 4 && !si.heads.some(h => Math.abs(h.cx - d.cx) < sp)); const sg = sigFrom(dg, si.st); if (sg) state[map[i]].sig = sg; });
      const sig = state.map(s => s.sig).find(Boolean) || sigNow;
      let len = sig[0] * 4 / sig[1];
      // ритм: сначала каждый стан, затем фортепиано целиком (ноты могут переходить между станами),
      // затем — по вертикальному выравниванию с уже понятыми станами
      const col = S.staves.map((si, i) => collectEvents(si, xa, xb, len, state[map[i]], sp));
      // пустой отрезок (например, предупредительный размер в конце строки) — не такт
      if (col.every(c => !c.events.length) && (xb - xa < sp * 5 || !S.staves.some(x => x.tab))) continue;
      const midOf = i => e => (S.staves[i].st.top + S.staves[i].st.bot) / 2;
      const perStaff = col.map((c, i) => Object.assign({ events: c.events, all: c.events }, sequence(c.events, len, sp, midOf(i))));
      // затакт: первый такт короче размера, суммы во всех станах одинаковы
      if (mNo === 1) {
        const ne = perStaff.filter(r => r.events.length);
        if (ne.length && ne.every(r => r.sum < len - 1e-6 && Math.abs(r.sum - ne[0].sum) < 1e-6)) {
          len = ne[0].sum; ne.forEach((r, k) => { const i = perStaff.indexOf(r); Object.assign(r, sequence(col[i].events, len, sp, midOf(i))); });
        }
      }
      for (const g of groups) {
        const idx = S.staves.map((x, i) => i).filter(i => g.includes(map[i]));
        if (idx.length < 2 || idx.every(i => perStaff[i].ok)) continue;
        const merged = idx.flatMap(i => col[i].events).sort((p, q) => p.x - q.x);
        const snap = merged.map(e => [e.on, e.dur]);
        const r = sequence(merged, len, sp, e => (S.staves[idx[0]].st.bot + S.staves[idx[idx.length - 1]].st.top) / 2);
        if (r.ok) idx.forEach(i => { perStaff[i].ok = true; perStaff[i].sum = r.sum; perStaff[i].joint = true; });
        else merged.forEach((e, k) => { e.on = snap[k][0]; e.dur = snap[k][1]; });
      }
      // выравнивание по вертикали: известные (x → доля) из понятых станов
      const anchors = [];
      perStaff.forEach(r => { if (r.ok) for (const e of r.events) anchors.push([e.x, e.on]); });
      anchors.sort((p, q) => p[0] - q[0]);
      perStaff.forEach((r, i) => {
        if (r.ok || !r.events.length) return;
        if (anchors.length < 2) { r.why = r.sum < len ? 'в такте не хватает длительностей' : 'ритм не сходится с размером'; for (const e of r.events) e.on = Math.max(0, Math.min(len - 0.0625, Math.round((e.x - xa) / (xb - xa) * len * 12) / 12)); return; }
        let exact = 0;
        for (const e of r.events) {
          const hit = anchors.find(a => Math.abs(a[0] - e.x) < sp * 0.6);
          if (hit) { e.on = hit[1]; exact++; continue; }
          let lo = [xa, 0], hi = [xb, len];
          for (const a of anchors) { if (a[0] <= e.x && a[0] >= lo[0]) lo = a; if (a[0] >= e.x && a[0] <= hi[0]) hi = a; }
          e.on = Math.round((lo[1] + (hi[1] - lo[1]) * (e.x - lo[0]) / Math.max(1, hi[0] - lo[0])) * 12) / 12;
        }
        r.aligned = true; r.why = exact === r.events.length ? 'ритм восстановлен по соседним станам' : 'ритм восстановлен приблизительно';
        if (exact === r.events.length) r.ok = true;
      });
      if (meta.debug) report.debug = (report.debug || []).concat(perStaff.map((r, i) => ({ m: mNo, staff: map[i], ok: r.ok, why: r.why, sum: r.sum, len, ev: r.events.map(e => [Math.round(e.x), e.rest ? 'R' : 'N', +e.dur.toFixed(3), e.up, e.stem ? e.stem.beams : '-', (e.heads || []).map(h => h.midi).join(','), +(e.on || 0).toFixed(3)]) })));
      perStaff.forEach(r => { r.all = r.events; for (const e of r.events) { if (e.on + e.dur > len + 1e-6) e.dur = Math.max(0.0625, len - e.on); } r.events = r.events.filter(e => !e.rest); });
      // затакт: первый такт короче размера, и во всех станах сумма одинакова
      const sums = perStaff.filter(r => r.ok && r.sum > 0).map(r => r.sum);
      if (mNo === 1 && sums.length && sums.every(v => Math.abs(v - sums[0]) < 1e-6) && sums[0] < len - 1e-6) len = sums[0];
      const mLen = Math.round(len * PPQ);
      measures.push({ n: mNo, tick, len: mLen, sig: [sig[0], sig[1]] });
      perStaff.forEach((r, i) => {
        const si = S.staves[i], stt = state[map[i]], tinfo = staffTrack[map[i]]; if (!tinfo) return;
        const tr = tracks[tinfo.tr];
        if (!r.ok && r.events.length) { report.unsureMeasures.push({ n: mNo, staff: map[i] + 1, track: tr.name, page: S.page.page, why: r.why }); }
        for (const e of r.events) {
          for (const h of e.heads) {
            const n = { t: tick + Math.round(e.on * PPQ), d: Math.max(1, Math.round(e.dur * PPQ)), m: h.midi, v: e.vel || stt.dyn, bar: mNo, page: S.page.page,
              box: [toPt(h.x), toPt(h.y - sp * 0.5), toPt(h.x + h.w), toPt(h.y + sp * 0.5)].map(v => +v.toFixed(1)) };
            if (tinfo.hand) n.h = tinfo.hand;
            if (!r.ok || h.unsure) { n.unsure = true; n.why = h.unsure || r.why; }
            if (h.tieTo) n._tie = h.tieTo;
            n._h = h;
            const x = {}; if (e.stacc) x.stacc = 1; if (e.accent) x.acc = e.accent; if (e.ferm) x.ferm = 'medium';
            if (Object.keys(x).length) n.x = x;
            tr.notes.push(n);
          }
        }
      });
      tick += mLen; mNo++;
    }
  }
  // связующие лиги: продлеваем первую ноту, вторую не играем
  for (const tr of tracks) {
    const byH = new Map(tr.notes.map(n => [n._h, n]));
    for (const n of tr.notes) if (n._tie) { const z = byH.get(n._tie); if (z && z.m === n.m && z.t > n.t) { n.d = z.t + z.d - n.t; z.tie = true; } }
    tr.notes = tr.notes.filter(n => !n.tie);
    for (const n of tr.notes) { delete n._h; delete n._tie; }
    tr.notes.sort((a, z) => a.t - z.t || a.m - z.m);
    report.notes += tr.notes.length; report.unsure += tr.notes.filter(n => n.unsure).length;
  }
  report.measures = measures.length; report.staves = nSt;
  if (allSys.some(S => S.staves.some(x => x.tab))) report.problems.push('В нотах есть табулатура: такты по ней учтены, но ноты табулатуры при распознавании обычной нотации не читаются. Табулатуры Songsterr открывайте как обычно — они распознаются отдельным способом.');
  if (tempoGuess) report.problems.push('Темп в нотах не найден — поставлен 100 ударов в минуту. Поправьте в редакторе («Темп»).');
  report.tempo = bpm;
  const song = { title: meta.title || titleFrom(pages) || 'Ноты из PDF', source: 'pdf', omr: true, tempos: [{ tick: 0, bpm }], measures, totalTicks: tick, tracks: tracks.filter(t => t.notes.length).map(t => ({ name: t.name, instrument: t.name, kind: t.kind, program: t.program, notes: t.notes })) };
  return { song, report };
}
function titleFrom(pages) {
  const p = pages[0]; if (!p || !p.texts.length) return '';
  const top = p.texts.filter(t => t.y < (p.staves[0] ? p.staves[0].top : 1e9));
  const big = top.sort((a, z) => z.size - a.size)[0];
  return big ? top.filter(t => Math.abs(t.y - big.y) < 4).map(t => t.s).join(' ') : '';
}
function guessProgram(nm) {
  const n = (nm || '').toLowerCase();
  const T = [[/voice|vocal|голос|сопрано|soprano|alto|tenor|bass voice|singer/, 52], [/violin|скрип/, 40], [/viola|альт/, 41], [/cello|виолонч/, 42], [/contrabass|double bass|контраб/, 43], [/flute|флейт/, 73], [/clarinet|кларн/, 71], [/oboe|гобо/, 68], [/bassoon|фагот/, 70], [/trumpet|труб/, 56], [/horn|валтор/, 60], [/trombone|тромб/, 57], [/sax|сакс/, 65], [/guitar|гитар/, 24], [/organ|орган/, 19], [/harp|арф/, 46]];
  for (const [re, p] of T) if (re.test(n)) return p;
  return 0;
}
function matchStaves(S, ref, nSt) {
  // в системе меньше станов (скрытые пустые партии): фортепиано (скобка) — к фортепиано, табулатура — к табулатуре,
  // остальное — по порядку того же вида
  const R = ref.staves.map((x, i) => ({ i, kind: x.st.kind, brace: !!x.st.braceNext || (i > 0 && !!ref.staves[i - 1].st.braceNext) }));
  const used = new Set(), out = [];
  S.staves.forEach((x, i) => {
    const brace = !!x.st.braceNext || (i > 0 && !!S.staves[i - 1].st.braceNext);
    let cand = R.filter(r => !used.has(r.i) && r.kind === x.st.kind && r.brace === brace);
    if (!cand.length) cand = R.filter(r => !used.has(r.i) && r.kind === x.st.kind);
    if (!cand.length) cand = R.filter(r => !used.has(r.i));
    const r = cand.find(r => !out.length || r.i > out[out.length - 1]) || cand[0];
    out.push(r ? r.i : Math.min(nSt - 1, i)); if (r) used.add(r.i);
  });
  return out;
}
function firstContentX(si, S) {
  if (si.tab) return si.st.x0 + si.st.sp * 3;
  const xs = [...si.heads.map(h => h.x), ...si.rests.map(r => r.x)];
  return xs.length ? Math.min(...xs) : si.st.x1;
}
function sigFrom(dg, st) {
  if (!dg.length) return null;
  const C = dg.find(d => d.type === 'tsig'); if (C) return C.val === 'C' ? [4, 4] : [2, 2];
  const mid = (st.top + st.bot) / 2;
  const top = dg.filter(d => d.y < mid + 1).sort((a, z) => a.x - z.x), bot = dg.filter(d => d.y >= mid + 1).sort((a, z) => a.x - z.x);
  if (!top.length || !bot.length) return null;
  const num = +top.map(d => d.val).join(''), den = +bot.map(d => d.val).join('');
  if (!num || ![1, 2, 4, 8, 16, 32].includes(den) || num > 32) return null;
  return [num, den];
}

// Ритм одного такта на одном стане
function collectEvents(si, xa, xb, len, stt, sp) {
  const st = si.st;
  const inM = x => x > xa + 1 && x < xb - 1;
  const heads = si.heads.filter(h => inM(h.cx));
  const rests = si.rests.filter(r => inM(r.cx));
  // события: аккорды на штилях; головки без штиля (целые / полые)
  const events = [];
  const used = new Set();
  for (const s of si.stems) {
    if (!inM(s.x)) continue;
    const hs = s.heads.filter(h => inM(h.cx) && !used.has(h));
    if (!hs.length) continue;
    hs.forEach(h => used.add(h));
    const hollow = hs.some(h => h.val >= 2);
    let dur = hollow ? 2 : 1 / Math.pow(2, s.beams || 0);
    events.push({ x: Math.min(...hs.map(h => h.cx)), heads: hs, dur, up: s.up, stem: s });
  }
  for (const h of heads) if (!used.has(h)) {
    const near = events.find(e => Math.abs(e.x - h.cx) < sp * 1.2 && e.heads.some(q => Math.abs(q.y - h.y) <= sp * 1.1));
    if (near) { near.heads.push(h); used.add(h); continue; }
    events.push({ x: h.cx, heads: [h], dur: h.val >= 4 ? h.val : h.val >= 2 ? (h.raster ? 4 : 2) : 1, up: null, nostem: true });
    used.add(h);
  }
  events.sort((a, z) => a.x - z.x);
  // группы под одним ребром и триоли/секстоли по цифре над группой
  {
    const { c, W } = si.img; const se = events.filter(e => e.stem && e.stem.beams > 0 && !e.stem.flag);
    let grp = [];
    const groups = [];
    for (const e of se) {
      const p = grp[grp.length - 1];
      if (p) {
        const fa = p.stem.up ? p.stem.a : p.stem.b, fb = e.stem.up ? e.stem.a : e.stem.b;
        const xm = Math.round((p.stem.x + e.stem.x) / 2), ym = Math.round((fa + fb) / 2);
        let ink = false; for (let d = -Math.round(sp * 0.6); d <= Math.round(sp * 0.6) && !ink; d++) if (c[(ym + d) * W + xm]) ink = true;
        if (ink && e.stem.x - p.stem.x < sp * 8) { grp.push(e); continue; }
        groups.push(grp);
      }
      grp = [e];
    }
    if (grp.length) groups.push(grp);
    const restsAll = rests.map(r => r); // паузы внутри группы (например, шестнадцатая пауза перед ребром)
    for (const g of groups) {
      if (g.length < 2) continue;
      const x0 = g[0].stem.x - sp, x1 = g[g.length - 1].stem.x + sp;
      const ys = g.map(e => e.stem.up ? e.stem.a : e.stem.b);
      const tn = si.tupNums.find(t => t.x > x0 - sp && t.x < x1 && ys.some(y => Math.abs(t.y - y) < sp * 3.2));
      g.restMembers = restsAll.filter(r => r.cx > g[0].x - sp * 2.2 && r.cx < g[g.length - 1].x + sp * 0.5);
      const count = g.length + g.restMembers.length;
      let n = tn ? tn.n : null;
      // та же группировка без цифры (цифру часто ставят только в первый раз)
      if (!n && stt.tup && count === stt.tup.count && g[0].stem.beams === stt.tup.beams) n = stt.tup.n;
      if (!n) continue;
      if (count !== n && count * 2 !== n) continue; // число нот в группе должно совпадать с цифрой
      if (tn) stt.tup = { n, count, beams: g[0].stem.beams };
      const normal = n === 3 ? 2 : n < 8 ? 4 : 8;
      for (const e of g) { e.dur *= normal / n; e.tup = n; }
      g.restMembers.forEach(r => r.tupScale = normal / n);
    }
    // триоль без ребра (четверти) — цифра над/под несколькими нотами
  }
  for (const r of rests) events.push({ x: r.cx, heads: [], dur: r.val === 'm' ? len : r.val * (r.tupScale || 1), rest: true, y: r.y, whole: r.val === 'm' || (r.val === 4 && Math.abs(r.cx - (xa + xb) / 2) < (xb - xa) * 0.3) });
  events.sort((a, z) => a.x - z.x);
  // точки
  for (const e of events) {
    const hx = e.rest ? e.x : Math.max(...e.heads.map(h => h.x + h.w));
    const ys = e.rest ? [e.y] : e.heads.map(h => h.y);
    const d = si.dots.filter(dt => dt.cx > hx && dt.cx < hx + sp * 1.6 && ys.some(y => Math.abs(dt.y - y) < sp * 0.75));
    if (d.length) {
      const xs = [...new Set(d.map(q => Math.round(q.cx / (sp * 0.4))))].length;
      e.dur *= xs >= 2 ? 1.75 : 1.5; e.dotted = xs;
    }
    // стаккато: точка над/под головкой
    if (!e.rest && si.dots.some(dt => Math.abs(dt.cx - e.x) < sp * 0.6 && !e.heads.some(h => Math.abs(dt.y - h.y) < sp * 0.4) && e.heads.some(h => Math.abs(dt.y - h.y) < sp * 2.2))) e.stacc = true;
    if (!e.rest && si.marks.some(mk => mk.type === 'accent' && Math.abs(mk.cx - e.x) < sp)) e.accent = 1;
    if (!e.rest && si.marks.some(mk => mk.type === 'marc' && Math.abs(mk.cx - e.x) < sp)) e.accent = 2;
    if (si.marks.some(mk => mk.type === 'ferm' && Math.abs(mk.cx - e.x) < sp * 1.2)) e.ferm = true;
  }
  if (events.some(e => e.whole)) for (const e of events) if (e.whole) e.dur = len;
  // динамика: знак под станом действует с этого места
  for (const e of events) { const dd = si.dyns.filter(d => d.cx <= e.x + sp).sort((a, z) => z.cx - a.cx)[0]; if (dd && DYN_VEL[dd.val]) { e.vel = DYN_VEL[dd.val]; } }
  const lastDyn = si.dyns.filter(d => d.cx < xb).sort((a, z) => z.cx - a.cx)[0];
  if (lastDyn && DYN_VEL[lastDyn.val]) stt.dynNext = DYN_VEL[lastDyn.val];
  // высота: ключ (может смениться в такте), ключевые и случайные знаки
  const keyAlt = {}; if (stt.key > 0) SHARPS.slice(0, stt.key).forEach(s => keyAlt[s] = 1); if (stt.key < 0) FLATS.slice(0, -stt.key).forEach(s => keyAlt[s] = -1);
  const acc = {};
  const clefAt = x => { const cs = si.clefs.filter(c => c.cx < x && c.cx > xa - sp * 0.5).sort((a, z) => z.cx - a.cx)[0]; return cs ? cs.val : stt.clef; };
  for (const e of events) if (!e.rest) {
    for (const h of e.heads) {
      const cl = clefAt(h.cx); const D = CLEF_BOTTOM[cl] + h.k;
      const a = si.accs.find(q => q.k === h.k && q.cx < h.x + 1 && q.cx > h.x - sp * 2.6);
      if (a) acc[D] = a.val;
      const alter = acc[D] != null ? acc[D] : (keyAlt[((D % 7) + 7) % 7] || 0);
      h.midi = dia2midi(D, alter);
    }
  }
  const lastClef = si.clefs.filter(c => c.cx < xb && c.cx > xa).sort((a, z) => z.cx - a.cx)[0]; if (lastClef) stt.clef = lastClef.val;
  // связующие лиги
  for (const t of si.ties) t.a.tieTo = t.z;
  return { events, len };
}
// Последовательность: один голос по порядку; два голоса (штили вверх/вниз)
function sequence(events, len, sp, mid) {
  if (!events.length) return { ok: true, sum: 0 };
  const run = (evs) => { let on = 0; for (const g of groupOnsets(evs, sp)) { for (const e of g) e.on = on; on += Math.min(...g.map(e => e.dur)); } return on; };
  const fits = v => Math.abs(v - len) < 1e-6;
  let sum = run(events);
  if (fits(sum)) return { ok: true, sum };
  const ups = events.filter(e => e.up === true || (e.rest && e.y < mid(e)) || (e.nostem && !e.rest)), downs = events.filter(e => !ups.includes(e));
  if (ups.length && downs.length) {
    const s1 = run(ups), s2 = run(downs);
    if (fits(s1) && (fits(s2) || s2 === 0)) return { ok: true, sum: len };
    if (fits(s2) && s1 === 0) return { ok: true, sum: len };
  }
  // триоли: всё ровно в 3/2 раза длиннее
  if (Math.abs(len / run(events) - 2 / 3) < 1e-6) { for (const e of events) { e.dur *= 2 / 3; e.on *= 2 / 3; } return { ok: true, sum: len }; }
  sum = run(events);
  return { ok: false, sum };
}
function groupOnsets(events, sp) {
  const g = []; for (const e of events) { const last = g[g.length - 1]; if (last && Math.abs(last[0].x - e.x) < sp * 0.7 && !e.rest && !last[0].rest) last.push(e); else g.push([e]); } return g;
}
// ---------- точка входа ----------
export async function recognizePdf(pdfjsLib, data, progress, meta = {}) {
  const doc = await pdfjsLib.getDocument({ data: data.slice ? data.slice() : data, isEvalSupported: false }).promise;
  const pages = [];
  for (let p = 1; p <= doc.numPages; p++) {
    if (progress) progress(`Распознаю ноты: страница ${p} из ${doc.numPages}…`);
    const page = await doc.getPage(p);
    pages.push(await analyzePage(page, p, { OPS: pdfjsLib.OPS }));
    page.cleanup();
  }
  return assemble(pages, meta);
}
// Есть ли на страницах обычный нотный стан (а не только табулатура)?
export function hasStandardNotation(pages) { return pages.some(p => p.staves.length > 0); }
