import * as pdfjsLib from './lib/pdf.min.mjs';
import * as alphaTab from './lib/alphatab/alphaTab.min.mjs';
import { parseSongsterrPdf } from './parser.js';
import { importMidi } from './import-midi.js';
import { importScore } from './import-gp.js';
import { makeTime, fromBeatSong, songSummary, KIND_LABEL, isStringKind, PPQ, GM_NAMES, GM_GROUPS } from './model.js';
import { Engine } from './engine.js';
import { PianoView, GuitarView, HAND, TRACK_COLORS } from './views.js';
import { PdfView } from './pdfview.js';
import { idb, ls } from './store.js';
import { analyze, mergeSongs, alignOffset, extendMeasures, barPos } from './merge.js';
import { toMidiBytes, toMusicXml } from './export.js';
import { barOf } from './import-midi.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('./lib/pdf.worker.min.mjs', import.meta.url).href;

const $ = id => document.getElementById(id);
const A = window.Android;
const NAMES = ['до', 'до♯', 'ре', 'ми♭', 'ми', 'фа', 'фа♯', 'соль', 'ля♭', 'ля', 'си♭', 'си'];
const octName = m => ['субконтр', 'контр', 'большой', 'малой', '1-й', '2-й', '3-й', '4-й', '5-й'][Math.floor(m / 12) - 1] || '';
const noteName = m => NAMES[((m % 12) + 12) % 12] + ' ' + octName(m);
const fmt = s => { s = Math.max(0, Math.round(s || 0)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
function toast(t) { const e = $('toast'); e.textContent = t; e.classList.add('on'); clearTimeout(toast.h); toast.h = setTimeout(() => e.classList.remove('on'), 2800); }
function busy(on, t) { $('busy').classList.toggle('on', on); if (t) $('busyTxt').textContent = t; }

// ---------- Звук ----------
const engine = new Engine(alphaTab, $('at'), ev => {
  if (ev === 'sound' || ev === 'ready') $('soundState').textContent = '';
  if (ev === 'play' || ev === 'pause') { $('playBtn').textContent = $('lPlay').textContent = engine.playing ? '❚❚' : '▶'; if (A && A.setKeepOn) A.setKeepOn(engine.playing); }
  if (ev === 'finished' && !P.loop) { engine.seekTick(0); }
  if (ev === 'midi') applyEngineSettings();
});
$('soundState').textContent = 'Загружаю звуки инструментов…';

// ---------- Главный экран ----------
async function renderRecent() {
  let list = [];
  try { list = (await idb.all('meta')).sort((a, b) => (b.added || 0) - (a.added || 0)); } catch (e) { }
  const box = $('recent'); box.innerHTML = '';
  if (!list.length) { box.innerHTML = '<div class="empty muted">Пока пусто. Импортируйте файл с нотами или табами.</div>'; return; }
  const SRC = { pdf: 'PDF', midi: 'MIDI', gp: 'Guitar Pro' };
  for (const it of list) {
    const d = document.createElement('div'); d.className = 'card';
    d.innerHTML = `<div class="grow"><div class="t"></div><div class="muted small k"></div><div class="muted small i"></div></div><button class="icon" aria-label="Удалить">✕</button>`;
    d.querySelector('.t').textContent = it.title;
    d.querySelector('.k').textContent = [SRC[it.source] || it.source, fmt(it.dur), `${it.notes} нот`].join(' · ');
    d.querySelector('.i').textContent = (it.kinds || []).join(', ');
    d.onclick = e => { if (e.target.tagName === 'BUTTON') return; openSong(it.id); };
    d.querySelector('button').onclick = async () => {
      await idb.del('meta', it.id); await idb.del('songs', it.id); await idb.del('files', it.id); ls.del('nv-set-' + it.id); renderRecent();
    };
    box.appendChild(d);
  }
}

$('importBtn').onclick = () => { if (A && A.openPicker) A.openPicker(); else $('fileInput').click(); };
$('fileInput').onchange = async e => {
  const f = e.target.files[0]; if (!f) return;
  await importFile(new Uint8Array(await f.arrayBuffer()), f.name); e.target.value = '';
};
window.onFileReady = async () => {
  if (!A) return;
  const b64 = A.getFile(); if (!b64) return;
  const bin = atob(b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  const name = A.getFileName ? A.getFileName() : '';
  A.clearFile && A.clearFile();
  await importFile(u, name);
};

const isPdf = b => b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46;
const isMidi = b => b[0] === 0x4d && b[1] === 0x54 && b[2] === 0x68 && b[3] === 0x64;
// Разбор файла любого поддерживаемого формата во внутреннюю модель
async function parseFile(bytes, name, progress) {
  let song, keepRaw = false;
  if (isPdf(bytes)) {
    const old = await parseSongsterrPdf(pdfjsLib, bytes.slice(), progress);
    if (!old.notes.length) throw new Error('Ноты не найдены. Сейчас поддерживаются PDF-табулатуры Songsterr.');
    song = fromBeatSong(old); keepRaw = true;
    if (!song.title || song.title === 'Без названия') song.title = (name || 'PDF').replace(/\.pdf$/i, '');
  } else if (isMidi(bytes)) {
    song = importMidi(window.Midi, bytes, name);
  } else {
    song = importScore(alphaTab, bytes, name); keepRaw = true;
  }
  return { song, keepRaw };
}
async function importFile(bytes, name) {
  busy(true, 'Разбираю файл…');
  try {
    const { song, keepRaw } = await parseFile(bytes, name, (p, n) => busy(true, `Разбираю страницу ${p} из ${n}…`));
    song.id = Date.now().toString(36);
    song.added = Date.now();
    song.fileName = name || '';
    await idb.put('songs', song.id, song);
    if (keepRaw) await idb.put('files', song.id, bytes);
    await idb.put('meta', song.id, songSummary(song));
    busy(false);
    renderRecent();
    openSong(song.id);
  } catch (e) {
    busy(false); console.error(e);
    toast('Не получилось открыть файл: ' + (e.message || e));
  }
}

// Перенос композиций из первой версии (localStorage)
async function migrate() {
  const list = ls.get('nv-list', null); if (!list) return;
  for (const it of list) {
    const old = ls.get('nv-song-' + it.id, null); if (!old) continue;
    try {
      const s = fromBeatSong(old); s.id = it.id; s.added = Date.now() - 1000; s.title = old.title;
      await idb.put('songs', s.id, s); await idb.put('meta', s.id, songSummary(s));
    } catch (e) { console.warn(e); }
    ls.del('nv-song-' + it.id);
  }
  ls.del('nv-list');
}

// ---------- Плеер ----------
const P = {
  song: null, time: null, raw: null, mode: 'keys', show: [], mute: {}, gTrack: -1, oct: 0, split: 60, handMode: 'auto',
  names: true, fullKb: false, stave: 'default', land: false, landDismissed: false, pressed: new Set(), prog: {}, speed: 1, loop: null, metro: false, keysNotes: [], fretNotes: [], scoreShown: null, vol: 0.8
};
const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5];
const piano = new PianoView(), guitar = new GuitarView();
const pdfView = new PdfView($('pdfWrap'), pdfjsLib, i => openEdit(i));

async function openSong(id) {
  const song = await idb.get('songs', id);
  if (!song) { toast('Композиция не найдена'); renderRecent(); return; }
  if (engine.playing) engine.pause();
  P.song = song; P.time = makeTime(song); P.raw = null;
  if (song.source !== 'midi') P.raw = await idb.get('files', id);
  const set = ls.get('nv-set-' + id, {});
  const tracks = song.tracks;
  P.oct = set.oct || 0; P.split = set.split || 60; P.handMode = set.handMode || 'auto';
  P.mute = set.mute || {}; P.prog = set.prog || {};
  P.show = set.show || tracks.map((t, i) => i).filter(i => tracks[i].kind !== 'drums' && (tracks[i].kind === 'piano' || tracks.length <= 2 || !tracks.some(x => x.kind === 'piano')));
  if (!P.show.length) P.show = tracks.map((t, i) => i).filter(i => tracks[i].kind !== 'drums').slice(0, 1);
  const fretIdx = tracks.findIndex(t => t.tuning && isStringKind(t.kind));
  P.gTrack = set.gTrack != null ? set.gTrack : (fretIdx >= 0 ? fretIdx : tracks.findIndex(t => t.tuning));
  P.loop = null; P.scoreShown = null;
  const firstStringed = tracks[P.show[0]] && isStringKind(tracks[P.show[0]].kind) && tracks[P.show[0]].tuning;
  P.mode = set.mode || (firstStringed ? 'fret' : 'keys');
  engine.prog = P.prog;
  engine.load(song, P.time, song.source === 'gp' ? P.raw : null);
  prepare();
  $('pTitle').textContent = song.title;
  $('pSub').textContent = tracks.length === 1 ? [tracks[0].name, KIND_LABEL[tracks[0].kind]].filter(Boolean).join(' · ') : `${tracks.length} дорожек: ` + [...new Set(tracks.map(t => KIND_LABEL[t.kind]))].join(', ');
  show('player');
  if (P.land) exitLand(true);
  P.landDismissed = false;
  setMode(P.mode, true);
  setTimeout(onOrient, 50);
  const first = firstNoteSec();
  engine.seekTick(P.time.toTick(Math.max(0, first - 0.3)));
  updateUi();
  if (!engine.sfReady) toast('Звуки ещё загружаются, подождите пару секунд');
}
function saveSet() {
  if (!P.song) return;
  ls.set('nv-set-' + P.song.id, { oct: P.oct, split: P.split, handMode: P.handMode, mode: P.mode, show: P.show, mute: P.mute, gTrack: P.gTrack, prog: P.prog });
}
function firstNoteSec() {
  let m = 1e9; for (const i of P.show) { const n = P.song.tracks[i] && P.song.tracks[i].notes.find(n => !n.deleted); if (n) m = Math.min(m, P.time.toSec(n.t)); }
  return m === 1e9 ? 0 : m;
}
function applyEngineSettings() {
  engine.setSpeed(P.speed); engine.setVolume(P.vol); engine.setMetronome(P.metro);
  engine.setChannels({ mute: P.mute, oct: P.oct });
  if (P.loop) engine.setLoop(P.loop.ta, P.loop.tb); else engine.setLoop(null);
}

// Подготовка нот для отрисовки
function prepare() {
  const { song, time } = P;
  const tracks = song.tracks;
  const onlyPiano = P.show.every(i => tracks[i] && (tracks[i].kind === 'piano' || P.show.length === 1));
  const out = [];
  for (const ti of P.show) {
    const tr = tracks[ti]; if (!tr || tr.kind === 'drums') continue;
    const tc = TRACK_COLORS[ti % TRACK_COLORS.length];
    const trCol = [tc, shadeHex(tc, -0.3), shadeHex(tc, 0.5)];
    for (const n of tr.notes) {
      if (n.deleted || n.tie) continue;
      const m = n.m + 12 * P.oct; if (m < 21 || m > 108) continue;
      let col;
      if (onlyPiano) {
        let h;
        if (P.handMode === 'right') h = 'R';
        else if (P.handMode === 'auto' && (n.h || tr.hand)) h = n.h || tr.hand;
        else h = m < P.split ? 'L' : 'R';
        col = HAND[h];
      } else col = trCol;
      out.push({ s: time.toSec(n.t), e: time.toSec(n.t + n.d), m, col, ti });
    }
  }
  out.sort((a, b) => a.s - b.s || a.m - b.m);
  P.keysNotes = out;
  piano.setRange(out, P.fullKb);
  const gt = tracks[P.gTrack];
  P.fretNotes = [];
  if (gt && gt.tuning) {
    gt.notes.forEach((n, idx) => {
      if (n.deleted || n.tie || n.s == null || n.f == null) return;
      P.fretNotes.push({ s: time.toSec(n.t), e: time.toSec(n.t + n.d), m: n.m, f: n.f, st: n.s, idx });
    });
    P.fretNotes.sort((a, b) => a.s - b.s || a.st - b.st);
    guitar.setTrack(gt, P.fretNotes);
  }
}
function shadeHex(hex, k) { const n = parseInt(hex.slice(1), 16); const f = v => Math.max(0, Math.min(255, Math.round(k > 0 ? v + (255 - v) * k : v * (1 + k)))); return `rgb(${f(n >> 16)},${f((n >> 8) & 255)},${f(n & 255)})`; }
function firstIdx(arr, s) { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m].s < s) lo = m + 1; else hi = m; } return lo; }

