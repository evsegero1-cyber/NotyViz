// Разучивание в плеере: кто что играет, «жду ноту», проверка игры, плавное ускорение,
// MIDI-клавиатура, микрофон, запись своей игры.
import { MicNotes, scoreNotes } from './practice.js';
import { ls } from './store.js';

const $ = id => document.getElementById(id);
const NAMES = ['до', 'до♯', 'ре', 'ми♭', 'ми', 'фа', 'фа♯', 'соль', 'ля♭', 'ля', 'си♭', 'си'];
const nm = m => NAMES[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1);

export function initTrain(d) {
  const { P, engine, toast, curTimbre, prepare, setSpeed, updateUi, saveSet, setLoop } = d;
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
    if (RF.on && P.loop) add('', `🔁 Риф ${P.loop.from}–${P.loop.to} · круг ${RF.rounds + 1} · ${Math.round(P.speed * 100)}%` + (RF.best ? ` · лучший ${Math.round(RF.best * 100)}%` : ''));
    if (st.pending) add('wait', 'Сыграйте: ' + [...st.pending.need].sort((a, b) => a - b).map(nm).join(' + '));
    if (T.check && st.score && st.score.total) add('score', `🎯 <b>${st.score.hit}</b> из ${st.score.total} · ${Math.round(st.score.hit / st.score.total * 100)}%`);
    if (T.who !== 'none' && !st.pending && !st.rec) add('', T.who === 'fret' ? 'Вы играете партию на грифе' : T.who === 'both' ? 'Вы играете обе руки' : T.who === 'R' ? 'Вы играете правую руку' : 'Вы играете левую руку');
    h.classList.toggle('on', h.children.length > 0);
  }
  // перемотка, пауза, конец повтора
  function onSeek() { st.pending = null; st.lastS = P.time.toSec(engine.nowTick()) - 0.01; st.checkFrom = st.lastS; st.inputs = []; for (const q of TG) if (q.ref) q.ref.res = null; hud(); }
  engine.audio.onLoopWrap = () => {
    let msg = '';
    const pct = st.score && st.score.total ? st.score.hit / st.score.total : null;
    if (T.check && pct != null) msg = `Проход: ${Math.round(pct * 100)}% верно`;
    let ns = null;
    if (RF.on && P.loop) {
      RF.rounds++; if (pct != null) RF.best = Math.max(RF.best || 0, pct);
      const up = RF.mode === 'each' || (RF.mode === 'good' && pct != null && pct >= 0.9);
      if (up) { const sp = Math.min(RF.s1, Math.round((P.speed + RF.step) * 100) / 100); if (sp !== P.speed) { ns = sp; P.speed = sp; engine.speed = sp; msg += (msg ? ' · ' : '') + 'Скорость ' + Math.round(sp * 100) + '%'; } else if (P.speed >= RF.s1 && !RF.done) { RF.done = true; msg += (msg ? ' · ' : '') + 'Целевой темп достигнут!'; } }
      else if (RF.mode === 'good' && pct != null) msg += ' · нужно 90%, чтобы ускорить';
      setTimeout(() => { updateUi(); hud(); }, 0);
    } else if (T.ramp && P.loop) {
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
  // ---------- риф-репитер ----------
  const RF = Object.assign({ on: false, s0: 0.6, s1: 1, step: 0.05, mode: 'each', count: false, rounds: 0 }, ls.get('nv-riff', {}), { on: false, rounds: 0 });
  const saveRF = () => ls.set('nv-riff', { s0: RF.s0, s1: RF.s1, step: RF.step, mode: RF.mode, count: RF.count });
  const curMeasure = () => P.song.measures[P.time.measureAtSec(engine.audio.nowSec() + 0.01)].n;
  const mMax = () => P.song.measures[P.song.measures.length - 1].n;
  function rfFill() {
    if (!$('rfA').value) { const a = P.loop ? P.loop.from : curMeasure(); $('rfA').value = a; $('rfB').value = P.loop ? P.loop.to : Math.min(mMax(), a + 3); }
    const sel = (id, vals, cur, f) => { const s = $(id); s.innerHTML = ''; for (const v of vals) { const o = document.createElement('option'); o.value = v; o.textContent = f(v); s.appendChild(o); } s.value = cur; };
    sel('rfS0', [0.3, 0.4, 0.5, 0.6, 0.7, 0.75, 0.8, 0.9, 1], RF.s0, v => Math.round(v * 100) + '%');
    sel('rfS1', [0.6, 0.7, 0.8, 0.9, 1, 1.1, 1.25], RF.s1, v => Math.round(v * 100) + '%');
    sel('rfStep', [0.02, 0.05, 0.1], RF.step, v => '+' + Math.round(v * 100) + '%');
    for (const b of $('rfMode').children) b.classList.toggle('on', b.dataset.v === RF.mode);
    $('rfModeInfo').textContent = RF.mode === 'good' ? 'Проверка игры включится сама: ускорение — только после круга, сыгранного на 90% и лучше (экранные клавиши, MIDI или микрофон).' : '';
    $('rfCount').checked = RF.count;
    const a = +$('rfA').value, b = +$('rfB').value;
    $('rfInfo').textContent = a && b ? `Такты ${a}–${b}: ${b - a + 1} ${b - a + 1 === 1 ? 'такт' : b - a + 1 < 5 ? 'такта' : 'тактов'}` : '';
    $('rfGo').textContent = RF.on ? '■ Остановить риф-репитер' : '▶ Начать';
    $('rfStat').textContent = RF.on ? `Круг ${RF.rounds + 1}, скорость ${Math.round(P.speed * 100)}%` + (RF.best ? `, лучший результат ${Math.round(RF.best * 100)}%` : '') : '';
  }
  const clampM = v => Math.max(P.song.measures[0].n, Math.min(mMax(), v));
  const setAB = (a, b) => { a = clampM(a); b = clampM(Math.max(a, b)); $('rfA').value = a; $('rfB').value = b; rfFill(); if (RF.on) setLoop(a, b); };
  $('rfA-').onclick = () => setAB(+$('rfA').value - 1, +$('rfB').value); $('rfA+').onclick = () => setAB(+$('rfA').value + 1, +$('rfB').value);
  $('rfB-').onclick = () => setAB(+$('rfA').value, +$('rfB').value - 1); $('rfB+').onclick = () => setAB(+$('rfA').value, +$('rfB').value + 1);
  $('rfA').onchange = $('rfB').onchange = () => setAB(+$('rfA').value, +$('rfB').value);
  $('rfHere').onclick = () => { const a = curMeasure(); setAB(a, a + Math.max(0, +$('rfB').value - +$('rfA').value)); };
  for (const b of document.querySelectorAll('.rflen')) b.onclick = () => { const a = +$('rfA').value || curMeasure(); setAB(a, a + +b.dataset.len - 1); };
  $('rfMarkA').onclick = () => { const a = curMeasure(); setAB(a, Math.max(a, +$('rfB').value)); toast('Начало: такт ' + a); };
  $('rfMarkB').onclick = () => { const b = curMeasure(); setAB(Math.min(+$('rfA').value, b), b); toast('Конец: такт ' + b); };
  $('rfS0').onchange = e => { RF.s0 = +e.target.value; saveRF(); };
  $('rfS1').onchange = e => { RF.s1 = +e.target.value; saveRF(); };
  $('rfStep').onchange = e => { RF.step = +e.target.value; saveRF(); };
  for (const b of $('rfMode').children) b.onclick = () => { RF.mode = b.dataset.v; saveRF(); rfFill(); };
  $('rfCount').onchange = e => { RF.count = e.target.checked; saveRF(); applyCount(); };
  function applyCount() {
    if (RF.on && RF.count) { const m = P.song.measures[P.time.measureAtSec(P.time.toSec(P.loop.ta))]; const beats = m.sig[0], spb = 60 / (P.song.tempos[0].bpm || 120) * 4 / m.sig[1]; engine.audio.setCountIn(beats, P.time.toSec(P.loop.ta + m.len / beats) - P.time.toSec(P.loop.ta) || spb); }
    else engine.audio.setCountIn(0);
  }
  function rfStart() {
    const a = +$('rfA').value, b = +$('rfB').value; if (!a || !b) return;
    RF.on = true; RF.rounds = 0; RF.best = 0; RF.done = false;
    if (RF.mode === 'good' && !T.check) { T.check = true; saveT(); rebuild(); }
    engine.pause(); setLoop(a, b); setSpeed(RF.s0); engine.seekTick(P.loop.ta);
    applyCount();
    $('riffSheet').classList.remove('on');
    if (RF.count) { // отсчёт перед первым кругом
      const ctx = engine.audio.ensureCtx(), cnt = engine.audio.countIn || { beats: 4, beat: 0.5 }, bc = cnt.beat / P.speed;
      engine.audio.setMetronome(engine.audio.metro); // загрузить щелчки
      const go = () => { const t0 = ctx.currentTime + 0.05; for (let k = 0; k < cnt.beats; k++) engine.audio.click(t0 + k * bc, k === 0); setTimeout(() => engine.play(), cnt.beats * bc * 1000 - 30); };
      if (engine.audio.metroInst) go(); else { engine.audio.loadMetro().then(go); }
    } else engine.play();
    hud();
  }
  function rfStop() { RF.on = false; engine.audio.setCountIn(0); hud(); rfFill(); toast('Риф-репитер выключен' + (RF.rounds ? `: ${RF.rounds} кругов` : '')); }
  $('rfGo').onclick = () => { if (RF.on) rfStop(); else rfStart(); };
  const openRiff = () => { $('rfA').value = ''; rfFill(); $('riffSheet').classList.add('on'); };
  $('riffBtn').onclick = openRiff; if ($('lLoop')) $('lLoop').onclick = openRiff;

  const open = () => { fill(); $('pracSheet').classList.add('on'); };
  $('pracBtn').onclick = open; $('lPrac').onclick = open;

  return {
    rebuild, frame, input, onSeek, fill, isMine, handOf,
    riffOff() { if (RF.on) rfStop(); },
    onSong() { RF.on = false; engine.audio.setCountIn(0); st.last = null; st.recBuf = null; $('prLast').style.display = 'none'; rebuild(); if (T.mic) micOn(); },
    onLeave() { if (st.rec) recStop(); micOff(); },
    get waiting() { return st.pending; }
  };
}
