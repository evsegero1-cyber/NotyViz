import * as pdfjsLib from './lib/pdf.min.mjs';
import { parseSongsterrPdf } from './parser.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('./lib/pdf.worker.min.mjs', import.meta.url).href;

const $ = id => document.getElementById(id);
const A = window.Android;
const NAMES = ['до', 'до♯', 'ре', 'ми♭', 'ми', 'фа', 'фа♯', 'соль', 'ля♭', 'ля', 'си♭', 'си'];
const SHORT = ['до', 'до♯', 'ре', 'ми♭', 'ми', 'фа', 'фа♯', 'сол', 'ля♭', 'ля', 'си♭', 'си'];
const isBlack = m => [1, 3, 6, 8, 10].includes(((m % 12) + 12) % 12);
const octName = m => { const o = Math.floor(m / 12) - 1; return ['субконтр', 'контр', 'большой', 'малой', '1-й', '2-й', '3-й', '4-й', '5-й'][o] || ''; };
const noteName = m => NAMES[((m % 12) + 12) % 12] + ' ' + octName(m);

function toast(t) { const e = $('toast'); e.textContent = t; e.classList.add('on'); clearTimeout(toast.h); toast.h = setTimeout(() => e.classList.remove('on'), 2600); }
function busy(on, t) { $('busy').classList.toggle('on', on); if (t) $('busyTxt').textContent = t; }
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { toast('Не хватает места для сохранения'); } },
  del(k) { try { localStorage.removeItem(k); } catch { } }
};

