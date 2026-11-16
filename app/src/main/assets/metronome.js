// Метроном отдельным экраном: темп, размер, акценты, дробление доли, «тап», огоньки долей.
import { ls } from './store.js';
const $ = id => document.getElementById(id);

const METERS = [[2, 4], [3, 4], [4, 4], [5, 4], [6, 8], [7, 8], [9, 8], [12, 8]];
const SUBS = [['1', 'Доли', 1], ['2', 'Восьмые', 2], ['3', 'Триоли', 3], ['4', '16-е', 4]];
const TEMPO_NAMES = [[40, 'Largo'], [60, 'Adagio'], [76, 'Andante'], [108, 'Moderato'], [120, 'Allegro'], [168, 'Presto'], [999, 'Prestissimo']];

export function initMetronome({ show }) {
  const S = Object.assign({ bpm: 100, meter: 2, sub: 0, accent: true, vol: 0.8 }, ls.get('nv-metro', {}));
  let ctx = null, timer = 0, next = 0, step = 0, playing = false, back = 'home', taps = [], lit = -1, litT = [];
  const save = () => ls.set('nv-metro', S);
  const beatsPerBar = () => METERS[S.meter][0];
  // для x/8 считаем восьмыми, но группируем по 3 (6/8 — две доли по три)
  const beatLen = () => 60 / S.bpm * (METERS[S.meter][1] === 8 ? 0.5 : 1);

  function click(t, kind) {
    const o = ctx.createOscillator(), g = ctx.createGain(), f = ctx.createBiquadFilter();
    o.type = 'triangle'; o.frequency.value = kind === 2 ? 1760 : kind === 1 ? 1175 : 880;
    f.type = 'bandpass'; f.frequency.value = o.frequency.value; f.Q.value = 2;
    const a = S.vol * (kind === 2 ? 1 : kind === 1 ? 0.75 : 0.4);
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(a, t + 0.001); g.gain.exponentialRampToValueAtTime(0.001, t + (kind ? 0.06 : 0.035));
    o.connect(f); f.connect(g); g.connect(ctx.destination); o.start(t); o.stop(t + 0.08);
  }
  function schedule() {
    const subs = SUBS[S.sub][2], bpb = beatsPerBar();
    while (next < ctx.currentTime + 0.12) {
      const beat = Math.floor(step / subs), isBeat = step % subs === 0;
      const inBar = beat % bpb;
      const group8 = METERS[S.meter][1] === 8 && inBar % 3 === 0;
      const kind = !isBeat ? 0 : (inBar === 0 && S.accent) ? 2 : (group8 || METERS[S.meter][1] === 4) ? 1 : 0.5;
      click(next, kind === 0.5 ? 0 : kind);
      if (isBeat) litT.push([next, inBar]);
      next += beatLen() / subs; step++;
    }
  }
  function start() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!ctx) ctx = new AC();
    if (ctx.state !== 'running') ctx.resume();
    playing = true; step = 0; next = ctx.currentTime + 0.06; litT = [];
    schedule(); timer = setInterval(schedule, 25); draw(); paint();
  }
  function stop() { playing = false; clearInterval(timer); lit = -1; litT = []; paint(); }
  function restart() { if (playing) { stop(); start(); } }

  function paint() {
    $('mtBpm').textContent = S.bpm;
    $('mtName').textContent = TEMPO_NAMES.find(([b]) => S.bpm < b)[1];
    $('mtRange').value = S.bpm;
    $('mtPlay').textContent = playing ? '■ Стоп' : '▶ Старт';
    $('mtPlay').classList.toggle('on', playing);
    for (const b of $('mtMeter').children) b.classList.toggle('on', +b.dataset.i === S.meter);
    for (const b of $('mtSub').children) b.classList.toggle('on', +b.dataset.i === S.sub);
    $('mtAccent').checked = S.accent;
    const dots = $('mtDots'); const n = beatsPerBar();
    if (dots.children.length !== n) { dots.innerHTML = ''; for (let i = 0; i < n; i++) { const d = document.createElement('span'); dots.appendChild(d); } }
    [...dots.children].forEach((d, i) => { d.classList.toggle('on', i === lit); d.classList.toggle('acc', i === 0 && S.accent); });
  }
  function draw() {
    if (!playing) return;
    requestAnimationFrame(draw);
    const now = ctx.currentTime - (ctx.outputLatency || ctx.baseLatency || 0);
    let changed = false;
    while (litT.length && litT[0][0] <= now) { lit = litT.shift()[1]; changed = true; }
    if (changed) paint();
  }
  const setBpm = v => { S.bpm = Math.max(20, Math.min(300, Math.round(v))); save(); paint(); };
  // элементы управления
  METERS.forEach(([a, b], i) => { const x = document.createElement('button'); x.dataset.i = i; x.textContent = a + '/' + b; x.onclick = () => { S.meter = i; save(); restart(); paint(); }; $('mtMeter').appendChild(x); });
  SUBS.forEach(([, n], i) => { const x = document.createElement('button'); x.dataset.i = i; x.textContent = n; x.onclick = () => { S.sub = i; save(); restart(); paint(); }; $('mtSub').appendChild(x); });
  $('mtRange').oninput = () => setBpm(+$('mtRange').value);
  $('mtMinus').onclick = () => setBpm(S.bpm - 1); $('mtPlus').onclick = () => setBpm(S.bpm + 1);
  $('mtMinus5').onclick = () => setBpm(S.bpm - 5); $('mtPlus5').onclick = () => setBpm(S.bpm + 5);
  $('mtAccent').onchange = () => { S.accent = $('mtAccent').checked; save(); paint(); };
  $('mtPlay').onclick = () => { if (playing) stop(); else start(); };
  $('mtTap').onclick = () => {
    const t = performance.now(); taps = taps.filter(x => t - x < 2500); taps.push(t);
    if (taps.length >= 2) { const d = (taps[taps.length - 1] - taps[0]) / (taps.length - 1); setBpm(60000 / d); }
  };
  $('mtBack').onclick = () => { stop(); show(back); };
  document.addEventListener('visibilitychange', () => { if (document.hidden && playing) stop(); });
  return { open(from, bpm) { back = from || 'home'; if (bpm) S.bpm = Math.round(bpm); paint(); show('metro'); }, stop };
}
