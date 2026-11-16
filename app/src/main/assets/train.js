// Разучивание в плеере: кто что играет, «жду ноту», проверка игры, плавное ускорение,
// MIDI-клавиатура, микрофон, запись своей игры.
import { MicNotes, scoreNotes } from './practice.js';
import { ls } from './store.js';

const $ = id => document.getElementById(id);
const NAMES = ['до', 'до♯', 'ре', 'ми♭', 'ми', 'фа', 'фа♯', 'соль', 'ля♭', 'ля', 'си♭', 'си'];
const nm = m => NAMES[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1);

export function initTrain(d) {
  const { P, engine, toast, curTimbre, prepare, setSpeed, updateUi, saveSet } = d;
  const T = P.train = Object.assign({ who: 'none', wait: false, check: false, mic: false, ramp: false, from: 0.6, to: 1, step: 0.05, fing: false }, ls.get('nv-train', {}));
  const st = { inputs: [], pending: null, lastS: -1, lastT: 0, score: null, rec: null, recBuf: null, recSrc: null, midiDevs: [] };
  const saveT = () => ls.set('nv-train', T);
  let mic = null;

  // ---------- чья партия ----------
  // рука ноты — так же, как раскраска клавиш
  function handOf(ti, n, m) {
    const tr = P.song.tracks[ti];
    if (P.handMode === 'right') return 'R';
    if (P.handMode === 'auto' && ((n && n.h) || tr.hand)) return (n && n.h) || tr.hand;
    return m < P.split ? 'L' : 'R';
  }
  function isMine(ti, n, m) {
    if (T.who === 'none') return false;
    if (T.who === 'fret') return ti === P.gTrack;
    if (!P.show.includes(ti)) return false;
    const tr = P.song.tracks[ti]; if (!tr || tr.kind === 'drums') return false;
    if (T.who === 'both') return true;
    return handOf(ti, n, m) === T.who;
  }
  // звук: партию ученика не играем
  engine.audio.userPart = e => T.who !== 'none' && P.song && isMine(e.tr, P.song.tracks[e.tr] && P.song.tracks[e.tr].notes[e.src], e.m);
  // цели для «жду ноту» и проверки
  function targets() {
    if (T.who === 'fret') return (P.fretNotes || []).filter(q => !q.dup).map(q => ({ s: q.s, m: q.m, ref: q }));
    const who = T.who === 'none' ? 'both' : T.who;
    return (P.keysNotes || []).filter(q => q.first && (who === 'both' || q.h === who)).map(q => ({ s: q.s, m: q.m, ref: q }));
  }
  let TG = [], groups = [];
  function rebuild() {
    TG = targets(); groups = [];
    for (const q of TG) { const g = groups[groups.length - 1]; if (g && q.s - g.s < 0.035) g.ms.push(q.m); else groups.push({ s: q.s, ms: [q.m] }); }
    for (const q of [...(P.keysNotes || []), ...(P.fretNotes || [])]) q.res = null;
    st.inputs = []; st.pending = null; st.score = null;
    st.lastS = P.time ? P.time.toSec(engine.nowTick()) - 0.01 : -1;
    hud();
  }

  // ---------- ввод нот ----------
  function input(m, src, tSong) {
    if (!P.song) return;
    const t = tSong != null ? tSong : engine.audio.nowSec();
    st.inputs.push({ t, m, src }); if (st.inputs.length > 4000) st.inputs.splice(0, 2000);
    if (st.rec) st.rec.inputs.push({ t, m, src });
    if (st.pending) {
      const need = st.pending.need;
      const hit = [...need].find(x => x === m || (src === 'mic' && (x - m) % 12 === 0));
      if (hit != null) need.delete(hit);
      if (!need.size) { st.lastS = st.pending.s + 0.001; st.pending = null; hud(); engine.play(); }
      else hud();
    }
  }
  // MIDI-клавиатура (Android передаёт байты; в браузере — Web MIDI)
  const midiDown = new Set();
  window.onMidiIn = (s, a, b) => {
    const type = s & 0xF0;
    if (type === 0x90 && b > 0) {
      midiDown.add(a); P.pressed.add(a);
      engine.audio.liveOn(a, b, P.song ? curTimbre(P.show[0] || 0) : 'grand');
      input(a, 'midi');
    } else if (type === 0x80 || (type === 0x90 && b === 0)) {
      midiDown.delete(a); P.pressed.delete(a); engine.audio.liveOff(a);
    }
  };
  window.onMidiDevices = names => { st.midiDevs = names || []; fill(); if (names && names.length) toast('Подключена MIDI-клавиатура: ' + names.join(', ')); };
  if (!window.Android && navigator.requestMIDIAccess) {
    navigator.requestMIDIAccess().then(acc => {
      const hook = () => { const ns = []; acc.inputs.forEach(i => { i.onmidimessage = e => window.onMidiIn(e.data[0], e.data[1], e.data[2] || 0); ns.push(i.name); }); st.midiDevs = ns; };
      hook(); acc.onstatechange = hook;
    }).catch(() => { });
  }
  async function micOn() {
    if (mic && mic.on) return true;
    mic = new MicNotes((m, perfT) => {
      // время песни, когда нота прозвучала: задержка микрофона и анализа ~ 80–120 мс
      const lag = (performance.now() - perfT) / 1000 + 0.06;
      input(m, 'mic', engine.audio.nowSec() - lag * engine.audio.speed);
    });
    const ok = await mic.start();
    if (!ok) { toast('Нет доступа к микрофону'); T.mic = false; saveT(); fill(); return false; }
    return true;
  }
  async function micOff() { if (mic) await mic.stop(); mic = null; }

  // ---------- каждый кадр ----------
  function frame(t) {
    if (!P.song) return;
    const active = T.wait || T.check;
    // «жду ноту»
    if (T.wait && engine.playing && !st.pending) {
      // первая группа после последней пройденной
      let lo = 0, hi = groups.length; while (lo < hi) { const m = (lo + hi) >> 1; if (groups[m].s <= st.lastS) lo = m + 1; else hi = m; }
      const g = groups[lo];
      if (g && t >= g.s - 0.003 && t < g.s + 0.5) {
        engine.internalSeek = true; engine.pause(); engine.seekTick(P.time.toTick(g.s)); engine.internalSeek = false;
        st.pending = { s: g.s, need: new Set(g.ms) };
        // уже зажатые клавиши засчитываются сразу
        for (const m of midiDown) st.pending.need.delete(m);
        if (!st.pending.need.size) { st.lastS = g.s + 0.001; st.pending = null; engine.play(); }
        hud();
      } else if (g && t >= g.s + 0.5) st.lastS = t - 0.01;
    }
    if (st.pending && engine.playing) { st.pending = null; hud(); }
    // проверка
    if (T.check && engine.playing && t - st.lastT > 0.2) {
      st.lastT = t;
      const from = st.checkFrom != null ? st.checkFrom : 0;
      const tg = TG.filter(q => q.s >= from);
      const r = scoreNotes(tg, st.inputs, t);
      for (const q of tg) if (q.ref) q.ref.res = q.res;
      st.score = r; hud();
    }
    if (!active && st.score) { st.score = null; hud(); }
  }
  function hud() {
    const h = $('hud'); h.innerHTML = '';
    const add = (cls, html) => { const x = document.createElement('div'); x.className = cls; x.innerHTML = html; h.appendChild(x); };
    if (st.rec) add('wait', '⏺ Идёт запись…');
    if (st.pending) add('wait', 'Сыграйте: ' + [...st.pending.need].sort((a, b) => a - b).map(nm).join(' + '));
    if (T.check && st.score && st.score.total) add('score', `🎯 <b>${st.score.hit}</b> из ${st.score.total} · ${Math.round(st.score.hit / st.score.total * 100)}%`);
    if (T.who !== 'none' && !st.pending && !st.rec) add('', T.who === 'fret' ? 'Вы играете партию на грифе' : T.who === 'both' ? 'Вы играете обе руки' : T.who === 'R' ? 'Вы играете правую руку' : 'Вы играете левую руку');
    h.classList.toggle('on', h.children.length > 0);
  }
  // перемотка, пауза, конец повтора
  function onSeek() { st.pending = null; st.lastS = P.time.toSec(engine.nowTick()) - 0.01; st.checkFrom = st.lastS; st.inputs = []; for (const q of TG) if (q.ref) q.ref.res = null; hud(); }
  engine.audio.onLoopWrap = () => {
    let msg = '';
    if (T.check && st.score && st.score.total) msg = `Проход: ${Math.round(st.score.hit / st.score.total * 100)}% верно`;
    let ns = null;
    if (T.ramp && P.loop) {
      const sp = Math.min(T.to, Math.round((P.speed + T.step) * 100) / 100);
      if (sp !== P.speed) { ns = sp; P.speed = sp; engine.speed = sp; setTimeout(() => { updateUi(); }, 0); msg += (msg ? ' · ' : '') + 'Скорость ' + Math.round(sp * 100) + '%'; }
    }
    setTimeout(() => { st.checkFrom = P.time.toSec(P.loop.ta) - 0.01; st.inputs = []; st.lastS = st.checkFrom; for (const q of TG) if (q.ref) q.ref.res = null; if (msg) toast(msg); }, 30);
    return ns;
  };

  // ---------- запись своей игры ----------
  async function recStart() {
    if (st.rec) return recStop();
    if (mic) await micOff();
    const t0 = engine.audio.nowSec();
    mic = new MicNotes((m, perfT) => { const lag = (performance.now() - perfT) / 1000 + 0.06; input(m, 'mic', engine.audio.nowSec() - lag * engine.audio.speed); });
    const ok = await mic.start({ record: true });
    if (!ok) { toast('Нет доступа к микрофону'); mic = null; return; }
    st.rec = { t0, inputs: [], speed: P.speed, perf0: performance.now() };
    $('pracSheet').classList.remove('on');
    engine.play(); hud(); fill();
  }
  async function recStop() {
    if (!st.rec) return;
    const r = st.rec; st.rec = null;
    const t1 = engine.audio.nowSec(); engine.pause();
    const blob = mic ? await mic.stop() : null; mic = null;
    if (T.mic) micOn();
    hud(); fill();
    let buf = null;
    try { if (blob) buf = await engine.audio.ctx.decodeAudioData(await blob.arrayBuffer()); } catch (e) { }
    // результат: ноты партии ученика (или все видимые) на записанном отрезке
    const tg = targets().filter(q => q.s >= r.t0 && q.s <= t1 - 0.3);
    const res = scoreNotes(tg, r.inputs, t1);
    const miss = new Map();
    for (const q of tg) if (q.res === 'miss') { const mi = P.time.measureAtSec(q.s); const n = P.song.measures[mi].n; miss.set(n, (miss.get(n) || 0) + 1); }
    st.recBuf = buf; st.last = { t0: r.t0, t1, res, miss: [...miss], speed: r.speed };
    showRec();
  }
  function showRec() {
    const L = st.last; if (!L) return;
    const pct = L.res.total ? Math.round(L.res.hit / L.res.total * 100) : 0;
    const b = $('recBody'); b.innerHTML = '';
    const a = document.createElement('div'); a.className = 'recres';
    a.innerHTML = L.res.total ? `Верно сыграно: <b>${pct}%</b><br>${L.res.hit} из ${L.res.total} нот` : 'Нот партии на записанном отрезке нет — запишите подольше или выберите, что вы играете.';
    b.appendChild(a);
    const mm = document.createElement('div'); mm.className = 'recmiss';
    mm.textContent = L.miss.length ? 'Ошибки в тактах: ' + L.miss.map(([n, k]) => `${n} (${k})`).join(', ') : (L.res.total ? 'Без ошибок!' : '');
    b.appendChild(mm);
    const nt = document.createElement('p'); nt.className = 'muted small';
    nt.textContent = `Отрезок ${fmt(L.t0)}–${fmt(L.t1)}, скорость ${Math.round(L.speed * 100)}%. Микрофон слышит одну ноту за раз: в аккордах засчитывается любая из нот.`;
    b.appendChild(nt);
    $('recMine').disabled = !st.recBuf; $('recBoth').disabled = !st.recBuf;
    $('prLast').style.display = '';
    $('recSheet').classList.add('on');
  }
  const fmt = s => { s = Math.max(0, Math.round(s)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
  function stopRecPlay() { if (st.recSrc) try { st.recSrc.stop(); } catch (e) { } st.recSrc = null; }
  function playRec(withOrig) {
    stopRecPlay(); const L = st.last; if (!L) return;
    const ctx = engine.audio.ensureCtx();
    if (withOrig !== 'orig' && st.recBuf) {
      const src = ctx.createBufferSource(); src.buffer = st.recBuf; src.connect(engine.audio.master);
      src.start(ctx.currentTime + 0.08); st.recSrc = src;
    }
    if (withOrig) {
      setSpeed(L.speed);
      engine.seekTick(P.time.toTick(L.t0)); engine.play();
      const dur = (L.t1 - L.t0) / L.speed;
      clearTimeout(st.origT); st.origT = setTimeout(() => engine.pause(), dur * 1000 + 300);
    } else engine.pause();
  }
  $('recMine').onclick = () => playRec(false);
  $('recBoth').onclick = () => playRec(true);
  $('recOrig').onclick = () => playRec('orig');
  $('recStop').onclick = () => { stopRecPlay(); engine.pause(); };
  $('prRec').onclick = () => recStart();
  $('prLast').onclick = () => { $('pracSheet').classList.remove('on'); showRec(); };

  // ---------- окно «Разучивание» ----------
  function fill() {
    const who = $('prWho'); who.innerHTML = '';
    const hasKeys = (P.keysNotes || []).length, hasFret = (P.fretNotes || []).length;
    const opts = [['none', 'Ничего'], ...(hasKeys ? [['R', 'Правая рука'], ['L', 'Левая рука'], ['both', 'Обе руки']] : []), ...(hasFret ? [['fret', 'Партия на грифе']] : [])];
    for (const [v, l] of opts) { const b = document.createElement('button'); b.textContent = l; b.classList.toggle('on', T.who === v); b.onclick = () => { T.who = v; saveT(); rebuild(); fill(); }; who.appendChild(b); }
    $('prWait').checked = T.wait; $('prCheck').checked = T.check; $('prMic').checked = T.mic; $('prRamp').checked = T.ramp; $('prFing').checked = T.fing;
    const sel = (id, vals, cur, f) => { const s = $(id); s.innerHTML = ''; for (const v of vals) { const o = document.createElement('option'); o.value = v; o.textContent = f(v); s.appendChild(o); } s.value = cur; };
    sel('prFrom', [0.4, 0.5, 0.6, 0.7, 0.75, 0.8, 0.9], T.from, v => Math.round(v * 100) + '%');
    sel('prTo', [0.8, 0.9, 1, 1.1, 1.25], T.to, v => Math.round(v * 100) + '%');
    sel('prStep', [0.02, 0.05, 0.1], T.step, v => '+' + Math.round(v * 100) + '%');
    const inputs = ['экранные клавиши'];
    if (st.midiDevs.length) inputs.push('MIDI: ' + st.midiDevs.join(', ')); else inputs.push('MIDI-клавиатура по USB (не подключена)');
    if (T.mic) inputs.push('микрофон');
    $('prInputs').textContent = 'Откуда берутся ваши ноты: ' + inputs.join(' · ') + '.';
    $('prRec').textContent = st.rec ? '■ Остановить запись' : '⏺ Записать с текущего места';
    $('prScore').textContent = st.score && st.score.total ? `Сейчас: ${st.score.hit} из ${st.score.total} нот верно (${Math.round(st.score.hit / st.score.total * 100)}%)` : '';
  }
  $('prWait').onchange = e => { T.wait = e.target.checked; saveT(); rebuild(); };
  $('prCheck').onchange = e => { T.check = e.target.checked; saveT(); rebuild(); };
  $('prMic').onchange = async e => { T.mic = e.target.checked; saveT(); if (T.mic) await micOn(); else await micOff(); fill(); };
  $('prRamp').onchange = e => {
    T.ramp = e.target.checked; saveT();
    if (T.ramp) { if (!P.loop) toast('Включите «Повтор» нужного фрагмента — скорость будет расти с каждым кругом'); setSpeed(T.from); }
  };
  $('prFrom').onchange = e => { T.from = +e.target.value; saveT(); if (T.ramp) setSpeed(T.from); };
  $('prTo').onchange = e => { T.to = +e.target.value; saveT(); };
  $('prStep').onchange = e => { T.step = +e.target.value; saveT(); };
  $('prFing').onchange = e => { T.fing = e.target.checked; saveT(); prepare(); rebuild(); };
  const open = () => { fill(); $('pracSheet').classList.add('on'); };
  $('pracBtn').onclick = open; $('lPrac').onclick = open;

  return {
    rebuild, frame, input, onSeek, fill, isMine, handOf,
    onSong() { st.last = null; st.recBuf = null; $('prLast').style.display = 'none'; rebuild(); if (T.mic) micOn(); },
    onLeave() { if (st.rec) recStop(); micOff(); },
    get waiting() { return st.pending; }
  };
}