// ---------- Главный экран ----------
function renderRecent() {
  const list = store.get('nv-list', []);
  const box = $('recent'); box.innerHTML = '';
  if (!list.length) { box.innerHTML = '<div class="empty muted">Пока пусто. Откройте PDF с табулатурой.</div>'; return; }
  for (const it of list) {
    const d = document.createElement('div'); d.className = 'card';
    d.innerHTML = `<div class="grow"><div class="t"></div><div class="muted small"></div></div><button class="icon" aria-label="Удалить">✕</button>`;
    d.querySelector('.t').textContent = it.title;
    d.querySelector('.small').textContent = [it.track || it.instrument, `${it.notes} нот`, fmt(it.dur)].filter(Boolean).join(' · ');
    d.onclick = e => { if (e.target.tagName === 'BUTTON') return; openSong(it.id); };
    d.querySelector('button').onclick = () => {
      store.set('nv-list', store.get('nv-list', []).filter(x => x.id !== it.id)); store.del('nv-song-' + it.id); renderRecent();
    };
    box.appendChild(d);
  }
}
const fmt = s => { s = Math.max(0, Math.round(s || 0)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };

$('importBtn').onclick = () => { if (A && A.openPicker) A.openPicker(); else $('fileInput').click(); };
$('fileInput').onchange = async e => {
  const f = e.target.files[0]; if (!f) return;
  await importPdf(new Uint8Array(await f.arrayBuffer()), f.name); e.target.value = '';
};
window.onFileReady = async () => {
  if (!A) return;
  const b64 = A.getFile(); if (!b64) return;
  const bin = atob(b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  A.clearFile && A.clearFile();
  await importPdf(u, A.getFileName ? A.getFileName() : 'PDF');
};

async function importPdf(data, fileName) {
  busy(true, 'Разбираю PDF…');
  try {
    const song = await parseSongsterrPdf(pdfjsLib, data, (p, n) => busy(true, `Разбираю страницу ${p} из ${n}…`));
    if (!song.notes.length) throw new Error('Ноты не найдены. Возможно, это не табулатура Songsterr.');
    if (!song.title || song.title === 'Без названия') song.title = (fileName || 'Без названия').replace(/\.pdf$/i, '');
    const id = Date.now().toString(36);
    song.id = id;
    store.set('nv-song-' + id, song);
    const t = buildTiming(song);
    const list = store.get('nv-list', []).filter(x => !(x.title === song.title && x.track === song.track));
    list.unshift({ id, title: song.title, track: song.track, instrument: song.instrument, notes: song.notes.length, dur: t.total });
    list.slice(30).forEach(x => store.del('nv-song-' + x.id));
    store.set('nv-list', list.slice(0, 30));
    renderRecent();
    busy(false);
    openSong(id);
  } catch (e) {
    busy(false);
    console.error(e);
    toast('Не получилось разобрать: ' + (e.message || e));
  }
}

// ---------- Время ----------
function buildTiming(song) {
  const ms = song.measures;
  const secAt = [];
  let s = 0;
  for (const m of ms) { secAt.push(s); s += m.len * 60 / (m.tempo || 120); }
  const total = s;
  const beatToSec = b => {
    let i = 0; while (i + 1 < ms.length && ms[i + 1].start <= b) i++;
    const m = ms[i]; return secAt[i] + (b - m.start) * 60 / (m.tempo || 120);
  };
  return { secAt, total, beatToSec };
}

// ---------- Звук ----------
const audio = { ctx: null, master: null, buffers: new Map(), loading: null, live: [] };
const SAMPLES = []; for (let o = 1; o <= 7; o++) for (const [n, k] of [['C', 0], ['Ds', 3], ['Fs', 6], ['A', 9]]) SAMPLES.push({ f: `samples/${n}${o}.mp3`, m: 12 * (o + 1) + k });
function ensureAudio() {
  if (!audio.ctx) {
    const C = window.AudioContext || window.webkitAudioContext;
    audio.ctx = new C({ latencyHint: 'interactive' });
    audio.master = audio.ctx.createGain(); audio.master.gain.value = (+$('vol').value) / 100;
    const comp = audio.ctx.createDynamicsCompressor(); comp.threshold.value = -14; comp.ratio.value = 4;
    audio.master.connect(comp); comp.connect(audio.ctx.destination);
  }
  if (audio.ctx.state === 'suspended') audio.ctx.resume();
  if (!audio.loading) audio.loading = Promise.all(SAMPLES.map(async s => {
    try { const r = await fetch(s.f); const b = await r.arrayBuffer(); audio.buffers.set(s.m, await audio.ctx.decodeAudioData(b)); } catch (e) { console.warn('sample', s.f, e); }
  }));
  return audio.loading;
}
function playNote(midi, when, dur, vel = 0.7) {
  const c = audio.ctx; if (!c) return;
  let best = null, bd = 1e9;
  for (const [m, b] of audio.buffers) { const d = Math.abs(m - midi); if (d < bd) { bd = d; best = m; } }
  if (best == null) return;
  const src = c.createBufferSource(); src.buffer = audio.buffers.get(best);
  src.playbackRate.value = Math.pow(2, (midi - best) / 12);
  const g = c.createGain();
  const t0 = Math.max(when, c.currentTime);
  g.gain.setValueAtTime(vel, t0);
  const end = t0 + Math.max(0.08, dur);
  g.gain.setTargetAtTime(0, end, 0.08);
  src.connect(g); g.connect(audio.master);
  src.start(t0); src.stop(end + 0.6);
  audio.live.push(src);
  src.onended = () => { const i = audio.live.indexOf(src); if (i >= 0) audio.live.splice(i, 1); };
}
function click(when, accent) {
  const c = audio.ctx; const o = c.createOscillator(), g = c.createGain();
  o.frequency.value = accent ? 1760 : 1180; g.gain.setValueAtTime(0.0001, when);
  g.gain.exponentialRampToValueAtTime(accent ? 0.5 : 0.3, when + 0.002); g.gain.exponentialRampToValueAtTime(0.0001, when + 0.05);
  o.connect(g); g.connect(audio.master); o.start(when); o.stop(when + 0.06); audio.live.push(o);
  o.onended = () => { const i = audio.live.indexOf(o); if (i >= 0) audio.live.splice(i, 1); };
}
function stopAll() { for (const s of audio.live.splice(0)) { try { s.stop(); } catch { } } }

// ---------- Плеер ----------
const P = {
  song: null, T: null, notes: [], playing: false, pos: 0, speed: 1, anchorCtx: 0, anchorPos: 0,
  schedIdx: 0, schedPos: 0, beatIdx: 0, loop: null, metro: false, oct: 0, split: 60, handMode: 'split', names: true, fullKb: false,
  lo: 48, hi: 84
};
const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5];

function openSong(id) {
  const song = store.get('nv-song-' + id, null);
  if (!song) { toast('Композиция не найдена'); renderRecent(); return; }
  P.song = song; P.T = buildTiming(song);
  const set = store.get('nv-set-' + id, {});
  P.oct = set.oct || 0; P.split = set.split || 60; P.handMode = set.handMode || 'split';
  P.loop = null; P.pos = 0; P.playing = false;
  prepareNotes();
  const first = P.notes.length ? P.notes[0].s : 0;
  P.pos = Math.max(0, first - 0.5);
  $('pTitle').textContent = song.title;
  $('pSub').textContent = [song.track, song.instrument].filter(Boolean).join(' · ');
  show('player');
  fillSettings();
  resize();
  updateUi();
  if (A && A.setKeepOn) A.setKeepOn(false);
}
function saveSet() { if (P.song) store.set('nv-set-' + P.song.id, { oct: P.oct, split: P.split, handMode: P.handMode }); }
function prepareNotes() {
  const T = P.T;
  P.notes = P.song.notes.map(n => {
    const s = T.beatToSec(n.start), e = T.beatToSec(n.start + n.dur);
    const midi = n.midi + 12 * P.oct;
    return { midi, s, e, m: n.measure, string: n.string, fret: n.fret };
  }).filter(n => n.midi >= 21 && n.midi <= 108).sort((a, b) => a.s - b.s);
  let lo = 200, hi = 0; for (const n of P.notes) { lo = Math.min(lo, n.midi); hi = Math.max(hi, n.midi); }
  if (!P.notes.length) { lo = 48; hi = 84; }
  if (P.fullKb) { lo = 21; hi = 108; }
  else {
    lo = Math.max(21, lo - 1); while (lo % 12 !== 0 && lo % 12 !== 5) lo--;
    hi = Math.min(108, hi + 1); while (hi % 12 !== 11 && hi % 12 !== 4) hi++;
    while (countWhite(lo, hi) < 15) { if (lo > 21) lo--; if (hi < 108) hi++; }
  }
  P.lo = lo; P.hi = hi;
  layoutKeys();
}
const countWhite = (a, b) => { let c = 0; for (let m = a; m <= b; m++) if (!isBlack(m)) c++; return c; };
const hand = midi => P.handMode === 'right' ? 'R' : (midi < P.split ? 'L' : 'R');

function measureAt(sec) {
  const S = P.T.secAt; let i = 0; while (i + 1 < S.length && S[i + 1] <= sec + 1e-6) i++; return i;
}
function now() { return P.playing ? P.anchorPos + (audio.ctx.currentTime - P.anchorCtx) * P.speed : P.pos; }

async function play() {
  if (!P.song) return;
  await ensureAudio();
  if (P.pos >= P.T.total - 0.01) P.pos = 0;
  if (P.loop && (P.pos < P.loop.a || P.pos >= P.loop.b)) P.pos = P.loop.a;
  P.playing = true;
  P.anchorCtx = audio.ctx.currentTime + 0.08; P.anchorPos = P.pos;
  resetSched(P.pos);
  $('playBtn').textContent = '❚❚';
  if (A && A.setKeepOn) A.setKeepOn(true);
}
function pause() {
  if (!P.playing) return;
  P.pos = Math.max(0, now()); P.playing = false; stopAll();
  $('playBtn').textContent = '▶';
  if (A && A.setKeepOn) A.setKeepOn(false);
}
function seek(sec) {
  const was = P.playing; if (was) { P.playing = false; stopAll(); }
  P.pos = Math.max(0, Math.min(P.T.total, sec));
  if (was) { P.playing = true; P.anchorCtx = audio.ctx.currentTime + 0.05; P.anchorPos = P.pos; resetSched(P.pos); }
  updateUi();
}
function resetSched(pos) {
  let i = 0; while (i < P.notes.length && P.notes[i].s < pos - 1e-4) i++;
  P.schedIdx = i;
  // ноты, которые уже звучат в этот момент — тоже озвучить
  const c = audio.ctx;
  for (const n of P.notes) { if (n.s >= pos) break; if (n.e > pos + 0.05) playNote(n.midi, c.currentTime + 0.05, (n.e - pos) / P.speed, 0.5); }
  P.schedPos = pos;
  P.beatIdx = null;
}
function scheduler() {
  if (!P.playing) return;
  const c = audio.ctx;
  const t = now();
  const ahead = t + 0.25 * P.speed;
  const end = P.loop ? P.loop.b : P.T.total;
  const toCtx = s => P.anchorCtx + (s - P.anchorPos) / P.speed;
  while (P.schedIdx < P.notes.length && P.notes[P.schedIdx].s < Math.min(ahead, end)) {
    const n = P.notes[P.schedIdx++];
    if (n.s >= P.schedPos - 1e-4) playNote(n.midi, toCtx(n.s), (Math.min(n.e, end) - n.s) / P.speed);
  }
  if (P.metro) {
    // метроном: каждая доля такта
    const ms = P.song.measures, S = P.T.secAt;
    if (P.beatIdx == null) { P.beatIdx = { m: measureAt(t), b: 0 }; const m = ms[P.beatIdx.m]; const bl = 60 / (m.tempo || 120); P.beatIdx.b = Math.ceil((t - S[P.beatIdx.m]) / bl - 1e-6); }
    for (; ;) {
      const mi = P.beatIdx.m; if (mi >= ms.length) break;
      const m = ms[mi], bl = 60 / (m.tempo || 120), nb = Math.round(m.len);
      if (P.beatIdx.b >= nb) { P.beatIdx.m++; P.beatIdx.b = 0; continue; }
      const bs = S[mi] + P.beatIdx.b * bl;
      if (bs >= Math.min(ahead, end)) break;
      if (bs >= t - 0.02) click(toCtx(bs), P.beatIdx.b === 0);
      P.beatIdx.b++;
    }
  }
  if (t >= end) {
    if (P.loop) { stopAll(); P.anchorCtx = c.currentTime + 0.05; P.anchorPos = P.loop.a; resetSched(P.loop.a); }
    else { P.pos = P.T.total; pause(); }
  }
}
setInterval(scheduler, 25);

// ---------- Отрисовка ----------
const cv = $('cv'); const g = cv.getContext('2d');
let W = 0, H = 0, DPR = 1, KB = 0, keys = new Map();
function resize() {
  const r = cv.getBoundingClientRect(); DPR = Math.min(2.5, window.devicePixelRatio || 1);
  W = r.width; H = r.height; cv.width = Math.round(W * DPR); cv.height = Math.round(H * DPR);
  layoutKeys();
}
window.addEventListener('resize', () => { if ($('player').classList.contains('on')) resize(); });
function layoutKeys() {
  keys = new Map(); if (!W) return;
  const nw = countWhite(P.lo, P.hi), ww = W / nw;
  KB = Math.min(Math.max(90, H * 0.24), 170, ww * 7);
  let i = 0;
  for (let m = P.lo; m <= P.hi; m++) if (!isBlack(m)) { keys.set(m, { x: i * ww, w: ww, black: false }); i++; }
  for (let m = P.lo; m <= P.hi; m++) if (isBlack(m)) { const L = keys.get(m - 1); if (L) keys.set(m, { x: L.x + ww * 0.68, w: ww * 0.64, black: true }); }
}
const COL = { R: ['#4c9aff', '#2f6fcc', '#a9cdff'], L: ['#ff8a3d', '#c85e1c', '#ffc59c'] };
function rr(x, y, w, h, r) { r = Math.min(r, w / 2, h / 2); g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); }

