import * as pdfjsLib from './lib/pdf.min.mjs';
import * as alphaTab from './lib/alphatab/alphaTab.min.mjs';
import { parseSongsterrPdf, PARSER_VERSION } from './parser.js';
import { recognizePdf } from './omr.js';
import { importMidi } from './import-midi.js';
import { importScore } from './import-gp.js';
import { makeTime, fromBeatSong, songSummary, assignChannels, KIND_LABEL, isStringKind, PPQ, GM_NAMES, GM_GROUPS } from './model.js';
import { perform, TECH, techIds } from './techniques.js';
import { Engine } from './engine.js';
import { TIMBRES, TIMBRE, timbreFor, defaultTimbre, GROUP_LABEL, FX_PRESETS, FX_FOR_GROUP, GM_DRUMS } from './audio.js';
import { PianoView, GuitarView, DrumView, DRUM_NAMES, drumGroup, HAND, TRACK_COLORS } from './views.js';
import { PdfView } from './pdfview.js';
import { idb, ls } from './store.js';
import { analyze, mergeSongs, alignOffset, extendMeasures, barPos, pianoParts, handOctaveCheck } from './merge.js';
import { toMidiBytes, toMusicXml } from './export.js';
import { barOf } from './import-midi.js';
import { describeTuning, tuningLine, tunerPresetFor } from './tunings.js';
import { initTuner } from './tuner.js';
import { initTrain } from './train.js';
import { assignFingering } from './practice.js';
import { chordName, retuneNotes } from './chords.js';
import { initMetronome } from './metronome.js';
import { RoadView } from './road.js';
import { INSTRUMENTS } from './tunings.js';
import { detectSections, sectionAt } from './sections.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('./lib/pdf.worker.min.mjs', import.meta.url).href;

