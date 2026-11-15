// Отрисовка: клавиатура с падающими нотами и гриф с табулатурой
export const SHORT = ['до', 'до♯', 'ре', 'ми♭', 'ми', 'фа', 'фа♯', 'сол', 'ля♭', 'ля', 'си♭', 'си'];
export const isBlack = m => [1, 3, 6, 8, 10].includes(((m % 12) + 12) % 12);
export const HAND = { R: ['#4c9aff', '#2f6fcc', '#a9cdff'], L: ['#ff8a3d', '#c85e1c', '#ffc59c'] };
export const TRACK_COLORS = ['#4c9aff', '#ff8a3d', '#3ccf8e', '#c77dff', '#ffd23f', '#ff5c8a', '#4dd0e1', '#a3e635'];
export const STRING_COLORS = ['#ff5c5c', '#ffd23f', '#4c9aff', '#ff8a3d', '#3ccf8e', '#c77dff', '#4dd0e1', '#f472b6'];
const shade = (hex, k) => { const n = parseInt(hex.slice(1), 16); let r = n >> 16, g = (n >> 8) & 255, b = n & 255; const f = v => Math.max(0, Math.min(255, Math.round(k > 0 ? v + (255 - v) * k : v * (1 + k)))); return `rgb(${f(r)},${f(g)},${f(b)})`; };

function rr(g, x, y, w, h, r) { r = Math.max(0, Math.min(r, w / 2, h / 2)); g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); }
const countWhite = (a, b) => { let c = 0; for (let m = a; m <= b; m++) if (!isBlack(m)) c++; return c; };

// Общая часть: тактовые линии на «дороге»
function measureLines(g, ctx, x0, x1, yOf, top, bottom) {
  const { mStarts, measures } = ctx;
  g.font = '11px system-ui'; g.textBaseline = 'bottom'; g.textAlign = 'left';
  const t = ctx.t;
  for (let i = Math.max(0, ctx.measureIdx - 1); i < mStarts.length; i++) {
    const y = yOf(mStarts[i]); if (y < top - 2) break; if (y > bottom) continue;
    g.fillStyle = '#262b35'; g.fillRect(x0, y, x1 - x0, 1);
    g.fillStyle = '#5b6372'; g.fillText(measures[i].n, x0 + 4, y - 2);
  }
  if (ctx.loop) {
    const ya = yOf(ctx.loop.a), yb = yOf(ctx.loop.b);
    const a = Math.max(top, yb), b = Math.min(bottom, ya);
    if (b > a) { g.fillStyle = 'rgba(60,207,142,.07)'; g.fillRect(x0, a, x1 - x0, b - a); }
  }
}

