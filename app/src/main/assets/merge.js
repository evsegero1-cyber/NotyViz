// Объединение партий из разных файлов в одну композицию на общей временной шкале.
// Основной файл задаёт темп и такты; остальные приводятся к нему по тактам или по реальному времени.
import { PPQ, makeTime, assignChannels } from './model.js';
import { barOf } from './import-midi.js';

const firstNote = song => {
  let t = Infinity;
  for (const tr of song.tracks) for (const n of tr.notes) if (!n.deleted && n.t < t) t = n.t;
  return t === Infinity ? 0 : t;
};
function measureIdx(measures, tick) {
  let lo = 0, hi = measures.length - 1;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (measures[m].tick <= tick) lo = m; else hi = m - 1; }
  return lo;
}
// Позиция в тактах: «такт 5, доля 2»
export function barPos(song, tick) {
  const ms = song.measures, i = measureIdx(ms, tick), m = ms[i];
  const beatTicks = PPQ * 4 / m.sig[1];
  return { bar: m.n, idx: i, beat: 1 + (tick - m.tick) / beatTicks };
}
export function sameTempo(a, b) {
  const ta = makeTime(a), tb = makeTime(b);
  const end = Math.min(a.totalTicks, b.totalTicks);
  for (let t = 0; t <= end; t += PPQ) if (Math.abs(ta.bpmAt(t) - tb.bpmAt(t)) > 0.5) return false;
  return true;
}
export function sameMeter(a, b) {
  const n = Math.min(a.measures.length, b.measures.length);
  for (let i = 0; i < n; i++) {
    const x = a.measures[i], y = b.measures[i];
    if (x.sig[0] !== y.sig[0] || x.sig[1] !== y.sig[1] || Math.abs(x.tick - y.tick) > 2) return false;
  }
  return true;
}
const tempoText = song => {
  const bpms = [...new Set(song.tempos.map(t => Math.round(t.bpm)))];
  return bpms.length === 1 ? `${bpms[0]} уд/мин` : `${bpms[0]} уд/мин (меняется ${song.tempos.length - 1} раз)`;
};

// Сведения о файлах и предупреждения
export function analyze(files, refIdx) {
  const ref = files[refIdx].song;
  const refFirst = barPos(ref, firstNote(ref));
  const warnings = [];
  const info = files.map((f, i) => {
    const s = f.song, tm = makeTime(s);
    const fn = firstNote(s), fp = barPos(s, fn);
    const sig = s.measures[0].sig.join('/');
    const sigs = [...new Set(s.measures.map(m => m.sig.join('/')))];
    const it = {
      tempo: tempoText(s), sig: sigs.length > 1 ? sigs.join(', ') : sig, bars: s.measures.length, dur: tm.total,
      first: `такт ${fp.bar}${fp.beat > 1.01 ? ', доля ' + (+fp.beat.toFixed(2)) : ''} (${tm.toSec(fn).toFixed(2)} с)`,
      sameTempo: i === refIdx || sameTempo(s, ref), sameMeter: i === refIdx || sameMeter(s, ref),
      startDiff: i !== refIdx && (fp.idx !== refFirst.idx || Math.abs(fp.beat - refFirst.beat) > 0.05),
      firstPos: fp
    };
    if (i !== refIdx) {
      if (!it.sameTempo) warnings.push(`«${f.name}»: другой темп (${it.tempo}, у основного ${tempoText(ref)}). Выберите, как синхронизировать: по тактам или по реальному времени.`);
      if (!it.sameMeter) warnings.push(`«${f.name}»: размер или длина тактов не совпадают с основным (${it.sig}). Проверьте результат на слух.`);
      // партии одной песни (темп, размер и число тактов совпадают) вступают в разное время — это нормально, сдвигать не нужно
      const sameSong = it.sameTempo && it.sameMeter && Math.abs(s.measures.length - ref.measures.length) <= 2; // последний пустой такт партия может не печатать
      if (it.startDiff && !sameSong) warnings.push(`«${f.name}»: первая нота в ${it.first}, у основного — такт ${refFirst.bar}${refFirst.beat > 1.01 ? ', доля ' + (+refFirst.beat.toFixed(2)) : ''}. Если партия вступает позже по задумке — ничего не меняйте; иначе задайте смещение или нажмите «Выровнять начало».`);
    }
    return it;
  });
  return { info, warnings };
}

