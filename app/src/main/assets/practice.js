// Разучивание: аппликатура для фортепиано, ноты с микрофона, проверка игры.
import { detectPitch, freqToMidi } from './pitch.js';

const isBlack = m => [1, 3, 6, 8, 10].includes(((m % 12) + 12) % 12);

// ---------- Аппликатура ----------
// notes: [{ s, m, h ('L'|'R'), first }] (по времени). Ставит n.fing = 1…5.
// Аккорды — по порядку высот (правая: снизу 1→5, левая: снизу 5→1),
// мелодия — динамическим программированием по удобству переходов между пальцами.
export function assignFingering(notes) {
  for (const hand of ['R', 'L']) {
    const ns = notes.filter(n => n.h === hand && n.first);
    // группы одновременных нот
    const groups = [];
    for (const n of ns) { const g = groups[groups.length - 1]; if (g && Math.abs(g.s - n.s) < 0.03) g.ns.push(n); else groups.push({ s: n.s, ns: [n] }); }
    for (const g of groups) g.ns.sort((a, b) => a.m - b.m);
    // состояния: для одиночной ноты — палец 1…5; для аккорда — фиксированная раскладка
    const chordFingers = g => {
      const k = g.ns.length, span = g.ns[k - 1].m - g.ns[0].m;
      let f;
      if (k >= 5) f = [1, 2, 3, 4, 5];
      else if (k === 4) f = span > 9 ? [1, 2, 3, 5] : [1, 2, 3, 4];
      else if (k === 3) f = span >= 7 ? [1, 3, 5] : span >= 5 ? [1, 2, 4] : [1, 2, 3];
      else if (k === 2) { const d = span; f = d >= 10 ? [1, 5] : d >= 7 ? [1, 5] : d >= 5 ? [1, 4] : d >= 3 ? [1, 3] : [1, 2]; }
      else f = [null];
      f = f.slice(0, k); while (f.length < k) f.push(5);
      return hand === 'R' ? f : f.slice().reverse();
    };
    // стоимость перехода (правая рука; для левой зеркалим интервал)
    const cost = (f1, m1, f2, m2) => {
      let d = m2 - m1; if (hand === 'L') d = -d;
      if (f1 === f2) return d === 0 ? 0 : 6 + Math.abs(d) * 0.5;
      const df = f2 - f1;
      let c = 0;
      if (df > 0) { // вверх по пальцам
        const lo = df, hi = df * 2 + (f1 === 1 ? 3 : 1);
        if (d < 0) c += f1 === 1 && f2 <= 4 && d >= -4 ? 2.5 + Math.abs(d) * 0.8 : 10 + Math.abs(d); // перекладывание пальца через большой — только 2–4 и близко
        else if (d < lo) c += (lo - d) * 1.2; else if (d > hi) c += (d - hi) * 1.5;
      } else { // вниз по пальцам
        const ad = -df, lo = ad, hi = ad * 2 + (f2 === 1 ? 3 : 1);
        if (d > 0) c += f2 === 1 && f1 <= 4 && d <= 4 ? 2.5 + d * 0.8 : 10 + d; // подкладывание большого пальца — от 2–4 и близко
        else { const a = -d; if (a < lo) c += (lo - a) * 1.2; else if (a > hi) c += (a - hi) * 1.5; }
      }
      if (f2 === 1 && isBlack(m2)) c += 2;
      if (f2 === 5 && isBlack(m2)) c += 0.8;
      if ((f1 === 3 && f2 === 4) || (f1 === 4 && f2 === 3)) c += 0.6;
      return c;
    };
    // DP по группам: состояние = палец крайней ноты, от которой считаем переход
    // (для аккорда — палец верхней ноты для правой руки и нижней для левой)
    let prev = null; // массив [cost, back] для 5 пальцев
    const back = [];
    groups.forEach((g, gi) => {
      const cur = [];
      if (g.ns.length > 1) {
        const fs = chordFingers(g); g.fixed = fs;
        const edge = hand === 'R' ? fs[0] : fs[fs.length - 1]; // нота, к которой «приходим»
        const edgeM = hand === 'R' ? g.ns[0].m : g.ns[g.ns.length - 1].m;
        let best = 0, bi = 0;
        if (prev) { best = 1e9; for (let f = 1; f <= 5; f++) { if (prev[f] == null) continue; const pm = groups[gi - 1].lastM[f]; const c = prev[f] + cost(f, pm, edge, edgeM) * (g.s - groups[gi - 1].s > 1.2 ? 0.2 : 1); if (c < best) { best = c; bi = f; } } }
        const out = hand === 'R' ? fs[fs.length - 1] : fs[0], outM = hand === 'R' ? g.ns[g.ns.length - 1].m : g.ns[0].m;
        for (let f = 1; f <= 5; f++) cur[f] = f === out ? best : null;
        g.lastM = []; g.lastM[out] = outM; back.push({ pick: () => bi, chord: true });
      } else {
        const m = g.ns[0].m; g.lastM = [];
        const bk = [];
        for (let f = 1; f <= 5; f++) {
          g.lastM[f] = m;
          if (!prev) { cur[f] = (f === 1 && isBlack(m) ? 2 : 0) + (f === 3 ? -0.1 : 0); bk[f] = 0; continue; }
          let best = 1e9, bi = 0;
          const gap = g.s - groups[gi - 1].s > 1.2 ? 0.2 : 1; // после паузы руку можно переставить
          for (let p = 1; p <= 5; p++) { if (prev[p] == null) continue; const c = prev[p] + cost(p, groups[gi - 1].lastM[p], f, m) * gap; if (c < best) { best = c; bi = p; } }
          cur[f] = best; bk[f] = bi;
        }
        back.push({ bk });
      }
      prev = cur;
    });
    // обратный проход
    if (!groups.length) continue;
    let f = 1, bc = 1e9; for (let k = 1; k <= 5; k++) if (prev[k] != null && prev[k] < bc) { bc = prev[k]; f = k; }
    for (let gi = groups.length - 1; gi >= 0; gi--) {
      const g = groups[gi], b = back[gi];
      if (g.fixed) { g.ns.forEach((n, i) => n.fing = g.fixed[i]); f = b.pick(); }
      else { g.ns[0].fing = f; f = b.bk[f]; }
    }
  }
}

