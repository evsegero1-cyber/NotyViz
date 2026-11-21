// Разбор PDF-табулатур Songsterr: ноты, строй, ритм, темп.
// Работает с pdf.js (getOperatorList + getTextContent), без распознавания картинок:
// цифры ладов в таких PDF нарисованы векторными контурами, их форма сравнивается с эталонами.
import TEMPLATES from './templates.js';

const GW = 8, GH = 11;
// Версия разбора: при её смене сохранённые PDF Songsterr разбираются заново (2 — паузы, глухие ноты, штили ударных)
export const PARSER_VERSION = 6; // 6 — гитара в низких строях не путается с басом; // 5 — темп: accel./rit., единица темпа, отметки выше подписей // 3 — форшлаги, бенды, части; 4 — слова песни

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
export async function walkPage(page, O) {
  const ol = await page.getOperatorList();
  let ctm = [1, 0, 0, 1, 0, 0], st = [], fill = [0, 0, 0], stroke = [0, 0, 0];
  const out = [];
  const H = page.view[3];
  // буквы текста с точным положением (подписи слов песни в PDF идут по одной букве)
  const chars = []; out.chars = chars;
  let tm = [1, 0, 0, 1, 0, 0], lm = tm, fsz = 10, cs = 0, ws = 0, hs = 1;
  for (let i = 0; i < ol.fnArray.length; i++) {
    const f = ol.fnArray[i], a = ol.argsArray[i];
    if (f === O.beginText) { tm = lm = [1, 0, 0, 1, 0, 0]; }
    else if (f === O.setFont) fsz = a[1] || fsz;
    else if (f === O.setTextMatrix) { const m = Array.isArray(a[0]) ? a[0] : a; tm = lm = [m[0], m[1], m[2], m[3], m[4], m[5]]; }
    else if (f === O.moveText) { lm = mul(lm, [1, 0, 0, 1, a[0], a[1]]); tm = lm; }
    else if (f === O.setCharSpacing) cs = a[0];
    else if (f === O.setWordSpacing) ws = a[0];
    else if (f === O.setHScale) hs = a[0] / 100;
    else if (f === O.showText || f === O.showSpacedText) {
      for (const gq of a[0] || []) {
        if (typeof gq === 'number') { tm = mul(tm, [1, 0, 0, 1, -gq / 1000 * fsz * hs, 0]); continue; }
        if (!gq) continue;
        const M = mul(ctm, tm), x = M[4], y = H - M[5], sc = Math.hypot(M[2], M[3]) * fsz;
        const adv = ((gq.width || 0) / 1000 * fsz + cs + (gq.isSpace ? ws : 0)) * hs;
        const xw = Math.hypot(M[0], M[1]) * adv;
        chars.push({ c: gq.unicode || '', x, y, w: xw, h: sc, color: fill });
        tm = mul(tm, [1, 0, 0, 1, adv, 0]);
      }
    }
    else if (f === O.save) st.push([ctm, fill, stroke]);
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
    // Ноты ударных: залитая овальная головка, крестик, крестик в кружке
    const t0 = g.subs[0].t.join(''), ar = w / h;
    const nC = (t0.match(/C/g) || []).length, nL = (t0.match(/L/g) || []).length;
    let head = null;
    if (g.subs.length === 1 && nC >= 4 && nL === 0 && ar > 1.05 && ar < 1.7 && w > 4 && w < 11) head = 'head';
    else if (g.subs.length === 1 && nL >= 8 && nC === 0 && ar > 0.75 && ar < 1.35 && w > 4) head = w > 7.3 ? 'xbig' : 'x';
    else if (nC >= 5 && ar > 0.85 && ar < 1.18 && w > 7 && w < 12) head = 'xcirc';
    else if (g.subs.length === 2 && /^MLLLLZ?$/.test(t0) && nC === 0 && ar > 0.8 && ar < 1.25 && w > 5 && w < 10) head = 'diamond'; // ромб — райд-белл / ковбелл
    if (head) { g.label = head; g.head = true; g.w = w; g.h = h; g.cx = (g.b.x0 + g.b.x1) / 2; g.cy = (g.b.y0 + g.b.y1) / 2; continue; }
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

// Паузы Songsterr рисует залитыми контурами прямо на стане:
//   брусок 8×4 pt — висит под линией (целая) или лежит на линии (половинная);
//   восьмая/16-я/32-я — «флажки» с 1/2/3 кружками (контур из прямых и кривых, вытянут по высоте);
//   четвертная — такой же вытянутый контур без кружков.
// Справа могут стоять одна-две точки (×1,5 / ×1,75).
export function findRests(out, st) {
  const { top, bot, sp, ys, sx0, sx1 } = st;
  const res = [], rdots = [];
  for (const o of out) {
    if (o.kind !== 'F' || !isGray(o.color) || o.color[0] > 200) continue;
    for (const s of o.subs) {
      const b = s.b, w = b.x1 - b.x0, h = b.y1 - b.y0, cx = (b.x0 + b.x1) / 2, ty = s.t.join('');
      if (cx < sx0 || cx > sx1 || b.y0 < top - sp * 1.2 || b.y1 > bot + sp * 1.2) continue;
      if (!/L/.test(ty) && /C/.test(ty) && w > 1.3 && w < 3.2 && h > 1.3 && h < 3.2 && Math.abs(w - h) < 0.6) { rdots.push(b); continue; }
      let dur = null, kind = '';
      const rect = ty === 'R' || /^ML{3,4}Z?$/.test(ty);
      if (rect && w > 5.5 && w < 11 && h > 2.2 && h < 5.5) {
        const dT = Math.min(...ys.map(y => Math.abs(b.y0 - y))), dB = Math.min(...ys.map(y => Math.abs(b.y1 - y)));
        dur = dT < dB ? 4 : 2; kind = dur === 4 ? 'whole' : 'half';
      } else if (/L/.test(ty) && /C/.test(ty) && h > 7.5 && h < 26 && w > 3.5 && w < 9.5 && h > w * 1.3) {
        const blobs = (ty.match(/C{5,}/g) || []).length;
        if (blobs) { dur = 0.5 / Math.pow(2, blobs - 1); kind = ['8', '16', '32', '64'][blobs - 1] || '64'; }
        else { dur = 1; kind = '4'; }
      }
      if (dur) res.push({ x: cx, dur, kind, gray: o.color[0] > 80, b: { ...b } });
    }
  }
  for (const r of res) {
    let edge = r.b.x1, n = 0;
    for (const d of rdots.filter(d => d.y1 > r.b.y0 - 3 && d.y0 < r.b.y1 + 3).sort((a, b) => a.x0 - b.x0)) {
      if (d.x0 > edge - 0.3 && d.x0 < edge + 4.5 && n < 2) { n++; edge = d.x1; }
    }
    if (n) { r.dur *= n === 1 ? 1.5 : 1.75; r.dots = n; }
  }
  return res;
}

// Разбор одной страницы: станы, такты, ноты-цифры, штили, лиги
const BEND_AMT = { 'full': 2, '½': 1, '¼': 0.5, '¾': 1.5, '1½': 3, '1¼': 2.5, '1¾': 3.5, '2': 4, '2½': 5, '3': 6 };
function detectTech(out, texts, notes, st) {
  const { top, bot, sp, ys } = st;
  const heads = [], shafts = [], slides = [], vibs = [], dashes = [];
  for (const o of out) {
    if (o.kind !== 'F' || !isGray(o.color) || o.color[0] > 150) continue;
    for (const sb of o.subs) {
      const b = sb.b, w = b.x1 - b.x0, h = b.y1 - b.y0, t = sb.t.join(''), P = sb.p;
      if (b.y0 < top - sp * 9 || b.y1 > bot + sp * 1.5) continue;
      if (t === 'MLLLZ' && w > 2 && h > 2 && w < 6 && h < 6) {
        const pts = P.slice(0, 3), my = (pts[0][1] + pts[1][1] + pts[2][1]) / 3;
        const apex = pts.reduce((a, q) => Math.abs(q[1] - my) > Math.abs(a[1] - my) ? q : a);
        heads.push({ x: apex[0], y: apex[1], up: apex[1] < my });
      } else if (/^MC/.test(t) && P.length >= 4 && h > 6 && Math.abs(P[0][1] - P[3][1]) > 5) {
        const A = P[0], B = P[3]; const hi = A[1] < B[1] ? A : B, lo = hi === A ? B : A;
        shafts.push({ hi: { x: hi[0], y: hi[1] }, lo: { x: lo[0], y: lo[1] }, vert: Math.abs(hi[0] - lo[0]) < 3 });
      } else if (t === 'MLLLLZ' && w > 3 && h > 3 && w < 9 && h < 9 && b.y0 > top - 4 && b.y1 < bot + 4) {
        let a = P[0], c = P[1], dm = 0; for (const p1 of P) for (const p2 of P) { const d = Math.hypot(p1[0] - p2[0], p1[1] - p2[1]); if (d > dm) { dm = d; a = p1; c = p2; } }
        slides.push({ x0: b.x0, x1: b.x1, cy: (b.y0 + b.y1) / 2, down: (c[0] - a[0]) * (c[1] - a[1]) > 0 });
      } else if (t.length > 12 && /^ML(CL){3,}/.test(t) && h < 8 && w > 8 && b.y1 < top) vibs.push({ x0: b.x0, x1: b.x1, wide: h > 5.5 });
      else if (t === 'MLLLLZ' && h < 1.2 && w < 6 && w > 1.5 && b.y1 < top) dashes.push(b);
    }
  }
  const rowY = n => (n.b.y0 + n.b.y1) / 2;
  const amtNear = (x, y) => { let best = null, bd = 1e9; for (const tx of texts) { const k = tx.s.replace(/\s+/g, ''); if (!(k in BEND_AMT)) continue; const cx = tx.x + (tx.w || 6) / 2, d = Math.abs(cx - x) + Math.abs(tx.y - y) * 0.7; if (d < bd && Math.abs(cx - x) < 12 && tx.y < y + 4 && tx.y > y - 16) { bd = d; best = BEND_AMT[k]; } } return best; };
  for (const sh of shafts) {
    const hd = heads.find(h => Math.hypot(h.x - sh.hi.x, h.y - sh.hi.y) < 7 || Math.hypot(h.x - sh.lo.x, h.y - sh.lo.y) < 7);
    if (!hd) continue;
    const atTop = Math.hypot(hd.x - sh.hi.x, hd.y - sh.hi.y) < 7;
    if (atTop && hd.up) { // подтяжка: от цифры вверх
      const amt = amtNear(sh.hi.x, sh.hi.y) || 2;
      let n = null, bd = 1e9;
      for (const q of notes) {
        const d = sh.vert ? (sh.lo.x >= q.x0 - 3 && sh.lo.x <= q.x1 + 3 && sh.lo.y <= q.b.y0 + 3 && sh.lo.y > q.b.y0 - 12 ? Math.abs(sh.lo.y - q.b.y0) : 1e9)
          : (Math.abs(sh.lo.x - q.x1) < 5 && Math.abs(sh.lo.y - rowY(q)) < sp * 0.9 ? Math.abs(sh.lo.x - q.x1) + Math.abs(sh.lo.y - rowY(q)) : 1e9);
        if (d < bd) { bd = d; n = q; }
      }
      if (!n) continue;
      if (sh.vert) n.pre = amt; else n.bend = amt;
      // пунктир от верха стрелки — бенд держится до конца пунктира
      let xe = sh.hi.x;
      for (let more = true; more;) { more = false; for (const d of dashes) if (d.x0 > xe - 1 && d.x0 < xe + 6 && Math.abs(d.y0 - sh.hi.y) < 3) { xe = d.x1; more = true; } }
      if (xe > sh.hi.x + 6) n.holdTo = xe;
    } else if (!atTop && !hd.up) { // возврат: стрелка вниз к цифре
      let n = null, bd = 1e9;
      for (const q of notes) { if (sh.lo.x < q.x0 - 4 || sh.lo.x > q.x1 + 4) continue; const d = Math.abs(sh.lo.y - q.b.y0); if (d < 10 && d < bd) { bd = d; n = q; } }
      if (n) { n.rel = amtNear(sh.hi.x, sh.hi.y) || true; if (sh.vert) n.preRel = true; }
    }
  }
  for (const sl of slides) {
    const row = notes.filter(q => Math.abs(rowY(q) - sl.cy) < sp * 0.6);
    const left = row.filter(q => q.x1 <= sl.x0 + 2 && q.x1 > sl.x0 - 6).sort((a, b) => b.x1 - a.x1)[0];
    const right = row.filter(q => q.x0 >= sl.x1 - 2 && q.x0 < sl.x1 + 6).sort((a, b) => a.x0 - b.x0)[0];
    if (left) left.slide = sl.down ? 'down' : 'up';
    else if (right) right.slideIn = sl.down ? 'above' : 'below';
  }
  for (const v of vibs) for (const q of notes) if (q.cx >= v.x0 - 4 && q.cx <= v.x1 + 2) q.vib = v.wide ? 'wide' : 'slight';
}

// Единица темпа по знаку ноты слева от «=» (в долях четверти)
function tempoUnit(out, x, y) {
  const sub = [];
  for (const o of out) if (o.kind === 'F') for (const s of o.subs) { const b = s.b; if (b.x1 < x + 0.5 && b.x0 > x - 18 && b.y0 > y - 17 && b.y1 < y + 5) sub.push(s); }
  if (!sub.length) return 1;
  const main = sub.reduce((a, c) => ((c.b.x1 - c.b.x0) * (c.b.y1 - c.b.y0) > (a.b.x1 - a.b.x0) * (a.b.y1 - a.b.y0) ? c : a));
  const hb = main.b;
  // половинная: внутри головки отверстие (отдельный контур внутри)
  const hole = sub.some(s => s !== main && s.b.x0 >= hb.x0 - 0.1 && s.b.x1 <= hb.x1 + 0.1 && s.b.y0 >= hb.y0 - 0.1 && s.b.y1 <= hb.y1 + 0.1 && (s.b.x1 - s.b.x0) > 1 && (s.b.y1 - s.b.y0) > 0.8);
  // точка: маленький круглый контур правее головки
  const dot = sub.some(s => s !== main && s.b.x0 > hb.x1 - 2 && (s.b.x1 - s.b.x0) < 1.6 && (s.b.y1 - s.b.y0) < 1.6 && s.t.includes('C'));
  // флажок восьмой: у самой фигуры правая часть выше головки шире штиля
  const flag = (hb.x1 - hb.x0) > 6.5 && (hb.y1 - hb.y0) > 10;
  let u = hole ? 2 : flag ? 0.5 : 1;
  if (dot) u *= 1.5;
  return u;
}
async function parsePage(page, O, pageNo) {
  const out = await walkPage(page, O);
  const tc = await page.getTextContent();
  const H = page.view[3];
  const texts = tc.items.filter(it => it.str && it.str.trim()).map(it => ({
    s: it.str.trim(), x: it.transform[4], y: H - it.transform[5], h: it.height || Math.abs(it.transform[3]), w: it.width || 0, raw: it.str, f: it.fontName
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
  // короткие станы тоже: последняя строка из 2–4 тактов бывает уже 150 pt, а линия струны рвётся цифрами
  const lines = [...byY.values()].filter(e => e.len > 45 && e.x1 - e.x0 > 55).sort((a, b) => a.y - b.y);
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
    const bars = cluster(vl.filter(v => v.y0 <= top + 1 && v.y1 >= bot - 1 && v.y0 >= top - sp * 0.6 && v.y1 <= bot + sp * 0.6 && v.x > sx0 - 2 && v.x < sx1 + 2).map(v => v.x), 4);
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
    // Темп: «♩ = 131» над станом. Знак относится к ближайшему стану ниже (над ним бывают ещё
    // подписи частей, «Choke», «let ring» — поэтому по высоте не ограничиваем жёстко).
    // Нота перед «=» задаёт единицу: половинная — ×2, с точкой — ×1,5, восьмая — ×0,5.
    const tops = staves.map(g => g[0].y);
    for (const t of texts) {
      const mt = /=\s*(\d{2,3})/.exec(t.s);
      if (!mt || t.y > top + 1 || t.y < top - 90) continue;
      if (tops.some(y => y < top - 1 && y > t.y)) continue; // ближе есть другой стан
      const m = measures.find(m => t.x >= m.x0 - 25 && t.x < m.x1 - 5) || measures[0];
      if (!m || m.tempo != null) continue;
      m.tempo = Math.round(+mt[1] * tempoUnit(out, t.x, t.y) * 100) / 100;
      // «accel.» / «rit.» на той же строке справа: плавное изменение до следующего темпа
      const ch = texts.find(u => u !== t && Math.abs(u.y - t.y) < 3 && u.x > t.x && u.x < t.x + 90 && /^(accel|rit|rall)/i.test(u.s));
      if (ch) m.tempoRamp = /^accel/i.test(ch.s) ? 'accel' : 'rit';
    }
    // Названия частей над станом (Intro, Verse 1, Chorus…): курсив крупнее подписей, у начала такта
    for (const t of texts) {
      if (t.h < 9.5 || t.h > 14 || t.y > top - 3 || t.y < top - 45) continue;
      if (/=\s*\d|^\d+$|^(full|½|¼|¾|P\.?\s?M\.?|let ring|rake|N\.?H\.?|A\.?H\.?|P\.?H\.?)$/i.test(t.s) || !/[A-Za-zА-Яа-я]{2}/.test(t.s)) continue;
      const m = measures.find(m => t.x >= m.x0 - 6 && t.x < m.x0 + Math.min(60, (m.x1 - m.x0) * 0.6));
      if (m) (m.mk = m.mk || []).push({ s: t.s.replace(/\s*\(.*?\)\s*/g, ' ').replace(/\s*\[.*?\]\s*/g, ' ').trim() || t.s, f: t.f });
    }
    // Размер такта (крупные цифры на стане)
    const big = texts.filter(t => /^\d+$/.test(t.s) && t.h > 15 && t.y > top - 2 && t.y < bot + 30);
    for (let i = 0; i + 1 < big.length; i++) {
      const a = big[i], b = big[i + 1];
      const ca = a.x + (a.w || 0) / 2, cb = b.x + (b.w || 0) / 2;
      if (Math.abs(ca - cb) < 3 && b.y > a.y && b.y - a.y < 30) {
        const m = measures.find(m => ca >= m.x0 - 3 && ca < m.x1);
        if (m) m.sig = [+a.s, +b.s];
      }
    }
    // Строй (буквы слева от стана)
    const tun = texts.filter(t => /^[A-Ga-g][#b♯♭]?$/.test(t.s) && t.x < sx0 + 12 && t.y > top - 8 && t.y < bot + sp * 3)
      .sort((a, b) => a.y - b.y).map(t => t.s).slice(0, ys.length);

    // Цифры на струнах
    const onStaff = glyphs.filter(g => !g.head && g.cx > sx0 && g.cx < sx1 && g.cy > top - sp * 0.7 && g.cy < bot + sp * 0.7 && g.label !== 'flag');
    // головки ударных: позиция на нотоносце в полуинтервалах от нижней линии
    const heads = glyphs.filter(g => g.head && g.cx > sx0 && g.cx < sx1 && g.cy > top - sp * 3.2 && g.cy < bot + sp * 2.2)
      .map(g => ({ kind: g.label, step: Math.round((bot - g.cy) / (sp / 2)), cx: g.b.x0, x0: g.b.x0, x1: g.b.x1, b: { ...g.b }, gray: g.gray }));
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
        if (!s.t.includes('C') || w < 5 || h < 0.5) continue;
        // плоская дуга (концы на одной высоте); высокая кривая со стрелкой — это бенд, не лига
        if (h > 5 && !(h <= 8 && w > h * 2.5 && s.p.length >= 4 && Math.abs(s.p[0][1] - s.p[3][1]) < 1.5)) continue;
        if (b.y0 < top - sp || b.y1 > bot + sp) continue;
        // прямая косая черта между цифрами — слайд (у лиги точки уходят от прямой на всю высоту дуги)
        const P = s.p || [], L0 = P.reduce((a, q) => q[0] < a[0] ? q : a, P[0] || [0, 0]), R0 = P.reduce((a, q) => q[0] > a[0] ? q : a, P[0] || [0, 0]);
        const len = Math.hypot(R0[0] - L0[0], R0[1] - L0[1]) || 1, dev = Math.max(0, ...P.map(q => Math.abs((R0[0] - L0[0]) * (L0[1] - q[1]) - (L0[0] - q[0]) * (R0[1] - L0[1])) / len));
        arcs.push({ ...b, straight: P.length >= 3 && dev < 1.3 && Math.abs(R0[1] - L0[1]) > 1.2 });
      }
    }
    // Бенды (стрелки с подписью full / ½), удержание бенда (пунктир), возврат (стрелка вниз),
    // вибрато (волна над станом), слайды (косая черта у цифры)
    detectTech(out, texts, notes, { top, bot, sp, ys });
    // Паузы на стане: целая/половинная (брусок), восьмая, шестнадцатая, тридцать вторая, четвертная; точки после паузы
    const rests = findRests(out, { top, bot, sp, ys, sx0, sx1 });
    // глифы, совпавшие с паузой, нотами не считаем
    const inRest = g => rests.some(r => g.cx > r.b.x0 - 0.5 && g.cx < r.b.x1 + 0.5 && g.cy > r.b.y0 - 0.5 && g.cy < r.b.y1 + 0.5);
    for (let i = notes.length - 1; i >= 0; i--) if (inRest({ cx: notes[i].cx, cy: (notes[i].b.y0 + notes[i].b.y1) / 2 })) notes.splice(i, 1);
    // Глухие ноты табулатуры (крестик на струне)
    const dead = [];
    for (const h of heads) {
      if (h.kind !== 'x' && h.kind !== 'xbig') continue;
      const cy = (h.b.y0 + h.b.y1) / 2, si = strIdx({ cy });
      if (si >= 0) dead.push({ si, dead: true, paren: false, digits: 'x', fret: 0, x0: h.b.x0, x1: h.b.x1, cx: (h.b.x0 + h.b.x1) / 2, gray: h.gray, b: { ...h.b } });
    }
    // Точки удлинения у головок ударных (стоят справа от головки на стане)
    const hdots = [];
    if (heads.length) for (const o of out) {
      if (o.kind !== 'F' || !isGray(o.color) || o.color[0] > 200) continue;
      for (const s of o.subs) {
        const b = s.b, w = b.x1 - b.x0, h = b.y1 - b.y0;
        if (/L/.test(s.t.join('')) || w < 1.4 || w > 3.4 || h < 1.4 || h > 3.4 || Math.abs(w - h) > 0.6) continue;
        if (b.y0 < top - sp * 3.5 || b.y1 > bot + sp * 2.5) continue;
        hdots.push(b);
      }
    }
    // Штили и балки ритма (под станом). Штиль ударных нарисован несколькими перекрывающимися кусками — склеиваем.
    const vm = [];
    for (const v of [...vl].sort((a, b) => a.x - b.x || a.y0 - b.y0)) {
      const p = vm.length && vm[vm.length - 1];
      let q = null;
      for (let k = vm.length - 1; k >= 0 && vm[k].x > v.x - 0.3; k--) if (v.y0 <= vm[k].y1 + 1.2 && v.y1 >= vm[k].y0 - 1.2) { q = vm[k]; break; }
      if (q && p) { q.y0 = Math.min(q.y0, v.y0); q.y1 = Math.max(q.y1, v.y1); } else vm.push({ ...v });
    }
    const stemsRaw = vm.filter(v => v.x > sx0 && v.x < sx1 && v.y1 > bot + 4 && v.y1 < bot + 70 &&
      ((v.y0 > bot - 1.5 && v.y0 < bot + 20 && v.y1 - v.y0 < 30) || (heads.length && v.y0 < bot && v.y1 - v.y0 < 110)));
    // (штиль начинается сразу под станом; вертикальные чёрточки ниже — концы «P.M. ---|» следующей строки)
    const stems = [];
    for (const v of stemsRaw.sort((a, b) => (b.y1 - b.y0) - (a.y1 - a.y0))) {
      // одинаковые штили (заливка + обводка) и куски одного штиля у ударных
      if (stems.some(s => Math.abs(s.x - v.x) < 0.3 && ((Math.abs(s.y1 - v.y1) < 0.3 && Math.abs(s.y0 - v.y0) < 0.3) || (heads.length && v.y0 >= s.y0 - 0.5 && v.y1 <= s.y1 + 0.5)))) continue;
      stems.push({ ...v });
    }
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
    // ударная нотация (головки, а не цифры): короткий штиль там — не половинная. Крестики глухих нот в табах не в счёт
    const drumish = heads.some(h => h.kind !== 'x' && h.kind !== 'xbig') || (heads.length > 0 && !notes.length);
    // Форшлаги: короткий штиль, перечёркнутый косой чертой; связанные с ним тонкой балкой — тоже форшлаги
    const slashes = [];
    for (const o of out) if (o.kind === 'F' && isGray(o.color)) for (const sb of o.subs) {
      const b = sb.b, w = b.x1 - b.x0, h = b.y1 - b.y0, t = sb.t.join('');
      if (/^ML{3,4}Z?$/.test(t) && w > 2.5 && w < 9 && h > 2.5 && h < 9 && Math.abs(w - h) < 3 && b.y0 > bot && b.y0 < bot + 70) slashes.push(b);
    }
    const hs = notes.filter(n => !n.paren).map(n => n.b.y1 - n.b.y0).sort((a, b) => a - b), medH = hs.length ? hs[hs.length >> 1] : 0;
    for (const n of notes) if (medH && !n.paren && n.b.y1 - n.b.y0 < medH * 0.8) { n.small = true; for (const s of stems) if (Math.abs(s.x - n.cx) < 3) s.grace = true; }
    for (const sl of slashes) for (const s of stems) if (s.x > sl.x0 && s.x < sl.x1 && sl.y0 < s.y1 && sl.y1 > s.y0 && s.y1 - s.y0 < full * 0.8) s.grace = true;
    for (let more = true; more;) {
      more = false;
      for (const g0 of stems.filter(s => s.grace)) for (const b of beams) {
        if (b.x0 > g0.x + 0.6 || b.x1 < g0.x - 0.6 || b.y > g0.y1 + 0.5 || b.y < g0.y0) continue;
        for (const s of stems) if (!s.grace && s.x >= b.x0 - 0.6 && s.x <= b.x1 + 0.6 && Math.abs(s.y1 - g0.y1) < 1) { s.grace = true; more = true; }
      }
    }
    for (const s of stems) {
      let ri = 0, bd = 1e9; rowYs.forEach((y, i) => { const d = Math.abs(y - s.y1); if (d < bd) { bd = d; ri = i; } });
      if (s.grace) { const rj = rowYs.reduce((a, y, i) => Math.abs(y - s.y1) > 2.5 && (a < 0 || Math.abs(y - s.y1) < Math.abs(rowYs[a] - s.y1)) ? i : a, -1); voices[rj >= 0 && Math.abs(rowYs[ri] - s.y1) < 1 ? rj : ri].push({ x: s.x, dur: 0, grace: true }); continue; }
      const h = s.y1 - s.y0;
      const nb = cluster(beams.filter(b => b.x0 <= s.x + 0.6 && b.x1 >= s.x - 0.6 && b.y > Math.max(s.y0 - 0.5, s.y1 - full * 0.9) && b.y < s.y1 + 1).map(b => b.y), 1).length; // балки на одной высоте (кусок + целая) — одна
      const nf = flags.filter(f => Math.abs(f.b.x0 - s.x) < 1.5 && f.cy > s.y0 - 3 && f.cy < s.y1 + 3).length;
      let dur = (!drumish && h < Math.max(full * 0.7, sp * 1.1)) ? 2 : 1;
      const k = Math.max(nb, nf);
      if (k) dur = 1 / Math.pow(2, k);
      let dotted = dots.some(d => d.x0 > s.x + 0.3 && d.x0 < s.x + 5 && d.y1 > s.y1 - 4 && d.y0 < s.y1 + 2);
      if (!dotted && heads.length) {
        const hs = heads.filter(h => (Math.abs(h.b.x0 - s.x) < 2.6 || Math.abs(h.b.x1 - s.x) < 2.6) && (h.b.y0 + h.b.y1) / 2 > s.y0 - 4 && (h.b.y0 + h.b.y1) / 2 < s.y1);
        dotted = hdots.some(d => hs.some(h => d.x0 > h.b.x1 + 0.2 && d.x0 < h.b.x1 + 5 && Math.abs((d.y0 + d.y1) / 2 - (h.b.y0 + h.b.y1) / 2) < sp * 0.75));
      }
      if (dotted) dur *= 1.5;
      voices[ri].push({ x: s.x, dur });
    }
    voices.forEach(v => v.sort((a, b) => a.x - b.x));
    // Триоли и другие группы: скобка под штилями с цифрой посередине (3 — две трети, 4 в 12/8 — три четверти…)
    const TUP = { 2: 3 / 2, 3: 2 / 3, 4: 3 / 4, 5: 4 / 5, 6: 4 / 6, 7: 4 / 7, 9: 8 / 9, 10: 8 / 10, 12: 8 / 12 };
    const segs = [];
    for (const o of out) for (const sb of o.subs) { const b = sb.b; if (sb.t.join('') === 'ML' && b.y1 - b.y0 < 0.3 && b.x1 - b.x0 > 3 && b.y0 > bot + 6 && b.y0 < bot + 80) segs.push(b); }
    const tupDigits = glyphs.filter(g => /^\d$/.test(g.label) && g.gray && g.cy > bot + 6 && g.cy < bot + 80 && g.h < 7);
    const tuplets = [];
    for (const d of tupDigits) {
      const L = segs.filter(b => Math.abs(b.y0 - d.cy) < 2.5 && b.x1 <= d.b.x0 + 0.5 && b.x1 > d.b.x0 - 5).sort((a, b) => b.x1 - a.x1)[0];
      const R = segs.filter(b => Math.abs(b.y0 - d.cy) < 2.5 && b.x0 >= d.b.x1 - 0.5 && b.x0 < d.b.x1 + 5).sort((a, b) => a.x0 - b.x0)[0];
      const f = TUP[+d.label]; if (!f || (!L && !R)) continue;
      tuplets.push({ x0: L ? L.x0 : d.b.x0 - 3, x1: R ? R.x1 : d.b.x1 + 3, f, n: +d.label });
    }
    for (const tp of tuplets) for (const v of voices) for (const e of v) if (e.x >= tp.x0 - 1 && e.x <= tp.x1 + 1 && !e.tup) { e.dur *= tp.f; e.tup = tp.n; }
    for (const tp of tuplets) for (const r of rests) if (r.x >= tp.x0 - 1 && r.x <= tp.x1 + 1 && !r.tup) { r.dur *= tp.f; r.tup = tp.n; }
    // Текстовые обозначения техник над нотами (если они есть в PDF как текст): P.M., let ring, N.H., T, L.H.…
    const marks = [];
    const MK = [[/^P\.?\s?M\.?$/i, 'pm'], [/^(let\s*ring|l\.\s?r\.?)$/i, 'ring'], [/^N\.?\s?H\.?$/, 'harmN'], [/^A\.?\s?H\.?$/, 'harmA'], [/^P\.?\s?H\.?$/, 'harmP'], [/^T\.?\s?H\.?$/, 'harmT'],
      [/^T$/, 'tap'], [/^L\.?\s?H\.?$/, 'lh'], [/^R\.?\s?H\.?$/, 'rh'], [/^rasg\.?$/i, 'rasg'], [/^w\/?\s?bar$/i, 'whammy']];
    for (const t of texts) {
      if (t.y < top - 40 || t.y > bot + 6 || t.x < sx0 - 5 || t.x > sx1) continue;
      const k = MK.find(([re]) => re.test(t.s)); if (!k) continue;
      let x1 = t.x + (t.w || t.s.length * 4);
      // продолжение «- - - -» на той же строке
      for (const d of texts.filter(q => Math.abs(q.y - t.y) < 2 && /^[-–—\s]+$/.test(q.s) && q.x >= t.x).sort((a, b) => a.x - b.x)) { if (d.x - x1 < 25) x1 = d.x + (d.w || 4); }
      marks.push({ kind: k[1], x0: t.x - 3, x1: x1 + 3, ranged: x1 - t.x > 40 });
    }
    // Значки артикуляции над станом: акцент «>», маркато «^», стаккато «•»
    for (const o of out) {
      if (!isGray(o.color) || o.color[0] > 200) continue;
      for (const sb of o.subs) {
        const b = sb.b, w = b.x1 - b.x0, h = b.y1 - b.y0, cx = (b.x0 + b.x1) / 2, ty = sb.t.join('');
        if (b.y1 > top - 0.5 || b.y0 < top - 30 || cx < sx0 || cx > sx1) continue;
        let kind = null;
        if (o.kind === 'S' && ty === 'MLL' && w > h * 1.2 && w < 8 && h > 2) kind = 'acc';
        else if (o.kind === 'S' && /^ML{3,6}$/.test(ty) && h >= w * 0.9 && w < 7 && h > 3) kind = 'marc';
        else if (o.kind === 'F' && /^MC{4,6}Z$/.test(ty) && w < 2.2 && h < 2.2 && w > 0.7) kind = 'stacc';
        if (kind) marks.push({ kind, x0: cx - 1, x1: cx + 1, ranged: false, sym: true });
      }
    }
    // маркато рисуется поверх акцента в одной колонке — оставляем более сильное обозначение
    // Слова песни: строка под ритмом (буквы ~10 pt), разбиваем на слоги по промежуткам
    const lyr = [];
    {
      const band = (out.chars || []).filter(ch => ch.y > bot + 14 && ch.y < bot + 80 && ch.x > sx0 - 5 && ch.x < sx1 + 5 && ch.h > 8 && ch.h < 13);
      band.sort((a, b) => a.y - b.y || a.x - b.x);
      const rowsY = cluster(band.map(c => c.y), 2);
      const rowOf = c => rowsY.reduce((bi, y, i) => Math.abs(y - c.y) < Math.abs(rowsY[bi] - c.y) ? i : bi, 0);
      // ряд слов — самый нижний ряд с буквами (выше могут быть подписи вроде «let ring»)
      const best = rowsY.length ? rowsY.reduce((bi, y, i) => band.filter(c => rowOf(c) === i).length > band.filter(c => rowOf(c) === bi).length ? i : bi, 0) : -1;
      const row = band.filter(c => rowOf(c) === best).sort((a, b) => a.x - b.x);
      // ширина буквы из шрифта бывает в другом масштабе — поправку берём по соседним буквам
      const rat = [];
      for (let k = 1; k < row.length; k++) { const a = row[k - 1], b = row[k]; if (a.w > 0 && a.c.trim() && b.c.trim()) { const r = (b.x - a.x) / a.w; if (r > 0.2 && r < 1.6) rat.push(r); } }
      rat.sort((a, b) => a - b);
      const kw = rat.length ? rat[Math.floor(rat.length * 0.3)] : 1;
      let cur = null;
      for (const ch of row) {
        const w = ch.w * kw;
        if (!ch.c.trim() || ch.c === '_') { cur = null; continue; } // пробел и «_» (протяжка) — граница слова
        if (ch.c === '-' && cur) { cur.s += '-'; cur.x1 = ch.x + w; cur = null; continue; } // перенос слога
        const gap = cur ? ch.x - cur.x1 : 1e9;
        if (!cur || gap > Math.max(0.8, ch.h * 0.09)) { cur = { s: '', x0: ch.x, x1: ch.x + w, y: ch.y }; lyr.push(cur); }
        cur.s += ch.c; cur.x1 = ch.x + w;
      }
    }
    const lyrics = lyr.filter(w => /[A-Za-zА-Яа-яЁё]/.test(w.s) && !/^\d+$/.test(w.s) && !/^(P\.?M\.?|let|ring|rake|full|N\.?H\.?|A\.?H\.?)$/i.test(w.s));
    res.push({ page: pageNo, top, bot, sp, ys, sx0, sx1, measures, tun, notes, heads, dead, arcs, voices, marks, rests, dots, lyrics });
  }
  return { systems: res, texts };
}

// Склейка кусочков текста одной строки (pdf.js режет строку на части)
function joinLine(items) {
  const a = [...items].sort((p, q) => p.x - q.x);
  let out = '', prevEnd = null;
  for (const t of a) {
    const txt = (t.raw != null ? t.raw : t.s).trim(); if (!txt) continue;
    const gap = prevEnd == null ? 0 : t.x - prevEnd;
    if (prevEnd != null && (gap > t.h * 0.12 || /^\s/.test(t.raw || ''))) out += ' ';
    out += txt;
    prevEnd = t.x + (t.w || txt.length * t.h * 0.5);
  }
  return out.replace(/\s+/g, ' ').trim();
}

export async function parseSongsterrPdf(pdfjsLib, data, onProgress) {
  const doc = await pdfjsLib.getDocument({ data, isEvalSupported: false }).promise;
  const O = pdfjsLib.OPS;
  const systems = []; let title = '', track = '', instrument = '';
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const r = await parsePage(page, O, p);
    if (p === 1) {
      const head = r.texts.filter(t => t.y < 90);
      const big = head.filter(t => t.h > 14);
      const y0 = big.length ? Math.min(...big.map(t => t.y)) : 0;
      title = joinLine(big.filter(t => Math.abs(t.y - y0) < 4));
      const trk0 = head.find(t => /Track:/i.test(t.s));
      const tr = trk0 ? head.filter(t => Math.abs(t.y - trk0.y) < 2.5) : [];
      const line = joinLine(tr);
      const mt = /Track:\s*(.*)$/i.exec(line);
      if (mt) {
        const parts = mt[1].split(/\s+—\s+|^—\s*|\s*—$/);
        track = (parts[0] || '').trim();
        instrument = parts.slice(1).join(' ').trim();
        if (!track && !instrument) track = mt[1].replace(/^—\s*/, '').trim();
      }
    }
    systems.push(...r.systems);
    if (onProgress) onProgress(p, doc.numPages);
  }
  if (!systems.length) throw new Error('В файле не найдено табулатуры. Подходят PDF, сохранённые из Songsterr.');
  return buildSong(systems, { title, track, instrument });
}

// Ударные: позиция на нотоносце + вид головки → номер инструмента General MIDI
const DRUM_MAP = {
  head: { '-2': 35, '-1': 35, 0: 35, 1: 36, 2: 41, 3: 43, 4: 45, 5: 38, 6: 48, 7: 50, 8: 50, 9: 48 },
  x: { '-2': 44, '-1': 44, 0: 44, 1: 44, 3: 42, 5: 37, 6: 42, 7: 53, 8: 51, 9: 42, 10: 49, 11: 57, 12: 55 },
  xbig: { 7: 53, 8: 51, 9: 42, 10: 49, 11: 57, 12: 55, 13: 52 },
  xcirc: { 8: 53, 9: 46, 10: 49, 11: 57 },
  diamond: { 4: 56, 5: 56, 6: 53, 7: 53, 8: 53, 9: 53, 10: 53, 11: 53 }
};
export function drumNote(kind, step) {
  const m = DRUM_MAP[kind] || DRUM_MAP.head;
  if (m[step] != null) return m[step];
  return null; // положение на стане не соответствует ни одному элементу установки — не угадываем
}

export function buildSong(systems, meta) {
  const nStr = systems[0].ys.length;
  const drumWords = /drum|perc|удар|бараб/i.test((meta.instrument || '') + ' ' + (meta.track || ''));
  const totalDigits = systems.reduce((a, s) => a + s.notes.length, 0), totalHeads = systems.reduce((a, s) => a + (s.heads || []).length, 0);
  const isDrum = (drumWords && totalHeads > 0) || (totalDigits === 0 && totalHeads > 0);
  if (isDrum) for (const sy of systems) {
    sy.notes = (sy.heads || []).map(h => ({ si: -1, drum: drumNote(h.kind, h.step), head: h.kind, step: h.step, digits: '', fret: null, paren: false, cx: h.cx, x0: h.x0, x1: h.x1, b: h.b, gray: false, src: null }));
    for (const n of sy.notes) n.src = n;
    sy.arcs = [];
    // головки, сдвинутые вбок от штиля (секунда в аккорде), относим к тому же штилю
    const allStems = sy.voices.flat();
    for (const n of sy.notes) {
      let best = null, bd = 2.6;
      for (const st of allStems) { const d = Math.min(Math.abs(st.x - n.x0), Math.abs(st.x - n.x1)); if (d < bd) { bd = d; best = st; } }
      if (best) n.cx = best.x;
    }
  }
  const letters = (systems.find(s => s.tun.length === nStr) || {}).tun;
  // Бас: по названию, либо 4–6 струн с верхней струной соль/до (у гитары верхняя — ми/ре)
  const topL = letters && letters[0] ? letters[0][0].toUpperCase() : '';
  // Бас или гитара. У баса все соседние струны — через кварту (5 полутонов), у гитары между 2-й и 3-й
  // струной большая терция (4 полутона). Поэтому гитара в строе Standard C (C F A# D# G C) — не бас,
  // хотя верхняя струна у неё тоже «C», как у 6-струнного баса (B E A D G C).
  const pcsL = letters ? letters.map(letterPc) : null;
  const allFourths = !!pcsL && pcsL.length >= 4 && pcsL.every(p => p != null) && pcsL.slice(1).every((p, i) => ((pcsL[i] - p) % 12 + 12) % 12 === 5);
  const byName = /bass|бас/i.test(meta.track + ' ' + meta.instrument), guitarName = /guitar|гитар|strat|les paul|gibson|ibanez rg|esp|jackson|schecter|prs/i.test(meta.track + ' ' + meta.instrument) && !byName;
  const isBass = !isDrum && !guitarName && (byName || (pcsL ? allFourths && nStr <= 6 && (topL === 'G' || topL === 'C') : nStr <= 4));
  const tuning = (letters && inferTuning(letters, isBass)) || standardTuning(nStr, isBass);
  const tuningNames = letters && letters.length === nStr ? letters : null;

  // Такты по порядку
  const ms = [];
  let lastN = 0, sig = [4, 4], tempo = 120, firstTempo = null;
  for (const sy of systems) sy.measures.forEach((m, mi) => {
    // такт, не поместившийся в строку: начало новой строки без номера, а следующий такт — со следующим номером
    const nx = sy.measures[mi + 1];
    if (m.n == null && mi === 0 && ms.length && (!nx || nx.n == null || nx.n === lastN + 1)) {
      const prev = ms[ms.length - 1];
      ms.push({ n: lastN, sy, x0: m.x0, x1: m.x1, len: 0, sig: [...prev.sig], tempo: prev.tempo, cont: prev });
      prev.split = ms[ms.length - 1];
      return;
    }
    const n = m.n != null ? m.n : lastN + 1; lastN = n;
    if (m.sig) sig = m.sig;
    if (m.tempo) { tempo = m.tempo; if (firstTempo == null) firstTempo = tempo; }
    ms.push({ n, sy, x0: m.x0, x1: m.x1, len: sig[0] * 4 / sig[1], sig: [...sig], tempo, mk: m.mk, tempoSet: !!m.tempo, tempoRamp: m.tempoRamp });
  });
  // шрифт названий частей узнаём по знакомым словам — так подписи текста песни не примешиваются
  const SEC_RE = /^(intro|verse|chorus|pre-?chorus|bridge|solo|outro|interlude|ending|coda|refrain|break|riff|вступ|куплет|припев|бридж|соло|проигрыш|кода|концовка)/i;
  const secFonts = new Set(); for (const m of ms) for (const c of m.mk || []) if (SEC_RE.test(c.s)) secFonts.add(c.f);
  for (const m of ms) { const c = (m.mk || []).find(c => secFonts.has(c.f)); if (c) m.marker = c.s; }
  // длительность частей перенесённого такта — по ритму (штили и паузы), иначе по ширине
  const rhythmSum = m => { const inM = x => x >= m.x0 - 0.5 && x < m.x1 - 0.5; let best = 0; for (const v of m.sy.voices) best = Math.max(best, v.filter(e => inM(e.x)).reduce((a, e) => a + e.dur, 0)); return best + (m.sy.rests || []).filter(r => inM(r.x)).reduce((a, r) => a + r.dur, 0); };
  for (const m of ms) if (m.split) {
    const full = m.len, b = m.split, sa = rhythmSum(m), sb = rhythmSum(b);
    let la = sa > 0 && sa < full ? sa : sb > 0 && sb < full ? full - sb : full * (m.x1 - m.x0) / Math.max(1, (m.x1 - m.x0) + (b.x1 - b.x0));
    la = Math.max(0.25, Math.min(full - 0.25, Math.round(la * 8) / 8));
    m.len = la; b.len = full - la; m.fullLen = full;
  }
  let beat = 0;
  for (const m of ms) { m.start = beat; beat += m.len; }
  const total = beat;
  // accel. / rit.: темп меняется по долям от отметки до следующей отметки темпа
  ms.forEach((m, i) => {
    if (!m.tempoRamp) return;
    const j = ms.findIndex((q, k) => k > i && q.tempoSet && !q.cont);
    if (j < 0) return;
    const a = m.tempo, z = ms[j].tempo, span = ms[j].start - m.start;
    if (span <= 0 || (m.tempoRamp === 'accel') !== (z > a)) return;
    const pts = [];
    for (let b = 0; b < span; b += 1) pts.push([+(m.start + b).toFixed(4), Math.round((a + (z - a) * b / span) * 10) / 10]);
    m.tempoPts = pts;
  });

  const notes = [];
  for (const m of ms) {
    const sy = m.sy;
    const inM = x => x >= m.x0 - 0.5 && x < m.x1 - 0.5;
    const mNotes = sy.notes.filter(n => inM(n.cx));
    if (!isDrum) for (const d of sy.dead || []) if (inM(d.cx) && !mNotes.some(n => n.si === d.si && Math.abs(n.cx - d.cx) < 2)) mNotes.push(d);
    // Ритм голосов этого такта: штили + паузы. Паузу отдаём голосу, которому не хватает длительности.
    const evs = sy.voices.map(v => v.filter(s => inM(s.x)).map(s => ({ ...s })));
    const mRests = (sy.rests || []).filter(r => inM(r.x));
    if (!evs.length && mRests.length) evs.push([]);
    const sumOf = ev => ev.reduce((a, e) => a + e.dur, 0);
    for (const r of [...mRests].sort((a, b) => b.dur - a.dur || a.x - b.x)) {
      let bi = -1, bd = -1;
      // пауза — в голос, у которого есть ноты и не хватает длительности (пустой голос — в последнюю очередь)
      evs.forEach((ev, i) => { const d = m.len - sumOf(ev); if (d < r.dur - 0.01) return; const sc = (ev.some(e => !e.rest) ? 1000 : 0) + d; if (sc > bd + 0.01) { bd = sc; bi = i; } });
      if (bi < 0) { m.restMismatch = (m.restMismatch || 0) + 1; continue; }
      evs[bi].push({ x: r.x, dur: r.dur, rest: true });
    }
    // цифра без штиля — целая нота (с точкой под ней — целая с точкой)
    if (!isDrum && evs.length) {
      const xs = cluster(mNotes.map(n => n.cx), 2.6);
      for (const x of xs) {
        if (evs.some(ev => ev.some(e => Math.abs(e.x - x) < 3.2))) continue;
        const dotted = (sy.dots || []).some(d => Math.abs((d.x0 + d.x1) / 2 - x) < 6);
        const dur = dotted ? 6 : 4;
        let bi = -1; evs.forEach((ev, i) => { if (bi < 0 && m.len - sumOf(ev) >= dur - 0.01) bi = i; });
        if (bi >= 0) evs[bi].push({ x, dur });
      }
    }
    const vts = evs.map(ev => {
      ev.sort((a, b) => a.x - b.x);
      let sum = sumOf(ev);
      let t = 0;
      const deficit = m.len - sum;
      if (deficit > 0.01 && ev.length && ev[0].x - m.x0 > (m.x1 - m.x0) * 0.22) t = deficit;
      if (sum > m.len + 0.01) { const k = m.len / sum; ev.forEach(e => e.dur *= k); m.squeezed = true; }
      else if (deficit > 0.01 && ev.some(e => !e.rest)) m.short = true;
      for (const e of ev) { e.t = t; t += e.dur; }
      for (const e of ev) if (!e.rest && !e.grace) (sy.ev = sy.ev || []).push({ x: e.x, t0: m.start + e.t, dur: e.dur });
      return ev.filter(e => !e.rest);
    });
    // форшлаг — короткая нота (1/32) прямо перед следующей нотой (в любом голосе)
    {
      const mains = vts.flat().filter(e => !e.grace).sort((a, b) => a.x - b.x), gr = vts.flat().filter(e => e.grace);
      for (const g of gr) {
        const nx = mains.find(e => e.x > g.x + 1), k = gr.filter(o => o.x >= g.x - 0.1 && (!nx || o.x < nx.x)).length;
        g.dur = 0.125; g.t = Math.max(0, (nx ? nx.t : m.len) - 0.125 * k);
      }
    }
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
      const midi = isDrum ? n.drum : tuning[n.si] + n.fret;
      if (isDrum) dur = Math.min(dur, 0.5);
      notes.push({ midi, string: n.si, fret: n.fret, start: m.start + c.t, dur: Math.max(0.05, dur), measure: m.n,
        tie: !!n.paren, gray: !!n.gray, src: n, x: n.cx, sy, ...(n.dead ? { x2: { dead: true } } : {}) });
    }
  }
  // текстовые обозначения → техники нот
  for (const sy of systems) for (const mk of sy.marks || []) {
    const cand = notes.filter(n => n.sy === sy);
    let hit;
    if (mk.ranged) hit = cand.filter(n => n.x >= mk.x0 && n.x <= mk.x1);
    else {
      const cx = (mk.x0 + mk.x1) / 2; let best = 1e9;
      for (const n of cand) best = Math.min(best, Math.abs(n.x - cx));
      hit = best < (mk.sym ? 5 : 14) ? cand.filter(n => Math.abs(Math.abs(n.x - cx) - best) < 2.5) : [];
    }
    for (const n of hit) {
      n.x2 = n.x2 || {};
      if (mk.kind === 'lh') { n.hand = 'L'; n.x2.lh = true; }
      else if (mk.kind === 'rh') n.hand = 'R';
      else if (mk.kind.startsWith('harm')) n.x2.harm = mk.kind.slice(4);
      else if (mk.kind === 'acc') n.x2.acc = Math.max(n.x2.acc || 0, 1);
      else if (mk.kind === 'marc') n.x2.acc = 2;
      else n.x2[mk.kind] = true;
    }
  }
  notes.sort((a, b) => a.start - b.start || a.midi - b.midi);
  // Обрезка: следующая нота на той же струне прерывает звук
  for (let i = 0; i < notes.length; i++) {
    const a = notes[i];
    for (let j = i + 1; j < notes.length; j++) {
      const b = notes[j];
      if (b.start >= a.start + a.dur - 1e-6) break;
      if (!isDrum && b.string === a.string && b.sy === a.sy && b.start > a.start + 1e-6 && !b.tie) { a.dur = b.start - a.start; break; }
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
    if (tgt && tgt.midi !== a.midi && tgt.string === a.string && arc.straight) {
      // косая черта к другой ноте на той же струне — слайд
      a.x2 = a.x2 || {}; a.x2.sl = 'legato'; a.x2.slTo = tgt.fret;
      a.dur = Math.max(a.dur, tgt.start - a.start);
    } else if (tgt && tgt.midi !== a.midi && tgt.string === a.string) {
      // дуга к другой ноте на той же струне — хаммер-он / пулл-офф
      a.x2 = a.x2 || {}; a.x2.hp = tgt.midi > a.midi ? 'h' : 'p';
    } else if (tgt && tgt.midi === a.midi) {
      if (!tgt.tie) tgt.tie = true;
      a.dur = Math.max(a.dur, tgt.start + tgt.dur - a.start);
    } else {
      // лига к штилю без цифры — нота тянется до конца этого штиля (продолжение звучит, цифру не пишут)
      const e = (sy.ev || []).filter(e => Math.abs(e.x - arc.x1) < 7 && e.t0 > a.start + 1e-6).sort((p, q) => Math.abs(p.x - arc.x1) - Math.abs(q.x - arc.x1))[0];
      const m = ms.find(m => m.sy === sy && arc.x1 >= m.x0 && arc.x1 <= m.x1 + 2);
      if (e) a.dur = Math.max(a.dur, e.t0 + e.dur - a.start);
      else if (m && arc.x1 >= m.x1 - 3) a.dur = Math.max(a.dur, m.start + m.len - a.start);
    }
  }
  // Техники из графики: вибрато, слайды, бенды (подтяжка, удержание, возврат)
  if (!isDrum) {
    const held = new Map(); // струна → { amt, until: {sy, x} }
    for (let i = 0; i < notes.length; i++) {
      const n = notes[i], s = n.src || {};
      const X = () => (n.x2 = n.x2 || {});
      if (s.vib) X().vib = s.vib;
      if (s.slide) {
        const nx = notes.slice(i + 1).find(q => q.string === n.string && q.sy === n.sy && q.start > n.start + 1e-6);
        if (nx && nx.x - n.x < 70 && nx.fret !== n.fret) { X().sl = 'shift'; n.x2.slTo = nx.fret; }
        else X().sl = s.slide === 'down' ? 'down' : 'up';
      }
      if (s.slideIn) X().slIn = s.slideIn;
      const h = held.get(n.string);
      const inHold = h && h.sy === n.sy && n.x <= h.x + 2 && n.start > h.start;
      const D = n.dur, q = Math.min(D * 0.35, 0.25);
      let curve = null, amt = 0;
      if (s.pre && s.rel) { amt = s.pre; curve = [[0, amt], [Math.min(D * 0.2, 0.12), amt], [Math.min(D * 0.55, 0.4), 0], [D, 0]]; }
      else if (s.pre) { amt = s.pre; curve = [[0, amt], [D, amt]]; }
      else if (s.bend) { amt = s.bend; curve = [[0, 0], [q, amt], [D, amt]]; }
      else if (s.rel) { amt = typeof s.rel === 'number' ? s.rel : (h ? h.amt : 2); curve = [[0, amt], [q, 0], [D, 0]]; }
      else if (inHold) { amt = h.amt; curve = [[0, amt], [D, amt]]; }
      if (curve) n.curve = curve.map(([o, v]) => [n.start + o, v]);
      if (s.holdTo && (s.bend || s.pre)) held.set(n.string, { amt: s.bend || s.pre, sy: n.sy, x: s.holdTo, start: n.start });
      else if (s.rel || (h && !inHold)) held.delete(n.string);
    }
  }
  // Ноты в скобках и связанные — продолжение предыдущей ноты той же высоты (кривая бенда склеивается)
  const outNotes = [];
  for (const n of notes) {
    if (n.tie) {
      const prev = [...outNotes].reverse().find(p => p.midi === n.midi && p.start < n.start - 1e-6 && p.start + p.dur >= n.start - 0.6);
      if (prev) {
        if (prev.curve || n.curve) {
          const pc = prev.curve || [[prev.start, 0], [prev.start + prev.dur, 0]];
          const lastV = pc[pc.length - 1][1];
          const nc = n.curve || [[n.start, lastV], [n.start + n.dur, lastV]];
          prev.curve = pc.filter(p => p[0] < n.start - 1e-6).concat(nc);
        }
        if (n.x2 && n.x2.vib) { prev.x2 = prev.x2 || {}; prev.x2.vib = n.x2.vib; }
        prev.dur = Math.max(prev.dur, n.start + n.dur - prev.start); continue;
      }
    }
    outNotes.push(n);
  }
  for (const n of outNotes) if (n.curve && n.curve.some(p => p[1] > 0)) {
    const D = Math.max(1e-3, n.dur), pts = n.curve.map(([t, v]) => [Math.max(0, Math.min(60, Math.round((t - n.start) / D * 60))), v]);
    const max = Math.max(...pts.map(p => p[1])), first = pts[0][1], last = pts[pts.length - 1][1];
    const type = first > 0 && last === 0 ? (first === max ? 'prebendRelease' : 'release') : first > 0 ? 'prebend' : last === 0 ? 'bendRelease' : 'bend';
    n.x2 = n.x2 || {}; n.x2.bend = { type, max, pts };
  }
  // Слова песни → доли: слог стоит под своей нотой (ближайший штиль), иначе — по положению в такте
  const lyrics = [];
  for (const sy of systems) for (const w of sy.lyrics || []) {
    const cx = (w.x0 + w.x1) / 2;
    const m = ms.find(m => m.sy === sy && cx >= m.x0 - 2 && cx < m.x1 + 2) || ms.find(m => m.sy === sy && w.x0 >= m.x0 - 2 && w.x0 < m.x1);
    if (!m) continue;
    const ev = (sy.ev || []).filter(e => e.x >= m.x0 - 1 && e.x <= m.x1 + 1).sort((a, b) => a.x - b.x);
    let best = null, bd = 9;
    for (const e of ev) { const d = Math.min(Math.abs(e.x - cx), Math.abs(e.x - w.x0 - 3)); if (d < bd) { bd = d; best = e; } }
    let t;
    if (best) t = best.t0;
    else {
      const pts = [[m.x0 + 6, m.start], ...ev.map(e => [e.x, e.t0]), [m.x1, m.start + m.len]];
      t = m.start + m.len * Math.max(0, Math.min(1, (cx - m.x0) / Math.max(1, m.x1 - m.x0)));
      for (let k = 1; k < pts.length; k++) if (cx <= pts[k][0]) { const [xa, ta] = pts[k - 1], [xb, tb] = pts[k]; t = ta + (tb - ta) * Math.max(0, Math.min(1, (cx - xa) / Math.max(1, xb - xa))); break; }
      t = Math.round(t * 4) / 4;
    }
    lyrics.push({ start: +t.toFixed(4), s: w.s });
  }
  lyrics.sort((a, b) => a.start - b.start);
  // ударные: головки в положении, которому нет элемента установки, не озвучиваем — показываем для проверки
  const unknown = isDrum ? outNotes.filter(n => n.midi == null).map(n => ({ start: +n.start.toFixed(4), measure: n.measure, page: n.sy.page, head: n.src.head, step: n.src.step, box: [n.src.b.x0, n.src.b.y0, n.src.b.x1, n.src.b.y1].map(v => +v.toFixed(1)) })) : [];
  const clean = outNotes.filter(n => n.midi != null).map(n => ({ midi: n.midi, start: +n.start.toFixed(4), dur: +n.dur.toFixed(4), string: n.string, fret: n.fret, measure: n.measure, voice: n.gray ? 1 : 0,
    page: n.sy.page, box: [n.src.b.x0, n.src.b.y0, n.src.b.x1, n.src.b.y1].map(v => +v.toFixed(1)),
    ...(n.x2 && Object.keys(n.x2).length ? { x: n.x2 } : {}), ...(n.hand ? { hand: n.hand } : {}) }));
  return {
    pv: PARSER_VERSION, title: meta.title || 'Без названия', track: meta.track, instrument: meta.instrument,
    tuning: isDrum ? null : tuning, tuningNames: isDrum ? null : tuningNames, strings: nStr, isBass, isDrum,
    measures: ms.filter(m => !m.cont).map(m => ({ n: m.n, start: m.start, len: m.fullLen || m.len, tempo: m.tempo, sig: m.sig, ...(m.tempoPts ? { tempoPts: m.tempoPts } : {}), ...(m.marker ? { marker: m.marker } : {}), ...(m.squeezed || m.short || m.restMismatch ? { rhythmCheck: true } : {}) })),
    totalBeats: total, notes: clean, unknown, ...(lyrics.length ? { lyrics } : {})
  };
}