// ---------- Фортепиано ----------
export class PianoView {
  constructor() { this.keys = new Map(); this.lo = 48; this.hi = 84; this.KB = 120; }
  setRange(notes, full) {
    let lo = 200, hi = 0; for (const n of notes) { if (n.m < lo) lo = n.m; if (n.m > hi) hi = n.m; }
    if (!notes.length) { lo = 48; hi = 84; }
    if (full) { lo = 21; hi = 108; } else {
      lo = Math.max(21, lo - 1); while (lo % 12 !== 0 && lo % 12 !== 5) lo--;
      hi = Math.min(108, hi + 1); while (hi % 12 !== 11 && hi % 12 !== 4) hi++;
      while (countWhite(lo, hi) < (this.minWhite || 15)) { if (lo > 21) lo--; if (hi < 108) hi++; if (lo <= 21 && hi >= 108) break; }
    }
    this.lo = lo; this.hi = hi; this.W = 0;
  }
  // Пропорции как у настоящего пианино: чёрные клавиши делят группы до–ми на 5 частей и фа–си на 7,
  // ширина чёрной ≈ 0,58 белой, длина ≈ 0,63 белой
  layout(W, H, land) {
    if (this.W === W && this.H === H && this.land === land) return; this.W = W; this.H = H; this.land = land;
    this.keys = new Map();
    const nw = countWhite(this.lo, this.hi), ww = W / nw;
    this.KB = land ? Math.max(60, Math.min(ww * 6.3, H * 0.36)) : Math.min(Math.max(90, H * 0.24), 170, ww * 7);
    this.blackH = this.KB * 0.63;
    let i = 0;
    for (let m = this.lo; m <= this.hi; m++) if (!isBlack(m)) { this.keys.set(m, { x: i * ww, w: ww, black: false }); i++; }
    const OFF = { 1: [0, 0.6], 3: [0, 1.8], 6: [5, 0.571], 8: [5, 1.714], 10: [5, 2.857] };
    for (let m = this.lo; m <= this.hi; m++) if (isBlack(m)) {
      const pc = m % 12, [basePc, off] = OFF[pc];
      const base = this.keys.get(m - pc + basePc);
      let x;
      if (base) x = base.x + off * ww;
      else { const L = this.keys.get(m - 1); if (!L) continue; x = L.x + ww * 0.68; }
      this.keys.set(m, { x, w: ww * 0.58, black: true });
    }
  }
  hit(x, y) {
    if (y < this.H - this.KB) return null;
    for (const [m, k] of this.keys) if (k.black && x >= k.x && x < k.x + k.w && y < this.H - this.KB + 3 + this.blackH) return m;
    for (const [m, k] of this.keys) if (!k.black && x >= k.x && x < k.x + k.w) return m;
    return null;
  }
  draw(g, W, H, ctx) {
    this.layout(W, H, !!ctx.land);
    const { t, notes, speed, names } = ctx;
    const pressed = ctx.pressed || new Set();
    g.fillStyle = '#0f1115'; g.fillRect(0, 0, W, H);
    const fallH = H - this.KB;
    const win = Math.max(1.2, Math.min(4, 3 * speed));
    const pps = fallH / win;
    const yOf = s => fallH - (s - t) * pps;
    g.fillStyle = '#13161c';
    for (const [m, k] of this.keys) if (k.black) g.fillRect(k.x, 0, k.w, fallH);
    g.fillStyle = '#1b1f27';
    for (const [m, k] of this.keys) if (!k.black && (m % 12 === 0 || m % 12 === 5)) g.fillRect(k.x, 0, 1, fallH);
    measureLines(g, ctx, 0, W, yOf, 0, fallH);
    const active = new Map();
    const t1 = t + win;
    let i = ctx.firstIdx(notes, t - 30);
    for (; i < notes.length; i++) {
      const n = notes[i];
      if (n.s > t1) break; if (n.e < t - 0.02) continue;
      const k = this.keys.get(n.m); if (!k) continue;
      const c = n.col;
      const on = n.s <= t && n.e > t;
      if (on) active.set(n.m, c);
      const y1 = yOf(n.s), y0 = yOf(n.e);
      const top = Math.max(-4, y0), bot = Math.min(fallH, y1);
      if (bot <= top) continue;
      const pad = k.black ? 1 : 2;
      rr(g, k.x + pad, top, k.w - pad * 2, Math.max(4, bot - top), 5);
      g.fillStyle = on ? c[2] : (k.black ? c[1] : c[0]); g.fill();
      if (names && k.w > 15 && bot - top > 16 && y1 < fallH + 1) {
        g.fillStyle = 'rgba(0,0,0,.65)'; g.font = `600 ${Math.min(12, k.w * 0.45)}px system-ui`; g.textAlign = 'center'; g.textBaseline = 'bottom';
        g.fillText(SHORT[n.m % 12], k.x + k.w / 2, bot - 3); g.textAlign = 'left';
      }
    }
    const ky = fallH, KB = this.KB;
    g.fillStyle = '#000'; g.fillRect(0, ky, W, KB);
    g.fillStyle = '#3a3f4a'; g.fillRect(0, ky, W, 3);
    for (const m of pressed) if (!active.has(m)) active.set(m, ['#9cc5ff', '#6fa6e8', '#cfe3ff']);
    for (const [m, k] of this.keys) if (!k.black) {
      const c = active.get(m);
      rr(g, k.x + 1, ky + 3, k.w - 2, KB - 5, 4);
      g.fillStyle = c ? c[0] : '#f2f2f0'; g.fill();
      if (names && k.w > 14) {
        g.fillStyle = c ? '#fff' : (m % 12 === 0 ? '#222' : '#9a9a96');
        g.font = `${m % 12 === 0 ? 600 : 400} ${Math.min(11, k.w * 0.42)}px system-ui`; g.textAlign = 'center'; g.textBaseline = 'bottom';
        g.fillText(SHORT[m % 12], k.x + k.w / 2, ky + KB - 6);
        if (m % 12 === 0) { g.font = `${Math.min(10, k.w * 0.38)}px system-ui`; g.fillText(Math.floor(m / 12) - 1 + '', k.x + k.w / 2, ky + KB - 20); }
        g.textAlign = 'left';
      }
    }
    for (const [m, k] of this.keys) if (k.black) {
      const c = active.get(m);
      rr(g, k.x, ky + 3, k.w, this.blackH, 3);
      g.fillStyle = c ? c[1] : '#1c1d21'; g.fill();
    }
  }
}