// ---------- Режимы ----------
function setMode(mode, silent) {
  const s = P.song;
  if (mode === 'fret' && !(s.tracks[P.gTrack] && s.tracks[P.gTrack].tuning && P.fretNotes.length)) {
    if (!silent) toast('Нет дорожки со струнами (гитара или бас)'); mode = 'keys';
  }
  if (mode === 'pdf' && s.source !== 'pdf') { if (!silent) toast('«Оригинал» есть только у PDF'); mode = P.mode === 'pdf' ? 'keys' : P.mode; }
  P.mode = mode; saveSet();
  for (const b of $('modes').children) {
    b.classList.toggle('on', b.dataset.mode === mode);
    const off = (b.dataset.mode === 'pdf' && s.source !== 'pdf') || (b.dataset.mode === 'fret' && !P.fretNotes.length) || (b.dataset.mode === 'score' && (s.source !== 'gp' || s.custom));
    b.classList.toggle('off', off);
  }
  $('landBtn').style.display = mode === 'keys' ? '' : 'none';
  if (mode !== 'keys' && P.land) exitLand(true);
  $('cv').style.display = (mode === 'keys' || mode === 'fret') ? 'block' : 'none';
  $('scoreWrap').classList.toggle('on', mode === 'score');
  $('pdfWrap').classList.toggle('on', mode === 'pdf');
  if (mode === 'score') showScore();
  if (mode === 'pdf') pdfView.show(s, P.raw);
  resize();
}
for (const b of $('modes').children) b.onclick = () => setMode(b.dataset.mode);
function showScore() {
  const s = P.song;
  if (s.source !== 'gp' || !engine.score) {
    $('scoreMsg').style.display = 'block'; $('at').style.display = 'none'; $('scoreBar').style.display = 'none';
    $('scoreMsg').textContent = s.source === 'pdf'
      ? 'Для PDF нотный вид — это «Оригинал»: страница с отмеченными нотами, их можно исправить. Табулатура выбранной дорожки — в режиме «Гриф».'
      : 'В MIDI-файле нет нотной записи и аппликатуры, только ноты по времени. Смотрите их в режимах «Клавиши» и «Гриф» (там же лента табулатуры). Ноты и табы с аппликатурой показываются для Guitar Pro и MusicXML.';
    return;
  }
  $('scoreMsg').style.display = 'none'; $('at').style.display = 'block'; $('scoreBar').style.display = 'flex';
  let tr = s.tracks[P.show[0]] || s.tracks[0];
  if (P.stave === 'tab' || !tr || tr.kind === 'drums') {
    const g2 = s.tracks[P.gTrack];
    if (g2 && g2.tuning) tr = g2; else if (P.stave === 'tab') { P.stave = 'default'; toast('Табулатура есть только у гитары и баса'); }
  }
  const key = tr.scoreTrack + ':' + P.song.id + ':' + P.stave;
  for (const b of $('scoreBar').children) b.classList.toggle('on', b.dataset.stave === P.stave);
  if (P.scoreShown !== key) { P.scoreShown = key; busy(true, 'Рисую ноты…'); setTimeout(() => { engine.showScore(tr.scoreTrack, P.stave); busy(false); }, 30); }
}
for (const b of $('scoreBar').children) b.onclick = () => { P.stave = b.dataset.stave; showScore(); };

