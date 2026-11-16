// «Дорога» — гриф уходит вдаль, ноты летят к игроку (по мотивам Rocksmith).
// Лад — дорожка по горизонтали, струна — высота и цвет, время — глубина.
import { STRING_COLORS } from './views.js';

const shade = (hex, k) => { const n = parseInt(hex.slice(1), 16); const f = v => Math.max(0, Math.min(255, Math.round(k > 0 ? v + (255 - v) * k : v * (1 + k)))); return `rgb(${f(n >> 16)},${f((n >> 8) & 255)},${f(n & 255)})`; };
function rr(g, x, y, w, h, r) { r = Math.max(0, Math.min(r, w / 2, h / 2)); g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); }

export class RoadView {
  constructor() { this.cam = null; this.flash = new Map(); }
  setTrack(track, notes, tuningNames) {
    this.n = track.tuning.length; this.notes = notes; this.names = tuningNames;
    // окно ладов «под рукой»: ближайшие ноты задают позицию
    this.cam = null;
  }
  // позиция руки: средний лад нот на ближайшие ~2 с (открытые струны не двигают руку)
  handTarget(t, notes, firstIdx) {
    let lo = 99, hi = 0, cnt = 0;
    for (let i = firstIdx(notes, t - 0.05); i < notes.length; i++) {
      const q = notes[i]; if (q.s > t + 2.2) break; if (q.f > 0) { lo = Math.min(lo, q.f); hi = Math.max(hi, q.f); cnt++; }
    }
    if (!cnt) return this.cam ? this.cam : { a: 0.5, b: 5.5 };
    const span = Math.max(4, hi - lo + 2);
    const a = Math.max(0.5, lo - 1 - (span - (hi - lo + 2)) / 2);
    return { a, b: a + span };
  }
  draw(g, W, H, ctx) {
    const { t, notes, speed, firstIdx } = ctx;
    const n = this.n;
    g.fillStyle = '#07090d'; g.fillRect(0, 0, W, H);
    if (!notes) return;
    // камера плавно едет за рукой
    const tg = this.handTarget(t, notes, firstIdx);
    if (!this.cam || Math.abs(tg.a - this.cam.a) > 12) this.cam = { ...tg };
    const now = performance.now(), dt = Math.min(0.1, (now - (this.lastT || now)) / 1000); this.lastT = now;
    // скоро нужная нота вне окна — догоняем быстрее
    let urgent = false;
    for (let i = firstIdx(notes, t - 0.02); i < notes.length; i++) { const q = notes[i]; if (q.s > t + 0.6) break; if (q.f > 0 && (q.f < this.cam.a + 0.4 || q.f > this.cam.b - 0.4)) urgent = true; }
    const k = 1 - Math.exp(-dt * (urgent ? 9 : 3.2));
    this.cam.a += (tg.a - this.cam.a) * k; this.cam.b += (tg.b - this.cam.b) * k;
    const fa = this.cam.a, fb = this.cam.b;
    // геометрия
    const top = ctx.land ? 40 : 6;
    const neckH = Math.min(H * 0.3, 26 * n + 26);          // ближний край: гриф со струнами
    const nearY = H - neckH;                                 // линия удара
    const horY = top + (nearY - top) * 0.06;                 // горизонт
    const padL = 34, nearL = padL, nearR = W - 8, cx = (nearL + nearR) / 2;
    const win = Math.max(1.6, Math.min(4.5, 3.2 * speed));   // секунд впереди
    const K = 3.2;                                           // сила перспективы
    const sOf = z => 1 / (1 + z * K);                        // масштаб на глубине z∈[0,1]
    const yOf = z => horY + (nearY - horY) * (sOf(z) - sOf(1)) / (1 - sOf(1));
    const xAt = (xn, z) => cx + (xn - cx) * (0.25 + 0.75 * (sOf(z) - sOf(1)) / (1 - sOf(1)));
    const scl = z => 0.25 + 0.75 * (sOf(z) - sOf(1)) / (1 - sOf(1));
    const xFret = f => nearL + (f - fa) / (fb - fa) * (nearR - nearL);      // середина лада f на ближнем краю
    const laneW = (nearR - nearL) / (fb - fa);
    const strGap = (neckH - 22) / Math.max(1, n - 1);
    const strY = s => nearY + 8 + s * strGap;               // струны на грифе: 0 — тонкая сверху
    const lift = s => (n - 1 - s) * strGap * 0.9;            // высота «стены струн» над дорогой
    // дорога: полосы ладов
    const fFrom = Math.floor(fa - 0.5), fTo = Math.ceil(fb + 0.5);
    for (let f = fFrom; f <= fTo; f++) {
      const x0 = xFret(f - 0.5), x1 = xFret(f + 0.5);
      g.beginPath(); g.moveTo(x0, nearY); g.lineTo(x1, nearY); g.lineTo(xAt(x1, 1), horY); g.lineTo(xAt(x0, 1), horY); g.closePath();
      g.fillStyle = f % 2 ? '#0e1218' : '#11161e'; g.fill();
      if ([3, 5, 7, 9, 12, 15, 17, 19, 21, 24].includes(f)) { g.fillStyle = 'rgba(255,255,255,.035)'; g.fill(); }
    }
    // линии тактов и долей поперёк дороги
    const ms = ctx.mStarts, mi = ctx.measureIdx;
    for (let i = Math.max(0, mi - 1); i < ms.length; i++) {
      const z = (ms[i] - t) / win; if (z > 1) break; if (z < 0) continue;
      const y = yOf(z), xl = xAt(nearL, z), xr = xAt(nearR, z);
      g.fillStyle = 'rgba(255,255,255,.18)'; g.fillRect(xl, y, xr - xl, Math.max(1, 2 * scl(z)));
      // доли
      const next = ms[i + 1] != null ? ms[i + 1] : ms[i] + 2, beats = (ctx.measures[i].sig || [4, 4])[0];
      for (let b = 1; b < beats; b++) { const zb = (ms[i] + (next - ms[i]) * b / beats - t) / win; if (zb < 0 || zb > 1) continue; const yb = yOf(zb); g.fillStyle = 'rgba(255,255,255,.06)'; g.fillRect(xAt(nearL, zb), yb, xAt(nearR, zb) - xAt(nearL, zb), 1); }
      g.fillStyle = 'rgba(255,255,255,.35)'; g.font = `${Math.max(9, Math.round(11 * scl(z)))}px system-ui`; g.textAlign = 'right'; g.textBaseline = 'bottom';
      g.fillText(ctx.measures[i].n, xl - 3, y);
    }
    // ноты: от дальних к ближним
    const vis = [];
    for (let i = firstIdx(notes, t - 0.4); i < notes.length; i++) {
      const q = notes[i]; if (q.s > t + win) break; if (q.e < t - 0.05) continue; vis.push(q);
    }
    vis.sort((a, b) => b.s - a.s);
    const active = [];
    // аккорды: рамка вокруг одновременных нот
    const groups = new Map();
    for (const q of vis) { const key = Math.round(q.s * 50); if (!groups.has(key)) groups.set(key, []); groups.get(key).push(q); }
    for (const q of vis) {
      const z0 = Math.max(0, (q.s - t) / win), z1 = Math.min(1, Math.max(0, (q.e - t) / win));
      const on = q.s <= t + 0.01 && q.e > t;
      if (on) active.push(q);
      const col = STRING_COLORS[q.st % STRING_COLORS.length];
      const x = q.x || {};
      const open = q.f === 0;
      const xc = open ? cx : xFret(q.f);
      // хвост (длительность)
      if (q.e - q.s > 0.22 && z1 > z0) {
        const w0 = (open ? (nearR - nearL) * 0.9 : Math.min(laneW * 0.22, 16)), y0 = yOf(z0) - lift(q.st) * scl(z0), y1 = yOf(z1) - lift(q.st) * scl(z1);
        g.beginPath(); g.moveTo(xAt(xc - w0 / 2, z0), y0); g.lineTo(xAt(xc + w0 / 2, z0), y0); g.lineTo(xAt(xc + w0 / 2, z1), y1); g.lineTo(xAt(xc - w0 / 2, z1), y1); g.closePath();
        g.fillStyle = col; g.globalAlpha = on ? 0.55 : 0.32; g.fill(); g.globalAlpha = 1;
        if (x.vib || x.bend) { g.strokeStyle = '#fff'; g.lineWidth = 1; g.beginPath(); for (let zz = z0; zz < z1; zz += 0.01) { const yy = yOf(zz) - lift(q.st) * scl(zz); g.lineTo(xAt(xc, zz) + Math.sin(zz * 120) * 3 * scl(zz), yy); } g.stroke(); }
      }
      if (q.s < t - 0.02) continue; // голова уже прошла
      const z = z0, s = scl(z), y = yOf(z) - lift(q.st) * s;
      // тень на дороге
      g.fillStyle = 'rgba(0,0,0,.35)'; g.fillRect(xAt(xc - laneW * 0.35, z), yOf(z) - 1, laneW * 0.7 * s, 2);
      if (lift(q.st) * s > 3) { g.strokeStyle = shade(col, -0.4); g.lineWidth = 1; g.beginPath(); g.moveTo(xAt(xc, z), yOf(z)); g.lineTo(xAt(xc, z), y); g.stroke(); }
      const gh = Math.max(5, strGap * 0.82 * s), gw = open ? (nearR - nearL) * 0.9 * s : Math.min(laneW * 0.78 * s, Math.max(gh * 2.4, 34 * s));
      const gx = xAt(xc, z) - gw / 2;
      rr(g, gx, y - gh / 2, gw, gh, Math.min(8, gh / 2.2));
      g.fillStyle = on ? shade(col, 0.5) : col; g.fill();
      g.strokeStyle = 'rgba(255,255,255,.55)'; g.lineWidth = 1; g.stroke();
      if (x.pm) { g.save(); g.clip(); g.strokeStyle = 'rgba(0,0,0,.45)'; g.lineWidth = 2; for (let xx = gx - gh; xx < gx + gw; xx += 6) { g.beginPath(); g.moveTo(xx, y + gh / 2); g.lineTo(xx + gh, y - gh / 2); g.stroke(); } g.restore(); }
      if (x.dead) { g.strokeStyle = '#000'; g.lineWidth = 2; g.beginPath(); g.moveTo(xAt(xc, z) - gh * 0.3, y - gh * 0.3); g.lineTo(xAt(xc, z) + gh * 0.3, y + gh * 0.3); g.moveTo(xAt(xc, z) + gh * 0.3, y - gh * 0.3); g.lineTo(xAt(xc, z) - gh * 0.3, y + gh * 0.3); g.stroke(); }
      if (q.res) { g.strokeStyle = q.res === 'hit' ? '#3ccf8e' : '#ff5c5c'; g.lineWidth = 3; rr(g, gx - 2, y - gh / 2 - 2, gw + 4, gh + 4, 8); g.stroke(); }
      if (gh > 11 && !open) { g.fillStyle = '#000'; g.font = `700 ${Math.round(Math.min(14, gh * 0.75))}px system-ui`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(x.dead ? '' : q.f, xAt(xc, z), y + 0.5); }
      // обозначения техник
      const lab = x.hp ? x.hp : x.sl ? (x.slTo != null && x.slTo > q.f ? '↗' : '↘') : x.bend ? '↑' + (x.bend.max >= 2 ? '1' : '½') : x.harm ? '◇' : x.tap ? 'T' : '';
      if (lab && s > 0.45) { g.fillStyle = '#ffd9bd'; g.font = `700 ${Math.round(11 * s + 3)}px system-ui`; g.textAlign = 'left'; g.textBaseline = 'middle'; g.fillText(lab, gx + gw + 3, y); }
      if (x.sl && x.slTo != null && !open) { const x2 = xAt(xFret(x.slTo), z1); g.strokeStyle = '#4dd0e1'; g.lineWidth = 2; g.beginPath(); g.moveTo(xAt(xc, z), y); g.lineTo(x2, yOf(z1) - lift(q.st) * scl(z1)); g.stroke(); }
    }
    // рамки аккордов
    for (const grp of groups.values()) {
      if (grp.length < 2 || grp[0].s < t - 0.02) continue;
      const z = Math.max(0, (grp[0].s - t) / win), s = scl(z);
      const fr = grp.filter(q => q.f > 0).map(q => q.f); if (!fr.length) continue;
      const x0 = xAt(xFret(Math.min(...fr)) - laneW * 0.5, z), x1 = xAt(xFret(Math.max(...fr)) + laneW * 0.5, z);
      const ys = grp.map(q => yOf(z) - lift(q.st) * s);
      g.strokeStyle = 'rgba(255,255,255,.7)'; g.lineWidth = 1.5;
      rr(g, x0 - 2, Math.min(...ys) - strGap * 0.6 * s, x1 - x0 + 4, Math.max(...ys) - Math.min(...ys) + strGap * 1.2 * s, 6); g.stroke();
      const chn = ctx.chordFor ? ctx.chordFor(grp[0].s) : null;
      if (chn && s > 0.4) { g.fillStyle = '#ffd23f'; g.font = `700 ${Math.round(12 * s + 3)}px system-ui`; g.textAlign = 'center'; g.textBaseline = 'bottom'; g.fillText(chn, (x0 + x1) / 2, Math.min(...ys) - strGap * 0.6 * s - 2); }
    }
    // ближний край: гриф
    g.fillStyle = '#1a140f'; g.fillRect(0, nearY, W, H - nearY);
    for (let f = fFrom; f <= fTo; f++) {
      const xl = xFret(f - 0.5); if (xl < nearL - 1 || xl > nearR + 1) continue;
      g.fillStyle = '#8f949c'; g.fillRect(xl - 1, nearY + 2, 2, (n - 1) * strGap + 12);
    }
    g.font = '11px system-ui'; g.textAlign = 'center'; g.textBaseline = 'top';
    for (let f = Math.max(1, fFrom); f <= fTo; f++) { const xc = xFret(f); if (xc < nearL || xc > nearR) continue; g.fillStyle = [3, 5, 7, 9, 12, 15, 17, 19, 21, 24].includes(f) ? '#e9ecf2' : '#6b7280'; g.fillText(f, xc, nearY + (n - 1) * strGap + 12); }
    for (let s = 0; s < n; s++) {
      const y = strY(s), col = STRING_COLORS[s % STRING_COLORS.length];
      g.fillStyle = col; g.globalAlpha = 0.85; g.fillRect(nearL - 4, y - 0.75 - s * 0.15, W - nearL, 1.5 + s * 0.3); g.globalAlpha = 1;
      g.fillStyle = col; g.font = '600 12px system-ui'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(this.names ? this.names[s] : s + 1, 14, y);
    }
    // линия удара
    g.fillStyle = 'rgba(255,255,255,.75)'; g.fillRect(nearL, nearY - 1, nearR - nearL, 2);
    // что играть сейчас: точки на грифе + вспышка
    for (const q of active) {
      const col = STRING_COLORS[q.st % STRING_COLORS.length];
      if (q.f === 0) { g.fillStyle = col; g.globalAlpha = 0.5; g.fillRect(nearL, strY(q.st) - 4, nearR - nearL, 8); g.globalAlpha = 1; continue; }
      const x = xFret(q.f), y = strY(q.st);
      g.fillStyle = col; g.beginPath(); g.arc(x, y, Math.min(12, strGap * 0.55 + 3), 0, 7); g.fill();
      g.fillStyle = '#000'; g.font = '700 11px system-ui'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(q.f, x, y + 0.5);
      const age = t - q.s; if (age < 0.18) { g.strokeStyle = col; g.globalAlpha = 1 - age / 0.18; g.lineWidth = 3; g.beginPath(); g.arc(x, nearY, 10 + age * 120, Math.PI, 0); g.stroke(); g.globalAlpha = 1; }
    }
    g.textAlign = 'left';
  }
}