// Смещение «выровнять начало»: в тактах основного файла
export function alignOffset(files, i, refIdx) {
  const ref = files[refIdx].song, s = files[i].song;
  const a = mapper(files[i], ref, { method: files[i].method, offset: null })(firstNote(s));
  return +((firstNote(ref) - a) / ref.measures[0].len).toFixed(4);
}

function mapper(f, ref, o) {
  const s = f.song;
  const same = s === ref || (sameTempo(s, ref) && sameMeter(s, ref));
  const method = o.method || 'bars';
  const refMs = ref.measures, last = refMs[refMs.length - 1];
  const rt = makeTime(ref), st = makeTime(s);
  const uniq = ms => new Set(ms.map(m => m.n)).size === ms.length;
  const byNum = uniq(refMs) && uniq(s.measures) ? new Map(refMs.map(m => [m.n, m])) : null;
  let dt = 0;
  const off = o.offset;
  if (off && off.v) dt = off.unit === 'ms' ? off.v / 1000 * rt.bpmAt(0) / 60 * PPQ : off.v * refMs[0].len;
  return tick => {
    let r;
    if (same) r = tick;
    else if (method === 'time') r = rt.toTick(st.toSec(tick));
    else {
      const i = measureIdx(s.measures, tick), m = s.measures[i];
      const frac = (tick - m.tick) / m.len;
      // если номера тактов в обоих файлах однозначны — сопоставляем по номеру такта
      const rm = byNum && byNum.get(m.n);
      if (rm) r = rm.tick + frac * rm.len;
      else if (i < refMs.length) r = refMs[i].tick + frac * refMs[i].len;
      else r = last.tick + (i - refMs.length + 1 + frac) * last.len;
    }
    return r + dt;
  };
}

