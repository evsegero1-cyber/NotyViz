// Импорт Guitar Pro (.gp3/.gp4/.gp5/.gpx/.gp) и MusicXML через alphaTab → модель v2.
// Время берётся из MIDI, который строит сам alphaTab (с повторами и лигами), поэтому
// падающие ноты совпадают со звуком один в один. Струна и лад — из партитуры.
import { PPQ, kindFromProgram, programName, isStringKind } from './model.js';
import { barOf } from './import-midi.js';
import { guideFromText } from './performance-guide.js';
import { dynName } from './techniques.js';

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
  // Дорожка события — по номеру дорожки генератора (каналы у дорожек Guitar Pro могут совпадать:
  // раньше ноты одной дорожки попадали в другую, и барабаны играли чужие ноты).
  const chTrack = new Map();
  score.tracks.forEach((t, i) => { chTrack.set(t.playbackInfo.primaryChannel, i); chTrack.set(t.playbackInfo.secondaryChannel, i); });
  const trackOf = e => (e.track >= 0 && e.track < score.tracks.length) ? e.track : (chTrack.has(e.channel) ? chTrack.get(e.channel) : -1);
  // Подтяжки (pitch bend) и педаль по каналам — так их уже рассчитал alphaTab по партитуре
  const bendRange = new Map(), rpn = new Map(), chBends = new Map(), chPedal = new Map();
  for (const e of evs) {
    if (e instanceof M.ControlChangeEvent) {
      const st = rpn.get(e.channel) || {}; rpn.set(e.channel, st);
      if (e.controller === 101) st.msb = e.value; else if (e.controller === 100) st.lsb = e.value;
      else if (e.controller === 6 && st.msb === 0 && st.lsb === 0) bendRange.set(e.channel, e.value);
      else if (e.controller === 64) { const k = trackOf(e); if (!chPedal.has(k)) chPedal.set(k, []); chPedal.get(k).push([T(e.tick), e.value >= 64]); }
      continue;
    }
    if (e.constructor && e.constructor.name === 'PitchBendEvent' || (M.PitchBendEvent && e instanceof M.PitchBendEvent)) {
      const range = bendRange.get(e.channel) || 2, k = trackOf(e);
      if (!chBends.has(k)) chBends.set(k, []);
      const arr = chBends.get(k), semi = +((e.value - 8192) / 8192 * range).toFixed(3);
      if (!arr.length || arr[arr.length - 1][1] !== semi) arr.push([T(e.tick), semi]);
      continue;
    }
  }
  for (const e of evs) {
    const type = e.type;
    if (e instanceof M.TempoChangeEvent) { tempos.push({ tick: T(e.tick), bpm: +(60000000 / e.microSecondsPerQuarterNote).toFixed(3) }); continue; }
    if (!(e instanceof M.NoteOnEvent || e instanceof M.NoteOffEvent)) continue;
    const ti = trackOf(e);
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
    const isDrum = st.isPercussion || (staff && staff.isPercussion) || st.playbackInfo.primaryChannel === 9;
    const program = st.playbackInfo.program;
    let kind = kindFromProgram(program, isDrum, st.name);
    const tuning = staff && staff.tuning && staff.tuning.length ? Array.from(staff.tuning) : null;
    if (tuning && !isDrum && !isStringKind(kind) && /guitar|гитар|rhythm guitar/i.test(st.name)) kind = 'guitar';
    const notes = perTrack[i].sort((a, b) => a.t - b.t || a.m - b.m);
    const tr = {
      name: (st.name || '').trim() || programName(program, kind), instrument: programName(program, kind), kind, program,
      channel: st.playbackInfo.primaryChannel, channel2: st.playbackInfo.secondaryChannel, scoreTrack: i, tuning: isStringKind(kind) && tuning ? tuning : null, notes
    };
    mapScore(alphaTab, lookup, st, tr, notes, div, kind);
    for (const n of notes) { n.bar = barOf(measures, n.t); n.real = true; delete n.rawTick; }
    // кривая подтяжек канала (только если в ней есть что-то кроме нуля)
    const bends = chBends.get(i) || [];
    if (bends.some(b => b[1] !== 0)) tr.bends = bends;
    tr.pedal = pedalSegments(chPedal.get(i)) || pedalFromScore(lookup, st, T);
    if (!tr.pedal || !tr.pedal.length) delete tr.pedal;
    return tr;
  }).filter(t => t.notes.length);
  if (!tracks.length) throw new Error('В файле нет нот');
  const title = [score.artist, score.title].filter(s => s && s.trim()).join(' — ') || (fileName || 'Без названия').replace(/\.[^.]+$/, '');
  return { v: 2, title, source: 'gp', tempos, measures, totalTicks, tracks };
}