// ---------- Гриф + табулатура ----------
export class GuitarView {
  setTrack(track, notes) {
    this.track = track; this.nStr = track.tuning.length;
    let lo = 99, hi = 0;
    for (const n of notes) if (n.f != null) { if (n.f > 0) lo = Math.min(lo, n.f); hi = Math.max(hi, n.f); }
    if (lo === 99) lo = 1;
    lo = Math.max(1, lo - 1); hi = Math.max(hi + 1, lo + 6);
    this.f0 = lo; this.f1 = Math.min(36, hi);
  }
  draw(g, W, H, ctx) {
    const { t, notes, speed, tuningNames } = ctx;
    const n = this.nStr;
    g.fillStyle = '#0f1115'; g.fillRect(0, 0, W, H);
    // Зоны: табулатура сверху, «дорога», гриф снизу
    const strGap = Math.max(11, Math.min(18, H * 0.028));
    const tabH = strGap * (n - 1) + 34;
    const fbH = strGap * 1.25 * (n - 1) + 36;
    const roadTop = tabH + 6, roadBot = H - fbH;
    // --- лента табулатуры ---
    const tabTop = 18, playX = Math.round(W * 0.22);
    const pxs = Math.max(90, Math.min(220, W / 3.2)) / Math.max(0.4, speed);
    g.fillStyle = '#141820'; g.fillRect(0, 0, W, tabH);
    g.strokeStyle = '#3a404c'; g.lineWidth = 1;
    for (let s = 0; s < n; s++) { const y = tabTop + s * strGap + .5; g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke(); }
    g.fillStyle = '#8b93a3'; g.font = '11px system-ui'; g.textBaseline = 'middle'; g.textAlign = 'left';
    if (tuningNames) for (let s = 0; s < n; s++) g.fillText(tuningNames[s] || '', 3, tabTop + s * strGap);
    const xOfT = s => playX + (s - t) * pxs;
    // такты
    for (let i = Math.max(0, ctx.measureIdx - 2); i < ctx.mStarts.length; i++) {
      const x = xOfT(ctx.mStarts[i]); if (x > W) break; if (x < 0) continue;
      g.fillStyle = '#4a5160'; g.fillRect(x, tabTop, 1, strGap * (n - 1));
      g.fillStyle = '#5b6372'; g.textBaseline = 'bottom'; g.fillText(ctx.measures[i].n, x + 2, tabTop - 3);
    }
    const tA = t - playX / pxs, tB = t + (W - playX) / pxs;
    g.textAlign = 'center'; g.textBaseline = 'middle'; g.font = `600 ${Math.round(strGap * 0.82)}px system-ui`;
    let i = ctx.firstIdx(notes, tA - 10);
    for (let j = i; j < notes.length; j++) {
      const q = notes[j]; if (q.s > tB) break; if (q.e < tA || q.f == null) continue;
      const x = xOfT(q.s), y = tabTop + q.st * strGap;
      const on = q.s <= t && q.e > t;
      const len = Math.max(0, (Math.min(q.e, tB) - q.s) * pxs);
      g.fillStyle = on ? 'rgba(76,154,255,.35)' : 'rgba(255,255,255,.07)';
      g.fillRect(x, y - 2, len, 4);
      const txt = String(q.f); const tw = g.measureText(txt).width + 6;
      g.fillStyle = '#141820'; g.fillRect(x - tw / 2, y - strGap / 2 + 1, tw, strGap - 2);
      g.fillStyle = on ? '#9cc5ff' : '#e9ecf2'; g.fillText(txt, x, y + 1);
    }
    g.fillStyle = 'rgba(76,154,255,.8)'; g.fillRect(playX, 4, 2, tabH - 8);
    // --- гриф: геометрия ---
    const nutX = 46, fbX1 = W - 6;
    const nf = this.f1 - this.f0 + 1;
    const fw = (fbX1 - nutX) / nf;
    const fretX = f => f === 0 ? 31 : nutX + (f - this.f0 + 0.5) * fw;
    const fbTop = roadBot + 14, sg = strGap * 1.25;
    const laneW = fw / Math.max(1, n);
    // --- падающие ноты ---
    const roadH = roadBot - roadTop;
    const win = Math.max(1.2, Math.min(4, 3 * speed));
    const pps = roadH / win;
    const yOf = s => roadBot - (s - t) * pps;
    g.fillStyle = '#12151b'; g.fillRect(0, roadTop, W, roadH);
    for (let f = this.f0; f <= this.f1 + 1; f++) { const x = nutX + (f - this.f0) * fw; g.fillStyle = '#1d222b'; g.fillRect(x, roadTop, 1, roadH); }
    g.fillStyle = '#1d222b'; g.fillRect(nutX - 1, roadTop, 2, roadH);
    measureLines(g, ctx, 0, W, yOf, roadTop, roadBot);
    const active = [];
    const t1 = t + win;
    for (let j = i; j < notes.length; j++) {
      const q = notes[j]; if (q.s > t1) break; if (q.e < t - 0.02 || q.f == null) continue;
      if (q.f > 0 && (q.f < this.f0 || q.f > this.f1)) continue;
      const on = q.s <= t && q.e > t; if (on) active.push(q);
      const col = STRING_COLORS[q.st % STRING_COLORS.length];
      const cx = q.f === 0 ? 31 : nutX + (q.f - this.f0) * fw + (q.st + 0.5) * laneW;
      const w = q.f === 0 ? 22 : Math.max(8, laneW - 2);
      const y1 = Math.min(roadBot, yOf(q.s)), y0 = Math.max(roadTop, yOf(q.e));
      if (y1 <= y0) continue;
      g.globalAlpha = on ? 1 : 0.85;
      rr(g, cx - w / 2, y0, w, Math.max(6, y1 - y0), 4); g.fillStyle = on ? shade(col, 0.45) : col; g.fill();
      g.globalAlpha = 1;
      if (y1 - y0 > 14 && w >= 12) { g.fillStyle = 'rgba(0,0,0,.7)'; g.font = `700 ${Math.min(12, w * 0.8)}px system-ui`; g.textAlign = 'center'; g.textBaseline = 'bottom'; g.fillText(q.f, cx, y1 - 2); }
    }
    // --- гриф ---
    g.fillStyle = '#2a1f17'; g.fillRect(nutX, fbTop - 8, fbX1 - nutX, sg * (n - 1) + 16);
    g.fillStyle = '#d9d4c7'; g.fillRect(nutX - 3, fbTop - 8, 3, sg * (n - 1) + 16);
    g.font = '10px system-ui'; g.textAlign = 'center'; g.textBaseline = 'top';
    for (let f = this.f0; f <= this.f1; f++) {
      const x = nutX + (f - this.f0 + 1) * fw;
      g.fillStyle = '#9aa0aa'; g.fillRect(x - 1, fbTop - 8, 2, sg * (n - 1) + 16);
      const cx = nutX + (f - this.f0 + 0.5) * fw;
      if ([3, 5, 7, 9, 15, 17, 19, 21].includes(f)) { g.fillStyle = '#5a4a3a'; g.beginPath(); g.arc(cx, fbTop + sg * (n - 1) / 2, 4, 0, 7); g.fill(); }
      if (f === 12 || f === 24) { g.fillStyle = '#5a4a3a'; for (const d of [-1, 1]) { g.beginPath(); g.arc(cx, fbTop + sg * (n - 1) / 2 + d * sg, 4, 0, 7); g.fill(); } }
      g.fillStyle = '#8b93a3'; g.fillText(f, cx, fbTop + sg * (n - 1) + 10);
    }
    for (let s = 0; s < n; s++) {
      const y = fbTop + s * sg;
      g.fillStyle = '#c9c4b8'; g.fillRect(nutX - 3, y - 0.5 - s * 0.15, fbX1 - nutX + 3, 1 + s * 0.3);
      g.fillStyle = '#8b93a3'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.font = '11px system-ui';
      g.fillText(tuningNames && tuningNames[s] ? tuningNames[s] : (s + 1), 10, y);
    }
    for (const q of active) {
      const x = fretX(q.f), y = fbTop + q.st * sg;
      const col = STRING_COLORS[q.st % STRING_COLORS.length];
      g.fillStyle = col; g.beginPath(); g.arc(x, y, Math.min(11, sg * 0.55 + 2), 0, 7); g.fill();
      g.fillStyle = '#000'; g.font = '700 11px system-ui'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(q.f, x, y + 0.5);
    }
    g.textAlign = 'left';
  }
}