function draw() {
  requestAnimationFrame(draw);
  if (!$('player').classList.contains('on') || !P.song) return;
  const t = now();
  g.setTransform(DPR, 0, 0, DPR, 0, 0);
  g.fillStyle = '#0f1115'; g.fillRect(0, 0, W, H);
  const fallH = H - KB;
  const win = Math.max(1.2, Math.min(4, 3 * P.speed));
  const pps = fallH / win;
  const yOf = s => fallH - (s - t) * pps;
  // дорожки чёрных клавиш
  g.fillStyle = '#13161c';
  for (const [m, k] of keys) if (k.black) g.fillRect(k.x, 0, k.w, fallH);
  g.strokeStyle = '#1b1f27'; g.lineWidth = 1;
  for (const [m, k] of keys) if (!k.black && (m % 12 === 0 || m % 12 === 5)) { g.beginPath(); g.moveTo(k.x + .5, 0); g.lineTo(k.x + .5, fallH); g.stroke(); }
  // тактовые линии
  const S = P.T.secAt, ms = P.song.measures;
  g.font = '11px system-ui'; g.textBaseline = 'bottom';
  for (let i = measureAt(t); i < S.length; i++) {
    const y = yOf(S[i]); if (y < 0) break; if (y > fallH) continue;
    g.fillStyle = '#262b35'; g.fillRect(0, y, W, 1);
    g.fillStyle = '#5b6372'; g.fillText(ms[i].n, 4, y - 2);
  }
  if (P.loop) {
    const ya = yOf(P.loop.a), yb = yOf(P.loop.b);
    g.fillStyle = 'rgba(60,207,142,.07)'; g.fillRect(0, Math.max(0, yb), W, Math.min(fallH, ya) - Math.max(0, yb));
  }
  // ноты
  const active = new Map();
  const t0 = t - 0.05, t1 = t + win;
  for (const n of P.notes) {
    if (n.s > t1) break; if (n.e < t0 - 0.01) continue;
    const k = keys.get(n.midi); if (!k) continue;
    const h = hand(n.midi), c = COL[h];
    const on = n.s <= t && n.e > t;
    if (on) active.set(n.midi, h);
    const y1 = yOf(n.s), y0 = yOf(n.e);
    const top = Math.max(-4, y0), bot = Math.min(fallH, y1);
    if (bot <= top) continue;
    const pad = k.black ? 1 : 2;
    rr(k.x + pad, top, k.w - pad * 2, Math.max(4, bot - top), 5);
    g.fillStyle = on ? c[2] : (k.black ? c[1] : c[0]); g.fill();
    if (P.names && k.w > 15 && bot - top > 16 && y1 < fallH + 1) {
      g.fillStyle = 'rgba(0,0,0,.65)'; g.font = `600 ${Math.min(12, k.w * 0.45)}px system-ui`; g.textAlign = 'center'; g.textBaseline = 'bottom';
      g.fillText(SHORT[n.midi % 12], k.x + k.w / 2, bot - 3); g.textAlign = 'left';
    }
  }
  // клавиатура
  const ky = fallH;
  g.fillStyle = '#000'; g.fillRect(0, ky, W, KB);
  g.fillStyle = '#3a3f4a'; g.fillRect(0, ky, W, 3);
  for (const [m, k] of keys) if (!k.black) {
    const h = active.get(m);
    rr(k.x + 1, ky + 3, k.w - 2, KB - 5, 4);
    g.fillStyle = h ? COL[h][0] : '#f2f2f0'; g.fill();
    if (P.names && k.w > 14) {
      g.fillStyle = h ? '#fff' : (m % 12 === 0 ? '#222' : '#9a9a96');
      g.font = `${m % 12 === 0 ? 600 : 400} ${Math.min(11, k.w * 0.42)}px system-ui`; g.textAlign = 'center'; g.textBaseline = 'bottom';
      g.fillText(SHORT[m % 12], k.x + k.w / 2, ky + KB - 6);
      if (m % 12 === 0) { g.font = `${Math.min(10, k.w * 0.38)}px system-ui`; g.fillText(Math.floor(m / 12) - 1 + '', k.x + k.w / 2, ky + KB - 20); }
      g.textAlign = 'left';
    }
  }
  for (const [m, k] of keys) if (k.black) {
    const h = active.get(m);
    rr(k.x, ky + 3, k.w, (KB - 5) * 0.62, 3);
    g.fillStyle = h ? COL[h][1] : '#1c1d21'; g.fill();
  }
  // интерфейс позиции
  if (P.playing) updatePos(t);
}
requestAnimationFrame(draw);

