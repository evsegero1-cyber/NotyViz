import * as pdfjsLib from './lib/pdf.min.mjs';
import * as alphaTab from './lib/alphatab/alphaTab.min.mjs';
import { parseSongsterrPdf } from './parser.js';
import { importMidi } from './import-midi.js';
import { importScore } from './import-gp.js';
import { makeTime, fromBeatSong, songSummary, KIND_LABEL, isStringKind, PPQ } from './model.js';
import { Engine } from './engine.js';
import { PianoView, GuitarView, HAND, TRACK_COLORS } from './views.js';
import { PdfView } from './pdfview.js';
import { idb, ls } from './store.js';

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
  if (ev === 'play' || ev === 'pause') { $('playBtn').textContent = engine.playing ? '❚❚' : '▶'; if (A && A.setKeepOn) A.setKeepOn(engine.playing); }
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
async function importFile(bytes, name) {
  busy(true, 'Разбираю файл…');
  try {
    let song, keepRaw = false;
    if (isPdf(bytes)) {
      const old = await parseSongsterrPdf(pdfjsLib, bytes.slice(), (p, n) => busy(true, `Разбираю страницу ${p} из ${n}…`));
      if (!old.notes.length) throw new Error('Ноты не найдены. Сейчас поддерживаются PDF-табулатуры Songsterr.');
      song = fromBeatSong(old); keepRaw = true;
      if (!song.title || song.title === 'Без названия') song.title = (name || 'PDF').replace(/\.pdf$/i, '');
    } else if (isMidi(bytes)) {
      song = importMidi(window.Midi, bytes, name);
    } else {
      song = importScore(alphaTab, bytes, name); keepRaw = true;
    }
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
  names: true, fullKb: false, stave: 'default', speed: 1, loop: null, metro: false, keysNotes: [], fretNotes: [], scoreShown: null, vol: 0.8
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
  P.mute = set.mute || {};
  P.show = set.show || tracks.map((t, i) => i).filter(i => tracks[i].kind !== 'drums' && (tracks[i].kind === 'piano' || tracks.length <= 2 || !tracks.some(x => x.kind === 'piano')));
  if (!P.show.length) P.show = tracks.map((t, i) => i).filter(i => tracks[i].kind !== 'drums').slice(0, 1);
  const fretIdx = tracks.findIndex(t => t.tuning && isStringKind(t.kind));
  P.gTrack = set.gTrack != null ? set.gTrack : (fretIdx >= 0 ? fretIdx : tracks.findIndex(t => t.tuning));
  P.loop = null; P.scoreShown = null;
  const firstStringed = tracks[P.show[0]] && isStringKind(tracks[P.show[0]].kind) && tracks[P.show[0]].tuning;
  P.mode = set.mode || (firstStringed ? 'fret' : 'keys');
  engine.load(song, P.time, song.source === 'gp' ? P.raw : null);
  prepare();
  $('pTitle').textContent = song.title;
  $('pSub').textContent = tracks.length === 1 ? [tracks[0].name, KIND_LABEL[tracks[0].kind]].filter(Boolean).join(' · ') : `${tracks.length} дорожек: ` + [...new Set(tracks.map(t => KIND_LABEL[t.kind]))].join(', ');
  show('player');
  setMode(P.mode, true);
  const first = firstNoteSec();
  engine.seekTick(P.time.toTick(Math.max(0, first - 0.3)));
  updateUi();
  if (!engine.sfReady) toast('Звуки ещё загружаются, подождите пару секунд');
}
function saveSet() {
  if (!P.song) return;
  ls.set('nv-set-' + P.song.id, { oct: P.oct, split: P.split, handMode: P.handMode, mode: P.mode, show: P.show, mute: P.mute, gTrack: P.gTrack });
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
    const off = (b.dataset.mode === 'pdf' && s.source !== 'pdf') || (b.dataset.mode === 'fret' && !P.fretNotes.length) || (b.dataset.mode === 'score' && s.source !== 'gp');
    b.classList.toggle('off', off);
  }
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
$('backBtn').onclick = () => { engine.pause(); show('home'); renderRecent(); };

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
    if (P.mode === 'keys') piano.draw(g, W, H, { ...ctx, notes: P.keysNotes });
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
}
$('playBtn').onclick = () => {
  if (!engine.sfReady || !engine.ready) { toast('Звуки ещё загружаются…'); return; }
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

// Касание: по клавише — звук ноты, по «дороге» — пуск/пауза
cv.addEventListener('pointerdown', e => {
  const r = cv.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
  if (P.mode === 'keys') {
    const m = piano.hit(x, y);
    if (m != null) { engine.previewNote(m, 0); toast(noteName(m)); return; }
  }
  $('playBtn').onclick();
});

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
    row.append(dot, info, showBtn, snd); box.appendChild(row);
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