function pedalSegments(ev) {
  if (!ev || !ev.length) return null;
  const seg = []; let down = null;
  for (const [t, on] of ev) { if (on && down == null) down = t; else if (!on && down != null) { if (t > down) seg.push([down, t]); down = null; } }
  return seg;
}
// Педаль из партитуры (если alphaTab не выдал её в MIDI)
function pedalFromScore(lookup, scoreTrack, T) {
  const seg = []; let down = null;
  for (const mb of lookup.masterBars) {
    for (const staff of scoreTrack.staves) {
      const bar = staff.bars[mb.masterBar.index]; if (!bar || !bar.sustainPedals) continue;
      for (const p of bar.sustainPedals) {
        const t = T(mb.start + p.ratioPosition * (mb.end - mb.start));
        if (p.pedalType === 0) { if (down != null && t > down) seg.push([down, t]); down = t; }
        else if (p.pedalType === 2 && down != null) { if (t > down) seg.push([down, t]); down = null; }
      }
    }
  }
  return seg;
}

const SLIDE_OUT = [null, 'shift', 'legato', 'up', 'down', 'pickdown', 'pickup'];
const BEND_T = [null, 'custom', 'bend', 'release', 'bendrelease', 'hold', 'prebend', 'prebendbend', 'prebendrelease'];
const HARM = [null, 'N', 'A', 'P', 'T', 'S', 'F'];
const ORN = [null, 'iturn', 'turn', 'umord', 'lmord'];
const OTT = { 0: '15ma', 1: '8va', 3: '8vb', 4: '15mb' };
// Техники ноты из модели партитуры alphaTab
function techFrom(nt, b, kind, stringed) {
  const x = {};
  if (nt.isHammerPullOrigin && nt.hammerPullDestination) x.hp = nt.hammerPullDestination.realValue >= nt.realValue ? 'h' : 'p';
  if (nt.slideOutType) {
    x.sl = SLIDE_OUT[nt.slideOutType] || 'shift';
    if (nt.slideTarget) x.slTo = stringed ? nt.slideTarget.fret : nt.slideTarget.realValue;
    if (kind === 'piano') { x.gliss = true; if (nt.slideTarget) x.slTo = nt.slideTarget.realValue; }
  }
  if (nt.slideInType) x.slIn = nt.slideInType === 1 ? 'below' : 'above';
  if (nt.bendType && nt.bendPoints && nt.bendPoints.length) {
    const pts = nt.bendPoints.map(p => [p.offset, p.value / 2]);
    x.bend = { type: BEND_T[nt.bendType] || 'custom', max: Math.max(...pts.map(p => Math.abs(p[1]))), pts };
  }
  const vib = nt.vibrato || b.vibrato; if (vib) x.vib = vib === 2 ? 'wide' : 'slight';
  if (nt.trillValue > 0) x.tr = nt.trillValue;
  if (b.tap || nt.isLeftHandTapped) x.tap = true;
  if (stringed) {
    const guides = [];
    if (b.golpe) guides.push('bodyHit');
    if (nt.isLeftHandTapped) guides.push('tapLeft');
    else if (b.tap) guides.push('tapRight');
    if (b.isBarre && nt.fret === b.barreFret) guides.push('barre');
    if (nt.leftHandFinger >= 0) x.leftFinger = ['T','1','2','3','4'][nt.leftHandFinger];
    if (nt.rightHandFinger >= 0) x.rightFinger = ['p','i','m','a','c'][nt.rightHandFinger];
    if (guides.length) x.guides = guides;
  }
  if (nt.isPalmMute || b.isPalmMute) x.pm = true;
  if (nt.harmonicType) x.harm = HARM[nt.harmonicType] || 'N';
  if (b.tremoloPicking) x.trem = b.tremoloPicking.marks || 3;
  if (nt.isDead) x.dead = true;
  if (nt.isGhost) x.ghost = true;
  if (nt.isLetRing || b.isLetRing) x.ring = true;
  if (b.pickStroke) x.stroke = b.pickStroke === 1 ? 'up' : 'down';
  if (b.brushType === 1 || b.brushType === 2) x.brush = b.brushType === 1 ? 'up' : 'down';
  if (b.brushType === 3 || b.brushType === 4) x.arp = b.brushType === 3 ? 'up' : 'down';
  if (b.whammyBarType && b.whammyBarPoints && b.whammyBarPoints.length) x.whammy = { type: b.whammyBarType, pts: b.whammyBarPoints.map(p => [p.offset, p.value / 2]) };
  if (b.slap) x.slap = true;
  if (b.pop) x.pop = true;
  if (b.rasgueado) x.rasg = true;
  if (nt.isStaccato) x.stacc = true;
  if (nt.accentuated) x.acc = nt.accentuated;
  if (nt.isSlurOrigin || b.isLegatoOrigin) x.leg = true;
  if (nt.ornament) x.orn = ORN[nt.ornament];
  if (b.graceType) x.grace = b.graceType === 1 ? 'on' : b.graceType === 2 ? 'before' : 'bend';
  try { const mb = b.voice.bar.masterBar; const f = mb.getFermata && mb.getFermata(b); if (f) x.ferm = ['short', 'medium', 'long'][f.type] || 'medium'; } catch (e) { }
  if (b.crescendo) x.cresc = b.crescendo === 1 ? 'cresc' : 'dim';
  const dn = dynName(b.dynamics); if (dn) x.dyn = dn;
  const prev = b.previousBeat; if (dn && (!prev || prev.dynamics !== b.dynamics || b.showDynamics)) x.dynMark = true;
  if (b.tupletNumerator > 0 && b.tupletDenominator > 0 && b.tupletNumerator !== b.tupletDenominator) x.tup = b.tupletNumerator + ':' + b.tupletDenominator;
  if (OTT[b.ottava] != null) x.ott = OTT[b.ottava];
  return x;
}