let lastUi = 0;
function updatePos(t) {
  const nowMs = performance.now(); if (nowMs - lastUi < 120) return; lastUi = nowMs;
  const mi = measureAt(t), m = P.song.measures[mi];
  $('posLbl').textContent = 'Такт ' + m.n;
  $('timeLbl').textContent = fmt(t);
  if (!seeking) $('seek').value = Math.round(t / P.T.total * 1000);
}
function updateUi() { lastUi = 0; updatePos(now()); $('speedBtn').textContent = Math.round(P.speed * 100) + '%'; $('loopBtn').classList.toggle('on', !!P.loop); $('metroBtn').classList.toggle('on', P.metro); }

// ---------- Управление ----------
let seeking = false;
$('seek').oninput = () => { seeking = true; const s = $('seek').value / 1000 * P.T.total; $('posLbl').textContent = 'Такт ' + P.song.measures[measureAt(s)].n; if (!P.playing) { P.pos = s; } };
$('seek').onchange = () => { seeking = false; seek($('seek').value / 1000 * P.T.total); };
$('playBtn').onclick = () => P.playing ? pause() : play();
const stepMeasure = d => { const mi = measureAt(now() + 0.01); const j = Math.max(0, Math.min(P.T.secAt.length - 1, mi + d)); seek(P.T.secAt[j]); };
$('prevBtn').onclick = () => { const t = now(), mi = measureAt(t); if (t - P.T.secAt[mi] > 0.4) seek(P.T.secAt[mi]); else stepMeasure(-1); };
$('nextBtn').onclick = () => stepMeasure(1);
$('speedBtn').onclick = () => setSpeed(SPEEDS[(SPEEDS.indexOf(P.speed) + 1) % SPEEDS.length]);
function setSpeed(s) {
  const t = now(); P.speed = s;
  if (P.playing) { stopAll(); P.anchorCtx = audio.ctx.currentTime + 0.05; P.anchorPos = t; resetSched(t); }
  updateUi(); fillSeg();
}
$('metroBtn').onclick = () => { P.metro = !P.metro; P.beatIdx = null; updateUi(); };
$('loopBtn').onclick = () => {
  if (P.loop) { P.loop = null; updateUi(); toast('Повтор выключен'); return; }
  const mi = measureAt(now() + 0.01);
  setLoop(P.song.measures[mi].n, P.song.measures[Math.min(mi + 3, P.song.measures.length - 1)].n);
};
function setLoop(fromN, toN) {
  const ms = P.song.measures;
  const a = ms.findIndex(m => m.n === fromN), b = ms.findIndex(m => m.n === toN);
  if (a < 0 || b < 0 || b < a) { toast('Проверьте номера тактов'); return; }
  P.loop = { a: P.T.secAt[a], b: P.T.secAt[b] + ms[b].len * 60 / (ms[b].tempo || 120), from: fromN, to: toN };
  $('loopFrom').value = fromN; $('loopTo').value = toN;
  toast(`Повтор: такты ${fromN}–${toN}`);
  if (now() < P.loop.a || now() >= P.loop.b) seek(P.loop.a);
  updateUi();
}
$('loopSet').onclick = () => setLoop(+$('loopFrom').value, +$('loopTo').value);
$('backBtn').onclick = () => goHome();
function goHome() { pause(); show('home'); renderRecent(); }
function show(id) { for (const s of document.querySelectorAll('.screen')) s.classList.toggle('on', s.id === id); }

