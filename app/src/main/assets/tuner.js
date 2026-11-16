// Тюнер через микрофон: инструмент и строй, автоопределение струны, стрелка в центах.
import { detectPitch, freqToMidi, midiToFreq } from './pitch.js';
import { INSTRUMENTS, midiName, midiNameOct, RU } from './tunings.js';
import { ls } from './store.js';

const $ = id => document.getElementById(id);

export function initTuner({ show, engine, toast }) {
  const S = Object.assign({ inst: 'guitar6', tuning: 'std', a4: 440 }, ls.get('nv-tuner', {}));
  let custom = null;          // строй композиции, если его нет в списке
  let back = 'home', stream = null, ctx = null, an = null, buf = null, raf = 0, lastDet = 0;
  let manual = -1, cur = null, hist = [], tuned = new Set(), inTuneSince = 0, lastHeard = 0, err = '';
  const save = () => ls.set('nv-tuner', { inst: S.inst, tuning: S.tuning, a4: S.a4 });
  const inst = () => INSTRUMENTS.find(i => i.id === S.inst) || INSTRUMENTS[0];
  const tun = () => custom && S.tuning === '__song' ? custom : (inst().tunings.find(t => t.id === S.tuning) || inst().tunings[0]);
  const chromatic = () => S.inst === 'chromatic';

  function fillSelects() {
    const si = $('tuInst'); si.innerHTML = '';
    for (const i of INSTRUMENTS) { const o = document.createElement('option'); o.value = i.id; o.textContent = i.name; si.appendChild(o); }
    si.value = S.inst;
    si.onchange = () => { S.inst = si.value; S.tuning = inst().tunings[0].id; custom = null; reset(); fillSelects(); save(); };
    const st = $('tuTun'); st.innerHTML = '';
    if (custom) { const o = document.createElement('option'); o.value = '__song'; o.textContent = custom.name; st.appendChild(o); }
    for (const t of inst().tunings) { const o = document.createElement('option'); o.value = t.id; o.textContent = t.name + (t.notes.length ? ' — ' + t.notes.map(n => n.replace(/-?\d$/, '')).join(' ') : ''); st.appendChild(o); }
    st.value = custom && S.tuning === '__song' ? '__song' : tun().id;
    st.style.display = chromatic() ? 'none' : '';
    st.onchange = () => { S.tuning = st.value; reset(); fillStrings(); save(); };
    fillStrings();
  }
  function reset() { manual = -1; tuned = new Set(); hist = []; cur = null; }
  function fillStrings() {
    const box = $('tuStrings'); box.innerHTML = '';
    const t = tun(); if (chromatic()) { $('tuAuto').style.display = 'none'; return; }
    $('tuAuto').style.display = '';
    t.midi.forEach((m, i) => {
      const b = document.createElement('button'); b.className = 'tustr';
      b.innerHTML = `<b>${midiName(m).replace('#', '♯')}</b><span>${t.midi.length - i}</span>`;
      b.title = 'Струна ' + (t.midi.length - i) + ': ' + midiNameOct(m);
      b.onclick = () => { manual = manual === i ? -1 : i; playTone(i); paintStrings(); };
      box.appendChild(b);
    });
    paintStrings();
  }
  function paintStrings() {
    const bs = $('tuStrings').children, tgt = cur && cur.si;
    for (let i = 0; i < bs.length; i++) {
      bs[i].classList.toggle('sel', manual === i);
      bs[i].classList.toggle('cur', tgt === i);
      bs[i].classList.toggle('ok', tuned.has(i));
    }
    $('tuAuto').classList.toggle('on', manual < 0);
    $('tuAuto').textContent = manual < 0 ? 'Авто: струна определяется сама' : 'Выбрана струна ' + (tun().midi.length - manual) + ' — нажмите, чтобы вернуть авто';
  }
  function playTone(i) {
    const m = tun().midi[i]; if (m == null) return;
    const timbre = inst().kind === 'bass' ? 'bass_finger' : (S.inst === 'violin' || S.inst === 'viola' || S.inst === 'cello') ? 'gm:40' : 'egtr_clean';
    try { engine.previewNote(m, 0, false, timbre); } catch (e) { }
  }
  $('tuAuto').onclick = () => { manual = -1; paintStrings(); };
  const A4S = [440, 441, 442, 443, 444, 445, 432, 435, 436, 438, 439];
  $('tuA4').onclick = () => {
    S.a4 = A4S[(A4S.indexOf(S.a4) + 1) % A4S.length]; save(); reset();
    $('tuA4').textContent = 'A = ' + S.a4 + ' Гц';
    if (toast) toast('Эталон: ля первой октавы = ' + S.a4 + ' Гц' + (S.a4 === 440 ? ' (стандарт)' : ''));
  };
  $('tuBack').onclick = () => { close(); show(back); };

  async function start() {
    err = '';
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    } catch (e) {
      err = 'Нет доступа к микрофону. Разрешите приложению NotyViz микрофон (Настройки Android → Приложения → NotyViz → Разрешения) и откройте тюнер снова.';
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    ctx = new AC();
    const src = ctx.createMediaStreamSource(stream);
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 22;
    an = ctx.createAnalyser(); an.fftSize = 8192; an.smoothingTimeConstant = 0;
    src.connect(hp); hp.connect(an);
    buf = new Float32Array(an.fftSize);
  }
  function close() {
    cancelAnimationFrame(raf); raf = 0;
    if (stream) stream.getTracks().forEach(t => t.stop()); stream = null;
    if (ctx) try { ctx.close(); } catch (e) { } ctx = null; an = null;
  }

  // ---- анализ ----
  function analyse(now) {
    if (!an) return;
    an.getFloatTimeDomainData(buf);
    const low = inst().kind === 'bass' || (tun().midi[0] || 99) < 38;
    const N = low ? 8192 : 4096;
    const view = N === buf.length ? buf : buf.subarray(buf.length - N);
    const t = tun();
    const lo = chromatic() ? 27 : Math.max(25, midiToFreq(Math.min(...t.midi) - 5, S.a4));
    const hi = chromatic() ? 1500 : Math.min(2000, midiToFreq(Math.max(...t.midi) + 5, S.a4));
    const r = detectPitch(view, ctx.sampleRate, { fMin: lo, fMax: hi * 1.05 });
    if (!r || r.clarity < 0.8) { if (now - lastHeard > 900) { cur = null; hist = []; } return; }
    lastHeard = now;
    hist.push(r.freq); if (hist.length > 5) hist.shift();
    const f = [...hist].sort((a, b) => a - b)[hist.length >> 1];
    // скачок высоты (дёрнули другую струну) — сбрасываем историю
    if (Math.abs(1200 * Math.log2(r.freq / f)) > 80) { hist = [r.freq]; }
    const mid = freqToMidi(hist.length > 2 ? f : r.freq, S.a4);
    let target, si = null;
    if (chromatic()) target = Math.round(mid);
    else if (manual >= 0) { target = t.midi[manual]; si = manual; }
    else { let bd = 1e9; t.midi.forEach((m, i) => { const d = Math.abs(mid - m); if (d < bd) { bd = d; si = i; } }); target = t.midi[si]; }
    const cents = (mid - target) * 100;
    const sm = cur && cur.target === target ? cur.cents * 0.6 + cents * 0.4 : cents;
    cur = { freq: midiToFreq(mid, S.a4), target, cents: sm, si };
    if (Math.abs(sm) < 4) { if (!inTuneSince) inTuneSince = now; if (now - inTuneSince > 450 && si != null && !tuned.has(si)) { tuned.add(si); try { navigator.vibrate && navigator.vibrate(40); } catch (e) { } } }
    else inTuneSince = 0;
    paintStrings();
  }

  // ---- рисование ----
  function draw() {
    const cv = $('tuCv'), r = cv.getBoundingClientRect(); if (!r.width) return;
    const dpr = Math.min(2.5, window.devicePixelRatio || 1);
    if (cv.width !== Math.round(r.width * dpr)) { cv.width = Math.round(r.width * dpr); cv.height = Math.round(r.height * dpr); }
    const g = cv.getContext('2d'), W = r.width, H = r.height; g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    const cx = W / 2, R = Math.min(W * 0.42, H * 0.62), cy = Math.min(H - 12, R + 30);
    const ok = cur && Math.abs(cur.cents) < 4;
    // шкала −50…+50 центов
    const a0 = -Math.PI * 0.8, a1 = -Math.PI * 0.2, ang = c => -Math.PI / 2 + Math.max(-50, Math.min(50, c)) / 50 * (Math.PI * 0.3);
    g.lineWidth = 10; g.lineCap = 'round';
    g.strokeStyle = '#20242d'; g.beginPath(); g.arc(cx, cy, R, a0, a1); g.stroke();
    g.strokeStyle = 'rgba(60,207,142,.45)'; g.beginPath(); g.arc(cx, cy, R, ang(-5), ang(5)); g.stroke();
    g.lineWidth = 2; g.strokeStyle = '#5b6372'; g.fillStyle = '#8b93a3'; g.font = '11px system-ui'; g.textAlign = 'center';
    for (let c = -50; c <= 50; c += 10) {
      const a = ang(c), l = c % 50 === 0 ? 16 : c === 0 ? 18 : 9;
      g.beginPath(); g.moveTo(cx + Math.cos(a) * (R - 14), cy + Math.sin(a) * (R - 14)); g.lineTo(cx + Math.cos(a) * (R - 14 - l), cy + Math.sin(a) * (R - 14 - l)); g.stroke();
      if (c % 25 === 0) g.fillText((c > 0 ? '+' : '') + c, cx + Math.cos(a) * (R + 16), cy + Math.sin(a) * (R + 16) + 4);
    }
    // нота
    g.textBaseline = 'alphabetic';
    if (err) {
      g.fillStyle = '#ff8f8f'; g.font = '15px system-ui'; wrap(g, err, cx, cy - R * 0.55, W - 40, 20);
    } else if (cur) {
      const col = ok ? '#3ccf8e' : Math.abs(cur.cents) < 15 ? '#ffd23f' : '#ff8a3d';
      const a = ang(cur.cents);
      // стрелка — только у шкалы, чтобы не закрывать ноту
      g.strokeStyle = col; g.lineWidth = 5; g.beginPath(); g.moveTo(cx + Math.cos(a) * (R * 0.7), cy + Math.sin(a) * (R * 0.7)); g.lineTo(cx + Math.cos(a) * (R + 6), cy + Math.sin(a) * (R + 6)); g.stroke();
      g.fillStyle = col; g.beginPath(); g.arc(cx + Math.cos(a) * (R * 0.7), cy + Math.sin(a) * (R * 0.7), 5, 0, 7); g.fill();
      g.fillStyle = ok ? '#3ccf8e' : '#e9ecf2'; g.font = `700 ${Math.round(R * 0.42)}px system-ui`;
      g.fillText(midiName(cur.target).replace('#', '♯'), cx, cy - R * 0.38);
      g.font = '15px system-ui'; g.fillStyle = '#8b93a3';
      const oct = Math.floor(cur.target / 12) - 1;
      g.fillText(`${RU[cur.target % 12]} · октава ${oct} · ${cur.freq.toFixed(1)} Гц`, cx, cy - R * 0.38 + 24);
      g.font = '600 17px system-ui'; g.fillStyle = col;
      const msg = ok ? '✓ Настроено' : cur.cents < 0 ? `Подтяните струну ↑  (${Math.round(cur.cents)} ц)` : `Ослабьте струну ↓  (+${Math.round(cur.cents)} ц)`;
      g.fillText(msg, cx, cy + 6 + 26);
      if (cur.si != null && !chromatic()) { g.font = '13px system-ui'; g.fillStyle = '#8b93a3'; g.fillText(`Струна ${tun().midi.length - cur.si} (${midiNameOct(tun().midi[cur.si]).replace('#', '♯')})`, cx, cy + 6 + 48); }
    } else {
      g.fillStyle = '#8b93a3'; g.font = '16px system-ui';
      g.fillText(an ? 'Дёрните струну' : 'Включаю микрофон…', cx, cy - R * 0.38);
    }
  }
  function wrap(g, txt, x, y, w, lh) {
    const words = txt.split(' '); let line = '';
    for (const wd of words) { const t = line ? line + ' ' + wd : wd; if (g.measureText(t).width > w && line) { g.fillText(line, x, y); y += lh; line = wd; } else line = t; }
    if (line) g.fillText(line, x, y);
  }
  function loop(now) {
    raf = requestAnimationFrame(loop);
    if (now - lastDet > 45) { lastDet = now; analyse(now); }
    draw();
  }

  // preset: { inst, tuning } или { inst, custom: [midi от низкой струны], name }
  async function open(preset, from) {
    back = from || 'home';
    try { engine.pause(); } catch (e) { }
    custom = null;
    if (preset) {
      S.inst = preset.inst || S.inst;
      if (preset.tuning) S.tuning = preset.tuning;
      else if (preset.custom) { custom = { id: '__song', name: preset.name || 'Строй композиции', midi: preset.custom, notes: preset.custom.map(midiNameOct) }; S.tuning = '__song'; }
    }
    reset(); fillSelects();
    $('tuA4').textContent = 'A = ' + S.a4 + ' Гц';
    show('tuner');
    cancelAnimationFrame(raf); raf = requestAnimationFrame(loop);
    if (!stream) await start();
  }
  document.addEventListener('visibilitychange', () => { if (document.hidden && stream) { close(); } else if (!document.hidden && $('tuner').classList.contains('on') && !stream) { start().then(() => { cancelAnimationFrame(raf); raf = requestAnimationFrame(loop); }); } });
  return { open, close, _state: () => ({ cur, tuned: [...tuned], S, err }) };
}