const $ = id => document.getElementById(id);
const A = window.Android;
const NAMES = ['до', 'до♯', 'ре', 'ми♭', 'ми', 'фа', 'фа♯', 'соль', 'ля♭', 'ля', 'си♭', 'си'];
const octName = m => ['субконтр', 'контр', 'большой', 'малой', '1-й', '2-й', '3-й', '4-й', '5-й'][Math.floor(m / 12) - 1] || '';
const noteName = m => NAMES[((m % 12) + 12) % 12] + ' ' + octName(m);
const fmt = s => { s = Math.max(0, Math.round(s || 0)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
function toast(t, ms = 2800) { const e = $('toast'); e.textContent = t; e.classList.add('on'); clearTimeout(toast.h); toast.h = setTimeout(() => e.classList.remove('on'), ms); }
function busy(on, t) { $('busy').classList.toggle('on', on); if (t) $('busyTxt').textContent = t; }

// ---------- Звук ----------
const engine = new Engine(alphaTab, $('at'), ev => {
  if (ev === 'sound' || ev === 'ready') { $('soundState').textContent = ''; busySnd(false); }
  if (ev === 'loading') busySnd(true);
  if (ev === 'play' || ev === 'pause') { $('playBtn').textContent = $('lPlay').textContent = engine.playing ? '❚❚' : '▶'; if (A && A.setKeepOn) A.setKeepOn(engine.playing); }
  if (ev === 'finished' && !P.loop) { engine.seekTick(0); }
  if (ev === 'seek' && train && !engine.internalSeek) train.onSeek();
  if (ev === 'midi') applyEngineSettings();
});
function busySnd(on) { const e = $('posLbl'); if (!e) return; e.classList.toggle('loading', on); if (on) e.textContent = 'Загружаю семплы…'; }

// ---------- Главный экран ----------
// Библиотека: поиск, состояние («учу» / «выучено»), папки. Хранится отдельно от композиций.
const LIB = () => ls.get('nv-lib', { songs: {}, folders: [] });
const saveLib = L => ls.set('nv-lib', L);
let libFilter = 'all';
async function renderRecent() {
  let list = [];
  try { list = (await idb.all('meta')).sort((a, b) => (b.added || 0) - (a.added || 0)); } catch (e) { }
  const L = LIB(), box = $('recent'); box.innerHTML = '';
  // фильтры
  const fb = $('libFilter'); fb.innerHTML = '';
  const chips = [['all', 'Все'], ['learning', 'Учу'], ['learned', 'Выучено ✓'], ...L.folders.map(f => ['f:' + f, '📁 ' + f])];
  if (!chips.some(c => c[0] === libFilter)) libFilter = 'all';
  for (const [v, t] of chips) { const b = document.createElement('button'); b.textContent = t; b.classList.toggle('on', libFilter === v); b.onclick = () => { libFilter = v; renderRecent(); }; fb.appendChild(b); }
  fb.style.display = list.length ? '' : 'none'; $('libSearch').style.display = list.length > 3 ? '' : 'none';
  if (!list.length) { box.innerHTML = '<div class="empty muted">Пока пусто. Импортируйте файл с нотами или табами.</div>'; return; }
  const q = ($('libSearch').value || '').trim().toLowerCase();
  const shown = list.filter(it => {
    const m = L.songs[it.id] || {};
    if (q && !(it.title || '').toLowerCase().includes(q)) return false;
    if (libFilter === 'learning' || libFilter === 'learned') return m.status === libFilter;
    if (libFilter.startsWith('f:')) return m.folder === libFilter.slice(2);
    return true;
  });
  if (!shown.length) { box.innerHTML = '<div class="empty muted">Ничего не найдено.</div>'; return; }
  const SRC = { pdf: 'PDF', midi: 'MIDI', gp: 'Guitar Pro' };
  for (const it of shown) {
    const m = L.songs[it.id] || {};
    const d = document.createElement('div'); d.className = 'card';
    d.innerHTML = `<div class="grow"><div class="t"></div><div class="muted small k"></div><div class="muted small i"></div></div><button class="icon" aria-label="Меню">⋯</button>`;
    const tt = d.querySelector('.t'); tt.textContent = it.title;
    if (m.status) { const b = document.createElement('span'); b.className = 'st ' + m.status; b.textContent = m.status === 'learned' ? 'выучено' : 'учу'; tt.appendChild(b); }
    d.querySelector('.k').textContent = [SRC[it.source] || it.source, fmt(it.dur), `${it.notes} нот`, m.folder ? '📁 ' + m.folder : ''].filter(Boolean).join(' · ');
    d.querySelector('.i').textContent = (it.kinds || []).join(', ');
    d.onclick = e => { if (e.target.tagName === 'BUTTON') return; openSong(it.id); };
    d.querySelector('button').onclick = () => songMenu(it);
    box.appendChild(d);
  }
}
$('libSearch').oninput = () => renderRecent();
function songMenu(it) {
  const L = LIB(); const m = L.songs[it.id] = L.songs[it.id] || {};
  $('ssTitle').textContent = it.title;
  for (const b of $('ssStatus').children) { b.classList.toggle('on', (m.status || '') === b.dataset.v); b.onclick = () => { m.status = b.dataset.v || undefined; saveLib(L); songMenu(it); renderRecent(); }; }
  const sel = $('ssFolder'); sel.innerHTML = '';
  for (const [v, t] of [['', 'Без папки'], ...L.folders.map(f => [f, f])]) { const o = document.createElement('option'); o.value = v; o.textContent = t; sel.appendChild(o); }
  sel.value = m.folder || '';
  sel.onchange = () => { m.folder = sel.value || undefined; saveLib(L); renderRecent(); };
  $('ssAdd').onclick = () => { const n = $('ssNew').value.trim(); if (!n) return; if (!L.folders.includes(n)) L.folders.push(n); m.folder = n; $('ssNew').value = ''; saveLib(L); songMenu(it); renderRecent(); };
  $('ssDel').onclick = async () => {
    if ($('ssDel').dataset.sure !== it.id) { $('ssDel').dataset.sure = it.id; $('ssDel').textContent = 'Точно удалить? Нажмите ещё раз'; return; }
    $('ssDel').dataset.sure = ''; $('ssDel').textContent = 'Удалить композицию';
    await idb.del('meta', it.id); await idb.del('songs', it.id); await idb.del('files', it.id); ls.del('nv-set-' + it.id);
    delete L.songs[it.id]; saveLib(L); $('songSheet').classList.remove('on'); renderRecent();
  };
  $('ssDel').dataset.sure = ''; $('ssDel').textContent = 'Удалить композицию';
  $('songSheet').classList.add('on');
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
    // 1) табулатура Songsterr (точное чтение цифр и ритма); 2) обычная нотная запись — распознавание нот
    let old = null;
    try { old = await parseSongsterrPdf(pdfjsLib, bytes.slice(), progress); } catch (e) { old = null; }
    // ударные из PDF читаются только в нотации Songsterr (иначе головки обычных нот приняли бы за удары)
    let isSongsterr = false;
    try { const d = await pdfjsLib.getDocument({ data: bytes.slice(), isEvalSupported: false }).promise; const tc = await (await d.getPage(1)).getTextContent(); isSongsterr = /songsterr/i.test(tc.items.map(i => i.str).join(' ')); } catch (e) { }
    if (old && old.notes.length && (!old.isDrum || isSongsterr)) {
      song = fromBeatSong(old); keepRaw = true;
    } else {
      const r = await recognizePdf(pdfjsLib, bytes.slice(), t => busy(true, t));
      if (!r.song || !r.song.tracks.length) throw new Error((r.report.problems[0] || 'Ноты не найдены.') + ' Поддерживаются PDF с нотами (из нотных редакторов и сервисов) и табулатуры Songsterr.');
      song = r.song; song.omrReport = r.report; keepRaw = true;
      assignChannels(song.tracks);
    }
    if (!song.title || song.title === 'Без названия' || song.title === 'Ноты из PDF') song.title = (name || 'PDF').replace(/\.pdf$/i, '');
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
    await openSong(song.id);
    if (song.omrReport) showOmrReport();
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
  names: true, fullKb: false, hints: true, stave: 'default', land: false, landDismissed: false, pressed: new Set(), prog: {}, speed: 1, loop: null, metro: false, keysNotes: [], fretNotes: [], scoreShown: null, vol: 0.8
};
const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5];
let train = null;
const piano = new PianoView(), guitar = new GuitarView(), drumsView = new DrumView(), road = new RoadView();
const pdfView = new PdfView($('pdfWrap'), pdfjsLib, (i, ti) => openEdit(i, ti));

async function openSong(id) {
  const song = await idb.get('songs', id);
  if (!song) { toast('Композиция не найдена'); renderRecent(); return; }
  if (engine.playing) engine.pause();
  P.song = song; P.time = makeTime(song); P.raw = null;
  if (song.source !== 'midi') P.raw = await idb.get('files', id);
  // объединённая композиция из PDF, собранная старым разбором: исправления разбора в неё не попадают
  if (song.source === 'merge' && (song.pv || 1) < PARSER_VERSION && (song.files || []).some(f => /\.pdf$/i.test(f)))
    setTimeout(() => toast('Эта композиция собрана старой версией разбора PDF: ритм и бенды в ней могут быть неточными. Удалите её и объедините файлы заново.', 9000), 600);
  // PDF Songsterr, разобранный старой версией: разбираем заново (если ноты не правили вручную)
  if (song.source === 'pdf' && !song.omr && !song.omrReport && song.tracks.length === 1 && (song.pv || 1) < PARSER_VERSION && P.raw) {
    const edited = song.tracks.some(t => t.notes.some(n => n.edited || n.deleted));
    if (!edited) {
      try {
        busy(true, 'Обновляю разбор файла…');
        const fresh = fromBeatSong(await parseSongsterrPdf(pdfjsLib, P.raw.slice()));
        if (fresh.tracks[0].notes.length) {
          const tr = fresh.tracks[0], o = song.tracks[0];
          for (const k of ['name', 'program', 'hand', 'channel']) if (o[k] != null) tr[k] = o[k];
          Object.assign(song, { pv: fresh.pv, tempos: fresh.tempos, measures: fresh.measures, totalTicks: fresh.totalTicks, tracks: fresh.tracks }); if (fresh.lyrics) song.lyrics = fresh.lyrics; else delete song.lyrics;
          await idb.put('songs', song.id, song); await idb.put('meta', song.id, songSummary(song));
          toast('Файл разобран заново новой версией разбора');
        }
      } catch (e) { console.warn(e); }
      busy(false);
    }
  }
  const set = ls.get('nv-set-' + id, {});
  const tracks = song.tracks;
  P.oct = set.oct || 0; P.split = set.split || 60; P.handMode = set.handMode || 'auto';
  P.mute = set.mute || {}; P.prog = set.prog || {}; P.sound = set.sound || {}; P.retune = set.retune || {};
  P.show = set.show || tracks.map((t, i) => i).filter(i => tracks[i].kind !== 'drums' && (tracks[i].kind === 'piano' || tracks.length <= 2 || !tracks.some(x => x.kind === 'piano')));
  if (!P.show.length) P.show = tracks.map((t, i) => i).filter(i => tracks[i].kind !== 'drums').slice(0, 1);
  const fretIdx = tracks.findIndex(t => t.tuning && isStringKind(t.kind));
  P.gTrack = set.gTrack != null ? set.gTrack : (fretIdx >= 0 ? fretIdx : tracks.findIndex(t => t.tuning));
  P.loop = null; P.scoreShown = null;
  const firstStringed = tracks[P.show[0]] && isStringKind(tracks[P.show[0]].kind) && tracks[P.show[0]].tuning;
  P.dTrack = set.dTrack != null ? set.dTrack : tracks.findIndex(t => t.kind === 'drums');
  const onlyDrums = tracks.every(t => t.kind === 'drums');
  P.mode = set.mode || (onlyDrums ? 'drums' : firstStringed ? 'fret' : 'keys');
  engine.prog = P.prog; engine.sound = P.sound; engine.channelState = { mute: P.mute, oct: P.oct };
  engine.load(song, P.time, song.source === 'gp' ? P.raw : null);
  prepare();
  P.secEdit = set.secEdit || {};
  computeSections();
  buildLyr();
  $('pTitle').textContent = song.title;
  updateSub();
  show('player');
  if (P.land) exitLand(true);
  P.landDismissed = false;
  setMode(P.mode, true);
  if (train) train.onSong();
  setTimeout(onOrient, 50);
  const first = firstNoteSec();
  engine.seekTick(P.time.toTick(Math.max(0, first - 0.3)));
  updateUi();
  if (!engine.sfReady) toast('Звуки ещё загружаются, подождите пару секунд');
}
function saveSet() {
  if (!P.song) return;
  ls.set('nv-set-' + P.song.id, { oct: P.oct, split: P.split, handMode: P.handMode, mode: P.mode, show: P.show, mute: P.mute, gTrack: P.gTrack, dTrack: P.dTrack, prog: P.prog, sound: P.sound, retune: P.retune, secEdit: P.secEdit });
}
function firstNoteSec() {
  let m = 1e9; for (const i of (P.show.length ? P.show : P.song.tracks.map((t, k) => k))) { const n = P.song.tracks[i] && P.song.tracks[i].notes.find(n => !n.deleted); if (n) m = Math.min(m, P.time.toSec(n.t)); }
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
  P.pedal = [];
  for (const ti of P.show) {
    const tr = tracks[ti]; if (!tr || tr.kind === 'drums') continue;
    const tc = TRACK_COLORS[ti % TRACK_COLORS.length];
    const trCol = [tc, shadeHex(tc, -0.3), shadeHex(tc, 0.5)];
    // звучащие события с учётом техник (трели, арпеджио, глиссандо, стаккато…) — как в звуке
    const perf = perform(tr, PPQ, P.oct);
    const seen = new Set();
    for (const e of perf.events) {
      const n = tr.notes[e.src];
      const m = e.m; if (m < 21 || m > 108) continue;
      let col;
      if (onlyPiano) {
        let h;
        if (P.handMode === 'right') h = 'R';
        else if (P.handMode === 'auto' && (n.h || tr.hand)) h = n.h || tr.hand;
        else h = m < P.split ? 'L' : 'R';
        col = HAND[h];
      } else col = trCol;
      const first = !seen.has(e.src); seen.add(e.src);
      const h = P.handMode === 'right' ? 'R' : (P.handMode === 'auto' && (n.h || tr.hand)) ? (n.h || tr.hand) : (m < P.split ? 'L' : 'R');
      out.push({ s: time.toSec(e.t), e: time.toSec(e.t + e.d), m, col, ti, v: e.v, x: n.x, f: n.f, first, src: e.src, tk: ti, h });
    }
    if (tr.pedal) for (const [a, b] of tr.pedal) P.pedal.push([time.toSec(a), time.toSec(b)]);
  }
  out.sort((a, b) => a.s - b.s || a.m - b.m);
  // крещендо/диминуэндо и триоли — подпись только в начале группы
  const st = new Map();
  for (const q of out) {
    if (!q.first) continue;
    const g = st.get(q.tk) || { cr: null, tup: null, cnt: 0 }; st.set(q.tk, g);
    const cr = q.x && q.x.cresc || null;
    q.crescStart = !!cr && cr !== g.cr; g.cr = cr;
    const tp = q.x && q.x.tup || null;
    if (tp) { if (tp !== g.tup) g.cnt = 0; q.tupStart = g.cnt % (+tp.split(':')[0] || 3) === 0; g.cnt++; } else g.cnt = 0;
    g.tup = tp;
    const ot = q.x && q.x.ott || null; q.ottStart = !!ot && ot !== g.ot; g.ot = ot;
  }
  // легато: ссылка на следующую ноту той же дорожки
  const lastBy = new Map();
  for (let k = out.length - 1; k >= 0; k--) { const q = out[k]; if (q.x && q.x.leg) { const nx = lastBy.get(q.tk); if (nx != null) q.nextIdx = nx; } if (q.first) lastBy.set(q.tk, k); }
  if (P.train && P.train.fing) assignFingering(out);
  P.keysNotes = out;
  // ноты для подсветки на оригинале PDF (все дорожки)
  P.pdfNotes = [];
  tracks.forEach((tr, ti) => tr.notes.forEach((n, i) => { if (!n.deleted && n.box) P.pdfNotes.push({ s: time.toSec(n.t), e: time.toSec(n.t + n.d), key: ti + ':' + i }); }));
  P.pdfNotes.sort((a, b) => a.s - b.s);
  piano.setRange(out, P.fullKb);
  P.drumNotes = [];
  const dt = tracks[P.dTrack];
  if (dt && dt.kind === 'drums') {
    dt.notes.forEach((n, idx) => { if (!n.deleted) P.drumNotes.push({ s: time.toSec(n.t), e: time.toSec(n.t + n.d), m: n.m, v: n.v, x: n.x, idx }); });
    P.drumNotes.sort((a, b) => a.s - b.s);
    drumsView.setNotes(P.drumNotes);
  }
  const gt = tracks[P.gTrack];
  P.fretNotes = [];
  P.fretTuning = gt && gt.tuning;
  if (gt && gt.tuning) {
    // показ в другом строе: высота та же, струны и лады пересчитаны
    const rt = P.retune && P.retune[P.gTrack];
    const newTun = rt ? retuneTarget(gt, rt) : null;
    const map = newTun ? retuneNotes(gt.notes.map(n => ({ t: n.t, s: n.s, f: n.f, m: n.m })), newTun) : null;
    if (newTun) P.fretTuning = newTun;
    gt.notes.forEach((n, idx) => {
      if (n.deleted || n.tie || n.s == null || n.f == null) return;
      const r = map && map[idx];
      if (r && r.dup) return;
      P.fretNotes.push({ s: time.toSec(n.t), e: time.toSec(n.t + n.d), m: r ? r.m : n.m, f: r ? r.f : n.f, st: r ? r.s : n.s, idx, x: n.x, octUp: r && r.octUp });
    });
    P.fretNotes.sort((a, b) => a.s - b.s || a.st - b.st);
    const nextOn = new Map();
    for (let k = P.fretNotes.length - 1; k >= 0; k--) { const q = P.fretNotes[k]; if (nextOn.has(q.st)) q.next = nextOn.get(q.st); nextOn.set(q.st, k); }
    P.gBends = perform(gt, PPQ).bends;
    guitar.setTrack(newTun ? Object.assign({}, gt, { tuning: newTun }) : gt, P.fretNotes);
    road.setTrack(newTun ? Object.assign({}, gt, { tuning: newTun }) : gt, P.fretNotes, tuningLabels(gt));
    // аккорды: группы одновременных нот → название и схема
    P.fretChords = [];
    let grp = null;
    const flush = () => { if (!grp) return; const nm = chordName(grp.ns.map(q => q.m)); if (nm) { const fr = Array(P.fretTuning.length).fill(null); for (const q of grp.ns) fr[q.st] = q.f; P.fretChords.push({ s: grp.s, e: grp.e, name: nm, frets: fr }); } };
    for (const q of P.fretNotes) { if (grp && q.s - grp.s < 0.04) { grp.ns.push(q); grp.e = Math.max(grp.e, q.e); } else { flush(); grp = { s: q.s, e: q.e, ns: [q] }; } }
    flush();
  }
}
function retuneTarget(tr, id) {
  for (const ins of INSTRUMENTS) for (const t of ins.tunings) if (t.id === id && t.midi.length === tr.tuning.length) return [...t.midi].reverse();
  return null;
}
function currentChord(t) {
  const L = P.fretChords || []; let lo = 0, hi = L.length; while (lo < hi) { const m = (lo + hi) >> 1; if (L[m].s <= t + 0.02) lo = m + 1; else hi = m; }
  const c = L[lo - 1]; return c && t < Math.max(c.e, c.s + 0.6) + 0.15 ? c : null;
}
function shadeHex(hex, k) { const n = parseInt(hex.slice(1), 16); const f = v => Math.max(0, Math.min(255, Math.round(k > 0 ? v + (255 - v) * k : v * (1 + k)))); return `rgb(${f(n >> 16)},${f((n >> 8) & 255)},${f(n & 255)})`; }
function firstIdx(arr, s) { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m].s < s) lo = m + 1; else hi = m; } return lo; }