// Нажатие на клавишу — звук
cv.addEventListener('pointerdown', async e => {
  const r = cv.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
  if (y < H - KB) { if (P.playing) pause(); else play(); return; }
  let hit = null;
  for (const [m, k] of keys) if (k.black && x >= k.x && x < k.x + k.w && y < H - KB + (KB - 5) * 0.62) hit = m;
  if (hit == null) for (const [m, k] of keys) if (!k.black && x >= k.x && x < k.x + k.w) hit = m;
  if (hit == null) return;
  await ensureAudio(); playNote(hit, audio.ctx.currentTime, 0.8);
  toast(noteName(hit));
});

// ---------- Настройки ----------
function fillSeg() {
  const s = $('speedSeg'); s.innerHTML = '';
  for (const v of SPEEDS) { const b = document.createElement('button'); b.textContent = Math.round(v * 100) + '%'; if (v === P.speed) b.className = 'on'; b.onclick = () => setSpeed(v); s.appendChild(b); }
  const o = $('octSeg'); o.innerHTML = '';
  for (const v of [-2, -1, 0, 1, 2]) {
    const b = document.createElement('button'); b.textContent = v > 0 ? '+' + v : v === 0 ? 'как есть' : v;
    if (v === P.oct) b.className = 'on';
    b.onclick = () => { const t = now(); const was = P.playing; pause(); P.oct = v; saveSet(); prepareNotes(); resize(); P.pos = t; fillSeg(); if (was) play(); };
    o.appendChild(b);
  }
}
function fillSettings() {
  fillSeg();
  const sel = $('splitSel'); sel.innerHTML = '';
  for (let m = 40; m <= 76; m++) { const o = document.createElement('option'); o.value = m; o.textContent = noteName(m); sel.appendChild(o); }
  sel.value = P.split; $('handMode').value = P.handMode; sel.disabled = P.handMode !== 'split';
  $('names').checked = P.names; $('fullKb').checked = P.fullKb;
  const ms = P.song.measures;
  $('loopFrom').value = P.loop ? P.loop.from : (P.notes[0] ? P.notes[0].m : ms[0].n);
  $('loopTo').value = P.loop ? P.loop.to : (+$('loopFrom').value + 3);
  const s = P.song;
  const tun = s.tuning.map((m, i) => (s.tuningNames ? s.tuningNames[i] : '') + '=' + noteName(m)).join(', ');
  $('info').innerHTML = '';
  const lines = [
    `Тактов: ${ms.length}, нот: ${s.notes.length}, длительность ${fmt(P.T.total)}`,
    `Строй (${s.strings} струн): ${tun}`,
    `Темп: ${[...new Set(ms.map(m => m.tempo))].join(', ')} уд/мин`,
    'Если всё звучит на октаву выше или ниже оригинала, поправьте «Октава».'
  ];
  for (const l of lines) { const d = document.createElement('div'); d.textContent = l; $('info').appendChild(d); }
}
$('setBtn').onclick = () => { fillSettings(); $('sheet').classList.add('on'); };
$('listBtn').onclick = () => { fillList(); $('listSheet').classList.add('on'); };
for (const sh of document.querySelectorAll('.sheet')) sh.addEventListener('click', e => { if (e.target === sh || e.target.hasAttribute('data-close')) sh.classList.remove('on'); });
$('handMode').onchange = e => { P.handMode = e.target.value; $('splitSel').disabled = P.handMode !== 'split'; saveSet(); };
$('splitSel').onchange = e => { P.split = +e.target.value; saveSet(); };
$('vol').oninput = e => { if (audio.master) audio.master.gain.value = e.target.value / 100; };
$('names').onchange = e => { P.names = e.target.checked; };
$('fullKb').onchange = e => { P.fullKb = e.target.checked; prepareNotes(); resize(); };

