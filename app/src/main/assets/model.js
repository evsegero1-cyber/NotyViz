// Единая модель композиции (версия 2) и всё, что с ней связано:
// время (тики ↔ секунды), определение инструментов, раскладка по струнам, сборка MIDI для синтезатора.
export const PPQ = 960;

export const KIND_LABEL = { piano: 'Фортепиано', guitar: 'Гитара', eguitar: 'Электрогитара', aguitar: 'Акустическая гитара', bass: 'Бас-гитара', drums: 'Ударные', other: 'Другой инструмент' };
export const isStringKind = k => k === 'guitar' || k === 'eguitar' || k === 'aguitar' || k === 'bass';
export const STD_TUNING = { guitar: [64, 59, 55, 50, 45, 40], bass: [43, 38, 33, 28] };

const GM = ['Акустический рояль', 'Яркий рояль', 'Электророяль', 'Хонки-тонк', 'Электропиано 1', 'Электропиано 2', 'Клавесин', 'Клавинет'];
export function kindFromProgram(program, isDrum, name = '') {
  const n = (name || '').toLowerCase();
  if (isDrum || /drum|perc|удар|бараб/.test(n)) return 'drums';
  if (/bass|бас/.test(n) && !/contra|double/.test(n)) return 'bass';
  if (/piano|keys|keyboard|фортеп|рояль|пианин/.test(n)) return 'piano';
  if (program <= 7) return 'piano';
  if (program === 24 || program === 25) return 'aguitar';
  if (program >= 26 && program <= 31) return 'eguitar';
  if (program >= 32 && program <= 39) return 'bass';
  if (/guitar|гитар/.test(n)) return 'guitar';
  return 'other';
}
export function programName(p, kind) {
  if (kind === 'drums') return 'Ударные';
  if (p < GM.length) return GM[p];
  return KIND_LABEL[kind] || 'Инструмент ' + (p + 1);
}
export function kindFromInstrumentText(s) {
  const n = (s || '').toLowerCase();
  if (/drum|perc/.test(n)) return { kind: 'drums', program: 0 };
  if (/bass/.test(n) && !/contrabass/.test(n)) return { kind: 'bass', program: /pick/.test(n) ? 34 : /fret/.test(n) ? 35 : 33 };
  if (/distort/.test(n)) return { kind: 'eguitar', program: 30 };
  if (/overdriv/.test(n)) return { kind: 'eguitar', program: 29 };
  if (/clean|jazz|electric|muted/.test(n) && /guitar/.test(n)) return { kind: 'eguitar', program: /jazz/.test(n) ? 26 : /muted/.test(n) ? 28 : 27 };
  if (/nylon/.test(n)) return { kind: 'aguitar', program: 24 };
  if (/guitar/.test(n)) return { kind: 'aguitar', program: 25 };
  if (/bright/.test(n) && /piano/.test(n)) return { kind: 'piano', program: 1 };
  if (/electric piano|rhodes/.test(n)) return { kind: 'piano', program: 4 };
  if (/piano|keys|keyboard/.test(n)) return { kind: 'piano', program: 0 };
  if (/string/.test(n)) return { kind: 'other', program: 48 };
  if (/organ/.test(n)) return { kind: 'other', program: 16 };
  if (/synth|pad/.test(n)) return { kind: 'other', program: 89 };
  return { kind: 'piano', program: 0 };
}

// ---------- Время ----------
export function makeTime(song) {
  const tempos = (song.tempos && song.tempos.length ? song.tempos : [{ tick: 0, bpm: 120 }]).slice().sort((a, b) => a.tick - b.tick);
  if (tempos[0].tick > 0) tempos.unshift({ tick: 0, bpm: tempos[0].bpm });
  const secs = [0];
  for (let i = 1; i < tempos.length; i++) secs.push(secs[i - 1] + (tempos[i].tick - tempos[i - 1].tick) / PPQ * 60 / tempos[i - 1].bpm);
  const idxTick = t => { let lo = 0, hi = tempos.length - 1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (tempos[m].tick <= t) lo = m; else hi = m - 1; } return lo; };
  const toSec = t => { const i = idxTick(t); return secs[i] + (t - tempos[i].tick) / PPQ * 60 / tempos[i].bpm; };
  const toTick = s => { let i = 0; while (i + 1 < secs.length && secs[i + 1] <= s) i++; return tempos[i].tick + (s - secs[i]) * tempos[i].bpm / 60 * PPQ; };
  const bpmAt = t => tempos[idxTick(t)].bpm;
  const total = toSec(song.totalTicks || 0);
  const mStarts = song.measures.map(m => toSec(m.tick));
  const measureAtSec = s => { let lo = 0, hi = mStarts.length - 1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (mStarts[m] <= s + 1e-6) lo = m; else hi = m - 1; } return lo; };
  return { toSec, toTick, bpmAt, total, mStarts, measureAtSec };
}

// Измерения по тактам, если в файле их нет (MIDI): по размерам такта
export function buildMeasures(totalTicks, sigs) {
  const S = (sigs && sigs.length ? sigs : [{ tick: 0, sig: [4, 4] }]).slice().sort((a, b) => a.tick - b.tick);
  const ms = []; let tick = 0, n = 1, si = 0;
  while (tick < totalTicks || ms.length === 0) {
    while (si + 1 < S.length && S[si + 1].tick <= tick) si++;
    const sig = S[si].sig; const len = Math.round(sig[0] * PPQ * 4 / sig[1]);
    ms.push({ n: n++, tick, len, sig: [...sig] }); tick += len;
    if (ms.length > 5000) break;
  }
  return ms;
}