// Подзаголовок: на грифе — дорожка и её строй, иначе состав композиции
function updateSub() {
  const tracks = P.song.tracks, gt = tracks[P.gTrack];
  let txt = tracks.length === 1 ? [tracks[0].name, KIND_LABEL[tracks[0].kind]].filter(Boolean).join(' · ') : `${tracks.length} дорожек: ` + [...new Set(tracks.map(t => KIND_LABEL[t.kind]))].join(', ');
  if ((P.mode === 'fret' || P.mode === 'road') && gt && gt.tuning) txt = `Строй ${tuningLine(P.fretTuning || gt.tuning, gt.kind)}${P.retune && P.retune[P.gTrack] ? ' (перестроено)' : ''} · ${gt.name}`;
  else if (tracks.length === 1 && gt && gt.tuning) txt += ' · ' + describeTuning(gt.tuning, gt.kind).name;
  $('pSub').textContent = txt;
}

// ---------- Режимы ----------
function setMode(mode, silent) {
  const s = P.song;
  if ((mode === 'fret' || mode === 'road') && !(s.tracks[P.gTrack] && s.tracks[P.gTrack].tuning && P.fretNotes.length)) {
    if (!silent) toast('Нет дорожки со струнами (гитара или бас)'); mode = 'keys';
  }
  if (mode === 'drums' && !P.drumNotes.length) { if (!silent) toast('В композиции нет ударных'); mode = 'keys'; }
  if (mode === 'keys' && !P.keysNotes.length && P.drumNotes.length) mode = 'drums';
  if (mode === 'pdf' && s.source !== 'pdf') { if (!silent) toast('«Оригинал» есть только у PDF'); mode = P.mode === 'pdf' ? 'keys' : P.mode; }
  P.mode = mode; saveSet();
  for (const b of $('modes').children) {
    b.classList.toggle('on', b.dataset.mode === mode);
    const off = (b.dataset.mode === 'drums' && !P.drumNotes.length) || (b.dataset.mode === 'keys' && !P.keysNotes.length) || (b.dataset.mode === 'pdf' && s.source !== 'pdf') || ((b.dataset.mode === 'fret' || b.dataset.mode === 'road') && !P.fretNotes.length) || (b.dataset.mode === 'score' && (s.source !== 'gp' || s.custom));
    b.classList.toggle('off', off);
  }
  const canvasMode = mode === 'keys' || mode === 'fret' || mode === 'drums' || mode === 'road';
  $('landBtn').style.display = canvasMode ? '' : 'none';
  if (!canvasMode && P.land) exitLand(true);
  updateSub(); updLandMode();
  const split = mode === 'pdf' && !!s.omr;
  $('player').classList.toggle('split', split);
  $('cv').style.display = (canvasMode || split) ? 'block' : 'none';
  for (const b of $('modes').children) if (b.dataset.mode === 'drums') b.style.display = P.drumNotes.length ? '' : 'none';
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
$('backBtn').onclick = () => { engine.pause(); if (train) train.onLeave(); if (P.land) exitLand(true); show('home'); renderRecent(); };

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
  if (P.mode === 'keys' || P.mode === 'fret' || P.mode === 'drums' || P.mode === 'road') {
    if (!W) resize();
    g.setTransform(DPR, 0, 0, DPR, 0, 0);
    P.hot = [];
    const ctx = { t, tick, hot: P.hints ? P.hot : null, speed: P.speed, names: P.names, mStarts: P.time.mStarts, measures: P.song.measures, measureIdx: mi, firstIdx, loop: P.loop ? { a: P.time.toSec(P.loop.ta), b: P.time.toSec(P.loop.tb) } : null, sections: P.sections };
    if (P.mode === 'keys') piano.draw(g, W, H, { ...ctx, notes: P.keysNotes, land: P.land, pressed: P.pressed, pedal: P.pedal, fingers: P.train && P.train.fing, want: train && train.waiting ? train.waiting.need : null, mineOnly: P.train && P.train.who !== 'none' && P.train.who !== 'fret' ? P.train.who : null });
    else if (P.mode === 'road') road.draw(g, W, H, { ...ctx, notes: P.fretNotes, land: P.land, chordFor: s0 => { const c = (P.fretChords || []).find(c => Math.abs(c.s - s0) < 0.05); return c ? c.name : null; } });
    else if (P.mode === 'drums') drumsView.draw(g, W, H, { ...ctx, notes: P.drumNotes, pressed: P.pressedPads, land: P.land });
    else { const tr = P.song.tracks[P.gTrack]; guitar.draw(g, W, H, { ...ctx, notes: P.fretNotes, tuningNames: tuningLabels(tr), tuningTitle: tr && tr.tuning ? describeTuning(P.fretTuning || tr.tuning, tr.kind).name + (P.retune && P.retune[P.gTrack] ? ' (перестроено)' : '') : '', bends: P.gBends, land: P.land, chord: currentChord(t), want: train && train.waiting ? train.waiting.need : null }); }
  } else if (P.mode === 'score') {
    engine.syncScore();
  } else if (P.mode === 'pdf') {
    const act = new Set();
    const L = P.pdfNotes || [];
    for (let i = firstIdx(L, t - 20); i < L.length; i++) { const n = L[i]; if (n.s > t) break; if (n.e > t || t - n.s < 0.15) act.add(n.key); }
    pdfView.follow = engine.playing; pdfView.highlight(act);
    if (P.song.omr && P.keysNotes.length) { if (!W) resize(); g.setTransform(DPR, 0, 0, DPR, 0, 0); P.hot = []; piano.draw(g, W, H, { t, tick, hot: null, speed: P.speed, names: P.names, mStarts: P.time.mStarts, measures: P.song.measures, measureIdx: mi, firstIdx, loop: null, notes: P.keysNotes, land: false, pressed: P.pressed, pedal: P.pedal }); }
  }
  if (train) train.frame(t);
  updLyr(t);
  const now = performance.now();
  if (now - lastUi > 150) {
    lastUi = now;
    if (!engine.loading) $('posLbl').textContent = 'Такт ' + P.song.measures[mi].n;
    $('timeLbl').textContent = fmt(t);
    if (!seeking) $('seek').value = Math.round(t / Math.max(0.1, P.time.total) * 1000);
    updSecUi(mi, t);
    if (P.land) { const sc = sectionAt(P.sections, mi); $('lPos').textContent = (sc ? sc.name + ' · ' : '') + 'Такт ' + P.song.measures[mi].n; $('landProg').firstChild.style.width = (t / Math.max(0.1, P.time.total) * 100) + '%'; }
  }
}
requestAnimationFrame(frame);
function tuningLabels(tr) {
  if (!tr || !tr.tuning) return null;
  if (P.retune && P.retune[P.gTrack] && tr === P.song.tracks[P.gTrack] && P.fretTuning) { const L = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']; return P.fretTuning.map((m, i) => { const s = L[m % 12]; return i === 0 ? s.toLowerCase() : s; }); }
  if (tr.tuningNames && tr.tuningNames.length === tr.tuning.length) return tr.tuningNames;
  const L = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  return tr.tuning.map((m, i) => { const s = L[m % 12]; return i === 0 ? s.toLowerCase() : s; });
}


// ---------- Слова песни ----------
// строки: новая строка, если пауза между словами больше ~1,6 с или в строке уже много слов
function buildLyr() {
  const L = P.song.lyrics || [];
  const words = L.map(w => ({ s: w.s, t: P.time.toSec(w.t) })).sort((a, b) => a.t - b.t);
  const lines = []; let cur = null;
  words.forEach((w, i) => {
    const prev = words[i - 1];
    const brk = !cur || (w.t - prev.t > 1.6 && !prev.s.endsWith('-')) || (cur.n >= 9 && !prev.s.endsWith('-'));
    if (brk) { cur = { a: i, n: 0 }; lines.push(cur); }
    cur.b = i; cur.n++; w.line = lines.length - 1;
  });
  P.lyr = { words, lines, cur: -2, line: -2 };
  const has = words.length > 0;
  for (const id of ['lyrP', 'lyrL']) { const e = $(id); e.innerHTML = ''; e.classList.toggle('none', !has); e.classList.toggle('off', !lyrOn()); }
}
const lyrOn = () => ls.get('nv-lyr', true) !== false;
function lyrHtml(li, wi) {
  const { words, lines } = P.lyr, ln = lines[li]; if (!ln) return '';
  let h = '';
  for (let i = ln.a; i <= ln.b; i++) {
    const w = words[i], txt = w.s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
    h += `<span class="${i < wi ? 'sung' : i === wi ? 'now' : ''}">${txt}</span>${w.s.endsWith('-') ? '' : ' '}`;
  }
  return h;
}
function updLyr(t) {
  const Ly = P.lyr; if (!Ly || !Ly.words.length) return;
  const W = Ly.words;
  let wi = -1; { let lo = 0, hi = W.length - 1; while (lo <= hi) { const m = (lo + hi) >> 1; if (W[m].t <= t + 0.05) { wi = m; lo = m + 1; } else hi = m - 1; } }
  // показываем строку текущего слова; если до следующей строки меньше 1,2 с — уже её
  let li = wi >= 0 ? W[wi].line : 0;
  const nx = Ly.lines[li + 1]; if (nx && W[nx.a].t - t < 1.2 && (wi < 0 || wi === Ly.lines[li].b)) li = li + 1;
  if (wi < 0 && W[0].t - t > 4) li = -1;
  if (wi === Ly.cur && li === Ly.line) return;
  Ly.cur = wi; Ly.line = li;
  const main = li >= 0 ? lyrHtml(li, wi) : '', next = li + 1 < Ly.lines.length ? lyrHtml(li + 1, -1) : '';
  const html = `<div class="l1">${main || '&nbsp;'}</div><div class="l2">${next || '&nbsp;'}</div>`;
  $('lyrP').innerHTML = html; $('lyrL').innerHTML = html;
}
for (const id of ['lyrP', 'lyrL']) $(id).onclick = () => { ls.set('nv-lyr', !lyrOn()); for (const k of ['lyrP', 'lyrL']) $(k).classList.toggle('off', !lyrOn()); };

// ---------- Части песни ----------
function computeSections() {
  let markers = null;
  try {
    const sc = engine.score;
    if (sc && sc.masterBars && P.song.source === 'gp' && !P.song.custom) {
      markers = [];
      P.song.measures.forEach((m, i) => { const mb = sc.masterBars[m.n - 1]; if (mb && mb.section && (mb.section.text || mb.section.marker)) markers.push({ idx: i, text: mb.section.text || mb.section.marker }); });
    }
  } catch (e) { markers = null; }
  if (!markers || !markers.length) { const mk = []; P.song.measures.forEach((m, i) => { if (m.marker) mk.push({ idx: i, text: m.marker }); }); if (mk.length) markers = mk; }
  let secs = [];
  try { secs = detectSections(P.song, markers); } catch (e) { console.warn(e); }
  for (const sc of secs) { const nm = P.secEdit && P.secEdit[sc.a]; if (nm) sc.name = nm; }
  P.sections = secs;
  renderSecBar();
}
function secDur(sc) { const ms = P.song.measures, t0 = P.time.mStarts[sc.a], last = ms[sc.b]; return P.time.toSec(last.tick + last.len) - t0; }
function renderSecBar() {
  const bar = $('secBar'), lp = $('landSecs'); bar.innerHTML = ''; lp.innerHTML = '';
  const secs = P.sections || []; bar.style.display = secs.length > 1 ? '' : 'none';
  const tot = Math.max(0.1, P.time.total);
  for (const sc of secs) {
    const d = secDur(sc), b = document.createElement('button');
    b.className = 'sec'; b.style.flexGrow = Math.max(0.01, d); b.style.setProperty('--c', sc.col);
    b.textContent = sc.name; b.title = sc.name;
    let pt = null, long = false;
    b.onpointerdown = () => { long = false; pt = setTimeout(() => { long = true; secMenu(sc); }, 500); };
    b.onpointerup = b.onpointerleave = b.onpointercancel = () => clearTimeout(pt);
    b.onclick = () => { if (long) return; gotoMeasure(sc.a); toast(sc.name + ' · такт ' + P.song.measures[sc.a].n); };
    b.oncontextmenu = e => e.preventDefault();
    sc.el = b; bar.appendChild(b);
    const l = document.createElement('div'); l.className = 'lsec'; l.style.left = (P.time.mStarts[sc.a] / tot * 100) + '%'; l.style.width = (d / tot * 100) + '%'; l.style.background = sc.col; lp.appendChild(l);
  }
  P.secCur = null;
}
function updSecUi(mi, t) {
  const sc = sectionAt(P.sections, mi);
  if (sc !== P.secCur) { if (P.secCur && P.secCur.el) P.secCur.el.classList.remove('on'); if (sc && sc.el) { sc.el.classList.add('on'); sc.el.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } P.secCur = sc; }
  const tag = $('secTag');
  if (!sc || (P.sections || []).length < 2) { tag.style.display = 'none'; return; }
  const i = P.sections.indexOf(sc), nx = P.sections[i + 1];
  const left = nx ? P.time.mStarts[nx.a] - t : 1e9;
  const beat = 60 / (P.time.bpmAt(engine.nowTick()) || 120);
  let html = `<i style="background:${sc.col}"></i>${sc.name}`;
  if (nx && left < beat * 4.5 && left > 0) html += ` <span>→ <i style="background:${nx.col}"></i>${nx.name} через ${Math.max(1, Math.ceil(left / beat - 0.05))}</span>`;
  if (tag._h !== html) { tag.innerHTML = html; tag._h = html; }
  tag.style.display = 'block';
}
function secMenu(sc) {
  const box = $('secBody'); box.innerHTML = '';
  $('secTitle').textContent = sc.name + ` · такты ${P.song.measures[sc.a].n}–${P.song.measures[sc.b].n}`;
  const add = (txt, fn) => { const b = document.createElement('button'); b.className = 'wide'; b.textContent = txt; b.onclick = () => { $('secSheet').classList.remove('on'); fn(); }; box.appendChild(b); };
  add('▶ Играть с начала части', () => { gotoMeasure(sc.a); if (!engine.playing && engine.sfReady) engine.play(); });
  add('⟲ Повторять эту часть', () => setLoop(P.song.measures[sc.a].n, P.song.measures[sc.b].n, sc.a));
  add('🔁 Учить в риф-репитере', () => { if (train) train.riffSection(sc); });
  const row = document.createElement('div'); row.className = 'row gap secren';
  const inp = document.createElement('input'); inp.value = sc.name; inp.placeholder = 'Название части';
  const ok = document.createElement('button'); ok.className = 'chip'; ok.textContent = '✎ Переименовать';
  ok.onclick = () => { const nm = inp.value.trim(); if (!nm) return; P.secEdit[sc.a] = nm; saveSet(); computeSections(); $('secSheet').classList.remove('on'); };
  row.append(inp, ok); box.appendChild(row);
  if (Object.keys(P.secEdit || {}).length) add('↺ Вернуть названия по умолчанию', () => { P.secEdit = {}; saveSet(); computeSections(); });
  $('secSheet').classList.add('on');
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
  if (P.loop) { P.loop = null; engine.setLoop(null); if (train) train.riffOff(); updateUi(); toast('Повтор выключен'); return; }
  const mi = P.time.measureAtSec(P.time.toSec(engine.nowTick()) + 0.01);
  setLoop(P.song.measures[mi].n, P.song.measures[Math.min(mi + 3, P.song.measures.length - 1)].n);
};
function setLoop(fromN, toN, aIdx) {
  const ms = P.song.measures;
  const a = aIdx != null && ms[aIdx] && ms[aIdx].n === fromN ? aIdx : ms.findIndex(m => m.n === fromN), b = ms.findIndex((m, i) => i >= a && m.n === toN);
  if (a < 0 || b < 0) { toast('Проверьте номера тактов'); return; }
  P.loop = { ta: ms[a].tick, tb: ms[b].tick + ms[b].len, from: fromN, to: toN, ai: a, bi: b };
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
  if (P.hints && P.hot && P.hot.length) {
    let best = null, bd = 1e9;
    for (const h of P.hot) { const dx = Math.max(h.x - x, 0, x - (h.x + h.w)), dy = Math.max(h.y - y, 0, y - (h.y + h.h)); const d = Math.hypot(dx, dy); if (d < bd) { bd = d; best = h; } }
    if (best && bd < 14) { showTech(best.ids); return; }
  }
  if (P.mode === 'drums') {
    const m = drumsView.hit(x, y);
    if (m != null) {
      const gid = drumGroup(m).id; P.pressedPads = P.pressedPads || new Set(); P.pressedPads.add(gid);
      setTimeout(() => P.pressedPads.delete(gid), 140);
      engine.previewNote(m, 0, true); return;
    }
  }
  if (P.mode === 'keys') {
    const m = piano.hit(x, y);
    if (m != null) {
      try { cv.setPointerCapture(e.pointerId); } catch (er) { }
      touchKey.set(e.pointerId, m); P.pressed.add(m);
      engine.previewNote(m, 0, false, curTimbre(P.show[0] || 0));
      if (train) train.input(m, 'key');
      if (!P.land && !(train && train.waiting) && !(P.train && (P.train.check || P.train.wait))) toast(noteName(m));
      return;
    }
  }
  $('playBtn').onclick();
});
const release = e => { const m = touchKey.get(e.pointerId); if (m == null) return; touchKey.delete(e.pointerId); if (![...touchKey.values()].includes(m)) P.pressed.delete(m); };
cv.addEventListener('pointerup', release); cv.addEventListener('pointercancel', release);

