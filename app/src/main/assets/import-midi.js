// Импорт MIDI (.mid/.midi) через @tonejs/midi → модель v2
import { velToDyn } from './techniques.js';
import { PPQ, handFromName, kindFromProgram, programName, buildMeasures, assignChannels, assignFrets, STD_TUNING, isStringKind } from './model.js';

// Названия в MIDI часто в UTF-8 или Windows-1251, а парсер отдаёт их побайтно
const fixText = s => {
  s = s || '';
  if (![...s].every(c => c.charCodeAt(0) < 256) || !/[\x80-\xff]/.test(s)) return s;
  const b = Uint8Array.from(s, c => c.charCodeAt(0));
  try { return new TextDecoder('utf-8', { fatal: true }).decode(b); } catch (e) { }
  try { return new TextDecoder('windows-1251').decode(b); } catch (e) { }
  return s;
};

export function importMidi(MidiClass, bytes, fileName) {
  const midi = new MidiClass(bytes);
  const k = PPQ / midi.header.ppq;
  const T = t => Math.round(t * k);
  const tempos = midi.header.tempos.map(t => ({ tick: T(t.ticks), bpm: +t.bpm.toFixed(3) }));
  if (!tempos.length || tempos[0].tick > 0) tempos.unshift({ tick: 0, bpm: tempos.length ? tempos[0].bpm : 120 });
  const sigs = midi.header.timeSignatures.map(s => ({ tick: T(s.ticks), sig: [s.timeSignature[0], s.timeSignature[1]] }));
  const tracks = [];
  let total = 0;
  for (const tr of midi.tracks) {
    if (!tr.notes.length) continue;
    const isDrum = tr.channel === 9 || (tr.instrument && tr.instrument.percussion);
    const program = tr.instrument ? tr.instrument.number : 0;
    const kind = kindFromProgram(program, isDrum, tr.name);
    const notes = tr.notes.map(n => ({ t: T(n.ticks), d: Math.max(1, T(n.durationTicks)), m: n.midi, v: Math.round((n.velocity || 0.8) * 127) }));
    for (const n of notes) total = Math.max(total, n.t + n.d);
    const name = fixText(tr.name).trim() || programName(program, kind);
    const t = { name, instrument: programName(program, kind), kind, program, notes };
    for (const n of notes) n.real = true;
    // Подтяжки (pitch bend): диапазон берём из RPN 0, иначе стандартные ±2 полутона
    const cc = tr.controlChanges || {};
    let range = 2;
    if (cc[6] && cc[6].length && cc[101] && cc[100]) range = Math.max(1, Math.round(cc[6][0].value * 127));
    const pb = (tr.pitchBends || []).map(b => [T(b.ticks), +(b.value * range).toFixed(3)]);
    if (pb.some(b => Math.abs(b[1]) > 0.05)) {
      t.bends = pb;
      for (const n of notes) {
        const seg = pb.filter(b => b[0] >= n.t && b[0] < n.t + n.d);
        if (seg.length < 2) continue;
        let flips = 0, prev = 0, max = 0;
        for (let k = 1; k < seg.length; k++) { const dlt = seg[k][1] - seg[k - 1][1]; if (dlt && prev && Math.sign(dlt) !== Math.sign(prev)) flips++; if (dlt) prev = dlt; max = Math.max(max, Math.abs(seg[k][1])); }
        if (flips >= 3 && max < 1.2) n.x = { ...(n.x || {}), vib: max > 0.4 ? 'wide' : 'slight' };
        else if (max >= 0.4) n.x = { ...(n.x || {}), bend: { type: 'custom', max: +max.toFixed(2), pts: seg.map(b => [Math.round((b[0] - n.t) / n.d * 60), b[1]]) } };
      }
    }
    // Педаль сустейна (CC 64)
    if (cc[64] && cc[64].length) {
      const seg = []; let down = null;
      for (const c of cc[64]) { const on = c.value >= 0.5, tk = T(c.ticks); if (on && down == null) down = tk; else if (!on && down != null) { if (tk > down) seg.push([down, tk]); down = null; } }
      if (seg.length) t.pedal = seg;
    }
    // Динамика: отмечаем заметные смены громкости (обозначения pp…ff на клавишах)
    let lastDyn = null;
    for (const n of notes) { const dn = velToDyn(n.v); if (dn !== lastDyn) { n.x = { ...(n.x || {}), dyn: dn, dynMark: true }; lastDyn = dn; } }
    if (isStringKind(kind)) { t.tuning = kind === 'bass' ? STD_TUNING.bass : STD_TUNING.guitar; t.fretsGuessed = true; assignFrets(notes, t.tuning, 24); }
    const hd = handFromName(name); if (hd) t.hand = hd;
    tracks.push(t);
  }
  if (!tracks.length) throw new Error('В MIDI-файле нет нот');
  // Две фортепианные дорожки без подписей: верхняя — правая рука, нижняя — левая
  const pianos = tracks.filter(t => t.kind === 'piano');
  if (pianos.length === 2 && !pianos.some(t => t.hand)) {
    const avg = t => t.notes.reduce((a, n) => a + n.m, 0) / t.notes.length;
    const [a, b] = pianos; if (avg(a) >= avg(b)) { a.hand = 'R'; b.hand = 'L'; } else { a.hand = 'L'; b.hand = 'R'; }
  }
  for (const t of tracks) t.notes.sort((a, b) => a.t - b.t || a.m - b.m);
  assignChannels(tracks);
  const measures = buildMeasures(total, sigs);
  const last = measures[measures.length - 1];
  const title = fixText(midi.header.name).trim() || (fileName || 'MIDI').replace(/\.(mid|midi)$/i, '');
  for (const t of tracks) for (const n of t.notes) n.bar = barOf(measures, n.t);
  return { v: 2, title, source: 'midi', tempos, measures, totalTicks: last.tick + last.len, tracks };
}

export function barOf(measures, tick) {
  let lo = 0, hi = measures.length - 1;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (measures[m].tick <= tick) lo = m; else hi = m - 1; }
  return measures[lo].n;
}