// ---------- Раскладка нот по струнам (для MIDI) ----------
export function assignFrets(notes, tuning, maxFret = 22) {
  const byTick = new Map();
  for (const n of notes) { if (!byTick.has(n.t)) byTick.set(n.t, []); byTick.get(n.t).push(n); }
  let pos = 3;
  for (const t of [...byTick.keys()].sort((a, b) => a - b)) {
    const chord = byTick.get(t).sort((a, b) => b.m - a.m);
    const used = new Set();
    let sum = 0, cnt = 0;
    for (const n of chord) {
      if (n.s != null && n.f != null) { used.add(n.s); continue; }
      let best = -1, bd = 1e9;
      tuning.forEach((open, si) => {
        if (used.has(si)) return;
        const f = n.m - open; if (f < 0 || f > maxFret) return;
        const d = (f === 0 ? 0 : Math.abs(f - pos)) + si * 0.01;
        if (d < bd) { bd = d; best = si; }
      });
      if (best >= 0) { n.s = best; n.f = n.m - tuning[best]; used.add(best); if (n.f > 0) { sum += n.f; cnt++; } }
    }
    if (cnt) pos = pos * 0.4 + (sum / cnt) * 0.6;
  }
}

// ---------- MIDI для синтезатора alphaTab ----------
export function buildMidiFile(alphaTab, song, opts = {}) {
  const M = alphaTab.midi;
  const mf = new M.MidiFile();
  mf.division = PPQ;
  const h = new M.AlphaSynthMidiFileHandler(mf, true);
  for (const t of song.tempos) h.addTempo(t.tick, t.bpm);
  let lastSig = '';
  for (const m of song.measures) { const k = m.sig.join('/'); if (k !== lastSig) { h.addTimeSignature(m.tick, m.sig[0], m.sig[1]); lastSig = k; } }
  const end = song.totalTicks;
  song.tracks.forEach((tr, ti) => {
    const ch = tr.channel;
    h.addProgramChange(ti, 0, ch, tr.kind === 'drums' ? 0 : tr.program || 0);
    h.addControlChange(ti, 0, ch, 7, 110);
    for (const n of tr.notes) {
      if (n.tie || n.deleted) continue;
      h.addNote(ti, n.t, Math.max(1, n.d), n.m, n.v || 96, ch);
    }
    h.finishTrack(ti, end);
  });
  // Метроном: по событию на каждую долю
  const time = makeTime(song);
  for (const m of song.measures) {
    const beatTicks = PPQ * 4 / m.sig[1];
    for (let b = 0; b < m.sig[0]; b++) {
      const tick = m.tick + b * beatTicks;
      const ms = (time.toSec(tick + beatTicks) - time.toSec(tick)) * 1000;
      mf.addEvent(new M.AlphaTabMetronomeEvent(0, tick, b, beatTicks, ms));
    }
  }
  return mf;
}

// Каналы MIDI: ударные — 9, остальные по порядку, пропуская 9
export function assignChannels(tracks) {
  let c = 0;
  for (const t of tracks) {
    if (t.kind === 'drums') { t.channel = 9; continue; }
    if (c === 9) c++;
    t.channel = Math.min(c, 15); c++;
  }
}

export function songSummary(song) {
  const time = makeTime(song);
  const kinds = [...new Set(song.tracks.map(t => KIND_LABEL[t.kind] || t.kind))];
  return { id: song.id, title: song.title, source: song.source, kinds, tracks: song.tracks.length, notes: song.tracks.reduce((a, t) => a + t.notes.length, 0), dur: time.total, added: song.added };
}

// Конвертация старого формата (PDF, доли) в модель v2
export function fromBeatSong(old) {
  const B = b => Math.round(b * PPQ);
  const measures = old.measures.map(m => ({ n: m.n, tick: B(m.start), len: B(m.len), sig: m.sig || [4, 4] }));
  const tempos = []; let last = null;
  for (const m of old.measures) { const bpm = m.tempo || 120; if (bpm !== last) { tempos.push({ tick: B(m.start), bpm }); last = bpm; } }
  const inst = kindFromInstrumentText(old.instrument || old.track);
  const notes = old.notes.map(n => ({ t: B(n.start), d: Math.max(1, B(n.dur)), m: n.midi, v: 96, s: n.string, f: n.fret, bar: n.measure, page: n.page, box: n.box, voice: n.voice }));
  const track = {
    name: old.track || old.instrument || 'Дорожка', instrument: old.instrument || '', kind: old.isBass ? 'bass' : inst.kind, program: inst.program,
    tuning: old.tuning, tuningNames: old.tuningNames, notes
  };
  if (/left|левая/i.test(track.name)) track.hand = 'L'; else if (/right|правая/i.test(track.name)) track.hand = 'R';
  const song = { v: 2, id: old.id, title: old.title, source: 'pdf', tempos, measures, totalTicks: B(old.totalBeats), tracks: [track] };
  assignChannels(song.tracks);
  return song;
}