function show(id) { for (const s of document.querySelectorAll('.screen')) s.classList.toggle('on', s.id === id); }
$('backBtn').onclick = () => { engine.pause(); if (P.land) exitLand(true); show('home'); renderRecent(); };

// ---------- Отрисовка ----------
const cv = $('cv'); const g = cv.getContext('2d');
let W = 0, H = 0, DPR = 1;
function resize() {
  const r = cv.getBoundingClientRect(); if (!r.width) return;
  DPR = Math.min(2.5, window.devicePixelRatio || 1);
  W = r.width; H = r.height; cv.width = Math.round(W * DPR); cv.height = Math.round(H * DPR);
}
window.addEventListener('resize', () => { if ($('player').classList.contains('on')) { resize(); if (P.mode === 'pdf') { pdfView.key = null; pdfView.show(P.song, P.raw); } } });

let lastUi = 0, seeking = false;
function frame() {
  requestAnimationFrame(frame);
  if (!P.song || !$('player').classList.contains('on')) return;
  const tick = engine.nowTick();
  const t = P.time.toSec(tick);
  const mi = P.time.measureAtSec(t);
  if (P.mode === 'keys' || P.mode === 'fret') {
    if (!W) resize();
    g.setTransform(DPR, 0, 0, DPR, 0, 0);
    const ctx = { t, speed: P.speed, names: P.names, mStarts: P.time.mStarts, measures: P.song.measures, measureIdx: mi, firstIdx, loop: P.loop ? { a: P.time.toSec(P.loop.ta), b: P.time.toSec(P.loop.tb) } : null };
    if (P.mode === 'keys') piano.draw(g, W, H, { ...ctx, notes: P.keysNotes, land: P.land, pressed: P.pressed });
    else { const tr = P.song.tracks[P.gTrack]; guitar.draw(g, W, H, { ...ctx, notes: P.fretNotes, tuningNames: tuningLabels(tr) }); }
  } else if (P.mode === 'pdf') {
    const act = new Set();
    for (let i = firstIdx(P.fretNotes, t - 20); i < P.fretNotes.length; i++) { const n = P.fretNotes[i]; if (n.s > t) break; if (n.e > t) act.add(n.idx); }
    pdfView.follow = engine.playing; pdfView.highlight(act);
  }
  const now = performance.now();
  if (now - lastUi > 150) {
    lastUi = now;
    $('posLbl').textContent = 'Такт ' + P.song.measures[mi].n;
    $('timeLbl').textContent = fmt(t);
    if (!seeking) $('seek').value = Math.round(t / Math.max(0.1, P.time.total) * 1000);
    if (P.land) { $('lPos').textContent = 'Такт ' + P.song.measures[mi].n; $('landProg').firstChild.style.width = (t / Math.max(0.1, P.time.total) * 100) + '%'; }
  }
}
requestAnimationFrame(frame);
function tuningLabels(tr) {
  if (!tr || !tr.tuning) return null;
  if (tr.tuningNames && tr.tuningNames.length === tr.tuning.length) return tr.tuningNames;
  const L = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  return tr.tuning.map((m, i) => { const s = L[m % 12]; return i === 0 ? s.toLowerCase() : s; });
}

// ---------- Управление ----------
function updateUi() {
  $('speedBtn').textContent = Math.round(P.speed * 100) + '%';
  $('loopBtn').classList.toggle('on', !!P.loop); $('metroBtn').classList.toggle('on', P.metro);
  $('playBtn').textContent = engine.playing ? '❚❚' : '▶';
  $('lPlay').textContent = engine.playing ? '❚❚' : '▶'; $('lSpeed').textContent = Math.round(P.speed * 100) + '%'; $('lLoop').classList.toggle('on', !!P.loop);
}
$('playBtn').onclick = () => {
  if (!engine.sfReady) { toast('Звуки ещё загружаются…'); return; }
  if (engine.playing) engine.pause(); else engine.play();
};
$('seek').oninput = () => { seeking = true; const s = $('seek').value / 1000 * P.time.total; $('posLbl').textContent = 'Такт ' + P.song.measures[P.time.measureAtSec(s)].n; };
$('seek').onchange = () => { seeking = false; engine.seekTick(P.time.toTick($('seek').value / 1000 * P.time.total)); };
function gotoMeasure(i) { i = Math.max(0, Math.min(P.song.measures.length - 1, i)); engine.seekTick(P.song.measures[i].tick); }
$('prevBtn').onclick = () => { const t = P.time.toSec(engine.nowTick()), mi = P.time.measureAtSec(t); if (t - P.time.mStarts[mi] > 0.4) gotoMeasure(mi); else gotoMeasure(mi - 1); };
$('nextBtn').onclick = () => gotoMeasure(P.time.measureAtSec(P.time.toSec(engine.nowTick())) + 1);
$('speedBtn').onclick = () => setSpeed(SPEEDS[(SPEEDS.indexOf(P.speed) + 1) % SPEEDS.length]);
function setSpeed(s) { P.speed = s; engine.setSpeed(s); updateUi(); fillSeg(); }
$('metroBtn').onclick = () => { P.metro = !P.metro; engine.setMetronome(P.metro); updateUi(); };
$('loopBtn').onclick = () => {
  if (P.loop) { P.loop = null; engine.setLoop(null); updateUi(); toast('Повтор выключен'); return; }
  const mi = P.time.measureAtSec(P.time.toSec(engine.nowTick()) + 0.01);
  setLoop(P.song.measures[mi].n, P.song.measures[Math.min(mi + 3, P.song.measures.length - 1)].n);
};
function setLoop(fromN, toN) {
  const ms = P.song.measures;
  const a = ms.findIndex(m => m.n === fromN), b = ms.findIndex((m, i) => i >= a && m.n === toN);
  if (a < 0 || b < 0) { toast('Проверьте номера тактов'); return; }
  P.loop = { ta: ms[a].tick, tb: ms[b].tick + ms[b].len, from: fromN, to: toN };
  engine.setLoop(P.loop.ta, P.loop.tb);
  $('loopFrom').value = fromN; $('loopTo').value = toN;
  const cur = engine.nowTick(); if (cur < P.loop.ta || cur >= P.loop.tb) engine.seekTick(P.loop.ta);
  toast(`Повтор: такты ${fromN}–${toN}`); updateUi();
}
$('loopSet').onclick = () => setLoop(+$('loopFrom').value, +$('loopTo').value);