// Сборка общей композиции
export function mergeSongs(files, refIdx, title, pianoName) {
  const ref = files[refIdx].song;
  const tracks = [];
  let total = ref.totalTicks, minT = 0;
  files.forEach((f, fi) => {
    const map = mapper(f, ref, { method: f.method, offset: f.offset });
    f.song.tracks.forEach((tr, ti) => {
      const sel = f.sel[ti]; if (!sel || !sel.on) return;
      const notes = [];
      const oct = tr.kind === 'drums' ? 0 : (sel.oct || 0) * 12;
      const hand = sel.hand && sel.hand !== 'auto' ? sel.hand : tr.hand;
      for (const n of tr.notes) {
        if (n.deleted) continue;
        const t0 = map(n.t), t1 = map(n.t + n.d);
        const q = { ...n, t: Math.round(t0), d: Math.max(1, Math.round(t1 - t0)), m: n.m + oct };
        if (hand && !q.h) q.h = hand;
        if (oct && q.s != null) { delete q.s; delete q.f; }
        delete q.page; delete q.box;
        notes.push(q);
        if (q.t + q.d > total) total = q.t + q.d;
        if (q.t < minT) minT = q.t;
      }
      tracks.push({
        name: sel.name || tr.name, instrument: tr.instrument, kind: tr.kind, program: sel.program != null ? sel.program : tr.program,
        tuning: oct ? null : tr.tuning || null, tuningNames: oct ? null : tr.tuningNames || null, hand, volume: 1, from: f.name, notes,
        ...(tr.bends ? { bends: tr.bends.map(([t, v]) => [Math.round(map(t)), v]) } : {}),
        ...(tr.pedal ? { pedal: tr.pedal.map(([a, b]) => [Math.round(map(a)), Math.round(map(b))]) } : {}),
        joinKey: sel.join ? 'piano' : null
      });
    });
  });
  if (!tracks.length) throw new Error('Не выбрано ни одной дорожки');
  // Умное объединение фортепиано: партии рук → одна дорожка, у каждой ноты своя рука
  const joined = tracks.filter(t => t.joinKey === 'piano');
  if (joined.length >= 2) {
    const R = joined.find(t => t.hand === 'R') || joined[0];
    const pianoTrack = {
      name: pianoName || 'Фортепиано', instrument: R.instrument, kind: 'piano', program: R.program, tuning: null, tuningNames: null, volume: 1,
      from: [...new Set(joined.map(t => t.from))].join(' + '),
      ...(joined.some(t => t.pedal) ? { pedal: joined.flatMap(t => t.pedal || []).sort((a, b) => a[0] - b[0]) } : {}),
      notes: joined.flatMap(t => t.notes.map(n => { const q = { ...n }; delete q.s; delete q.f; if (!q.h && t.hand) q.h = t.hand; return q; }))
    };
    const at = tracks.indexOf(joined[0]);
    for (const t of joined) tracks.splice(tracks.indexOf(t), 1);
    tracks.splice(at, 0, pianoTrack);
  }
  for (const t of tracks) delete t.joinKey;
  // Если смещение увело ноты раньше начала — сдвигаем всё вместе, чтобы ничего не потерять
  const shift = minT < 0 ? Math.ceil(-minT / ref.measures[0].len) * ref.measures[0].len : 0;
  const measures = ref.measures.map(m => ({ ...m, sig: [...m.sig] }));
  // метки частей (Intro, Chorus…) — из любого файла с тем же числом тактов
  if (!measures.some(m => m.marker)) for (const f of files) if (f.song.measures.length === measures.length && f.song.measures.some(m => m.marker)) { f.song.measures.forEach((m, i) => { if (m.marker) measures[i].marker = m.marker; }); break; }
  const tempos = ref.tempos.map(t => ({ ...t }));
  if (shift) {
    for (const tr of tracks) { for (const n of tr.notes) n.t += shift; if (tr.bends) for (const b of tr.bends) b[0] += shift; if (tr.pedal) for (const q of tr.pedal) { q[0] += shift; q[1] += shift; } }
    for (const m of measures) m.tick += shift;
    for (const t of tempos) t.tick += shift;
    tempos.unshift({ tick: 0, bpm: tempos[0].bpm });
    const L = ref.measures[0].len, sig = measures[0].sig, pre = [];
    for (let k = 0; k < shift / L; k++) pre.push({ n: 0, tick: k * L, len: L, sig: [...sig] });
    measures.unshift(...pre); measures.forEach((m, i) => m.n = i + 1);
    total += shift;
  }
  const song = { v: 2, title, source: 'merge', custom: true, tempos, measures, totalTicks: total, tracks, files: files.map(f => f.name) };
  extendMeasures(song);
  for (const tr of tracks) { tr.notes.sort((a, b) => a.t - b.t || a.m - b.m); for (const n of tr.notes) n.bar = barOf(song.measures, n.t); }
  const ok = assignChannels(tracks);
  return { song, tooMany: !ok };
}

// Такты до конца композиции (по последнему размеру)
export function extendMeasures(song) {
  const ms = song.measures; let last = ms[ms.length - 1];
  while (last.tick + last.len < song.totalTicks) {
    last = { n: last.n + 1, tick: last.tick + last.len, len: last.len, sig: [...last.sig] }; ms.push(last);
  }
  song.totalTicks = Math.max(song.totalTicks, last.tick + last.len);
}

// Партии фортепиано среди выбранных дорожек (для умного объединения)
export function pianoParts(files) {
  const out = [];
  files.forEach((f, fi) => f.song.tracks.forEach((tr, ti) => {
    const sel = f.sel[ti];
    if (sel && sel.on && tr.kind === 'piano') out.push({ fi, ti, tr, sel, hand: sel.hand && sel.hand !== 'auto' ? sel.hand : tr.hand || null });
  }));
  return out;
}
const median = a => { if (!a.length) return 0; const b = [...a].sort((x, y) => x - y); return b[b.length >> 1]; };
// Левая рука выше правой — почти наверняка ошибка октавы (например, неверно угадан строй в PDF)
export function handOctaveCheck(parts) {
  const L = parts.filter(p => p.hand === 'L'), R = parts.filter(p => p.hand === 'R');
  if (!L.length || !R.length) return null;
  const pitch = p => p.tr.notes.filter(n => !n.deleted).map(n => n.m + 12 * (p.sel.oct || 0));
  const mL = median(L.flatMap(pitch)), mR = median(R.flatMap(pitch));
  if (mL >= mR) return { shift: -Math.ceil((mL - mR + 6) / 12), L, mL, mR };
  if (mR - mL > 36) return { shift: 1, L, mL, mR, far: true };
  return null;
}