// ---------- Ударные: дорожки по инструментам установки ----------
export const DRUM_GROUPS = [
  { id: 'crash', name: 'Крэш', col: '#ff8a3d', notes: [49, 57, 55, 52] },
  { id: 'hh', name: 'Хай-хэт', col: '#ffd23f', notes: [42, 44, 46, 26] },
  { id: 'snare', name: 'Малый', col: '#ff5c5c', notes: [37, 38, 39, 40] },
  { id: 'kick', name: 'Бочка', col: '#e9ecf2', notes: [35, 36], foot: true },
  { id: 'tom1', name: 'Том 1', col: '#4c9aff', notes: [48, 50] },
  { id: 'tom2', name: 'Том 2', col: '#3ccf8e', notes: [45, 47] },
  { id: 'floor', name: 'Напольный', col: '#c77dff', notes: [41, 43] },
  { id: 'ride', name: 'Райд', col: '#4dd0e1', notes: [51, 53, 59] },
  { id: 'perc', name: 'Перкуссия', col: '#a3a19a', notes: [] }
];
export const drumGroup = m => DRUM_GROUPS.find(g => g.notes.includes(m)) || DRUM_GROUPS[DRUM_GROUPS.length - 1];
export const DRUM_NAMES = {
  35: 'Бочка 2', 36: 'Бочка', 37: 'Римшот (боковой)', 38: 'Малый', 39: 'Хлопок', 40: 'Малый (электро)', 41: 'Напольный низкий', 42: 'Хай-хэт закрытый',
  43: 'Напольный высокий', 44: 'Хай-хэт педалью', 45: 'Том низкий', 46: 'Хай-хэт открытый', 47: 'Том средний', 48: 'Том высокий', 49: 'Крэш',
  50: 'Том очень высокий', 51: 'Райд', 52: 'Чайна', 53: 'Купол райда', 55: 'Сплэш', 57: 'Крэш 2', 59: 'Райд 2'
};