// Касание: по клавише — звук и подсветка (несколько пальцев), по «дороге» — пуск/пауза
const touchKey = new Map();
cv.addEventListener('pointerdown', e => {
  const r = cv.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
  if (P.mode === 'keys') {
    const m = piano.hit(x, y);
    if (m != null) {
      try { cv.setPointerCapture(e.pointerId); } catch (er) { }
      touchKey.set(e.pointerId, m); P.pressed.add(m);
      engine.previewNote(m, 0);
      if (!P.land) toast(noteName(m));
      return;
    }
  }
  $('playBtn').onclick();
});
const release = e => { const m = touchKey.get(e.pointerId); if (m == null) return; touchKey.delete(e.pointerId); if (![...touchKey.values()].includes(m)) P.pressed.delete(m); };
cv.addEventListener('pointerup', release); cv.addEventListener('pointercancel', release);

// ---------- Альбомный полноэкранный режим ----------
function enterLand(rotate) {
  if (P.mode !== 'keys') setMode('keys');
  P.land = true; P.landDismissed = false;
  document.body.classList.add('land');
  if (A && A.setLandscape && rotate) A.setLandscape(true);
  else if (A && A.setImmersive) A.setImmersive(true);
  piano.minWhite = 22; prepare();
  updateUi(); setTimeout(resize, 60); setTimeout(resize, 400);
}
function exitLand(silent) {
  P.land = false; P.landDismissed = true;
  document.body.classList.remove('land');
  if (A && A.setLandscape) A.setLandscape(false);
  piano.minWhite = 15; prepare();
  setTimeout(resize, 60); setTimeout(resize, 400);
}
$('landBtn').onclick = () => enterLand(true);
$('lExit').onclick = () => exitLand();
$('lPlay').onclick = () => $('playBtn').onclick();
$('lPrev').onclick = () => $('prevBtn').onclick();
$('lNext').onclick = () => $('nextBtn').onclick();
$('lSpeed').onclick = () => $('speedBtn').onclick();
$('lLoop').onclick = () => $('loopBtn').onclick();
$('lSet').onclick = () => $('setBtn').onclick();
$('landProg').addEventListener('pointerdown', e => {
  const r = $('landProg').getBoundingClientRect();
  engine.seekTick(P.time.toTick((e.clientX - r.left) / r.width * P.time.total));
});
// Телефон повернули горизонтально на клавишах — сразу компактный режим
const landMq = window.matchMedia('(orientation: landscape) and (max-height: 600px)');
const onOrient = () => {
  if (!$('player').classList.contains('on') || P.mode !== 'keys') return;
  if (landMq.matches && !P.land && !P.landDismissed) enterLand(false);
  if (!landMq.matches) { P.landDismissed = false; if (P.land && !(A && A.isLandscapeLocked && A.isLandscapeLocked())) exitLand(true); }
};
(landMq.addEventListener ? landMq.addEventListener('change', onOrient) : landMq.addListener(onOrient));

// ---------- Настройки ----------
function fillSeg() {
  const s = $('speedSeg'); s.innerHTML = '';
  for (const v of SPEEDS) { const b = document.createElement('button'); b.textContent = Math.round(v * 100) + '%'; if (v === P.speed) b.className = 'on'; b.onclick = () => setSpeed(v); s.appendChild(b); }
  const o = $('octSeg'); o.innerHTML = '';
  for (const v of [-2, -1, 0, 1, 2]) {
    const b = document.createElement('button'); b.textContent = v > 0 ? '+' + v : v === 0 ? 'как есть' : v;
    if (v === P.oct) b.className = 'on';
    b.onclick = () => { P.oct = v; saveSet(); prepare(); engine.setChannels({ mute: P.mute, oct: P.oct }); fillSeg(); };
    o.appendChild(b);
  }
}
function fillSettings() {
  fillSeg();
  const sel = $('splitSel'); sel.innerHTML = '';
  for (let m = 40; m <= 76; m++) { const o = document.createElement('option'); o.value = m; o.textContent = noteName(m); sel.appendChild(o); }
  sel.value = P.split; $('handMode').value = P.handMode; sel.disabled = P.handMode === 'right';
  $('names').checked = P.names; $('fullKb').checked = P.fullKb; $('vol').value = Math.round(P.vol * 100);
  const ms = P.song.measures;
  const mi = P.time.measureAtSec(P.time.toSec(engine.nowTick()));
  $('loopFrom').value = P.loop ? P.loop.from : ms[mi].n;
  $('loopTo').value = P.loop ? P.loop.to : ms[Math.min(mi + 3, ms.length - 1)].n;
  const s = P.song, tr = s.tracks[P.gTrack];
  const tempos = [...new Set(s.tempos.map(t => Math.round(t.bpm)))];
  const lines = [
    `Тактов: ${ms.length}, длительность ${fmt(P.time.total)}, темп ${tempos.slice(0, 6).join(', ')}${tempos.length > 6 ? '…' : ''} уд/мин`,
    `Дорожки: ${s.tracks.map(t => `${t.name} (${KIND_LABEL[t.kind]})`).join('; ')}`
  ];
  if (tr && tr.tuning) lines.push(`Строй «${tr.name}»: ${tr.tuning.map((m, i) => (tuningLabels(tr)[i]) + '=' + noteName(m)).join(', ')}${tr.fretsGuessed ? ' — аппликатура подобрана автоматически (в MIDI её нет)' : ''}`);
  if (s.source === 'pdf') lines.push('Если всё звучит на октаву выше или ниже оригинала, поправьте «Октава».');
  $('info').innerHTML = ''; for (const l of lines) { const d = document.createElement('div'); d.textContent = l; $('info').appendChild(d); }
}
for (const sh of document.querySelectorAll('.sheet')) sh.addEventListener('click', e => { if (e.target === sh || e.target.hasAttribute('data-close')) sh.classList.remove('on'); });
$('setBtn').onclick = () => { fillSettings(); $('sheet').classList.add('on'); };
$('handMode').onchange = e => { P.handMode = e.target.value; $('splitSel').disabled = P.handMode === 'right'; saveSet(); prepare(); };
$('splitSel').onchange = e => { P.split = +e.target.value; saveSet(); prepare(); };
$('vol').oninput = e => { P.vol = e.target.value / 100; engine.setVolume(P.vol); };
$('names').onchange = e => { P.names = e.target.checked; };
$('fullKb').onchange = e => { P.fullKb = e.target.checked; prepare(); };