// ---------- Ноты с микрофона ----------
// Слушает микрофон и сообщает о взятых нотах: onNote(midi, ctxTime). Одноголосно (самая явная нота).
export class MicNotes {
  constructor(onNote) { this.onNote = onNote; this.on = false; }
  async start(opt = {}) {
    if (this.on) return true;
    try { this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } }); }
    catch (e) { this.error = e; return false; }
    const AC = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AC(); const src = this.ctx.createMediaStreamSource(this.stream);
    this.an = this.ctx.createAnalyser(); this.an.fftSize = 4096; this.an.smoothingTimeConstant = 0; src.connect(this.an);
    this.buf = new Float32Array(4096); this.on = true; this.last = null; this.lastRms = 0; this.cand = null;
    if (opt.record && window.MediaRecorder) {
      this.chunks = []; this.rec = new MediaRecorder(this.stream);
      this.rec.ondataavailable = e => { if (e.data && e.data.size) this.chunks.push(e.data); };
      this.rec.start(); this.recStart = performance.now();
    }
    this.timer = setInterval(() => this.tick(), 30);
    return true;
  }
  tick() {
    if (!this.on) return;
    this.an.getFloatTimeDomainData(this.buf);
    const r = detectPitch(this.buf, this.ctx.sampleRate, { fMin: 40, fMax: 1600, gate: 0.006 });
    const now = performance.now();
    if (!r || r.clarity < 0.82) { this.cand = null; if (!r || r.rms < this.lastRms * 0.3) this.last = null; this.lastRms = r ? r.rms : 0; return; }
    const m = Math.round(freqToMidi(r.freq));
    const attack = r.rms > this.lastRms * 1.6 && r.rms > 0.01;
    this.lastRms = r.rms;
    // нота засчитывается, когда держится 2 замера; повтор той же ноты — только с новой атакой
    if (this.cand && this.cand.m === m) {
      if (!this.cand.sent && (this.last !== m || this.cand.attack)) { this.cand.sent = true; this.last = m; this.onNote(m, this.cand.t); }
    } else this.cand = { m, t: now - 60, attack, sent: false };
    if (attack && this.cand) this.cand.attack = true;
  }
  async stop() {
    clearInterval(this.timer); this.on = false;
    let blob = null;
    if (this.rec && this.rec.state !== 'inactive') {
      blob = await new Promise(res => { this.rec.onstop = () => res(new Blob(this.chunks, { type: this.rec.mimeType || 'audio/webm' })); this.rec.stop(); });
    }
    this.rec = null;
    if (this.stream) this.stream.getTracks().forEach(t => t.stop()); this.stream = null;
    if (this.ctx) try { await this.ctx.close(); } catch (e) { } this.ctx = null;
    return blob;
  }
}

// ---------- Проверка игры ----------
// targets: [{ s, m }] — ноты, которые играет ученик; inputs: [{ t, m, src }] — что он сыграл (время песни).
// Нота засчитана, если в окне [s − 0,2; s + 0,3] с нужной высотой (с микрофона — допускается октава).
export function scoreNotes(targets, inputs, upTo) {
  let hit = 0, total = 0;
  const used = new Set();
  for (const q of targets) {
    if (q.s > upTo - 0.3) break;
    total++;
    let ok = false;
    for (let k = 0; k < inputs.length; k++) {
      const p = inputs[k]; if (used.has(k)) continue;
      if (p.t < q.s - 0.2 || p.t > q.s + 0.3) continue;
      const d = p.m - q.m;
      if (d === 0 || (p.src === 'mic' && d % 12 === 0)) { ok = true; used.add(k); break; }
    }
    q.res = ok ? 'hit' : 'miss'; if (ok) hit++;
  }
  return { hit, total };
}
