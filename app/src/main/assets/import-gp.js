// Импорт Guitar Pro (.gp3/.gp4/.gp5/.gpx/.gp) и MusicXML через alphaTab → модель v2.
// Время берётся из MIDI, который строит сам alphaTab (с повторами и лигами), поэтому
// падающие ноты совпадают со звуком один в один. Струна и лад — из партитуры.
import { PPQ, kindFromProgram, programName, isStringKind } from './model.js';
import { barOf } from './import-midi.js';

export function importScore(alphaTab, bytes, fileName) {
  const settings = new alphaTab.Settings();
  const score = alphaTab.importer.ScoreLoader.loadScoreFromBytes(bytes, settings);
  return scoreToSong(alphaTab, score, settings, fileName);
}

export function scoreToSong(alphaTab, score, settings, fileName) {
  const M = alphaTab.midi;
  const mf = new M.MidiFile();
  const gen = new M.MidiFileGenerator(score, settings, new M.AlphaSynthMidiFileHandler(mf, true));
  gen.generate();
  const div = mf.division || 960;
  const k = PPQ / div;
  const T = t => Math.round(t * k);
  const evs = mf.events;
  const tempos = [];
  const open = new Map();
  const perTrack = score.tracks.map(() => []);
  let total = 0;
  // Канал → дорожка партитуры
  const chTrack = new Map();
  score.tracks.forEach((t, i) => { chTrack.set(t.playbackInfo.primaryChannel, i); chTrack.set(t.playbackInfo.secondaryChannel, i); });
  for (const e of evs) {
    const type = e.type;
    if (e instanceof M.TempoChangeEvent) { tempos.push({ tick: T(e.tick), bpm: +(60000000 / e.microSecondsPerQuarterNote).toFixed(3) }); continue; }
    if (!(e instanceof M.NoteOnEvent || e instanceof M.NoteOffEvent)) continue;
    const ti = chTrack.has(e.channel) ? chTrack.get(e.channel) : e.track;
    const key = ti + ':' + e.channel + ':' + e.noteKey;
    const on = e instanceof M.NoteOnEvent && e.noteVelocity > 0;
    if (on) {
      if (open.has(key)) { const n = open.get(key); n.d = Math.max(1, T(e.tick) - n.t); open.delete(key); }
      const n = { t: T(e.tick), d: 1, m: e.noteKey, v: e.noteVelocity, rawTick: e.tick };
      if (perTrack[ti]) perTrack[ti].push(n);
      open.set(key, n);
    } else if (open.has(key)) {
      const n = open.get(key); n.d = Math.max(1, T(e.tick) - n.t); open.delete(key);
      total = Math.max(total, n.t + n.d);
    }
  }
  if (!tempos.length) tempos.push({ tick: 0, bpm: score.tempo || 120 });
  if (tempos[0].tick > 0) tempos.unshift({ tick: 0, bpm: tempos[0].bpm });
  // Такты в порядке проигрывания (с повторами)
  const measures = [];
  const lookup = gen.tickLookup;
  for (const mb of lookup.masterBars) {
    const bar = mb.masterBar;
    measures.push({ n: bar.index + 1, tick: T(mb.start), len: T(mb.end - mb.start), sig: [bar.timeSignatureNumerator, bar.timeSignatureDenominator] });
  }
  if (!measures.length) throw new Error('В файле нет тактов');
  const last = measures[measures.length - 1];
  const totalTicks = Math.max(last.tick + last.len, total);
  // Струна и лад: ищем ноту партитуры в том же такте и доле
  const tracks = score.tracks.map((st, i) => {
    const staff = st.staves[0];
    const isDrum = st.isPercussion || (staff && staff.isPercussion);
    const program = st.playbackInfo.program;
    let kind = kindFromProgram(program, isDrum, st.name);
    const tuning = staff && staff.tuning && staff.tuning.length ? Array.from(staff.tuning) : null;
    if (tuning && !isDrum && kind === 'other') kind = tuning.length <= 5 && tuning[0] < 50 ? 'bass' : 'guitar';
    if (kind === 'piano' && tuning && tuning.length >= 4 && !/piano|key/i.test(st.name)) kind = tuning[0] < 50 ? 'bass' : 'guitar';
    const notes = perTrack[i].sort((a, b) => a.t - b.t || a.m - b.m);
    const tr = {
      name: (st.name || '').trim() || programName(program, kind), instrument: programName(program, kind), kind, program,
      channel: st.playbackInfo.primaryChannel, channel2: st.playbackInfo.secondaryChannel, scoreTrack: i, tuning: isStringKind(kind) && tuning ? tuning : null, notes
    };
    if (tr.tuning || st.staves.length > 1) mapStringsAndStaves(alphaTab, lookup, st, tr, notes, div);
    for (const n of notes) { n.bar = barOf(measures, n.t); delete n.rawTick; }
    return tr;
  }).filter(t => t.notes.length);
  if (!tracks.length) throw new Error('В файле нет нот');
  const title = [score.artist, score.title].filter(s => s && s.trim()).join(' — ') || (fileName || 'Без названия').replace(/\.[^.]+$/, '');
  return { v: 2, title, source: 'gp', tempos, measures, totalTicks, tracks };
}

// Для каждой ноты находим её в партитуре: струна/лад и номер нотного стана (руки для фортепиано)
function mapStringsAndStaves(alphaTab, lookup, scoreTrack, tr, notes, div) {
  const want = new Set([scoreTrack.index]);
  for (const n of notes) {
    let res = null;
    try { res = lookup.findBeat(want, n.rawTick, null); } catch (e) { res = null; }
    const beats = [];
    if (res) { if (res.beat) beats.push(res.beat); if (res.beatLookup && res.beatLookup.highlightedBeats) for (const b of res.beatLookup.highlightedBeats) if (b.beat && !beats.includes(b.beat)) beats.push(b.beat); }
    // также все голоса и станы этого такта на этой позиции
    const extra = [];
    if (res && res.beat) {
      const mbIndex = res.beat.voice.bar.index;
      for (const staff of scoreTrack.staves) { const bar = staff.bars[mbIndex]; if (!bar) continue; for (const v of bar.voices) for (const b of v.beats) if (!beats.includes(b)) extra.push(b); }
    }
    let found = null;
    const check = list => {
      for (const b of list) for (const nt of b.notes) {
        if (nt.realValue === n.m && (found == null || nt.isTieDestination === false)) {
          const startOk = !res || !res.beat || Math.abs((b.absolutePlaybackStart ?? b.playbackStart) - (res.beat.absolutePlaybackStart ?? res.beat.playbackStart)) < div / 8 || list === beats;
          if (startOk) { found = { nt, b }; return true; }
        }
      }
      return false;
    };
    if (!check(beats)) check(extra);
    if (!found) continue;
    const staffIdx = found.b.voice.bar.staff.index;
    if (scoreTrack.staves.length > 1) n.h = staffIdx === 0 ? 'R' : 'L';
    if (tr.tuning && found.nt.isStringed) {
      // string в alphaTab считается снизу (1 = самая низкая), у нас 0 = самая высокая
      const nStr = tr.tuning.length;
      n.s = nStr - found.nt.string; n.f = found.nt.fret;
      if (n.s < 0 || n.s >= nStr) { delete n.s; delete n.f; }
    }
  }
}