// ---------- Дорожки ----------
$('trackBtn').onclick = () => { fillTracks(); $('trackSheet').classList.add('on'); };
function fillTracks() {
  const box = $('tList'); box.innerHTML = '';
  P.song.tracks.forEach((tr, i) => {
    const row = document.createElement('div'); row.className = 'trow';
    const dot = document.createElement('span'); dot.className = 'dot'; dot.style.background = TRACK_COLORS[i % TRACK_COLORS.length];
    const info = document.createElement('div'); info.className = 'grow';
    const a = document.createElement('div'); a.textContent = tr.name;
    const b = document.createElement('div'); b.className = 'muted small';
    b.textContent = [KIND_LABEL[tr.kind], tr.instrument && tr.instrument !== tr.name ? tr.instrument : '', tr.notes.length + ' нот', tr.tuning ? tr.tuning.length + ' струн' : ''].filter(Boolean).join(' · ');
    info.append(a, b);
    const showBtn = document.createElement('button'); showBtn.className = 'chip';
    const isFret = P.mode === 'fret';
    const canShow = isFret ? !!(tr.tuning && tr.notes.some(n => n.s != null)) : tr.kind !== 'drums';
    const on = isFret ? P.gTrack === i : P.show.includes(i);
    showBtn.textContent = isFret ? (on ? 'На грифе' : 'Гриф') : (on ? 'Показ ✓' : 'Показ');
    showBtn.classList.toggle('on', on); showBtn.disabled = !canShow; if (!canShow) showBtn.style.opacity = .4;
    showBtn.onclick = () => {
      if (isFret) P.gTrack = i;
      else if (P.show.includes(i)) { if (P.show.length > 1) P.show = P.show.filter(x => x !== i); }
      else P.show = [...P.show, i].sort((x, y) => x - y);
      saveSet(); prepare(); P.scoreShown = P.mode === 'score' ? null : P.scoreShown; if (P.mode === 'score') showScore(); fillTracks();
    };
    const snd = document.createElement('button'); snd.className = 'chip';
    const muted = !!P.mute[i]; snd.textContent = muted ? 'Звук выкл' : 'Звук'; snd.classList.toggle('on', !muted);
    snd.onclick = () => { P.mute[i] = !P.mute[i]; saveSet(); engine.setChannels({ mute: P.mute, oct: P.oct }); fillTracks(); };
    const btns = document.createElement('div'); btns.className = 'tbtns'; btns.append(showBtn, snd);
    const top = document.createElement('div'); top.className = 'trow-top'; top.append(dot, info, btns);
    const sel = document.createElement('select'); sel.className = 'progSel';
    if (tr.kind === 'drums') { const o = document.createElement('option'); o.textContent = 'Ударная установка'; sel.appendChild(o); sel.disabled = true; }
    else {
      GM_GROUPS.forEach((gname, gi) => {
        const og = document.createElement('optgroup'); og.label = gname;
        for (let p = gi * 8; p < gi * 8 + 8; p++) { const o = document.createElement('option'); o.value = p; o.textContent = GM_NAMES[p] + (p === (tr.program || 0) ? ' — как в файле' : ''); og.appendChild(o); }
        sel.appendChild(og);
      });
      sel.value = P.prog[i] != null ? P.prog[i] : (tr.program || 0);
      sel.onchange = () => {
        const v = +sel.value;
        if (v === (tr.program || 0)) delete P.prog[i]; else P.prog[i] = v;
        saveSet(); const wasPlaying = engine.playing; engine.setPrograms(P.prog); if (!wasPlaying) setTimeout(() => engine.previewNote(60, v), 300); toast('Звучание: ' + GM_NAMES[v]);
      };
    }
    const lab = document.createElement('label'); lab.className = 'muted small proglab'; lab.textContent = 'Звучит как';
    const progRow = document.createElement('div'); progRow.className = 'trow-prog'; progRow.append(lab, sel);
    row.append(top, progRow); box.appendChild(row);
  });
}

// ---------- Ноты по тактам ----------
$('listBtn').onclick = () => { fillList(); $('listSheet').classList.add('on'); };
function fillList() {
  const box = $('mList'); box.innerHTML = '';
  const ti = P.mode === 'fret' ? P.gTrack : P.show[0];
  const tr = P.song.tracks[ti]; if (!tr) return;
  const head = document.createElement('div'); head.className = 'muted small'; head.textContent = 'Дорожка: ' + tr.name; box.appendChild(head);
  const by = new Map();
  for (const n of tr.notes) { if (n.deleted || n.tie) continue; if (!by.has(n.bar)) by.set(n.bar, []); by.get(n.bar).push(n); }
  const cur = P.song.measures[P.time.measureAtSec(P.time.toSec(engine.nowTick()))].n;
  let count = 0;
  for (const [mn, arr] of by) {
    if (++count > 600) break;
    const groups = [];
    for (const n of arr) { const gg = groups.find(x => x.t === n.t); if (gg) gg.ns.push(n); else groups.push({ t: n.t, ns: [n] }); }
    const d = document.createElement('div'); d.className = 'mrow' + (mn === cur ? ' cur' : '');
    const b = document.createElement('b'); b.textContent = mn; d.appendChild(b);
    const sp = document.createElement('span');
    sp.textContent = groups.map(gg => gg.ns.sort((a, b) => a.m - b.m).map(n => NAMES[(n.m + 12 * P.oct) % 12].replace('соль', 'сол') + (Math.floor((n.m + 12 * P.oct) / 12) - 1) + (n.f != null && tr.tuning ? `(${n.s + 1}/${n.f})` : '')).join('+')).join('  ·  ');
    d.appendChild(sp);
    d.onclick = () => { const i = P.song.measures.findIndex(m => m.n === mn); gotoMeasure(i); $('listSheet').classList.remove('on'); };
    box.appendChild(d);
  }
  const c = box.querySelector('.cur'); if (c) c.scrollIntoView({ block: 'center' });
}

// ---------- Правка нот (PDF) ----------
let editIdx = -1;
function openEdit(i) {
  const tr = P.song.tracks[0], n = tr.notes[i]; if (!n) return;
  editIdx = i;
  $('edTitle').textContent = `Такт ${n.bar}: ${noteName(n.m)}`;
  $('edInfo').textContent = n.edited ? 'Нота уже исправлена вручную' : 'Распознано автоматически';
  const s = $('edString'); s.innerHTML = '';
  const lab = tuningLabels(tr) || [];
  tr.tuning.forEach((m, k) => { const o = document.createElement('option'); o.value = k; o.textContent = `${k + 1} (${lab[k] || ''}, ${noteName(m)})`; s.appendChild(o); });
  s.value = n.s; $('edFret').value = n.f; $('edDur').value = 'keep';
  updEdNote();
  $('editSheet').classList.add('on');
}
function updEdNote() { const tr = P.song.tracks[0]; const m = tr.tuning[+$('edString').value] + (+$('edFret').value || 0); $('edNote').textContent = '→ ' + noteName(m); }
$('edString').onchange = updEdNote; $('edFret').oninput = updEdNote;
$('edListen').onclick = () => { const tr = P.song.tracks[0]; engine.previewNote(tr.tuning[+$('edString').value] + (+$('edFret').value || 0) + 12 * P.oct, tr.program || 0); };
async function saveEdit(del) {
  const tr = P.song.tracks[0], n = tr.notes[editIdx]; if (!n) return;
  if (del) n.deleted = true;
  else {
    const s = +$('edString').value, f = Math.max(0, Math.min(30, +$('edFret').value || 0));
    n.s = s; n.f = f; n.m = tr.tuning[s] + f;
    const d = $('edDur').value; if (d !== 'keep') n.d = Math.round(+d * PPQ);
  }
  n.edited = true;
  P.song.editVer = (P.song.editVer || 0) + 1;
  await idb.put('songs', P.song.id, P.song); await idb.put('meta', P.song.id, songSummary(P.song));
  prepare(); engine.rebuildMidi(P.song);
  pdfView.key = null; await pdfView.show(P.song, P.raw);
  $('editSheet').classList.remove('on');
  toast(del ? 'Нота удалена' : 'Сохранено');
}
$('edSave').onclick = () => saveEdit(false);
$('edDel').onclick = () => saveEdit(true);

