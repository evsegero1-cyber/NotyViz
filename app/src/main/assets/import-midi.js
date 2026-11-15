// Импорт MIDI (.mid/.midi) через @tonejs/midi → модель v2
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