function fillList() {
  const box = $('mList'); box.innerHTML = '';
  const by = new Map();
  for (const n of P.notes) { if (!by.has(n.m)) by.set(n.m, []); by.get(n.m).push(n); }
  const cur = P.song.measures[measureAt(now())].n;
  for (const [mn, arr] of by) {
    const groups = [];
    for (const n of arr) { const gg = groups.find(x => Math.abs(x.s - n.s) < 0.01); if (gg) gg.ns.push(n.midi); else groups.push({ s: n.s, ns: [n.midi] }); }
    const d = document.createElement('div'); d.className = 'mrow' + (mn === cur ? ' cur' : '');
    const b = document.createElement('b'); b.textContent = mn; d.appendChild(b);
    const sp = document.createElement('span'); sp.textContent = groups.map(gg => gg.ns.sort((a, b) => a - b).map(m => SHORT[m % 12] + (Math.floor(m / 12) - 1)).join('+')).join('  ·  ');
    d.appendChild(sp);
    d.onclick = () => { const i = P.song.measures.findIndex(m => m.n === mn); seek(P.T.secAt[i]); $('listSheet').classList.remove('on'); };
    box.appendChild(d);
  }
  const c = box.querySelector('.cur'); if (c) c.scrollIntoView({ block: 'center' });
}

// Кнопка «Назад» Android
window.onBack = () => {
  for (const sh of document.querySelectorAll('.sheet.on')) { sh.classList.remove('on'); return true; }
  if ($('player').classList.contains('on')) { goHome(); return true; }
  return false;
};
document.addEventListener('visibilitychange', () => { if (document.hidden) pause(); });
window.onAppPause = () => pause();

renderRecent();
if (A && A.hasFile && A.hasFile()) window.onFileReady();