// ---------- Системное ----------
window.onBack = () => {
  for (const sh of document.querySelectorAll('.sheet.on')) { sh.classList.remove('on'); return true; }
  if (P.land) { exitLand(); return true; }
  if ($('player').classList.contains('on')) { engine.pause(); show('home'); renderRecent(); return true; }
  return false;
};
window.onAppPause = () => engine.pause();
document.addEventListener('visibilitychange', () => { if (document.hidden) engine.pause(); });

(async () => {
  try { await migrate(); } catch (e) { console.warn(e); }
  renderRecent();
  if (A && A.hasFile && A.hasFile()) window.onFileReady();
})();

// =====================================================================
// Объединение файлов
// =====================================================================
const MG = { files: [], ref: 0, merged: null, time: null, dirty: true };
const SRC_LABEL = b => isPdf(b) ? 'PDF' : isMidi(b) ? 'MIDI' : 'Guitar Pro / MusicXML';
function gmSelect(value, onChange, disabled) {
  const sel = document.createElement('select');
  if (disabled) { const o = document.createElement('option'); o.textContent = 'Ударная установка'; sel.appendChild(o); sel.disabled = true; return sel; }
  GM_GROUPS.forEach((gname, gi) => {
    const og = document.createElement('optgroup'); og.label = gname;
    for (let p = gi * 8; p < gi * 8 + 8; p++) { const o = document.createElement('option'); o.value = p; o.textContent = GM_NAMES[p]; og.appendChild(o); }
    sel.appendChild(og);
  });
  sel.value = value || 0; sel.onchange = () => onChange(+sel.value);
  return sel;
}
$('mergeBtn').onclick = () => {
  MG.files = []; MG.ref = 0; MG.merged = null; MG.dirty = true; $('mTitle').value = '';
  show('merge'); renderMerge(); pickMerge();
};
function pickMerge() { if (A && A.openPickerMulti) A.openPickerMulti(); else $('mergeInput').click(); }
$('mAdd').onclick = pickMerge;
$('mergeInput').onchange = async e => {
  const list = [...e.target.files]; e.target.value = '';
  const items = []; for (const f of list) items.push({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) });
  await addMergeFiles(items);
};
window.onFilesReady = async () => {
  if (!A) return;
  const n = A.getFilesCount(); const items = [];
  for (let i = 0; i < n; i++) {
    const b64 = A.getFileAt(i); const bin = atob(b64); const u = new Uint8Array(bin.length); for (let k = 0; k < bin.length; k++) u[k] = bin.charCodeAt(k);
    items.push({ name: A.getFileNameAt(i), bytes: u });
  }
  A.clearFiles();
  await addMergeFiles(items);
};
async function addMergeFiles(items) {
  for (const it of items) {
    busy(true, `Анализирую «${it.name}»…`);
    try {
      const { song } = await parseFile(it.bytes, it.name, (p, n) => busy(true, `«${it.name}»: страница ${p} из ${n}…`));
      MG.files.push({ name: it.name, fmt: SRC_LABEL(it.bytes), song, method: 'bars', offset: { v: 0, unit: 'bars' }, sel: song.tracks.map(t => ({ on: true, name: t.name, program: t.program || 0 })) });
      if (!$('mTitle').value) $('mTitle').value = song.title;
    } catch (e) { toast(`«${it.name}»: ${e.message || e}`); }
  }
  busy(false); MG.dirty = true; renderMerge();
}
function renderMerge() {
  const box = $('mFiles'); box.innerHTML = '';
  $('mSub').textContent = MG.files.length ? `${MG.files.length} файл(а), ${MG.files.reduce((a, f) => a + f.sel.filter(x => x.on).length, 0)} дорожек выбрано` : 'Выберите два или больше файлов';
  const warnBox = $('mWarn'); warnBox.innerHTML = '';
  if (!MG.files.length) return;
  if (MG.ref >= MG.files.length) MG.ref = 0;
  const an = analyze(MG.files, MG.ref);
  if (MG.files.length < 2) { const d = document.createElement('div'); d.className = 'warn'; d.textContent = 'Добавьте ещё хотя бы один файл.'; warnBox.appendChild(d); }
  for (const w of an.warnings) { const d = document.createElement('div'); d.className = 'warn'; d.textContent = '⚠ ' + w; warnBox.appendChild(d); }
  if (MG.files.length > 1 && !an.warnings.length) { const d = document.createElement('div'); d.className = 'okmsg'; d.textContent = 'Темп, такты и начало партий совпадают — партии объединятся без сдвигов.'; warnBox.appendChild(d); }
  MG.files.forEach((f, i) => {
    const inf = an.info[i];
    const c = document.createElement('div'); c.className = 'fcard' + (i === MG.ref ? ' ref' : '');
    const h = document.createElement('div'); h.className = 'fhead';
    const nm = document.createElement('b'); nm.textContent = f.name;
    const badge = document.createElement('span'); badge.className = 'badge'; badge.textContent = f.fmt;
    const refBtn = document.createElement('button'); refBtn.className = 'chip' + (i === MG.ref ? ' on' : ''); refBtn.textContent = i === MG.ref ? 'Основной' : 'Сделать основным';
    refBtn.onclick = () => { MG.ref = i; MG.dirty = true; renderMerge(); };
    const del = document.createElement('button'); del.className = 'icon'; del.textContent = '✕'; del.setAttribute('aria-label', 'Убрать файл');
    del.onclick = () => { MG.files.splice(i, 1); if (MG.ref >= i && MG.ref > 0) MG.ref--; MG.dirty = true; renderMerge(); };
    h.append(nm, badge, refBtn, del); c.appendChild(h);
    const info = document.createElement('div'); info.className = 'finfo';
    info.textContent = `Темп: ${inf.tempo} · размер ${inf.sig} · ${inf.bars} тактов · ${fmt(inf.dur)} · первая нота: ${inf.first}`;
    c.appendChild(info);
    if (i !== MG.ref) {
      const r1 = document.createElement('div'); r1.className = 'frow';
      if (inf.sameTempo && inf.sameMeter) { const sp = document.createElement('span'); sp.className = 'muted small'; sp.textContent = 'Темп и такты совпадают с основным — ноты переносятся как есть.'; r1.appendChild(sp); }
      else {
        const lab = document.createElement('span'); lab.className = 'muted small'; lab.textContent = 'Синхронизация:';
        const sel = document.createElement('select');
        sel.innerHTML = '<option value="bars">по тактам основного (музыкально)</option><option value="time">по реальному времени (секунды)</option>';
        sel.value = f.method; sel.onchange = () => { f.method = sel.value; MG.dirty = true; renderMerge(); };
        r1.append(lab, sel);
      }
      c.appendChild(r1);
      const r2 = document.createElement('div'); r2.className = 'frow';
      const lab2 = document.createElement('span'); lab2.className = 'muted small'; lab2.textContent = 'Смещение:';
      const inp = document.createElement('input'); inp.type = 'number'; inp.step = 'any'; inp.className = 'sm'; inp.value = f.offset.v;
      inp.onchange = () => { f.offset.v = +inp.value || 0; MG.dirty = true; renderMerge(); };
      const unit = document.createElement('select'); unit.innerHTML = '<option value="bars">тактов</option><option value="ms">мс</option>'; unit.value = f.offset.unit;
      unit.onchange = () => { f.offset.unit = unit.value; MG.dirty = true; renderMerge(); };
      const al = document.createElement('button'); al.className = 'chip'; al.textContent = 'Выровнять начало';
      al.onclick = () => { f.offset = { v: alignOffset(MG.files, i, MG.ref), unit: 'bars' }; MG.dirty = true; renderMerge(); toast('Первая нота поставлена на начало основной партии'); };
      const z = document.createElement('button'); z.className = 'chip'; z.textContent = '0'; z.onclick = () => { f.offset = { v: 0, unit: f.offset.unit }; MG.dirty = true; renderMerge(); };
      r2.append(lab2, inp, unit, al, z); c.appendChild(r2);
    }
    f.song.tracks.forEach((tr, ti) => {
      const sl = f.sel[ti];
      const row = document.createElement('div'); row.className = 'trk';
      const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = sl.on; cb.style.width = cb.style.height = '20px';
      cb.onchange = () => { sl.on = cb.checked; MG.dirty = true; renderMergeSub(); };
      const name = document.createElement('input'); name.type = 'text'; name.value = sl.name;
      name.oninput = () => { sl.name = name.value; MG.dirty = true; };
      const sub = document.createElement('div'); sub.className = 'sub';
      const k = document.createElement('span'); k.className = 'badge'; k.textContent = `${KIND_LABEL[tr.kind]} · ${tr.notes.length} нот`;
      const ps = gmSelect(sl.program, v => { sl.program = v; MG.dirty = true; }, tr.kind === 'drums');
      sub.append(k, ps);
      row.append(cb, name, sub); c.appendChild(row);
    });
    box.appendChild(c);
  });
}
function renderMergeSub() { $('mSub').textContent = `${MG.files.length} файл(а), ${MG.files.reduce((a, f) => a + f.sel.filter(x => x.on).length, 0)} дорожек выбрано`; }
function buildMerged() {
  if (!MG.dirty && MG.merged) return MG.merged;
  if (MG.files.length < 1) throw new Error('Нет файлов');
  const { song, tooMany } = mergeSongs(MG.files, MG.ref, ($('mTitle').value || 'Объединённая композиция').trim());
  if (tooMany) toast('Слишком много разных инструментов (больше 15): некоторые дорожки будут звучать одним тембром');
  MG.merged = song; MG.time = makeTime(song); MG.dirty = false;
  return song;
}
$('mPlay').onclick = async () => {
  if (!engine.sfReady) { toast('Звуки ещё загружаются…'); return; }
  if (engine.playing) { engine.pause(); return; }
  try {
    const wasDirty = MG.dirty || engine.song !== MG.merged;
    const song = buildMerged();
    if (wasDirty) {
      P.song = null;
      engine.prog = {}; engine.channelState = {};
      engine.resume = true; engine.pendingTick = song.measures[Math.max(0, (song.tracks[0] && song.tracks[0].notes[0] ? measIdx(song, firstTick(song)) : 0))].tick;
      engine.load(song, MG.time, null);
      engine.pendingTick = engine.pendingTick || 0;
    } else engine.play();
  } catch (e) { toast(e.message || String(e)); }
};
const firstTick = song => Math.min(...song.tracks.map(t => t.notes.length ? t.notes[0].t : Infinity));
const measIdx = (song, tick) => song.measures.findIndex((m, i) => i === song.measures.length - 1 || song.measures[i + 1].tick > tick);
$('mSeek').onchange = () => { if (MG.merged && engine.song === MG.merged) engine.seekTick(MG.time.toTick($('mSeek').value / 1000 * MG.time.total)); };
$('mBack').onclick = () => { engine.pause(); show('home'); renderRecent(); };
$('mSave').onclick = async () => {
  if (MG.files.length < 2) { toast('Нужно хотя бы два файла'); return; }
  try {
    engine.pause();
    MG.dirty = true;
    const song = buildMerged();
    song.id = Date.now().toString(36); song.added = Date.now();
    await idb.put('songs', song.id, song); await idb.put('meta', song.id, songSummary(song));
    toast('Композиция сохранена'); MG.files = [];
    await openSong(song.id);
    openEditor();
  } catch (e) { toast('Не получилось объединить: ' + (e.message || e)); }
};