// ---------- Альбомный полноэкранный режим ----------
const CANVAS_MODES = ['keys', 'fret', 'road', 'drums'];
function availModes() { return CANVAS_MODES.filter(m => m === 'keys' ? P.keysNotes.length : (m === 'fret' || m === 'road') ? P.fretNotes.length : P.drumNotes.length); }
function updLandMode() {
  const b = $('lMode'); if (!b) return;
  const av = availModes(); b.style.display = av.length > 1 ? '' : 'none';
  const nx = av[(av.indexOf(P.mode) + 1) % av.length];
  b.textContent = nx === 'keys' ? '🎹' : nx === 'fret' ? '🎸' : nx === 'road' ? '🛣' : '🥁';
  b.setAttribute('aria-label', nx === 'keys' ? 'Клавиши' : nx === 'fret' ? 'Гриф' : nx === 'road' ? 'Дорога' : 'Барабаны');
}
function enterLand(rotate) {
  if (!CANVAS_MODES.includes(P.mode)) setMode(availModes()[0] || 'keys');
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

$('lSet').onclick = () => $('setBtn').onclick();
$('lMode').onclick = () => { const av = availModes(); const nx = av[(av.indexOf(P.mode) + 1) % av.length]; if (nx && nx !== P.mode) { setMode(nx); setTimeout(resize, 30); } };
$('landProg').addEventListener('pointerdown', e => {
  const r = $('landProg').getBoundingClientRect();
  engine.seekTick(P.time.toTick((e.clientX - r.left) / r.width * P.time.total));
});
// Телефон повернули горизонтально на клавишах — сразу компактный режим
const landMq = window.matchMedia('(orientation: landscape) and (max-height: 600px)');
const onOrient = () => {
  if (!$('player').classList.contains('on') || !CANVAS_MODES.includes(P.mode)) return;
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
    b.textContent = [KIND_LABEL[tr.kind], tr.instrument && tr.instrument !== tr.name ? tr.instrument : '', tr.notes.length + ' нот'].filter(Boolean).join(' · ');
    a.append(meterEl(i));
    info.append(a, b);
    if (tr.tuning && tr.kind !== 'drums') { const c = document.createElement('div'); c.className = 'small tuning'; c.textContent = 'Строй: ' + tuningLine(tr.tuning, tr.kind); info.appendChild(c); }
    const showBtn = document.createElement('button'); showBtn.className = 'chip';
    const isFret = P.mode === 'fret' || P.mode === 'road', isDr = P.mode === 'drums';
    const canShow = isFret ? !!(tr.tuning && tr.notes.some(n => n.s != null)) : isDr ? tr.kind === 'drums' : tr.kind !== 'drums';
    const on = isFret ? P.gTrack === i : isDr ? P.dTrack === i : P.show.includes(i);
    showBtn.textContent = isFret ? (on ? 'На грифе' : 'Гриф') : isDr ? (on ? 'Показ ✓' : 'Показ') : (on ? 'Показ ✓' : 'Показ');
    showBtn.classList.toggle('on', on); showBtn.disabled = !canShow; if (!canShow) showBtn.style.opacity = .4;
    showBtn.onclick = () => {
      if (isFret) P.gTrack = i; else if (isDr) P.dTrack = i;
      else if (P.show.includes(i)) { if (P.show.length > 1) P.show = P.show.filter(x => x !== i); }
      else P.show = [...P.show, i].sort((x, y) => x - y);
      saveSet(); prepare(); updateSub(); P.scoreShown = P.mode === 'score' ? null : P.scoreShown; if (P.mode === 'score') showScore(); fillTracks();
    };
    const snd = document.createElement('button'); snd.className = 'chip';
    const muted = !!P.mute[i]; snd.textContent = muted ? 'Звук выкл' : 'Звук'; snd.classList.toggle('on', !muted);
    snd.onclick = () => { P.mute[i] = !P.mute[i]; saveSet(); engine.setChannels({ mute: P.mute, oct: P.oct }); fillTracks(); };
    const btns = document.createElement('div'); btns.className = 'tbtns'; btns.append(showBtn, snd);
    const top = document.createElement('div'); top.className = 'trow-top'; top.append(dot, info, btns);
    const sel = timbreSelect(tr, i, id => setTimbre(i, id, true)); sel.className = 'progSel';
    const lab = document.createElement('label'); lab.className = 'muted small proglab'; lab.textContent = 'Звучит как';
    const progRow = document.createElement('div'); progRow.className = 'trow-prog'; progRow.append(lab, sel);
    // громкость инструмента
    const st = sndTrack(i);
    const vr = document.createElement('div'); vr.className = 'trow-vol';
    const vl = document.createElement('label'); vl.className = 'muted small proglab'; vl.textContent = 'Громкость';
    const vs = document.createElement('input'); vs.type = 'range'; vs.min = 0; vs.max = 1.5; vs.step = 0.01; vs.value = st.vol != null ? st.vol : 1;
    const vo = document.createElement('span'); vo.className = 'muted small'; vo.textContent = Math.round(vs.value * 100) + '%';
    vs.oninput = () => { st.vol = +vs.value; vo.textContent = Math.round(st.vol * 100) + '%'; applySoundVol(); };
    vs.onchange = () => saveSet();
    vr.append(vl, vs, vo);
    row.append(top, progRow, vr);
    if (tr.tuning && tr.kind !== 'drums' && tr.notes.some(n => n.s != null)) {
      // показать партию в другом строе (лады пересчитываются, звук тот же)
      const rr = document.createElement('div'); rr.className = 'trow-vol';
      const rl = document.createElement('label'); rl.className = 'muted small proglab'; rl.textContent = 'Играть в строе';
      const rs = document.createElement('select'); rs.style.flex = '1'; rs.style.minWidth = '0';
      const o0 = document.createElement('option'); o0.value = ''; o0.textContent = 'Как в файле (' + describeTuning(tr.tuning, tr.kind).name + ')'; rs.appendChild(o0);
      for (const ins of INSTRUMENTS) {
        if (ins.kind !== (tr.kind === 'bass' ? 'bass' : 'guitar')) continue;
        for (const t of ins.tunings) if (t.midi.length === tr.tuning.length) { const o = document.createElement('option'); o.value = t.id; o.textContent = t.name + ' — ' + t.notes.map(x => x.replace(/-?\d$/, '')).join(' '); rs.appendChild(o); }
      }
      rs.value = (P.retune || {})[i] || '';
      rs.onchange = () => { P.retune = P.retune || {}; if (rs.value) P.retune[i] = rs.value; else delete P.retune[i]; saveSet(); prepare(); updateSub(); if (train) train.rebuild(); toast(rs.value ? 'Лады пересчитаны под новый строй — звучит так же' : 'Строй как в файле'); };
      rr.append(rl, rs); row.appendChild(rr);
    }
    if (tr.tuning && tr.kind !== 'drums') {
      const tb = document.createElement('button'); tb.className = 'chip'; tb.textContent = '🎸 Настроить по этому строю';
      tb.style.cssText = 'margin-left:22px;align-self:flex-start';
      tb.onclick = () => { $('trackSheet').classList.remove('on'); const rt = P.retune && P.retune[i] ? retuneTarget(tr, P.retune[i]) : null; openTunerFor(rt ? Object.assign({}, tr, { tuning: rt }) : tr); };
      row.appendChild(tb);
    }
    box.appendChild(row);
  });
}