export class DrumView {
  setNotes(notes) {
    const used = new Set(notes.map(n => drumGroup(n.m).id));
    this.lanes = DRUM_GROUPS.filter(g => used.has(g.id));
    if (!this.lanes.length) this.lanes = DRUM_GROUPS.slice(0, 4);
    this.laneIdx = new Map(this.lanes.map((g, i) => [g.id, i]));
  }
  hit(x, y) {
    if (!this.lanes || y < this.padTop) return null;
    const i = Math.floor(x / (this.W / this.lanes.length));
    const g = this.lanes[i]; if (!g) return null;
    return g.notes[0] || 39;
  }
  draw(g, W, H, ctx) {
    this.W = W;
    const { t, notes, speed } = ctx;
    const n = this.lanes.length, lw = W / n;
    const padH = Math.max(64, Math.min(120, H * 0.18));
    const padTop = H - padH; this.padTop = padTop;
    g.fillStyle = '#0f1115'; g.fillRect(0, 0, W, H);
    for (let i = 0; i < n; i++) { g.fillStyle = i % 2 ? '#12151b' : '#14181f'; g.fillRect(i * lw, 0, lw, padTop); }
    const win = Math.max(1.2, Math.min(4, 3 * speed));
    const pps = padTop / win;
    const yOf = s => padTop - (s - t) * pps;
    measureLines(g, ctx, 0, W, yOf, 0, padTop);
    // доли такта тонкими линиями
    const active = new Map();
    let i = ctx.firstIdx(notes, t - 1);
    const gemH = Math.max(8, Math.min(16, lw * 0.18));
    for (; i < notes.length; i++) {
      const q = notes[i]; if (q.s > t + win) break;
      const grp = drumGroup(q.m), li = this.laneIdx.get(grp.id); if (li == null) continue;
      const y = yOf(q.s);
      const hitNow = q.s <= t && t - q.s < 0.12;
      if (hitNow) active.set(grp.id, q.m);
      if (q.s < t - 0.05) continue;
      const x = li * lw;
      g.globalAlpha = 1;
      rr(g, x + lw * 0.12, y - gemH / 2, lw * 0.76, gemH, gemH / 2);
      g.fillStyle = grp.col; g.fill();
      if (q.m === 46) { g.strokeStyle = '#000'; g.lineWidth = 2; g.beginPath(); g.arc(x + lw / 2, y, gemH * 0.28, 0, 7); g.stroke(); }
      if (q.m === 44) { g.fillStyle = '#000'; g.fillRect(x + lw * 0.3, y - 1, lw * 0.4, 2); }
    }
    // площадки
    for (let k = 0; k < n; k++) {
      const grp = this.lanes[k], x = k * lw, on = active.has(grp.id) || (ctx.pressed && ctx.pressed.has(grp.id));
      rr(g, x + 4, padTop + 6, lw - 8, padH - 12, 12);
      g.fillStyle = on ? grp.col : '#1b1f27'; g.fill();
      g.strokeStyle = grp.col; g.lineWidth = 2; g.stroke();
      g.fillStyle = on ? '#000' : '#e9ecf2'; g.font = `600 ${Math.max(11, Math.min(15, lw * 0.16))}px system-ui`; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(grp.name, x + lw / 2, padTop + padH / 2 - (grp.foot ? 7 : 0));
      if (grp.foot) { g.font = '11px system-ui'; g.fillStyle = on ? '#000' : '#8b93a3'; g.fillText('нога', x + lw / 2, padTop + padH / 2 + 10); }
    }
    g.fillStyle = 'rgba(255,255,255,.25)'; g.fillRect(0, padTop - 1, W, 2);
    g.textAlign = 'left';
  }
}
