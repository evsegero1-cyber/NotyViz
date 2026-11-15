// Разбор PDF-табулатур Songsterr: ноты, строй, ритм, темп.
// Работает с pdf.js (getOperatorList + getTextContent), без распознавания картинок:
// цифры ладов в таких PDF нарисованы векторными контурами, их форма сравнивается с эталонами.
import TEMPLATES from './templates.js';

const GW = 8, GH = 11;

function mul(m, n) {
  return [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
}
function bbox(pts) {
  let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
  for (const [x, y] of pts) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  return { x0, y0, x1, y1 };
}

// Все контуры страницы в координатах страницы (y вниз), с цветом и типом (заливка/обводка)
async function walkPage(page, O) {
  const ol = await page.getOperatorList();
  let ctm = [1, 0, 0, 1, 0, 0], st = [], fill = [0, 0, 0], stroke = [0, 0, 0];
  const out = [];
  const H = page.view[3];
  for (let i = 0; i < ol.fnArray.length; i++) {
    const f = ol.fnArray[i], a = ol.argsArray[i];
    if (f === O.save) st.push([ctm, fill, stroke]);
    else if (f === O.restore) { if (st.length) [ctm, fill, stroke] = st.pop(); }
    else if (f === O.transform) ctm = mul(ctm, a);
    else if (f === O.paintFormXObjectBegin) { st.push([ctm, fill, stroke]); if (a[0]) ctm = mul(ctm, a[0]); }
    else if (f === O.paintFormXObjectEnd) { if (st.length) [ctm, fill, stroke] = st.pop(); }
    else if (f === O.setFillRGBColor) fill = [a[0], a[1], a[2]];
    else if (f === O.setStrokeRGBColor) stroke = [a[0], a[1], a[2]];
    else if (f === O.setFillGray) fill = [a[0] * 255, a[0] * 255, a[0] * 255];
    else if (f === O.setStrokeGray) stroke = [a[0] * 255, a[0] * 255, a[0] * 255];
    else if (f === O.constructPath) {
      const next = ol.fnArray[i + 1];
      const kind = (next === O.stroke || next === O.closeStroke) ? 'S'
        : (next === O.fill || next === O.eoFill || next === O.fillStroke || next === O.eoFillStroke) ? 'F' : '';
      if (!kind) continue;
      const T = (x, y) => [ctm[0] * x + ctm[2] * y + ctm[4], H - (ctm[1] * x + ctm[3] * y + ctm[5])];
      const ops = a[0], c = a[1];
      const subs = []; let cur = null, j = 0;
      const start = () => { cur = { t: [], p: [] }; subs.push(cur); };
      for (const op of ops) {
        if (op === O.moveTo) { start(); cur.p.push(T(c[j], c[j + 1])); cur.t.push('M'); j += 2; }
        else if (op === O.lineTo) { if (!cur) start(); cur.p.push(T(c[j], c[j + 1])); cur.t.push('L'); j += 2; }
        else if (op === O.curveTo) { if (!cur) start(); cur.p.push(T(c[j], c[j + 1]), T(c[j + 2], c[j + 3]), T(c[j + 4], c[j + 5])); cur.t.push('C'); j += 6; }
        else if (op === O.curveTo2 || op === O.curveTo3) { if (!cur) start(); cur.p.push(T(c[j], c[j + 1]), T(c[j + 2], c[j + 3])); cur.t.push('c'); j += 4; }
        else if (op === O.closePath) { if (cur) cur.t.push('Z'); }
        else if (op === O.rectangle) {
          const x = c[j], y = c[j + 1], w = c[j + 2], h = c[j + 3]; j += 4;
          subs.push({ t: ['R'], p: [T(x, y), T(x + w, y), T(x + w, y + h), T(x, y + h)] }); cur = null;
        }
      }
      for (const s of subs) s.b = bbox(s.p);
      out.push({ kind, color: kind === 'S' ? stroke : fill, subs });
    }
  }
  return out;
}

function flatten(s) {
  const pts = []; let i = 0;
  for (const t of s.t) {
    if (t === 'M' || t === 'L') pts.push(s.p[i++]);
    else if (t === 'C') {
      const p0 = pts[pts.length - 1] || s.p[i], a = s.p[i], b = s.p[i + 1], c = s.p[i + 2]; i += 3;
      for (let k = 1; k <= 6; k++) {
        const u = k / 6, v = 1 - u;
        pts.push([v * v * v * p0[0] + 3 * v * v * u * a[0] + 3 * v * u * u * b[0] + u * u * u * c[0],
          v * v * v * p0[1] + 3 * v * v * u * a[1] + 3 * v * u * u * b[1] + u * u * u * c[1]]);
      }
    } else if (t === 'c') { pts.push(s.p[i + 1]); i += 2; }
    else if (t === 'R') { pts.push(...s.p); i += 4; }
  }
  return pts;
}
function inside(x, y, polys) {
  let c = false;
  for (const p of polys) for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    const [xi, yi] = p[i], [xj, yj] = p[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c;
  }
  return c;
}
const isGray = c => Math.abs(c[0] - c[1]) < 3 && Math.abs(c[1] - c[2]) < 3;

// Залитые контуры символов → глифы (контур внутри другого контура — часть того же глифа)
function extractGlyphs(out) {
  const cs = [];
  for (const o of out) {
    if (o.kind !== 'F' || !isGray(o.color) || o.color[0] > 200) continue;
    for (const s of o.subs) {
      if (s.t[0] === 'R') continue;
      const w = s.b.x1 - s.b.x0, h = s.b.y1 - s.b.y0;
      if (h < 1.5 || h > 16 || w > 10 || w < 0.8) continue;
      cs.push({ b: s.b, s, gray: o.color[0] > 80 });
    }
  }
  cs.sort((a, b) => (b.b.x1 - b.b.x0) * (b.b.y1 - b.b.y0) - (a.b.x1 - a.b.x0) * (a.b.y1 - a.b.y0));
  const gl = [];
  for (const c of cs) {
    const host = gl.find(g => g.gray === c.gray && c.b.x0 >= g.b.x0 - 0.2 && c.b.x1 <= g.b.x1 + 0.2 && c.b.y0 >= g.b.y0 - 0.2 && c.b.y1 <= g.b.y1 + 0.2);
    if (host) host.subs.push(c.s); else gl.push({ b: c.b, subs: [c.s], gray: c.gray });
  }
  for (const g of gl) {
    const polys = g.subs.map(flatten), w = g.b.x1 - g.b.x0, h = g.b.y1 - g.b.y0;
    const bits = [];
    for (let r = 0; r < GH; r++) for (let q = 0; q < GW; q++)
      bits.push(inside(g.b.x0 + (q + .5) / GW * w, g.b.y0 + (r + .5) / GH * h, polys) ? 1 : 0);
    let best = null, bd = 1e9;
    for (const t of TEMPLATES) {
      let d = 0; for (let i = 0; i < bits.length; i++) if (bits[i] !== +t.b[i]) d++;
      d += Math.abs(w / h - t.a) * 20;
      if (d < bd) { bd = d; best = t; }
    }
    g.label = bd <= 16 ? best.l : null;
    g.w = w; g.h = h; g.cx = (g.b.x0 + g.b.x1) / 2; g.cy = (g.b.y0 + g.b.y1) / 2;
  }
  return gl.filter(g => g.label);
}

const PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
function letterPc(s) {
  const L = s[0].toUpperCase(); if (!(L in PC)) return null;
  let pc = PC[L]; if (s[1] === '#' || s[1] === '♯') pc++; if (s[1] === 'b' || s[1] === '♭') pc--;
  return (pc + 12) % 12;
}
export function inferTuning(letters, isBass) {
  const pcs = letters.map(letterPc);
  if (pcs.some(p => p === null) || !pcs.length) return null;
  const ref = isBass ? 43 : 64;
  let top = ref - 6; while ((top % 12 + 12) % 12 !== pcs[0]) top++;
  const res = [top];
  for (let i = 1; i < pcs.length; i++) {
    let m = res[i - 1] - 1; while ((m % 12 + 12) % 12 !== pcs[i]) m--;
    res.push(m);
  }
  return res;
}
export function standardTuning(n, isBass) {
  const T = {
    4: isBass ? [43, 38, 33, 28] : [62, 57, 52, 47], 5: isBass ? [43, 38, 33, 28, 23] : [64, 59, 55, 50, 45],
    6: [64, 59, 55, 50, 45, 40], 7: [64, 59, 55, 50, 45, 40, 35], 8: [64, 59, 55, 50, 45, 40, 35, 30]
  };
  return T[n] || T[6];
}

function cluster(vals, tol) {
  const s = [...vals].sort((a, b) => a - b), res = [];
  for (const v of s) { const last = res[res.length - 1]; if (last && v - last[last.length - 1] <= tol) last.push(v); else res.push([v]); }
  return res.map(g => g.reduce((a, b) => a + b, 0) / g.length);
}

// Разбор одной страницы: станы, такты, ноты-цифры, штили, лиги
async function parsePage(page, O, pageNo) {
  const out = await walkPage(page, O);
  const tc = await page.getTextContent();
  const H = page.view[3];
  const texts = tc.items.filter(it => it.str && it.str.trim()).map(it => ({
    s: it.str.trim(), x: it.transform[4], y: H - it.transform[5], h: it.height || Math.abs(it.transform[3])
  }));

  // Горизонтальные линии (струны) и вертикальные (тактовые черты, штили)
  const hl = [], vl = [];
  for (const o of out) for (const s of o.subs) {
    const b = s.b, w = b.x1 - b.x0, h = b.y1 - b.y0;
    if (s.t[0] === 'R') {
      if (h < 1.6 && w > 1) hl.push({ y: (b.y0 + b.y1) / 2, x0: b.x0, x1: b.x1, kind: o.kind, rect: true, h, color: o.color });
      else if (w < 1.2 && h > 3) vl.push({ x: (b.x0 + b.x1) / 2, y0: b.y0, y1: b.y1, kind: o.kind, color: o.color });
      continue;
    }
    if (h < 0.3 && w > 0.5 && s.t.length <= 3) hl.push({ y: b.y0, x0: b.x0, x1: b.x1, kind: o.kind, h: 0, color: o.color });
    else if (w < 0.3 && h > 2.5 && s.t.length <= 3) vl.push({ x: b.x0, y0: b.y0, y1: b.y1, kind: o.kind, color: o.color });
    else if (s.t.length >= 4 && s.t.length <= 6 && s.t.every(t => t === 'M' || t === 'L' || t === 'Z') && h < 1.8 && w > 2)
      hl.push({ y: (b.y0 + b.y1) / 2, x0: b.x0, x1: b.x1, kind: o.kind, rect: true, h, color: o.color }); // балка
    else if (s.t.length >= 4 && s.t.length <= 6 && s.t.every(t => t === 'M' || t === 'L' || t === 'Z') && w < 2.2 && h > 10)
      vl.push({ x: (b.x0 + b.x1) / 2, y0: b.y0, y1: b.y1, kind: o.kind, color: o.color }); // жирная тактовая черта
  }
  // Линии струн: обводка, суммарная длина по одной высоте большая
  const byY = new Map();
  for (const l of hl) if (l.kind === 'S' && !l.rect) {
    const k = Math.round(l.y * 4) / 4; const e = byY.get(k) || { y: l.y, len: 0, x0: 1e9, x1: -1e9 };
    e.len += l.x1 - l.x0; e.x0 = Math.min(e.x0, l.x0); e.x1 = Math.max(e.x1, l.x1); byY.set(k, e);
  }
  const lines = [...byY.values()].filter(e => e.len > 120 && e.x1 - e.x0 > 150).sort((a, b) => a.y - b.y);
  // Группы равноотстоящих линий → станы
  const staves = [];
  let grp = [];
  const flush = () => { if (grp.length >= 4) staves.push(grp); grp = []; };
  for (const l of lines) {
    if (!grp.length) { grp.push(l); continue; }
    const d = l.y - grp[grp.length - 1].y;
    const sp = grp.length >= 2 ? grp[1].y - grp[0].y : d;
    if (d > 3 && d < 14 && Math.abs(d - sp) < 0.8) grp.push(l); else { flush(); grp.push(l); }
  }
  flush();

  const glyphs = extractGlyphs(out);
  const res = [];
  for (const sg of staves) {
    const ys = sg.map(l => l.y), top = ys[0], bot = ys[ys.length - 1], sp = ys[1] - ys[0];
    const sx0 = Math.min(...sg.map(l => l.x0)), sx1 = Math.max(...sg.map(l => l.x1));
    // Тактовые черты
    const bars = cluster(vl.filter(v => v.y0 <= top + 1 && v.y1 >= bot - 1 && v.x > sx0 - 2 && v.x < sx1 + 2).map(v => v.x), 4);
    const bx = cluster([sx0, ...bars, sx1], 4);
    const measures = [];
    for (let i = 0; i + 1 < bx.length; i++) if (bx[i + 1] - bx[i] > 8) measures.push({ x0: bx[i], x1: bx[i + 1] });
    // Номера тактов
    for (const t of texts) {
      if (!/^\d+$/.test(t.s) || t.h > 10) continue;
      if (t.y > top + 1 || t.y < top - 16) continue;
      const m = measures.find(m => t.x >= m.x0 - 3 && t.x < m.x1 - 3);
      if (m && m.n == null) m.n = +t.s;
    }
    // Темп
    for (const t of texts) {
      const mt = /=\s*(\d{2,3})/.exec(t.s);
      if (!mt || t.y > top || t.y < top - 30) continue;
      const m = measures.find(m => t.x >= m.x0 - 25 && t.x < m.x1 - 5) || measures[0];
      if (m && m.tempo == null) m.tempo = +mt[1];
    }
    // Размер такта (крупные цифры на стане)
    const big = texts.filter(t => /^\d+$/.test(t.s) && t.h > 15 && t.y > top - 2 && t.y < bot + 30);
    for (let i = 0; i + 1 < big.length; i++) {
      const a = big[i], b = big[i + 1];
      if (Math.abs(a.x - b.x) < 3 && b.y > a.y) {
        const m = measures.find(m => a.x >= m.x0 - 3 && a.x < m.x1);
        if (m) m.sig = [+a.s, +b.s];
      }
    }
    // Строй (буквы слева от стана)
    const tun = texts.filter(t => /^[A-Ga-g][#b♯♭]?$/.test(t.s) && t.x < sx0 + 12 && t.y > top - 8 && t.y < bot + sp * 3)
      .sort((a, b) => a.y - b.y).map(t => t.s).slice(0, ys.length);

    // Цифры на струнах
    const onStaff = glyphs.filter(g => g.cx > sx0 && g.cx < sx1 && g.cy > top - sp * 0.7 && g.cy < bot + sp * 0.7 && g.label !== 'flag');
    const strIdx = g => { let bi = 0, bd = 1e9; ys.forEach((y, i) => { const d = Math.abs(g.cy - y); if (d < bd) { bd = d; bi = i; } }); return bd < sp * 0.5 ? bi : -1; };
    const rows = new Map();
    for (const g of onStaff) { const si = strIdx(g); if (si < 0) continue; if (!rows.has(si)) rows.set(si, []); rows.get(si).push(g); }
    const notes = [];
    for (const [si, gs] of rows) {
      gs.sort((a, b) => a.b.x0 - b.b.x0);
      let tok = null;
      const push = () => { if (tok && tok.digits) notes.push(tok); tok = null; };
      for (const g of gs) {
        const gap = tok ? g.b.x0 - tok.x1 : 99;
        if (g.label === '(') { push(); tok = { si, paren: true, digits: '', x0: g.b.x0, x1: g.b.x1, gray: g.gray, b: { ...g.b } }; continue; }
        if (g.label === ')') { if (tok) { tok.x1 = g.b.x1; tok.b.x1 = g.b.x1; } push(); continue; }
        if (tok && gap < Math.max(2.2, g.h * 0.42) && (tok.digits.length < 2 || tok.paren)) {
          tok.digits += g.label; tok.x1 = g.b.x1; tok.b.x1 = g.b.x1; tok.b.y0 = Math.min(tok.b.y0, g.b.y0); tok.b.y1 = Math.max(tok.b.y1, g.b.y1);
        } else { push(); tok = { si, paren: false, digits: g.label, x0: g.b.x0, x1: g.b.x1, gray: g.gray, b: { ...g.b } }; }
      }
      push();
    }
    for (const n of notes) {
      n.fret = +n.digits; n.cx = (n.x0 + n.x1) / 2;
      if (n.paren) { n.cx = n.x0 + (n.x1 - n.x0) / 2; }
    }
    // Лиги: залитые дуги между нотами
    const arcs = [];
    for (const o of out) {
      if (o.kind !== 'F' || !isGray(o.color) || o.color[0] > 200) continue;
      for (const s of o.subs) {
        const b = s.b, w = b.x1 - b.x0, h = b.y1 - b.y0;
        if (!s.t.includes('C') || w < 5 || h > 5 || h < 0.5) continue;
        if (b.y0 < top - sp || b.y1 > bot + sp) continue;
        arcs.push(b);
      }
    }
    // Штили и балки ритма (под станом)
    const stemsRaw = vl.filter(v => v.y0 > bot - 1.5 && v.y1 > bot + 4 && v.y0 < bot + 70 && v.y1 - v.y0 < 30 && v.x > sx0 && v.x < sx1);
    const stems = [];
    for (const v of stemsRaw) if (!stems.some(s => Math.abs(s.x - v.x) < 0.3 && Math.abs(s.y1 - v.y1) < 0.3 && Math.abs(s.y0 - v.y0) < 0.3)) stems.push({ ...v });
    const beams = [];
    for (const l of hl) if (l.rect && l.y > bot + 2 && l.y < bot + 70 && l.h > 0.5 && l.x1 - l.x0 > 2 &&
      !beams.some(b => Math.abs(b.x0 - l.x0) < 0.3 && Math.abs(b.x1 - l.x1) < 0.3 && Math.abs(b.y - l.y) < 0.3)) beams.push(l);
    const flags = glyphs.filter(g => g.label === 'flag' && g.cy > bot && g.cy < bot + 70);
    const dots = [];
    for (const o of out) if (o.kind === 'F') for (const s of o.subs) {
      const b = s.b, w = b.x1 - b.x0, h = b.y1 - b.y0;
      if (w > 0.6 && w < 2 && h > 0.6 && h < 2 && Math.abs(w - h) < 0.4 && b.y0 > bot && b.y0 < bot + 70) dots.push(b);
    }
    // Ряды голосов по нижнему концу штиля
    const rowYs = cluster(stems.map(s => s.y1), 2.5);
    const voices = rowYs.map(() => []);
    const full = Math.max(1, ...stems.map(s => s.y1 - s.y0));
    for (const s of stems) {
      let ri = 0, bd = 1e9; rowYs.forEach((y, i) => { const d = Math.abs(y - s.y1); if (d < bd) { bd = d; ri = i; } });
      const h = s.y1 - s.y0;
      const nb = beams.filter(b => b.x0 <= s.x + 0.6 && b.x1 >= s.x - 0.6 && b.y > s.y1 - full * 0.7 && b.y < s.y1 + 1).length;
      const nf = flags.filter(f => Math.abs(f.b.x0 - s.x) < 1.5 && f.cy > s.y0 - 3 && f.cy < s.y1 + 3).length;
      let dur = h < Math.max(full * 0.7, sp * 1.1) ? 2 : 1;
      const k = Math.max(nb, nf);
      if (k) dur = 1 / Math.pow(2, k);
      if (dots.some(d => d.x0 > s.x + 0.3 && d.x0 < s.x + 5 && d.y1 > s.y1 - 4 && d.y0 < s.y1 + 2)) dur *= 1.5;
      voices[ri].push({ x: s.x, dur });
    }
    voices.forEach(v => v.sort((a, b) => a.x - b.x));
    res.push({ page: pageNo, top, bot, sp, ys, sx0, sx1, measures, tun, notes, arcs, voices });
  }
  return { systems: res, texts };
}

export async function parseSongsterrPdf(pdfjsLib, data, onProgress) {
  const doc = await pdfjsLib.getDocument({ data, isEvalSupported: false }).promise;
  const O = pdfjsLib.OPS;
  const systems = []; let title = '', track = '', instrument = '';
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const r = await parsePage(page, O, p);
    if (p === 1) {
      const head = r.texts.filter(t => t.y < 90).sort((a, b) => a.y - b.y || a.x - b.x);
      const big = head.filter(t => t.h > 14 && t.s !== '—');
      title = big.map(t => t.s).join(' — ');
      const tr = head.filter(t => t.h > 8 && t.h <= 14 && t.s !== '—');
      const trk = tr.find(t => /^Track:/i.test(t.s));
      if (trk) {
        track = trk.s.replace(/^Track:\s*/i, '');
        const rest = tr.filter(t => Math.abs(t.y - trk.y) < 1 && t.x > trk.x);
        instrument = rest.map(t => t.s).join(' ');
      }
    }
    systems.push(...r.systems);
    if (onProgress) onProgress(p, doc.numPages);
  }
  if (!systems.length) throw new Error('В файле не найдено табулатуры. Подходят PDF, сохранённые из Songsterr.');
  return buildSong(systems, { title, track, instrument });
}

export function buildSong(systems, meta) {
  const nStr = systems[0].ys.length;
  const isBass = /bass|бас/i.test(meta.track + ' ' + meta.instrument) || nStr <= 5 && /bass/i.test(meta.instrument);
  const letters = (systems.find(s => s.tun.length === nStr) || {}).tun;
  const tuning = (letters && inferTuning(letters, isBass)) || standardTuning(nStr, isBass);
  const tuningNames = letters && letters.length === nStr ? letters : null;

  // Такты по порядку
  const ms = [];
  let lastN = 0, sig = [4, 4], tempo = 120, firstTempo = null;
  for (const sy of systems) for (const m of sy.measures) {
    const n = m.n != null ? m.n : lastN + 1; lastN = n;
    if (m.sig) sig = m.sig;
    if (m.tempo) { tempo = m.tempo; if (firstTempo == null) firstTempo = tempo; }
    ms.push({ n, sy, x0: m.x0, x1: m.x1, len: sig[0] * 4 / sig[1], sig: [...sig], tempo });
  }
  let beat = 0;
  for (const m of ms) { m.start = beat; beat += m.len; }
  const total = beat;

  const notes = [];
  for (const m of ms) {
    const sy = m.sy;
    const inM = x => x >= m.x0 - 0.5 && x < m.x1 - 0.5;
    const mNotes = sy.notes.filter(n => inM(n.cx));
    // Ритм голосов этого такта
    const vts = sy.voices.map(v => {
      const ev = v.filter(s => inM(s.x)).map(s => ({ ...s }));
      let sum = ev.reduce((a, e) => a + e.dur, 0);
      let t = 0;
      const deficit = m.len - sum;
      if (deficit > 0.01 && ev.length && ev[0].x - m.x0 > (m.x1 - m.x0) * 0.22) t = deficit;
      if (sum > m.len + 0.01) { const k = m.len / sum; ev.forEach(e => e.dur *= k); }
      for (const e of ev) { e.t = t; t += e.dur; }
      return ev;
    });
    // Колонки (ноты с одинаковым x)
    const cols = cluster(mNotes.map(n => n.cx), 2.6).map(x => ({ x }));
    for (const c of cols) {
      const hits = [];
      vts.forEach((ev, vi) => { const e = ev.find(e => Math.abs(e.x - c.x) < 3.2); if (e) hits.push({ vi, e }); });
      c.hits = hits;
      if (hits.length) { c.t = hits[0].e.t; c.dur = Math.max(...hits.map(h => h.e.dur)); }
    }
    // Колонки без штилей — по положению
    const known = cols.filter(c => c.t != null);
    for (const c of cols) if (c.t == null) {
      const L = [...known].reverse().find(k => k.x < c.x), R = known.find(k => k.x > c.x);
      const xa = L ? L.x : m.x0 + 4, ta = L ? L.t : 0, xb = R ? R.x : m.x1, tb = R ? R.t : m.len;
      c.t = ta + (tb - ta) * Math.max(0, Math.min(1, (c.x - xa) / Math.max(1, xb - xa)));
      if (!L && !R) c.t = 0;
      c.dur = null;
    }
    cols.sort((a, b) => a.t - b.t);
    cols.forEach((c, i) => { if (c.dur == null) c.dur = (i + 1 < cols.length ? cols[i + 1].t : m.len) - c.t; });
    for (const n of mNotes) {
      let c = cols[0], bd = 1e9; for (const k of cols) { const d = Math.abs(k.x - n.cx); if (d < bd) { bd = d; c = k; } }
      let dur = c.dur;
      if (n.gray && c.hits.length > 1) dur = c.hits[c.hits.length - 1].e.dur;
      const midi = tuning[n.si] + n.fret;
      notes.push({ midi, string: n.si, fret: n.fret, start: m.start + c.t, dur: Math.max(0.05, dur), measure: m.n,
        tie: !!n.paren, gray: !!n.gray, src: n, x: n.cx, sy });
    }
  }
  notes.sort((a, b) => a.start - b.start || a.midi - b.midi);
  // Обрезка: следующая нота на той же струне прерывает звук
  for (let i = 0; i < notes.length; i++) {
    const a = notes[i];
    for (let j = i + 1; j < notes.length; j++) {
      const b = notes[j];
      if (b.start >= a.start + a.dur - 1e-6) break;
      if (b.string === a.string && b.sy === a.sy && b.start > a.start + 1e-6 && !b.tie) { a.dur = b.start - a.start; break; }
    }
  }
  // Лиги-дуги внутри системы: продлеваем ноту до конца события под концом дуги
  for (const sy of systems) for (const arc of sy.arcs) {
    const cand = notes.filter(n => n.sy === sy && Math.abs(n.src.x1 - arc.x0) < 4 && arc.y0 > n.src.b.y0 - 1 && arc.y0 < n.src.b.y1 + sy.sp * 0.9);
    if (!cand.length) continue;
    cand.sort((a, b) => Math.abs(a.src.b.y1 - arc.y0) - Math.abs(b.src.b.y1 - arc.y0));
    const a = cand[0];
    const after = notes.filter(n => n.sy === sy && n.x > arc.x1 - 3 && n.x < arc.x1 + 4);
    const tgt = after.find(n => n.midi === a.midi) || after[0];
    if (tgt) {
      if (tgt.midi === a.midi && !tgt.tie) tgt.tie = true;
      a.dur = Math.max(a.dur, tgt.start + tgt.dur - a.start);
    } else {
      const m = ms.find(m => m.sy === sy && arc.x1 >= m.x0 && arc.x1 <= m.x1 + 2);
      if (m && arc.x1 >= m.x1 - 3) a.dur = Math.max(a.dur, m.start + m.len - a.start);
    }
  }
  // Ноты в скобках и связанные — продолжение предыдущей ноты той же высоты
  const outNotes = [];
  for (const n of notes) {
    if (n.tie) {
      const prev = [...outNotes].reverse().find(p => p.midi === n.midi && p.start < n.start - 1e-6 && p.start + p.dur >= n.start - 0.6);
      if (prev) { prev.dur = Math.max(prev.dur, n.start + n.dur - prev.start); continue; }
    }
    outNotes.push(n);
  }
  const clean = outNotes.map(n => ({ midi: n.midi, start: +n.start.toFixed(4), dur: +n.dur.toFixed(4), string: n.string, fret: n.fret, measure: n.measure, voice: n.gray ? 1 : 0,
    page: n.sy.page, box: [n.src.b.x0, n.src.b.y0, n.src.b.x1, n.src.b.y1].map(v => +v.toFixed(1)) }));
  return {
    title: meta.title || 'Без названия', track: meta.track, instrument: meta.instrument,
    tuning, tuningNames, strings: nStr, isBass,
    measures: ms.map(m => ({ n: m.n, start: m.start, len: m.len, tempo: m.tempo, sig: m.sig })),
    totalBeats: total, notes: clean
  };
}