// ---------- Ноты по тактам ----------
$('listBtn').onclick = () => { fillList(); $('listSheet').classList.add('on'); };
function fillList() {
  const box = $('mList'); box.innerHTML = '';
  const ti = P.mode === 'fret' ? P.gTrack : P.mode === 'drums' ? P.dTrack : P.show[0];
  const tr = P.song.tracks[ti]; if (!tr) return;
  const head = document.createElement('div'); head.className = 'muted small'; head.textContent = 'Дорожка: ' + tr.name; box.appendChild(head);
  const ts = techSummary(tr);
  const tb = document.createElement('div'); tb.className = 'tchips';
  if (ts.length) {
    const l = document.createElement('div'); l.className = 'muted small'; l.textContent = 'Техники в партии (нажмите, чтобы узнать подробнее):'; tb.appendChild(l);
    for (const [id, c] of ts) { const b = document.createElement('button'); b.className = 'chip'; b.textContent = `${TECH[id].sym} ${TECH[id].name.split(' (')[0]} · ${c}`; b.onclick = () => showTech([id]); tb.appendChild(b); }
  } else { const l = document.createElement('div'); l.className = 'muted small'; l.textContent = 'Особых техник исполнения в этой партии не найдено.'; tb.appendChild(l); }
  box.appendChild(tb);
  const by = new Map();
  for (const n of tr.notes) { if (n.deleted || n.tie) continue; if (!by.has(n.bar)) by.set(n.bar, []); by.get(n.bar).push(n); }
  const cur = P.song.measures[P.time.measureAtSec(P.time.toSec(engine.nowTick()))].n;
  const secAt = new Map(); for (const sc of P.sections || []) { const n0 = P.song.measures[sc.a].n; if (!secAt.has(n0)) secAt.set(n0, { name: sc.name, col: sc.col }); }
  let count = 0;
  for (const [mn, arr] of by) {
    if (++count > 600) break;
    const groups = [];
    for (const n of arr) { const gg = groups.find(x => x.t === n.t); if (gg) gg.ns.push(n); else groups.push({ t: n.t, ns: [n] }); }
    for (const [n0, sc] of secAt) if (n0 <= mn && !sc.shown) { sc.shown = true; const h = document.createElement('div'); h.className = 'mhead'; h.style.borderColor = sc.col; h.textContent = sc.name; box.appendChild(h); }
    const d = document.createElement('div'); d.className = 'mrow' + (mn === cur ? ' cur' : '');
    const b = document.createElement('b'); b.textContent = mn; d.appendChild(b);
    const sp = document.createElement('span');
    if (tr.kind === 'drums') sp.textContent = groups.map(gg => gg.ns.map(n => DRUM_NAMES[n.m] || ('№' + n.m)).join('+')).join('  ·  ');
    else sp.textContent = groups.map(gg => gg.ns.sort((a, b) => a.m - b.m).map(n => NAMES[(n.m + 12 * P.oct) % 12].replace('соль', 'сол') + (Math.floor((n.m + 12 * P.oct) / 12) - 1) + (n.f != null && tr.tuning ? `(${n.s + 1}/${n.f})` : '')).join('+')).join('  ·  ');
    d.appendChild(sp);
    d.onclick = () => { const i = P.song.measures.findIndex(m => m.n === mn); gotoMeasure(i); $('listSheet').classList.remove('on'); };
    box.appendChild(d);
  }
  const c = box.querySelector('.cur'); if (c) c.scrollIntoView({ block: 'center' });
}