// Для каждой ноты находим её в партитуре: струна/лад и номер нотного стана (руки для фортепиано)
function mapScore(alphaTab, lookup, scoreTrack, tr, notes, div, kind) {
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
    if (!found) {
      // вспомогательная нота трели: в партитуре её нет, но у ноты в этой доле есть trillValue
      const tb = res && res.beat;
      if (tb) for (const nt of tb.notes) if (nt.trillValue === n.m) { n.x = { trillAux: true, tr: nt.realValue }; if (tr.tuning && nt.isStringed) { const ns = tr.tuning.length; n.s = ns - nt.string; } break; }
      continue;
    }
    const staffIdx = found.b.voice.bar.staff.index;
    if (scoreTrack.staves.length > 1) n.h = staffIdx === 0 ? 'R' : 'L';
    const x = techFrom(found.nt, found.b, kind, !!tr.tuning);
    const marked = guideFromText(found.b.text, tr);
    if (marked) x.guides = [...new Set([...(x.guides || []), marked])];
    // повторы тремоло и трели — та же нота партитуры: подпись техники только у первой
    if (Object.keys(x).length) n.x = x;
    if (tr.tuning && found.nt.isStringed) {
      // string в alphaTab считается снизу (1 = самая низкая), у нас 0 = самая высокая
      const nStr = tr.tuning.length;
      n.s = nStr - found.nt.string; n.f = found.nt.fret;
      if (n.s < 0 || n.s >= nStr) { delete n.s; delete n.f; }
    }
  }
}
