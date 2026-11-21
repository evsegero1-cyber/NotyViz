// «Дорога» — гриф уходит вдаль, ноты летят к игроку (по мотивам Rocksmith).
// Лад — дорожка по горизонтали, струна — высота и цвет, время — глубина.
// Длинная нота — хвост на всю длительность: голова доезжает до линии удара, «прилипает» к ней
// и горит, пока хвост не кончится. Плотные места разрежены: окно времени сужается само,
// повтор того же аккорда — пустая рамка, следующий удар подсвечен и показан кольцами на грифе.
import { STRING_COLORS } from './views.js';
import { bendText } from './techniques.js';
import { bendAt, slideAt, vibAt, trillFret, techMark, drawBendArrow, techCaption, drawCaption } from './techfx.js';

const shade = (hex, k) => { const n = parseInt(hex.slice(1), 16); const f = v => Math.max(0, Math.min(255, Math.round(k > 0 ? v + (255 - v) * k : v * (1 + k)))); return `rgb(${f(n >> 16)},${f((n >> 8) & 255)},${f(n & 255)})`; };
function rr(g, x, y, w, h, r) { r = Math.max(0, Math.min(r, w / 2, h / 2)); g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); }
const INLAY = [3, 5, 7, 9, 12, 15, 17, 19, 21, 24];
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export class RoadView {
  constructor() { this.cam = null; this.camV = { a: 0, b: 0 }; }
  setTrack(track, notes, tuningNames) {
    this.n = track.tuning.length; this.notes = notes; this.names = tuningNames;
    this.cam = null;
    // хаммер/пулл приходят на следующую ноту той же струны — её рисуем «пустой» (без удара медиатором)
    for (const q of notes) if (q.x && q.x.hp && q.next != null && notes[q.next]) notes[q.next].hpIn = q.x.hp;
    // группы одновременных нот и повторы аккордов
    let prev = null;
    for (let i = 0; i < notes.length;) {
      let j = i; while (j + 1 < notes.length && notes[j + 1].s === notes[i].s) j++;
      const grp = notes.slice(i, j + 1), sig = grp.map(q => q.st + ':' + q.f).sort().join(',');
      const rep = grp.length > 1 && prev && prev.sig === sig && grp[0].s - prev.s < 1.3;
      for (const q of grp) { q.gi = i; q.gn = grp.length; q.rep = rep; q.nextAttack = notes[j + 1]?.s ?? Infinity; }
      prev = { sig, s: grp[0].s }; i = j + 1;
    }
  }
  // какие лады нужны в ближайшие секунды
  need(t, notes, firstIdx, ahead) {
    let lo = 99, hi = 0;
    for (let i = firstIdx(notes, t - 0.05); i < notes.length; i++) {
      const q = notes[i]; if (q.s > t + ahead) break; if (q.e < t) continue;
      if (q.f > 0) { lo = Math.min(lo, q.f); hi = Math.max(hi, q.f); }
      if (q.x && q.x.slTo > 0) { lo = Math.min(lo, q.x.slTo); hi = Math.max(hi, q.x.slTo); }
    }
    return lo === 99 ? null : { lo, hi };
  }
  draw(g, W, H, ctx) {
    const { t, notes, speed, firstIdx } = ctx;
    const n = this.n;
    g.fillStyle = '#07090d'; g.fillRect(0, 0, W, H);
    if (!notes) return;
    const now = performance.now(), dt = Math.min(0.1, (now - (this.lastT || now)) / 1000); this.lastT = now;
    const win = (ctx.preview || 2.2) * speed;
    // --- камера: держит нужные лады в кадре, двигается плавно (пружина без рывков) ---
    const nd = this.need(t, notes, firstIdx, 1.8) || (this.cam ? { lo: Math.round((this.cam.a + this.cam.b) / 2), hi: Math.round((this.cam.a + this.cam.b) / 2) } : { lo: 1, hi: 5 });
    const span = Math.max(5, nd.hi - nd.lo + 3);
    const fit = c => nd.lo >= c.a + 0.6 && nd.hi <= c.b - 0.6;
    const mk = () => { const a = Math.max(0.5, (nd.lo + nd.hi) / 2 - span / 2); return { a, b: a + span }; };
    if (!this.cam) { this.cam = mk(); this.tgt = { ...this.cam }; }
    if (!fit(this.tgt) || (this.tgt.b - this.tgt.a) > span + 4) this.tgt = mk();
    const soon = this.need(t, notes, firstIdx, 0.5), urgent = soon && (soon.lo < this.cam.a + 0.4 || soon.hi > this.cam.b - 0.4);
    const w0 = urgent ? 7 : 3.2;
    for (const k of ['a', 'b']) { const acc = w0 * w0 * (this.tgt[k] - this.cam[k]) - 2 * w0 * this.camV[k]; this.camV[k] += acc * dt; this.cam[k] += this.camV[k] * dt; }
    const fa = this.cam.a, fb = Math.max(this.cam.a + 4, this.cam.b);
    // --- геометрия ---
    const top = ctx.land ? 40 : 6;
    const neckH = Math.min(H * 0.3, 24 * n + 26);
    const nearY = H - neckH;
    const horY = top + (nearY - top) * 0.04;
    const padL = 34, nearL = padL, nearR = W - 8, cx = (nearL + nearR) / 2;
    const K = 0.45;
    const s1 = 1 / (1 + K);
    const u = z => (1 / (1 + z * K) - s1) / (1 - s1);                 // 1 — у игрока, 0 — у горизонта
    const yOf = z => horY + (nearY - horY) * u(z);
    const scl = z => 0.3 + 0.7 * u(z);
    const xAt = (xn, z) => cx + (xn - cx) * scl(z);
    const xFret = f => nearL + (f - fa) / (fb - fa) * (nearR - nearL);
    const laneW = (nearR - nearL) / (fb - fa);
    const strGap = (neckH - 22) / Math.max(1, n - 1);
    const strY = s => nearY + 8 + s * strGap;
    const LIFT = Math.min(strGap * 0.75, (nearY - horY) * 0.42 / Math.max(1, n - 1));
    const lift = s => (n - 0.4 - s) * LIFT;
    const zOf = s => (s - t) / win;
    const P = (f, st, z, dy = 0) => ({ x: xAt(xFret(f), z), y: yOf(z) - (lift(st) + dy) * scl(z) });
    // --- дорога ---
    const fFrom = Math.floor(fa - 0.5), fTo = Math.ceil(fb + 0.5);
    for (let f = fFrom; f <= fTo; f++) {
      const x0 = xFret(f - 0.5), x1 = xFret(f + 0.5);
      g.beginPath(); g.moveTo(x0, nearY); g.lineTo(x1, nearY); g.lineTo(xAt(x1, 1), horY); g.lineTo(xAt(x0, 1), horY); g.closePath();
      g.fillStyle = f % 2 ? '#0e1218' : '#11161e'; g.fill();
      if (INLAY.includes(f)) { g.fillStyle = 'rgba(255,255,255,.035)'; g.fill(); }
      g.strokeStyle = 'rgba(255,255,255,.05)'; g.lineWidth = 1; g.beginPath(); g.moveTo(x0, nearY); g.lineTo(xAt(x0, 1), horY); g.stroke();
    }
    // такты, доли, части песни
    const ms = ctx.mStarts, mi = ctx.measureIdx, secs = ctx.sections || [];
    for (let i = Math.max(0, mi - 1); i < ms.length; i++) {
      const z = zOf(ms[i]); if (z > 1) break;
      const next = ms[i + 1] != null ? ms[i + 1] : ms[i] + 2, beats = (ctx.measures[i].sig || [4, 4])[0];
      for (let b = 1; b < beats; b++) { const zb = zOf(ms[i] + (next - ms[i]) * b / beats); if (zb < 0 || zb > 1) continue; const yb = yOf(zb); g.fillStyle = 'rgba(255,255,255,.07)'; g.fillRect(xAt(nearL, zb), yb, xAt(nearR, zb) - xAt(nearL, zb), 1); }
      if (z < 0) continue;
      const y = yOf(z), xl = xAt(nearL, z), xr = xAt(nearR, z);
      const sec = secs.find(s => s.a === i);
      g.fillStyle = sec ? sec.col : 'rgba(255,255,255,.2)'; g.fillRect(xl, y, xr - xl, Math.max(1, (sec ? 3 : 2) * scl(z)));
      g.fillStyle = 'rgba(255,255,255,.4)'; g.font = `${Math.max(9, Math.round(11 * scl(z)))}px system-ui`; g.textAlign = 'right'; g.textBaseline = 'bottom';
      g.fillText(ctx.measures[i].n, xl - 3, y);
      if (sec && i > 0) { g.font = `700 ${Math.round(10 + 5 * scl(z))}px system-ui`; g.textAlign = 'left'; g.fillStyle = sec.col; g.fillText(sec.name, xl + 4, y - 2); }
    }
    if (ctx.loop) { const za = zOf(ctx.loop.b); if (za > 0 && za < 1) { g.fillStyle = 'rgba(60,207,142,.8)'; g.fillRect(xAt(nearL, za), yOf(za) - 1, xAt(nearR, za) - xAt(nearL, za), 2); } }
    // --- видимые ноты ---
    const vis = [];
    for (let i = firstIdx(notes, t - 8); i < notes.length; i++) { const q = notes[i]; if (q.s > t + win) break; if (q.e < t - 0.15) continue; vis.push(q); }
    vis.sort((a, b) => b.s - a.s || a.st - b.st);
    let nextS = null; for (const q of vis) if (q.s > t + 0.01 && (nextS == null || q.s < nextS)) nextS = q.s;
    const active = [];
    const groups = new Map();
    const gemH = z => Math.max(6, Math.min(strGap * 0.8, LIFT * 0.92 + 4) * scl(z));
    const gemW = (q, z) => q.f === 0 ? (nearR - nearL) * 0.9 * scl(z) : Math.min(laneW * 0.8, Math.max(30, laneW * 0.6)) * scl(z);
    for (const q of vis) {
      const x = q.x || {}, col = STRING_COLORS[q.st % STRING_COLORS.length], open = q.f === 0;
      const end = Math.min(q.e, notes[q.next]?.s ?? Infinity);
      const on = q.s <= t && end > t;
      if (on) active.push(q);
      const dur = Math.max(0.001, q.e - q.s);
      // хвост: от текущего момента (или начала) до конца ноты — с бендом, слайдом, вибрато
      const tA = Math.max(q.s, t), tB = Math.min(end, t + win);
      const tech = x.bend || x.sl || x.slIn || x.vib || x.trem || x.tr != null || x.ring;
      if ((dur > 0.5 || (tech && dur > 0.15)) && tB > tA + 0.01) {
        const hw = open ? (nearR - nearL) * 0.42 : Math.min(laneW * 0.14, 9);
        const L = [], R = [];
        const N = Math.max(4, Math.min(40, Math.ceil((tB - tA) / 0.03)));
        for (let k = 0; k <= N; k++) {
          const tau = tA + (tB - tA) * k / N, z = zOf(tau), fr = (tau - q.s) / dur;
          const ff = open ? null : slideAt(q, fr);
          const dy = (bendAt(x, fr) * 0.9 + vibAt(x, tau) * 0.55) * LIFT;
          const xc = open ? cx : xFret(ff), y = yOf(z) - (lift(q.st) + dy) * scl(z);
          L.push([xAt(xc - hw, z), y]); R.push([xAt(xc + hw, z), y]);
        }
        g.beginPath(); L.forEach((p, k) => k ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1])); for (let k = R.length - 1; k >= 0; k--) g.lineTo(R[k][0], R[k][1]); g.closePath();
        g.fillStyle = col; g.globalAlpha = on ? 0.45 : 0.17; g.fill(); g.globalAlpha = 1;
        g.strokeStyle = shade(col, 0.35); g.lineWidth = 1; g.globalAlpha = 0.4;
        g.beginPath(); L.forEach((p, k) => k ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1])); g.stroke();
        g.beginPath(); R.forEach((p, k) => k ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1])); g.stroke(); g.globalAlpha = 1;
        if (x.trem || (x.tr != null && !x.trillAux)) { // тремоло и трель: чёрточки поперёк хвоста
          g.strokeStyle = 'rgba(255,255,255,.75)'; g.lineWidth = 1.5;
          for (let tau = q.s + 0.07; tau < tB; tau += 0.07) { if (tau < tA) continue; const z = zOf(tau); const xc = open ? cx : xFret(x.tr != null && Math.round((tau - q.s) / 0.07) % 2 ? q.f + (x.tr - q.m) : q.f), y = yOf(z) - lift(q.st) * scl(z); g.beginPath(); g.moveTo(xAt(xc - hw * 1.6, z), y); g.lineTo(xAt(xc + hw * 1.6, z), y); g.stroke(); }
        }
        if (x.ring) { const z = zOf(tB); const p = P(open ? (fa + fb) / 2 : q.f, q.st, z); g.fillStyle = col; g.font = '600 10px system-ui'; g.textAlign = 'center'; g.textBaseline = 'bottom'; if (z < 0.98) g.fillText('l.r.', p.x, p.y - 2); }
      }
      // После атаки нота остаётся только на струне грифа.
      if (q.s <= t) continue;
      const z = zOf(q.s);
      const ff = open ? null : slideAt(q, 0);
      const s = scl(z), y = yOf(z) - lift(q.st) * s, xc = open ? cx : xFret(ff);
      const gap = (q.nextAttack - q.s) / win * (nearY - horY);
      const gh = Math.max(6, Math.min(gemH(z), 0.8 * gap)), gw = gemW(q, z), gx = xAt(xc, z) - gw / 2;
      const fade = nextS === q.s ? 1 : Math.max(0.38, 0.74 - z * 0.3);
      { // тень и «ножка» до дороги
        g.fillStyle = 'rgba(0,0,0,.4)'; g.fillRect(xAt(xc, z) - gw * 0.45, yOf(z) - 1, gw * 0.9, 2);
        if (lift(q.st) * s > 3) { g.strokeStyle = shade(col, -0.45); g.lineWidth = 1; g.beginPath(); g.moveTo(xAt(xc, z), yOf(z)); g.lineTo(xAt(xc, z), y + gh / 2); g.stroke(); }
      }
      if (!groups.has(q.gi)) groups.set(q.gi, []); groups.get(q.gi).push({ q, x: xAt(xc, z), y, gw, gh, z });
      if (q.rep) continue; // повтор аккорда — только рамка
      const isNext = nextS != null && q.s === nextS;
      g.globalAlpha = fade * (x.ghost ? 0.5 : 1);
      if (x.harm) { // флажолет — ромб
        g.beginPath(); g.moveTo(gx + gw / 2, y - gh * 0.75); g.lineTo(gx + gw, y); g.lineTo(gx + gw / 2, y + gh * 0.75); g.lineTo(gx, y); g.closePath();
      } else rr(g, gx, y - gh / 2, gw, gh, Math.min(8, gh / 2.2));
      if (q.hpIn) { g.fillStyle = 'rgba(7,9,13,.8)'; g.fill(); g.strokeStyle = col; g.lineWidth = Math.max(2, 3 * s); g.stroke(); }
      else { g.fillStyle = col; g.fill(); g.strokeStyle = isNext ? '#fff' : x.acc ? '#fff' : 'rgba(255,255,255,.5)'; g.lineWidth = isNext ? 2.5 : x.acc ? 2 : 1; g.stroke(); }
      if (x.pm) { g.save(); g.clip(); g.strokeStyle = 'rgba(0,0,0,.45)'; g.lineWidth = 2; for (let xx = gx - gh; xx < gx + gw; xx += 6) { g.beginPath(); g.moveTo(xx, y + gh / 2); g.lineTo(xx + gh, y - gh / 2); g.stroke(); } g.restore(); }
      if (x.dead) { const c0 = xAt(xc, z), r = gh * 0.3; g.strokeStyle = '#000'; g.lineWidth = 2; g.beginPath(); g.moveTo(c0 - r, y - r); g.lineTo(c0 + r, y + r); g.moveTo(c0 + r, y - r); g.lineTo(c0 - r, y + r); g.stroke(); }
      if (q.res) { g.strokeStyle = q.res === 'hit' ? '#3ccf8e' : '#ff5c5c'; g.lineWidth = 3; rr(g, gx - 2, y - gh / 2 - 2, gw + 4, gh + 4, 8); g.stroke(); }
      if (s > 0.47 && !open && !x.dead) { g.fillStyle = q.hpIn ? '#fff' : '#000'; g.font = `700 ${Math.round(Math.max(9, Math.min(15, gh * 0.82)))}px system-ui`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(Math.round(ff), xAt(xc, z), y + 0.5); }
      if (x.ghost && s > 0.4) { g.fillStyle = col; g.font = `${Math.round(gh)}px system-ui`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('(', gx - 4, y); g.fillText(')', gx + gw + 4, y); }
      g.globalAlpha = 1;
      // обозначения техник над нотой
      if (s > 0.38) {
        if (x.bend) drawBendArrow(g, gx + gw + 6 * s, y + gh * 0.3, Math.max(10, 18 * s), x.bend.max, '#ff8a3d', /release/i.test(x.bend.type || '') && !/bend/i.test((x.bend.type || '').replace('release', '')));
        const lab = (q.hpIn ? (q.hpIn === 'h' ? 'H' : 'P') : '') || techMark(x, q.f);
        if (lab) { g.fillStyle = q.hpIn ? '#d9b3ff' : '#ffd9bd'; g.font = `700 ${Math.round(10 * s + 4)}px system-ui`; g.textAlign = 'center'; g.textBaseline = 'bottom'; g.fillText(lab, xAt(xc, z), y - gh / 2 - 2); }
        if ((x.sl && x.slTo == null) || x.slIn) { // слайд из ниоткуда / в никуда — стрелка
          g.strokeStyle = '#4dd0e1'; g.lineWidth = 2; g.beginPath();
          if (x.slIn) { const d = x.slIn === 'below' ? -1 : 1; g.moveTo(xAt(xc + d * 1.2, z), y + gh); g.lineTo(gx + (d < 0 ? 0 : gw), y); }
          else { const d = x.sl.endsWith('up') ? 1 : -1; g.moveTo(gx + (d > 0 ? gw : 0), y); g.lineTo(xAt(xc + d * 1.2, z), y - gh); }
          g.stroke();
        }
      }
      // h/p: дуга от предыдущей ноты
      if (x.hp && q.next != null && notes[q.next]) {
        const q2 = notes[q.next], z2 = zOf(q2.s); if (z2 <= 1) { const p2 = P(q2.f, q2.st, z2); g.strokeStyle = '#c77dff'; g.lineWidth = 2 * s; g.beginPath(); g.moveTo(xAt(xc, z), y - gh / 2); g.quadraticCurveTo((xAt(xc, z) + p2.x) / 2, Math.min(y, p2.y) - gh * 1.4, p2.x, p2.y - gemH(z2) / 2); g.stroke(); }
      }
    }
    // рамки аккордов
    for (const arr of groups.values()) {
      if (arr.length < 2) continue;
      const q0 = arr[0].q;
      const z = Math.min(...arr.map(a => a.z)), s = scl(z);
      const x0 = Math.min(...arr.map(a => a.x - a.gw / 2)), x1 = Math.max(...arr.map(a => a.x + a.gw / 2));
      const y0 = Math.min(...arr.map(a => a.y - a.gh / 2)), y1 = Math.max(...arr.map(a => a.y + a.gh / 2));
      const isNext = nextS != null && q0.s === nextS;
      g.strokeStyle = isNext ? '#fff' : q0.rep ? 'rgba(255,255,255,.55)' : 'rgba(255,255,255,.75)'; g.lineWidth = q0.rep ? 2 : 1.5;
      rr(g, x0 - 4 * s, y0 - 4 * s, x1 - x0 + 8 * s, y1 - y0 + 8 * s, 6); g.stroke();
      if (q0.rep) { g.fillStyle = 'rgba(255,255,255,.06)'; g.fill(); for (const a of arr) { g.fillStyle = STRING_COLORS[a.q.st % STRING_COLORS.length]; g.fillRect(x0 - 4 * s, a.y - 1, 6 * s, 2); g.fillRect(x1 - 2 * s, a.y - 1, 6 * s, 2); } }
      const xs = q0.x || {};
      if (xs.stroke || xs.brush) { const up = (xs.stroke || xs.brush) === 'up'; g.fillStyle = '#ffd9bd'; g.font = `700 ${Math.round(12 * s + 4)}px system-ui`; g.textAlign = 'right'; g.textBaseline = 'middle'; g.fillText(up ? '↑' : '↓', x0 - 6 * s, (y0 + y1) / 2); }
      const chn = !q0.rep && ctx.chordFor ? ctx.chordFor(q0.s) : null;
      if (chn && s > 0.4) { g.fillStyle = '#ffd23f'; g.font = `700 ${Math.round(12 * s + 3)}px system-ui`; g.textAlign = 'center'; g.textBaseline = 'bottom'; g.fillText(chn, (x0 + x1) / 2, y0 - 6 * s); }
    }
    // --- ближний край: гриф ---
    g.fillStyle = '#1a140f'; g.fillRect(0, nearY, W, H - nearY);
    for (let f = fFrom; f <= fTo; f++) {
      const xl = xFret(f - 0.5); if (xl < nearL - 1 || xl > nearR + 1) continue;
      g.fillStyle = '#8f949c'; g.fillRect(xl - 1, nearY + 2, 2, (n - 1) * strGap + 12);
    }
    g.font = '11px system-ui'; g.textAlign = 'center'; g.textBaseline = 'top';
    for (let f = Math.max(1, fFrom); f <= fTo; f++) { const xc = xFret(f); if (xc < nearL || xc > nearR) continue; g.fillStyle = INLAY.includes(f) ? '#e9ecf2' : '#6b7280'; g.fillText(f, xc, nearY + (n - 1) * strGap + 12); }
    for (let s = 0; s < n; s++) {
      const y = strY(s), col = STRING_COLORS[s % STRING_COLORS.length];
      g.fillStyle = col; g.globalAlpha = 0.85; g.fillRect(nearL - 4, y - 0.75 - s * 0.15, W - nearL, 1.5 + s * 0.3); g.globalAlpha = 1;
      g.fillStyle = col; g.font = '600 12px system-ui'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(this.names ? this.names[s] : s + 1, 14, y);
    }
    g.fillStyle = 'rgba(255,255,255,.75)'; g.fillRect(nearL, nearY - 1, nearR - nearL, 2);
    const R = Math.min(12, strGap * 0.55 + 3);
    // следующий удар: кольца сжимаются к месту на грифе
    if (nextS != null && nextS - t < 1.2) {
      const k = clamp((nextS - t) / 1.2, 0, 1);
      for (const q of vis) if (q.s === nextS) {
        const col = STRING_COLORS[q.st % STRING_COLORS.length], y = strY(q.st);
        g.globalAlpha = 0.35 + 0.65 * (1 - k);
        if (q.f === 0) { g.strokeStyle = col; g.lineWidth = 2; g.strokeRect(nearL, y - 5 - k * 6, nearR - nearL, 10 + k * 12); }
        else { const x = xFret(slideAt(q, 0)); g.strokeStyle = col; g.lineWidth = 2.5; g.beginPath(); g.arc(x, y, R + k * 22, 0, 7); g.stroke(); g.fillStyle = col; g.globalAlpha *= 0.35; g.beginPath(); g.arc(x, y, R, 0, 7); g.fill(); }
        g.globalAlpha = 1;
      }
    }
    // звучит сейчас: точка на грифе (бенд сдвигает её поперёк струны, слайд — вдоль), кольцо — сколько ещё держать
    for (const q of active) {
      const x = q.x || {}, col = STRING_COLORS[q.st % STRING_COLORS.length], dur = Math.max(0.001, q.e - q.s), fr = (t - q.s) / dur;
      if (q.f === 0) { g.fillStyle = col; g.globalAlpha = 0.5; g.fillRect(nearL, strY(q.st) - 4, nearR - nearL, 8); g.globalAlpha = 1; continue; }
      const ff = trillFret(q, t) !== q.f ? trillFret(q, t) : slideAt(q, fr), semi = bendAt(x, fr) + vibAt(x, t);
      const bx = xFret(ff), y0 = strY(q.st), y = y0 - clamp(semi, -1.5, 3) * strGap * 0.45;
      if (Math.abs(semi) > 0.05) { g.strokeStyle = col; g.lineWidth = 2; g.beginPath(); g.moveTo(bx - R * 1.5, y0); g.quadraticCurveTo(bx, y, bx + R * 1.5, y0); g.stroke(); }
      if (x.harm) { g.strokeStyle = '#4dd0e1'; g.lineWidth = 3; g.beginPath(); g.moveTo(bx, y - R - 3); g.lineTo(bx + R + 3, y); g.lineTo(bx, y + R + 3); g.lineTo(bx - R - 3, y); g.closePath(); g.stroke(); }
      g.fillStyle = x.pm ? shade(col, -0.45) : col; g.beginPath(); g.arc(bx, y, R, 0, 7); g.fill();
      if (dur > 0.5) { g.strokeStyle = '#fff'; g.lineWidth = 2.5; g.beginPath(); g.arc(bx, y, R + 4, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * (1 - clamp(fr, 0, 1))); g.stroke(); }
      g.fillStyle = x.pm ? '#fff' : '#000'; g.font = '700 11px system-ui'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(x.dead ? 'x' : Math.round(ff), bx, y + 0.5);
      if (x.bend && semi > 0.2) { g.fillStyle = '#ff8a3d'; g.font = '700 11px system-ui'; g.textBaseline = 'bottom'; g.fillText('↑' + bendText(semi).trim(), bx, y - R - 5); }
      const age = t - q.s; if (age < 0.2) { g.strokeStyle = col; g.globalAlpha = 1 - age / 0.2; g.lineWidth = 3; g.beginPath(); g.arc(bx, nearY, 10 + age * 120, Math.PI, 0); g.stroke(); g.globalAlpha = 1; }
    }
    // плашка: какая техника сейчас / скоро
    const cap = techCaption(notes, t, firstIdx, 'g');
    if (cap) drawCaption(g, cap, W / 2, ctx.land ? 108 : top + 38, t);
    g.textAlign = 'left';
  }
}