// ---------- Правка нот (PDF) ----------
let editIdx = -1;
let editTr = 0, edPitch = 60;
function openEdit(i, ti = 0) {
  const tr = P.song.tracks[ti], n = tr && tr.notes[i]; if (!n) return;
  editIdx = i; editTr = ti; edPitch = n.m;
  $('edTitle').textContent = `Такт ${n.bar}: ${noteName(n.m)}` + (P.song.tracks.length > 1 ? ' · ' + tr.name : '');
  $('edInfo').textContent = n.edited ? 'Нота уже исправлена вручную' : n.unsure ? 'Распознано неуверенно: ' + (n.why || 'проверьте ноту') : 'Распознано автоматически';
  const pitchMode = !tr.tuning && tr.kind !== 'drums';
  $('edPitchRow').style.display = pitchMode ? '' : 'none';
  $('edString').style.display = pitchMode ? 'none' : '';
  $('edFret').parentElement.style.display = pitchMode ? 'none' : '';
  $('edString').previousElementSibling.style.display = pitchMode ? 'none' : '';
  $('edFret').parentElement.previousElementSibling.style.display = pitchMode ? 'none' : '';
  $('edOk').style.display = n.unsure ? '' : 'none';
  if (pitchMode) { $('edDur').value = 'keep'; updEdNote(); $('editSheet').classList.add('on'); return; }
  const s = $('edString'); s.innerHTML = '';
  const drum = tr.kind === 'drums';
  $('edFret').parentElement.style.display = drum ? 'none' : '';
  $('edFret').parentElement.previousElementSibling.style.display = drum ? 'none' : '';
  s.previousElementSibling.textContent = drum ? 'Инструмент' : 'Струна';
  if (drum) {
    $('edTitle').textContent = `Такт ${n.bar}: ${DRUM_NAMES[n.m] || 'удар'}`;
    for (const [m, name] of Object.entries(DRUM_NAMES)) { const o = document.createElement('option'); o.value = m; o.textContent = name; s.appendChild(o); }
    s.value = n.m;
  } else {
    const lab = tuningLabels(tr) || [];
    tr.tuning.forEach((m, k) => { const o = document.createElement('option'); o.value = k; o.textContent = `${k + 1} (${lab[k] || ''}, ${noteName(m)})`; s.appendChild(o); });
    s.value = n.s; $('edFret').value = n.f;
  }
  $('edDur').value = 'keep';
  updEdNote();
  $('editSheet').classList.add('on');
}
function updEdNote() { const tr = P.song.tracks[editTr]; if (!tr.tuning && tr.kind !== 'drums') { $('edPitch').textContent = noteName(edPitch) + ' (MIDI ' + edPitch + ')'; return; } if (tr.kind === 'drums') { $('edNote').textContent = ''; return; } const m = tr.tuning[+$('edString').value] + (+$('edFret').value || 0); $('edNote').textContent = '→ ' + noteName(m); }
$('edString').onchange = updEdNote; $('edFret').oninput = updEdNote;
for (const [id, d] of [['edDn', -1], ['edUp', 1], ['edOctDn', -12], ['edOctUp', 12]]) $(id).onclick = () => { edPitch = Math.max(12, Math.min(120, edPitch + d)); updEdNote(); engine.previewNote(edPitch, 0, false, curTimbre(editTr)); };
$('edListen').onclick = () => { const tr = P.song.tracks[editTr]; if (!tr.tuning && tr.kind !== 'drums') { engine.previewNote(edPitch + 12 * P.oct, 0, false, curTimbre(editTr)); return; } if (tr.kind === 'drums') { engine.previewNote(+$('edString').value, 0, true); return; } engine.previewNote(tr.tuning[+$('edString').value] + (+$('edFret').value || 0) + 12 * P.oct, tr.program || 0, false, curTimbre(0)); };
async function saveEdit(del) {
  const tr = P.song.tracks[editTr], n = tr.notes[editIdx]; if (!n) return;
  if (del) n.deleted = true;
  else {
    if (!tr.tuning && tr.kind !== 'drums') n.m = edPitch;
    else if (tr.kind === 'drums') n.m = +$('edString').value;
    else { const s = +$('edString').value, f = Math.max(0, Math.min(30, +$('edFret').value || 0)); n.s = s; n.f = f; n.m = tr.tuning[s] + f; }
    const d = $('edDur').value; if (d !== 'keep') n.d = Math.round(+d * PPQ);
  }
  n.edited = true; delete n.unsure;
  P.song.editVer = (P.song.editVer || 0) + 1;
  await idb.put('songs', P.song.id, P.song); await idb.put('meta', P.song.id, songSummary(P.song));
  prepare(); engine.rebuildMidi(P.song);
  pdfView.key = null; await pdfView.show(P.song, P.raw);
  $('editSheet').classList.remove('on');
  toast(del ? 'Нота удалена' : 'Сохранено');
}
$('edSave').onclick = () => saveEdit(false);
$('edOk').onclick = () => saveEdit(false);
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
  MG.files = []; MG.ref = 0; MG.merged = null; MG.dirty = true; MG.pianoJoin = null; MG.pianoName = ''; $('mTitle').value = '';
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
  // Умное объединение фортепиано
  const parts = pianoParts(MG.files);
  if (parts.length >= 2) {
    const hands = parts.map(p => p.hand);
    if (MG.pianoJoin == null) MG.pianoJoin = hands.includes('L') && hands.includes('R') || parts.length === 2;
    const card = document.createElement('div'); card.className = 'okmsg piano';
    const lab = document.createElement('label'); lab.className = 'row check'; lab.style.marginTop = '0';
    const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = MG.pianoJoin;
    cb.onchange = () => { MG.pianoJoin = cb.checked; MG.dirty = true; renderMerge(); };
    const txt = document.createElement('span');
    txt.textContent = 'Объединить партии фортепиано в одну: ' + parts.map(p => `«${p.sel.name}» — ${p.hand === 'L' ? 'левая' : p.hand === 'R' ? 'правая' : 'рука по высоте'}`).join(', ');
    lab.append(cb, txt); card.appendChild(lab);
    if (MG.pianoJoin) {
      const nm = document.createElement('input'); nm.type = 'text'; nm.className = 'wide'; nm.style.marginTop = '8px';
      nm.placeholder = 'Название общей партии'; nm.value = MG.pianoName || 'Фортепиано';
      nm.oninput = () => { MG.pianoName = nm.value; MG.dirty = true; };
      card.appendChild(nm);
      const hint = document.createElement('div'); hint.className = 'small'; hint.style.marginTop = '6px';
      hint.textContent = 'На клавишах руки будут разного цвета. Руку каждой дорожки можно поменять ниже.';
      card.appendChild(hint);
    }
    warnBox.appendChild(card);
    for (const p of parts) p.sel.join = MG.pianoJoin;
    const oc = handOctaveCheck(parts);
    if (oc) {
      const d = document.createElement('div'); d.className = 'warn';
      d.textContent = oc.far ? '⚠ Левая рука звучит намного ниже правой (больше трёх октав). Возможно, октава левой руки определена неверно.'
        : '⚠ Левая рука звучит выше правой — похоже, октава левой руки определена неверно (так бывает с табами из PDF).';
      const b = document.createElement('button'); b.className = 'chip'; b.style.marginLeft = '8px';
      b.textContent = oc.far ? 'Левую руку на октаву выше' : `Левую руку на ${Math.abs(oc.shift)} окт. ниже`;
      b.onclick = () => { for (const p of oc.L) p.sel.oct = (p.sel.oct || 0) + oc.shift; MG.dirty = true; renderMerge(); };
      d.appendChild(b); warnBox.appendChild(d);
    }
  } else for (const f of MG.files) for (const sl of f.sel) sl.join = false;
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
      if (tr.kind !== 'drums') {
        const oc = document.createElement('select'); oc.title = 'Октава';
        oc.innerHTML = [-2, -1, 0, 1, 2].map(v => `<option value="${v}">${v === 0 ? 'октава как есть' : (v > 0 ? '+' : '−') + Math.abs(v) + ' окт.'}</option>`).join('');
        oc.value = sl.oct || 0; oc.style.flex = '0 0 auto';
        oc.onchange = () => { sl.oct = +oc.value; MG.dirty = true; renderMerge(); };
        sub.append(oc);
      }
      if (tr.kind === 'piano') {
        const hs = document.createElement('select'); hs.style.flex = '0 0 auto';
        hs.innerHTML = '<option value="auto">рука: ' + (tr.hand === 'L' ? 'левая (по названию)' : tr.hand === 'R' ? 'правая (по названию)' : 'по высоте') + '</option><option value="R">правая рука</option><option value="L">левая рука</option>';
        hs.value = sl.hand || 'auto';
        hs.onchange = () => { sl.hand = hs.value; MG.dirty = true; renderMerge(); };
        sub.append(hs);
      }
      row.append(cb, name, sub); c.appendChild(row);
    });
    box.appendChild(c);
  });
}
function renderMergeSub() { $('mSub').textContent = `${MG.files.length} файл(а), ${MG.files.reduce((a, f) => a + f.sel.filter(x => x.on).length, 0)} дорожек выбрано`; }
function buildMerged() {
  if (!MG.dirty && MG.merged) return MG.merged;
  if (MG.files.length < 1) throw new Error('Нет файлов');
  const { song, tooMany } = mergeSongs(MG.files, MG.ref, ($('mTitle').value || 'Объединённая композиция').trim(), (MG.pianoName || 'Фортепиано').trim());
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
      engine.prog = {}; engine.channelState = {}; engine.sound = {};
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
  if (tr.bends) for (const b of tr.bends) b[0] += dt;
  if (tr.pedal) for (const q of tr.pedal) { q[0] += dt; q[1] += dt; }
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

// =====================================================================
// Карточки техник
// =====================================================================
const ANIM_HTML = {
  bend: '<div class="ta-str"></div><div class="ta-dot a-bend"></div>', release: '<div class="ta-str"></div><div class="ta-dot a-release"></div>',
  vibrato: '<div class="ta-str"></div><div class="ta-dot a-vib"></div>', slide: '<div class="ta-str"></div><div class="ta-dot a-slide"></div>',
  hammer: '<div class="ta-str"></div><div class="ta-dot"></div><div class="ta-dot d2 a-hammer"></div>', pull: '<div class="ta-str"></div><div class="ta-dot"></div><div class="ta-dot d2 a-pull"></div>',
  tap: '<div class="ta-str"></div><div class="ta-dot a-tap"></div>', mute: '<div class="ta-str a-mute"></div><div class="ta-palm"></div>',
  harmonic: '<div class="ta-str"></div><div class="ta-dia a-glow"></div>', dead: '<div class="ta-str a-mute"></div><div class="ta-x">×</div>',
  ghost: '<div class="ta-key a-ghost"></div>', ring: '<div class="ta-bar a-ring"></div>', up: '<div class="ta-arrow a-up">↑</div>', down: '<div class="ta-arrow a-down">↓</div>',
  trill: '<div class="ta-key k1 a-tr1"></div><div class="ta-key k2 a-tr2"></div>', tremolo: '<div class="ta-key a-trem"></div>',
  staccato: '<div class="ta-key a-stacc"></div>', accent: '<div class="ta-key a-acc"></div>', legato: '<div class="ta-key k1 a-leg1"></div><div class="ta-key k2 a-leg2"></div>',
  turn: '<div class="ta-key k1 a-s1"></div><div class="ta-key k2 a-s2"></div><div class="ta-key k3 a-s3"></div>', gliss: '<div class="ta-key k1 a-s1"></div><div class="ta-key k2 a-s2"></div><div class="ta-key k3 a-s3"></div><div class="ta-key k4 a-s4"></div>',
  grace: '<div class="ta-key k1 a-grace"></div><div class="ta-key k2 a-s2"></div>', arp: '<div class="ta-key k1 a-s1"></div><div class="ta-key k2 a-s2"></div><div class="ta-key k3 a-s3"></div>',
  pedal: '<div class="ta-pedal a-pedal"></div>', cresc: '<div class="ta-wedge a-cresc"></div>', dim: '<div class="ta-wedge a-dim"></div>', tuplet: '<div class="ta-key k1 a-s1"></div><div class="ta-key k2 a-s2"></div><div class="ta-key k3 a-s3"></div>'
};
function showTech(ids) {
  ids = [...new Set(ids)].filter(id => TECH[id]);
  if (!ids.length) return;
  const box = $('techBody'); box.innerHTML = '';
  for (const id of ids.slice(0, 4)) {
    const T = TECH[id];
    const c = document.createElement('div'); c.className = 'tcard';
    c.innerHTML = `<div class="thead"><div class="tsym"></div><div><div class="tname"></div><div class="tfor muted small"></div></div></div><div class="tanim">${ANIM_HTML[T.anim] || ''}</div><p class="ttext"></p><p class="thow"><b>Как играть:</b> <span></span></p>`;
    c.querySelector('.tsym').textContent = T.sym; c.querySelector('.tname').textContent = T.name;
    c.querySelector('.tfor').textContent = { g: 'гитара', b: 'бас-гитара', p: 'фортепиано', gp: 'гитара и фортепиано' }[T.for] || '';
    c.querySelector('.ttext').textContent = T.text; c.querySelector('.thow span').textContent = T.how;
    box.appendChild(c);
  }
  $('techSheet').classList.add('on');
}
window.showTech = showTech;
$('hints').onchange = e => { P.hints = e.target.checked; ls.set('nv-hints', P.hints); };
P.hints = ls.get('nv-hints', true); $('hints').checked = P.hints;
// Список техник текущей дорожки (в «Нотах по тактам»)
function techSummary(tr) {
  const cnt = new Map();
  for (const n of tr.notes) for (const id of techIds(n.x, tr.kind)) cnt.set(id, (cnt.get(id) || 0) + 1);
  if (tr.pedal && tr.pedal.length) cnt.set('pedal', tr.pedal.length);
  return [...cnt.entries()].filter(([id]) => TECH[id]).sort((a, b) => b[1] - a[1]);
}

// ---------- Звуки и инструменты ----------
function curTimbre(i) { const st = (P.sound.tracks || {})[i] || {}; return st.timbre || defaultTimbre(P.song.tracks[i], P.prog[i], P.song.source === 'gp' || P.song.source === 'midi'); }
function timbreSelect(tr, i, onChange) {
  const sel = document.createElement('select');
  const cur = curTimbre(i), tb = timbreFor(cur);
  const want = tr.kind === 'drums' ? 'drums' : tr.kind === 'piano' ? 'piano' : tr.kind === 'bass' ? 'bass' : isStringKind(tr.kind) ? 'guitar' : null;
  const groups = ['piano', 'guitar', 'bass', 'drums'].sort((a, b) => (b === want) - (a === want));
  for (const gr of groups) {
    if (tr.kind === 'drums' && gr !== 'drums') continue;
    if (tr.kind !== 'drums' && gr === 'drums') continue;
    const og = document.createElement('optgroup'); og.label = GROUP_LABEL[gr];
    for (const t of TIMBRES.filter(t => t.group === gr)) { const o = document.createElement('option'); o.value = t.id; o.textContent = t.name; og.appendChild(o); }
    sel.appendChild(og);
  }
  if (tr.kind !== 'drums') GM_GROUPS.forEach((gname, gi) => {
    const og = document.createElement('optgroup'); og.label = 'GM: ' + gname;
    for (let p = gi * 8; p < gi * 8 + 8; p++) { const o = document.createElement('option'); o.value = 'gm:' + p; o.textContent = GM_NAMES[p] + (p === (tr.program || 0) ? ' — как в файле' : ''); og.appendChild(o); }
    sel.appendChild(og);
  });
  sel.value = cur; if (sel.value !== cur) { const o = document.createElement('option'); o.value = cur; o.textContent = tb.name; sel.prepend(o); sel.value = cur; }
  sel.onchange = () => onChange(sel.value);
  return sel;
}
function sndTrack(i) { P.sound.tracks = P.sound.tracks || {}; return P.sound.tracks[i] = P.sound.tracks[i] || {}; }
function setTimbre(i, id, preview) {
  const st = sndTrack(i); st.timbre = id; delete st.fx; delete st.fxParams;
  saveSet(); engine.setSound(P.sound);
  toast('Звучание: ' + timbreFor(id).name);
  if (preview && !engine.playing) setTimeout(() => sampleTrack(i), 400);
}
// Образец: 5 секунд этой дорожки соло (с текущего места, если в нём есть её ноты, иначе — с её первой ноты)
let sampleTimer = null;
function sampleTrack(i) {
  const tr = P.song.tracks[i]; if (!tr) return;
  if (engine.loading) { setTimeout(() => sampleTrack(i), 300); return; }
  const now = engine.nowTick();
  const n = tr.notes.find(n => !n.deleted && n.t >= now - 1) || tr.notes.find(n => !n.deleted); if (!n) return;
  clearTimeout(sampleTimer);
  const back = { tick: now, solo: null };
  engine.setChannels({ mute: {}, oct: P.oct, solo: i });
  engine.seekTick(n.t); engine.play();
  sampleTimer = setTimeout(() => { engine.pause(); engine.setChannels({ mute: P.mute, oct: P.oct }); engine.seekTick(back.tick); }, 5000);
}
$('soundBtn').onclick = () => { $('sheet').classList.remove('on'); fillSound(); $('soundSheet').classList.add('on'); };
const FX_KNOBS = [['vol', 'Громкость', 0, 1.5, 0.01, 1], ['drive', 'Перегруз', 0, 1, 0.01], ['low', 'Низ, дБ', -12, 12, 0.5], ['mid', 'Середина, дБ', -12, 12, 0.5], ['high', 'Верх, дБ', -12, 12, 0.5], ['chorus', 'Хорус', 0, 1, 0.01], ['delay', 'Дилей', 0, 0.8, 0.01], ['delayTime', 'Время дилея, с', 0.08, 1, 0.01], ['reverb', 'Реверб', 0, 0.8, 0.01]];
function fillSound() {
  const q = P.sound.quality || engine.audio.quality || 'high';
  for (const b of $('qualSeg').children) { b.classList.toggle('on', b.dataset.q === q); b.onclick = () => { P.sound.quality = b.dataset.q; saveSet(); engine.setSound(P.sound); fillSound(); }; }
  $('qualInfo').textContent = q === 'eco' ? 'Моно, упрощённые эффекты: вдвое меньше памяти — для слабых телефонов.' : 'Стерео, все слои громкости и эффекты.';
  $('revOn').checked = P.sound.reverb !== false;
  $('revOn').onchange = e => { P.sound.reverb = e.target.checked; saveSet(); engine.audio.setReverb(e.target.checked); };
  const box = $('sndList'); box.innerHTML = '';
  P.song.tracks.forEach((tr, i) => {
    const st = sndTrack(i), tb = timbreFor(curTimbre(i));
    const c = document.createElement('div'); c.className = 'scard';
    const hd = document.createElement('div'); hd.className = 'hd';
    const dot = document.createElement('span'); dot.className = 'dot'; dot.style.cssText = `width:12px;height:12px;border-radius:3px;background:${TRACK_COLORS[i % TRACK_COLORS.length]}`;
    const nm = document.createElement('b'); nm.textContent = tr.name + ' · ' + KIND_LABEL[tr.kind];
    const play = document.createElement('button'); play.className = 'chip'; play.textContent = '▶ Образец'; play.onclick = () => sampleTrack(i);
    hd.append(dot, nm, meterEl(i), play); c.appendChild(hd);
    c.appendChild(timbreSelect(tr, i, id => { setTimbre(i, id, true); setTimeout(fillSound, 50); }));
    const presets = FX_FOR_GROUP[tb.group] || FX_FOR_GROUP.gm;
    const curP = st.fx || tb.fx || (tb.group === 'piano' ? 'piano' : 'none');
    const ps = document.createElement('select');
    for (const id of [...new Set([curP, ...presets])]) { const o = document.createElement('option'); o.value = id; o.textContent = 'Обработка: ' + FX_PRESETS[id].label; ps.appendChild(o); }
    ps.value = curP;
    ps.onchange = () => { st.fx = ps.value; st.fxParams = {}; saveSet(); engine.audio.setFx(i, { preset: st.fx }); fillSound(); };
    c.appendChild(ps);
    const base = Object.assign({}, FX_PRESETS[curP], st.fxParams || {});
    for (const [k, label, mn, mx, step, dflt] of FX_KNOBS) {
      const amp = FX_PRESETS[curP].amp;
      if (k === 'drive' && !amp) continue;
      if ((k === 'chorus' || k === 'delay' || k === 'delayTime') && (tb.group === 'drums' || tb.group === 'bass')) continue;
      if (k === 'delayTime' && !(base.delay > 0)) continue;
      const row = document.createElement('div'); row.className = 'sl';
      const l = document.createElement('span'); l.textContent = label;
      const r = document.createElement('input'); r.type = 'range'; r.min = mn; r.max = mx; r.step = step;
      const v = k === 'vol' ? (st.vol != null ? st.vol : 1) : (base[k] != null ? base[k] : 0); r.value = v;
      const o = document.createElement('span'); o.className = 'muted small';
      const fmtv = x => k === 'vol' || k === 'drive' || k === 'chorus' || k === 'delay' || k === 'reverb' ? Math.round(x * 100) + '%' : (+x).toFixed(k === 'delayTime' ? 2 : 1);
      o.textContent = fmtv(v);
      r.oninput = () => {
        const x = +r.value; o.textContent = fmtv(x);
        if (k === 'vol') { st.vol = x; applySoundVol(); }
        else { st.fxParams = st.fxParams || {}; st.fxParams[k] = x; engine.audio.setFx(i, Object.assign({ preset: curP }, st.fxParams)); }
      };
      r.onchange = () => { saveSet(); if (k === 'delay') fillSound(); };
      row.append(l, r, o); c.appendChild(row);
    }
    box.appendChild(c);
  });
  $('sndCredits').textContent = 'Семплы: Salamander Grand Piano (A. Holm, CC-BY 3.0), Emilyguitar и Growlybass (Karoryfer, CC0), Martin acoustic и jRhodes3c (J. Learman, CC0), Virtuosity Drums (CC0), GeneralUser GS (S. C. Collins). Подробнее — в «Диагностике».';
}
function applySoundVol() {
  const t = P.sound.tracks || {};
  P.song.tracks.forEach((tr, i) => { const a = engine.audio.trackState[i]; if (a) a.vol = (tr.volume != null ? tr.volume : 1) * ((t[i] && t[i].vol != null) ? t[i].vol : 1); });
  engine.audio.applyMix();
}

// ---------- Диагностика ----------
let diagFrom = 'player';
$('diagBtn').onclick = () => { $('sheet').classList.remove('on'); diagFrom = 'player'; show('diag'); };
$('diagBack').onclick = () => { show(diagFrom); if (diagFrom === 'player') setMode(P.mode, true); };
$('diagPlay').onclick = () => { if (engine.playing) engine.pause(); else engine.play(); };
function diagLive() {
  if (!$('diag').classList.contains('on')) return;
  const au = engine.audio, ctx = au.ctx, s = P.song;
  const L = [];
  if (!s) { $('diagLive').textContent = 'Откройте композицию.'; return; }
  const sec = au.nowSec(), tick = P.time.toTick(sec), mi = P.time.measureAtSec(sec), m = s.measures[mi];
  const beatT = PPQ * 4 / m.sig[1], beat = Math.floor((tick - m.tick) / beatT) + 1;
  L.push(`Музыкальное время: такт ${m.n}, доля ${beat}/${m.sig[0]} · ${sec.toFixed(3)} с · тик ${Math.round(tick)} (PPQ ${PPQ})`);
  L.push(`Темп: ${P.time.bpmAt(tick).toFixed(1)} BPM × скорость ${Math.round(engine.speed * 100)}% · смен темпа в композиции: ${Math.max(0, (s.tempos || []).length - 1)}`);
  if (ctx) {
    const heard = au.heardCtxTime(), lat = (ctx.currentTime - heard);
    L.push(`Мастер-часы AudioContext: ${ctx.currentTime.toFixed(3)} с · ${ctx.state} · ${ctx.sampleRate} Гц`);
    L.push(`Задержка вывода звука: ${(lat * 1000).toFixed(0)} мс (base ${((ctx.baseLatency || 0) * 1000).toFixed(0)}, output ${((ctx.outputLatency || 0) * 1000).toFixed(0)}) — картинка показывает то, что слышно сейчас`);
    if (au.playing) {
      const schedSec = au.songSecAt(ctx.currentTime);
      L.push(`Расхождение картинка ↔ звук из динамика: ${((au.songSecAt(heard) - sec) * 1000).toFixed(1)} мс (ожидается 0)`);
      L.push(`Планировщик впереди звука на ${((schedSec - sec) * 1000).toFixed(0)} мс + окно ${Math.round(au.LOOK * 1000)} мс`);
    }
  }
  const st = au.stats;
  const pending = ctx ? [...au.voices].filter(v => v.start > ctx.currentTime).length : 0;
  L.push(`Запланировано нот: ${st.scheduled} · в очереди: ${pending} · звучит голосов: ${au.voices.size} (пик ${st.voicesPeak})`);
  L.push(`Опоздавших при планировании: ${st.late}${st.late ? `, максимум ${st.maxLateMs.toFixed(1)} мс` : ''} · повторно запланированных: ${st.dupes}`);
  L.push(`Память семплов: ${au.bank ? (au.bank.bytes / 1048576).toFixed(0) : 0} МБ · качество: ${au.quality === 'eco' ? 'экономное' : 'высокое'}`);
  L.push('');
  L.push('Дорожки (все на одних часах):');
  s.tracks.forEach((tr, i) => {
    const p = st.perTrack[i] || {}; const voices = [...au.voices].filter(v => v.tr === i).length;
    const ts = au.trackState[i] || {};
    L.push(` ${i + 1}. ${tr.name} — ${p.timbre || '…'}${tr.kind === 'drums' ? ' · канал MIDI 10 (индекс 9)' : ''}`);
    L.push(`    нот ${p.count || 0}, запланировано ${p.scheduled || 0}, звучит ${voices}, последняя нота ${p.lastSec != null ? p.lastSec.toFixed(2) : '—'} с (мастер ${sec.toFixed(2)} с), опозданий ${p.late || 0}${ts.mute ? ' · выключена' : ''}${ts.solo ? ' · соло' : ''}`);
  });
  if (st.lastDrum) { const d = st.lastDrum; L.push(''); L.push(`Ударные, последний удар: канал ${d.ch}, нота ${d.m} — ${d.name} · звук: ${d.ok ? d.src : 'НЕТ (элемент неизвестен, не подменяется)'}`); }
  if (st.unknownDrums) L.push(`Ударов без звука (неизвестный номер): ${st.unknownDrums}`);
  $('diagLive').textContent = L.join('\n');
  $('diagSub').textContent = s.title;
}
setInterval(diagLive, 200);
$('diagRun').onclick = async () => {
  const box = $('diagTests'); box.innerHTML = '<p class="muted">Идут тесты: планирование, ударные, рендер звука…</p>';
  if (engine.playing) engine.pause();
  try {
    const { runAll } = await import('./selftest.js');
    const r = await runAll(p => { box.firstChild.textContent = p; });
    box.innerHTML = '';
    const okN = r.results.filter(x => x.ok).length;
    const h = document.createElement('p'); h.innerHTML = `<b>${okN} из ${r.results.length} тестов пройдено</b>`; box.appendChild(h);
    for (const t of r.results) { const d = document.createElement('div'); d.className = 'tres'; d.innerHTML = `<b class="${t.ok ? 'ok' : 'bad'}"></b><span class="muted small"></span>`; d.firstChild.textContent = (t.ok ? '✓ ' : '✗ ') + t.id + '. ' + t.name; d.lastChild.textContent = t.detail; box.appendChild(d); }
    const tb = document.createElement('table'); tb.className = 'dtab';
    tb.innerHTML = '<tr><td><b>№</b></td><td><b>Элемент (GM, канал 10)</b></td><td><b>Звук</b></td><td><b>Слоёв</b></td></tr>';
    for (const d of r.drums) { const tr = document.createElement('tr'); for (const v of [d.m, d.name, d.src, d.layers]) { const td = document.createElement('td'); td.textContent = v; tr.appendChild(td); } tb.appendChild(tr); }
    const cap = document.createElement('p'); cap.className = 'muted small'; cap.textContent = 'Раскладка ударных General MIDI и источник каждого звука:';
    box.append(cap, tb);
  } catch (e) { box.textContent = 'Ошибка тестов: ' + (e.message || e); }
};

// ---------- Индикатор «сейчас звучит» в списках инструментов ----------
function meterEl(i) {
  const m = document.createElement('span'); m.className = 'lvl'; m.dataset.lv = i;
  m.innerHTML = '<b><i></i></b><em>звучит</em>'; m.style.setProperty('--c', TRACK_COLORS[i % TRACK_COLORS.length]);
  return m;
}
const lvHold = [];
function meterLoop() {
  requestAnimationFrame(meterLoop);
  if (!P.song || !($('trackSheet').classList.contains('on') || $('soundSheet').classList.contains('on'))) return;
  for (const el of document.querySelectorAll('.lvl')) {
    const i = +el.dataset.lv;
    const raw = engine.playing ? engine.audio.trackLevel(i) : 0;
    const v = Math.min(1, Math.sqrt(raw) * 2.2);
    lvHold[i] = Math.max(v, (lvHold[i] || 0) * 0.9);
    el.querySelector('i').style.width = Math.round(lvHold[i] * 100) + '%';
    const on = lvHold[i] > 0.06; el.classList.toggle('on', on);
    const row = el.closest('.trow, .scard'); if (row) row.classList.toggle('playing', on);
  }
  for (const b of document.querySelectorAll('.sheetPlay')) b.textContent = engine.playing ? '❚❚ Пауза' : '▶ Играть';
}
requestAnimationFrame(meterLoop);
for (const id of ['trackSheet', 'soundSheet']) {
  const head = $(id).querySelector('.sheet-head');
  const b = document.createElement('button'); b.className = 'chip sheetPlay'; b.textContent = '▶ Играть';
  b.onclick = e => { e.stopPropagation(); if (!engine.sfReady) { toast('Звуки ещё загружаются…'); return; } if (engine.playing) engine.pause(); else engine.play(); };
  head.insertBefore(b, head.lastElementChild);
}

// ---------- Тюнер, метроном, разучивание ----------
const tuner = initTuner({ show, engine, toast });
const metro = initMetronome({ show });
$('metroHome').onclick = () => metro.open('home');
$('metroBtn2').onclick = () => { $('sheet').classList.remove('on'); engine.pause(); if (P.land) exitLand(true); const bpm = P.song && P.song.tempos && P.song.tempos[0] ? P.song.tempos[0].bpm * P.speed : null; metro.open('player', bpm); };
train = initTrain({ P, engine, toast, curTimbre, prepare, setSpeed, updateUi, saveSet, setLoop });
function openTunerFor(tr) {
  engine.pause(); if (P.land) exitLand(true);
  const pr = tr && tr.tuning ? tunerPresetFor(tr.tuning, tr.kind) : null;
  if (pr && pr.custom) pr.name = 'Строй «' + tr.name + '»';
  tuner.open(pr, 'player');
}
$('tunerBtn').onclick = () => tuner.open(null, 'home');
$('tunerBtn2').onclick = () => { $('sheet').classList.remove('on'); const gt = P.song && P.song.tracks[P.gTrack]; openTunerFor(gt && gt.tuning ? gt : null); };
window.__nv = { engine, P, tuner, prepare: () => prepare(), openSong, computeSections: () => computeSections(), get train() { return train; } };

// ---------- Результат распознавания нот из PDF ----------
function showOmrReport() {
  const r = P.song && P.song.omrReport; if (!r) return;
  const box = $('omrBody'); box.innerHTML = '';
  const add = (t, cls) => { const d = document.createElement('div'); if (cls) d.className = cls; d.textContent = t; box.appendChild(d); return d; };
  const sure = r.notes - r.unsure;
  add(`Страниц: ${r.pages} · систем: ${r.systems} · станов в системе: ${r.staves} · тактов: ${r.measures}`);
  add(`Нот распознано: ${r.notes}. Уверенно: ${sure} (${r.notes ? Math.round(sure / r.notes * 100) : 0}%), требуют проверки: ${r.unsure}.`, 'omr-big');
  add(r.musicFont ? 'Знаки взяты из нотного шрифта PDF (точно), линии, штили и ребра — по изображению страницы.' : 'Нотного шрифта в PDF нет — все знаки распознаны по изображению страницы; точность ниже.', 'muted small');
  add('Дорожки: ' + P.song.tracks.map(t => `${t.name} (${KIND_LABEL[t.kind]}, ${t.notes.length} нот)`).join('; '), 'muted small');
  for (const p of r.problems || []) add('⚠ ' + p, 'omr-warn');
  const um = r.unsureMeasures || [];
  if (um.length) {
    add('Такты, где ритм не сошёлся с размером (ноты поставлены по положению на строке — проверьте):', 'lbl');
    const wrap = document.createElement('div'); wrap.className = 'tchips';
    const seen = new Set();
    for (const u of um) {
      const k = u.n + ':' + u.track; if (seen.has(k)) continue; seen.add(k);
      const b = document.createElement('button'); b.className = 'chip'; b.textContent = `Такт ${u.n} · ${u.track}`; b.title = u.why;
      b.onclick = () => { $('omrSheet').classList.remove('on'); gotoMeasure(u.n - 1); setMode('pdf'); setTimeout(() => pdfView.scrollToBar(u.n), 400); };
      wrap.appendChild(b);
    }
    box.appendChild(wrap);
  } else add('Ритм во всех тактах сошёлся с размером.', 'muted small');
  add('В режиме «Оригинал» рядом со страницей — клавиатура. Рамки: синие — уверенно, оранжевые — проверить, зелёные — исправлено. Нажмите на рамку, чтобы исправить высоту или удалить ноту.', 'muted small');
  $('omrSheet').classList.add('on');
}
$('omrCheck').onclick = () => { $('omrSheet').classList.remove('on'); setMode('pdf'); };
$('omrBtn').onclick = () => { $('sheet').classList.remove('on'); showOmrReport(); };