// =====================================================================
// Редактор композиции
// =====================================================================
const ED = { solo: null, delArm: -1 };
$('toEditor').onclick = () => { $('trackSheet').classList.remove('on'); openEditor(); };
function openEditor() {
  if (!P.song) return;
  engine.pause(); ED.solo = null; ED.delArm = -1;
  $('eTitle').value = P.song.title; $('eTempo').value = 100;
  show('editor'); renderEditor();
}
async function persist(rebuild) {
  const s = P.song;
  P.time = makeTime(s);
  for (const tr of s.tracks) for (const n of tr.notes) n.bar = barOf(s.measures, n.t);
  await idb.put('songs', s.id, s); await idb.put('meta', s.id, songSummary(s));
  prepare();
  if (rebuild) { engine.time = P.time; engine.rebuildMidi(s); } else engine.setChannels({ mute: P.mute, oct: P.oct, solo: ED.solo });
  renderEditor();
}
function markCustom() { if (P.song.source === 'gp' && !P.song.custom) { P.song.custom = true; toast('Нотный вид для этой композиции станет недоступен: она теперь изменена'); } }
function renderEditor() {
  const s = P.song;
  const bpms = [...new Set(s.tempos.map(t => Math.round(t.bpm)))];
  $('eBpm').textContent = 'сейчас ' + bpms.slice(0, 4).join(', ') + ' уд/мин';
  $('eSub').textContent = `${s.tracks.length} дорожек · ${fmt(P.time.total)}`;
  const box = $('eTracks'); box.innerHTML = '';
  s.tracks.forEach((tr, i) => {
    const c = document.createElement('div'); c.className = 'etr';
    const r1 = document.createElement('div'); r1.className = 'row';
    const dot = document.createElement('span'); dot.className = 'dot'; dot.style.cssText = `width:12px;height:12px;border-radius:3px;background:${TRACK_COLORS[i % TRACK_COLORS.length]}`;
    const name = document.createElement('input'); name.type = 'text'; name.value = tr.name; name.style.flex = '1';
    name.onchange = () => { tr.name = name.value.trim() || tr.name; persist(false); };
    const del = document.createElement('button'); del.className = 'chip danger'; del.textContent = ED.delArm === i ? 'Точно удалить?' : 'Удалить';
    del.onclick = () => { if (ED.delArm !== i) { ED.delArm = i; renderEditor(); return; } deleteTrack(i); };
    r1.append(dot, name, del);
    const info = document.createElement('div'); info.className = 'muted small';
    info.textContent = [KIND_LABEL[tr.kind], tr.from ? 'из «' + tr.from + '»' : '', tr.notes.filter(n => !n.deleted).length + ' нот'].filter(Boolean).join(' · ');
    const r2 = document.createElement('div'); r2.className = 'row';
    const lab = document.createElement('span'); lab.className = 'muted small'; lab.textContent = 'Звучит как';
    const ps = gmSelect(P.prog[i] != null ? P.prog[i] : tr.program, v => { if (v === (tr.program || 0)) delete P.prog[i]; else P.prog[i] = v; saveSet(); engine.setPrograms(P.prog); }, tr.kind === 'drums');
    ps.style.flex = '1'; r2.append(lab, ps);
    const r3 = document.createElement('div'); r3.className = 'row';
    const on = document.createElement('button'); on.className = 'chip' + (P.mute[i] ? '' : ' on'); on.textContent = P.mute[i] ? 'Выключена' : 'Включена';
    on.onclick = () => { P.mute[i] = !P.mute[i]; saveSet(); engine.setChannels({ mute: P.mute, oct: P.oct, solo: ED.solo }); renderEditor(); };
    const solo = document.createElement('button'); solo.className = 'chip' + (ED.solo === i ? ' on' : ''); solo.textContent = ED.solo === i ? 'Слушаю одну ✓' : 'Слушать одну';
    solo.onclick = () => { ED.solo = ED.solo === i ? null : i; engine.setChannels({ mute: P.mute, oct: P.oct, solo: ED.solo }); renderEditor(); if (!engine.playing) $('ePlay').onclick(); };
    const vol = document.createElement('input'); vol.type = 'range'; vol.min = 0; vol.max = 150; vol.value = Math.round((tr.volume ?? 1) * 100);
    const vl = document.createElement('span'); vl.className = 'vol'; vl.textContent = vol.value + '%';
    vol.oninput = () => { tr.volume = vol.value / 100; vl.textContent = vol.value + '%'; engine.setChannels({ mute: P.mute, oct: P.oct, solo: ED.solo }); };
    vol.onchange = () => persist(false);
    r3.append(on, solo, vol, vl);
    const r4 = document.createElement('div'); r4.className = 'row';
    const l4 = document.createElement('span'); l4.className = 'muted small'; l4.textContent = 'Сдвиг:';
    const off = document.createElement('input'); off.type = 'number'; off.step = 'any'; off.className = 'sm'; off.value = 0;
    const unit = document.createElement('select'); unit.innerHTML = '<option value="bars">тактов</option><option value="beats">долей</option><option value="ms">мс</option>';
    const go = document.createElement('button'); go.className = 'chip'; go.textContent = 'Сдвинуть';
    go.onclick = () => shiftTrack(i, +off.value || 0, unit.value);
    const first = tr.notes.find(n => !n.deleted);
    const fp = first ? barPos(s, first.t) : null;
    const where = document.createElement('span'); where.className = 'muted small'; where.textContent = fp ? `начало: такт ${fp.bar}${fp.beat > 1.01 ? ', доля ' + (+fp.beat.toFixed(2)) : ''}` : '';
    r4.append(l4, off, unit, go, where);
    c.append(r1, info, r2, r3, r4); box.appendChild(c);
  });
}
function shiftTrack(i, v, unit) {
  if (!v) return;
  const s = P.song, tr = s.tracks[i];
  const bpm0 = P.time.bpmAt(0);
  let dt = unit === 'ms' ? v / 1000 * bpm0 / 60 * PPQ : unit === 'beats' ? v * PPQ * 4 / s.measures[0].sig[1] : v * s.measures[0].len;
  dt = Math.round(dt);
  const minT = Math.min(...tr.notes.map(n => n.t));
  if (minT + dt < 0) { dt = -minT; toast('Дорожку нельзя сдвинуть раньше начала — сдвинул до самого начала'); }
  for (const n of tr.notes) n.t += dt;
  s.totalTicks = Math.max(s.totalTicks, ...tr.notes.map(n => n.t + n.d));
  extendMeasures(s); markCustom();
  persist(true); toast(`«${tr.name}» сдвинута`);
}
function deleteTrack(i) {
  const s = P.song; if (s.tracks.length <= 1) { toast('Нельзя удалить последнюю дорожку'); ED.delArm = -1; renderEditor(); return; }
  const name = s.tracks[i].name;
  s.tracks.splice(i, 1);
  const shiftMap = obj => { const o = {}; for (const k in obj) { const j = +k; if (j < i) o[j] = obj[k]; else if (j > i) o[j - 1] = obj[k]; } return o; };
  P.mute = shiftMap(P.mute); P.prog = shiftMap(P.prog); engine.prog = P.prog;
  P.show = P.show.filter(x => x !== i).map(x => x > i ? x - 1 : x); if (!P.show.length) P.show = [0];
  if (P.gTrack === i) P.gTrack = s.tracks.findIndex(t => t.tuning); else if (P.gTrack > i) P.gTrack--;
  ED.delArm = -1; ED.solo = null; markCustom(); saveSet();
  persist(true); toast(`Дорожка «${name}» удалена`);
}
$('eTempoSet').onclick = () => {
  const pct = Math.max(25, Math.min(300, +$('eTempo').value || 100));
  if (pct === 100) return;
  for (const t of P.song.tempos) t.bpm = +(t.bpm * pct / 100).toFixed(3);
  $('eTempo').value = 100; markCustom();
  persist(true); toast(`Темп изменён на ${pct}%`);
};
$('eTitle').onchange = () => { P.song.title = $('eTitle').value.trim() || P.song.title; $('pTitle').textContent = P.song.title; persist(false); };
$('ePlay').onclick = () => { if (!engine.sfReady) { toast('Звуки ещё загружаются…'); return; } if (engine.playing) engine.pause(); else engine.play(); };
$('eSoloOff').onclick = () => { ED.solo = null; engine.setChannels({ mute: P.mute, oct: P.oct, solo: null }); renderEditor(); };
$('eSeek').onchange = () => engine.seekTick(P.time.toTick($('eSeek').value / 1000 * P.time.total));
$('eBack').onclick = () => { engine.pause(); ED.solo = null; engine.setChannels({ mute: P.mute, oct: P.oct }); show('player'); setMode(P.mode, true); };
$('eDone').onclick = $('eBack').onclick;
const safeName = s => (s || 'composition').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 80);
$('eMidi').onclick = () => saveFile(safeName(P.song.title) + '.mid', 'audio/midi', toMidiBytes(window.Midi, P.song, P.prog));
$('eXml').onclick = () => saveFile(safeName(P.song.title) + '.musicxml', 'application/vnd.recordare.musicxml+xml', new TextEncoder().encode(toMusicXml(P.song, P.prog)));
function saveFile(name, mime, bytes) {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (A && A.saveFile) {
    let bin = ''; for (let i = 0; i < u.length; i += 0x8000) bin += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
    A.saveFile(name, mime, btoa(bin)); return;
  }
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([u], { type: mime })); a.download = name;
  document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  toast('Файл сохранён: ' + name);
}
window.onSaved = ok => toast(ok ? 'Файл сохранён' : 'Файл не сохранён');

// Позиция на экранах объединения и редактора
setInterval(() => {
  const vis = id => $(id).classList.contains('on');
  if (vis('merge') && MG.time && engine.song === MG.merged) {
    const t = MG.time.toSec(engine.nowTick());
    $('mPos').textContent = fmt(t); $('mDur').textContent = fmt(MG.time.total); $('mSeek').value = Math.round(t / Math.max(0.1, MG.time.total) * 1000);
    $('mPlay').textContent = engine.playing ? '❚❚ Пауза' : '▶ Прослушать';
  }
  if (vis('editor') && P.time) {
    const t = P.time.toSec(engine.nowTick());
    $('ePos').textContent = fmt(t); $('eDur').textContent = fmt(P.time.total); $('eSeek').value = Math.round(t / Math.max(0.1, P.time.total) * 1000);
    $('ePlay').textContent = engine.playing ? '❚❚ Пауза' : '▶ Слушать всё';
  }
}, 200);
