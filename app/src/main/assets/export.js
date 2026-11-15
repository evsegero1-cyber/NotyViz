// Экспорт композиции: MIDI (каждая дорожка отдельно) и MusicXML (каждая дорожка — отдельная партия)
import { PPQ } from './model.js';
import { perform, techIds } from './techniques.js';

const effProgram = (tr, i, prog) => prog && prog[i] != null ? prog[i] : (tr.program || 0);

export function toMidiBytes(MidiClass, song, prog = {}) {
  const midi = new MidiClass();
  const k = midi.header.ppq / PPQ;
  midi.header.name = song.title || '';
  midi.header.tempos = song.tempos.map(t => ({ ticks: Math.round(t.tick * k), bpm: t.bpm }));
  let last = '';
  midi.header.timeSignatures = [];
  for (const m of song.measures) { const s = m.sig.join('/'); if (s !== last) { midi.header.timeSignatures.push({ ticks: Math.round(m.tick * k), timeSignature: [...m.sig], measures: 0 }); last = s; } }
  midi.header.update();
  song.tracks.forEach((tr, i) => {
    const t = midi.addTrack();
    t.name = tr.name; t.channel = tr.channel;
    t.instrument.number = tr.kind === 'drums' ? 0 : effProgram(tr, i, prog);
    // ноты с учётом техник (трели, тремоло, арпеджио, стаккато…) + подтяжки и педаль
    const perf = perform(tr, PPQ);
    for (const e of perf.events) t.addNote({ midi: Math.max(0, Math.min(127, e.m)), ticks: Math.round(e.t * k), durationTicks: Math.max(1, Math.round(e.d * k)), velocity: Math.min(1, (e.v || 96) / 127) });
    if (tr.kind !== 'drums' && perf.bends.length) {
      for (const [num, val] of [[101, 0], [100, 0], [6, 16 / 127], [38, 0]]) t.addCC({ number: num, value: val, ticks: 0 });
      for (const [tk, semi] of perf.bends) t.addPitchBend({ ticks: Math.max(0, Math.round(tk * k)), value: Math.round(Math.max(-1, Math.min(0.9999, semi / 16)) * 8192) }); // писатель @tonejs/midi ждёт целое −8192…8191
    }
    if (tr.pedal) for (const [a, b] of tr.pedal) { t.addCC({ number: 64, value: 1, ticks: Math.round(a * k) }); t.addCC({ number: 64, value: 0, ticks: Math.round(b * k) }); }
    if (tr.volume != null && tr.volume !== 1) t.addCC({ number: 7, value: Math.max(0, Math.min(1, tr.volume * 0.85)), ticks: 0 });
  });
  return midi.toArray();
}

// ---------- MusicXML ----------
const DIV = 480;                         // долей четверти в MusicXML
const Q = PPQ / DIV;                     // наши тики → divisions
const GRID = 30;                         // сетка 1/64 для ненормированных (MIDI) длительностей
const STEPS = [['C', 0], ['C', 1], ['D', 0], ['E', -1], ['E', 0], ['F', 0], ['F', 1], ['G', 0], ['A', -1], ['A', 0], ['B', -1], ['B', 0]];
const TYPES = [[1920, 'whole'], [960, 'half'], [480, 'quarter'], [240, 'eighth'], [120, '16th'], [60, '32nd'], [30, '64th']];
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function typeOf(d) {
  for (const [v, n] of TYPES) { if (d === v) return [n, 0]; if (d === v * 1.5) return [n, 1]; if (d === v * 1.75) return [n, 2]; }
  let best = TYPES[TYPES.length - 1]; for (const t of TYPES) if (t[0] <= d) { best = t; break; }
  return [best[1], 0];
}
// Разбить длительность на «записываемые» куски (с лигами)
function splitDur(d) {
  const out = [];
  const vals = [2880, 1920, 1440, 960, 720, 480, 360, 240, 180, 120, 90, 60, 30];
  while (d >= 30) { const v = vals.find(x => x <= d); out.push(v); d -= v; }
  return out.length ? out : [30];
}
const q = x => Math.max(0, Math.round(x / Q / GRID) * GRID);

export function toMusicXml(song, prog = {}) {
  const tracks = song.tracks;
  const L = [];
  L.push('<?xml version="1.0" encoding="UTF-8" standalone="no"?>');
  L.push('<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">');
  L.push('<score-partwise version="4.0">');
  L.push(`<work><work-title>${esc(song.title)}</work-title></work>`);
  L.push('<identification><encoding><software>NotyViz</software></encoding></identification>');
  L.push('<part-list>');
  tracks.forEach((tr, i) => {
    L.push(`<score-part id="P${i + 1}"><part-name>${esc(tr.name)}</part-name><score-instrument id="P${i + 1}-I1"><instrument-name>${esc(tr.instrument || tr.name)}</instrument-name></score-instrument>`);
    L.push(`<midi-instrument id="P${i + 1}-I1"><midi-channel>${(tr.channel || 0) + 1}</midi-channel><midi-program>${(tr.kind === 'drums' ? 0 : effProgram(tr, i, prog)) + 1}</midi-program><volume>${Math.round(Math.min(1.27, (tr.volume ?? 1) * 0.8) * 100)}</volume></midi-instrument></score-part>`);
  });
  L.push('</part-list>');
  const tempoAt = new Map(); for (const t of song.tempos) tempoAt.set(t.tick, t.bpm);
  tracks.forEach((tr, ti) => {
    L.push(`<part id="P${ti + 1}">`);
    const notes = tr.notes.filter(n => !n.deleted && !n.tie && !(n.x && n.x.trillAux)).map(n => ({ m: n.m, v: n.v || 96, a: q(n.t), b: Math.max(q(n.t) + GRID, q(n.t + n.d)), x: n.x, s: n.s, f: n.f, nStr: tr.tuning ? tr.tuning.length : 0 }));
    // одинаковые повторы тремоло/трели в партитуре пишутся одной нотой со значком
    for (let k2 = notes.length - 1; k2 > 0; k2--) { const a = notes[k2 - 1], b2 = notes[k2]; if (a.x && a.x.trem && b2.x && b2.x.trem && a.m === b2.m && a.b >= b2.a - GRID) { a.b = Math.max(a.b, b2.b); notes.splice(k2, 1); } }
    const pedalAt = new Map(); if (tr.pedal) for (const [a2, b2] of tr.pedal) { pedalAt.set(q(a2), 'start'); pedalAt.set(q(b2), (pedalAt.get(q(b2)) === 'start' ? 'change' : 'stop')); }
    notes.sort((x, y) => x.a - y.a || x.m - y.m);
    const avg = notes.length ? notes.reduce((s, n) => s + n.m, 0) / notes.length : 60;
    const clef = tr.kind === 'drums' ? '<clef><sign>percussion</sign></clef>' : avg < 55 ? '<clef><sign>F</sign><line>4</line></clef>' : '<clef><sign>G</sign><line>2</line></clef>';
    let ni = 0, carry = [];
    let lastSig = '';
    song.measures.forEach((m, mi) => {
      const ms = Math.round(m.tick / Q), me = ms + Math.round(m.len / Q);
      L.push(`<measure number="${mi + 1}">`);
      const sig = m.sig.join('/');
      if (mi === 0 || sig !== lastSig) {
        const SN = ['C', 'C', 'D', 'D', 'E', 'F', 'F', 'G', 'G', 'A', 'A', 'B'], SA = [0, 1, 0, 1, 0, 0, 1, 0, 1, 0, 1, 0];
        const sd = mi === 0 && tr.tuning && tr.kind !== 'piano' ? '<staff-details><staff-lines>' + tr.tuning.length + '</staff-lines>' + [...tr.tuning].reverse().map((tm, li) => `<staff-tuning line="${li + 1}"><tuning-step>${SN[tm % 12]}</tuning-step>${SA[tm % 12] ? '<tuning-alter>1</tuning-alter>' : ''}<tuning-octave>${Math.floor(tm / 12) - 1}</tuning-octave></staff-tuning>`).join('') + '</staff-details>' : '';
        L.push('<attributes>' + (mi === 0 ? `<divisions>${DIV}</divisions><key><fifths>0</fifths></key>` : '') + `<time><beats>${m.sig[0]}</beats><beat-type>${m.sig[1]}</beat-type></time>` + (mi === 0 ? clef + sd : '') + '</attributes>');
        lastSig = sig;
      }
      for (const [tick, bpm] of tempoAt) if (tick >= m.tick && tick < m.tick + m.len) L.push(`<direction placement="above"><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>${Math.round(bpm)}</per-minute></metronome></direction-type><sound tempo="${+bpm.toFixed(2)}"/><offset>${Math.round((tick - m.tick) / Q)}</offset></direction>`);
      for (const [pt, kind] of pedalAt) if (pt >= ms && pt < me) L.push(`<direction placement="below"><direction-type><pedal type="${kind}" line="yes"/></direction-type><offset>${pt - ms}</offset></direction>`);
      // ноты такта: перенесённые из прошлого + начинающиеся здесь
      const here = carry.map(c => ({ ...c, tieStop: true })); carry = [];
      while (ni < notes.length && notes[ni].a < me) { const n = notes[ni++]; here.push({ ...n, a: Math.max(n.a, ms) }); }
      for (const n of here) if (n.b > me) { carry.push({ ...n, a: me }); n.b = me; n.tieStart = true; }
      // аккорды: одинаковое начало и конец
      const ev = [];
      for (const n of here) { const e = ev.find(e => e.a === n.a && e.b === n.b); if (e) e.ns.push(n); else ev.push({ a: n.a, b: n.b, ns: [n] }); }
      ev.sort((x, y) => x.a - y.a);
      // голоса без наложений
      const voices = [];
      for (const e of ev) { let v = voices.find(v => v.end <= e.a); if (!v) { v = { end: ms, ev: [] }; voices.push(v); } v.ev.push(e); v.end = e.b; }
      if (!voices.length) voices.push({ end: ms, ev: [] });
      voices.slice(0, 8).forEach((v, vi) => {
        if (vi > 0) L.push(`<backup><duration>${me - ms}</duration></backup>`);
        let cur = ms;
        const rest = d => { for (const p of splitDur(d)) { const [ty, dots] = typeOf(p); L.push(`<note><rest/><duration>${p}</duration><voice>${vi + 1}</voice><type>${ty}</type>${'<dot/>'.repeat(dots)}</note>`); } };
        for (const e of v.ev) {
          if (e.a > cur) rest(e.a - cur);
          const parts = splitDur(e.b - e.a);
          parts.forEach((p, pi) => {
            const [ty, dots] = typeOf(p);
            e.ns.sort((x, y) => x.m - y.m).forEach((n, k) => {
              const [st, al] = STEPS[n.m % 12], oct = Math.floor(n.m / 12) - 1;
              const tStart = pi < parts.length - 1 || n.tieStart, tStop = pi > 0 || n.tieStop;
              let x = `<note dynamics="${Math.round(n.v / 90 * 100)}">` + (k ? '<chord/>' : '') + `<pitch><step>${st}</step>${al ? `<alter>${al}</alter>` : ''}<octave>${oct}</octave></pitch><duration>${p}</duration>`;
              if (tStop) x += '<tie type="stop"/>'; if (tStart) x += '<tie type="start"/>';
              x += `<voice>${vi + 1}</voice><type>${ty}</type>${'<dot/>'.repeat(dots)}`;
              if (al === 1) x += '<accidental>sharp</accidental>'; else if (al === -1) x += '<accidental>flat</accidental>';
              const nx = (pi === 0 && !n.tieStop) ? n.x : null;
              if (nx && nx.dead) x += '<notehead>x</notehead>';
              else if (nx && nx.harm) x += '<notehead>diamond</notehead>';
              else if (nx && nx.ghost) x += '<notehead parentheses="yes">normal</notehead>';
              const nt = notationsXml(nx, n, tStart, tStop, tr.kind);
              if (nt) x += `<notations>${nt}</notations>`;
              if (nx && nx.dynMark && nx.dyn && k === 0 && /^[pmf]+$/.test(nx.dyn)) L.push(`<direction placement="below"><direction-type><dynamics><${nx.dyn}/></dynamics></direction-type></direction>`);
              L.push(x + '</note>');
            });
          });
          cur = e.b;
        }
        if (cur < me) rest(me - cur);
      });
      L.push('</measure>');
    });
    L.push('</part>');
  });
  L.push('</score-partwise>');
  return L.join('\n');
}

// Обозначения техник в MusicXML (articulations, technical, ornaments, fermata, arpeggiate)
function notationsXml(x, n, tStart, tStop, kind) {
  let o = '';
  if (tStop) o += '<tied type="stop"/>'; if (tStart) o += '<tied type="start"/>';
  if (!x) return o;
  if (x.ferm) o += `<fermata type="upright">${x.ferm === 'short' ? 'angled' : x.ferm === 'long' ? 'square' : 'normal'}</fermata>`;
  if (x.arp) o += `<arpeggiate direction="${x.arp === 'up' ? 'up' : 'down'}"/>`;
  if (x.sl && kind !== 'piano') o += '<slide type="start" line-type="solid"/>';
  if (x.gliss) o += '<glissando type="start" line-type="wavy"/>';
  if (x.leg) o += '<slur type="start"/>';
  const art = [];
  if (x.stacc) art.push('<staccato/>'); if (x.acc === 1) art.push('<accent/>'); if (x.acc === 2) art.push('<strong-accent type="up"/>'); if (x.acc === 3) art.push('<tenuto/>');
  if (art.length) o += `<articulations>${art.join('')}</articulations>`;
  const orn = [];
  if (x.tr != null && !x.trillAux) orn.push('<trill-mark/>');
  if (x.vib) orn.push('<wavy-line type="start"/>');
  if (x.orn === 'turn') orn.push('<turn/>'); if (x.orn === 'iturn') orn.push('<inverted-turn/>');
  if (x.orn === 'umord') orn.push('<inverted-mordent/>'); if (x.orn === 'lmord') orn.push('<mordent/>');
  if (x.trem) orn.push(`<tremolo type="single">${Math.min(4, x.trem)}</tremolo>`);
  if (orn.length) o += `<ornaments>${orn.join('')}</ornaments>`;
  const tech = [];
  if (n.s != null && n.f != null && n.nStr) tech.push(`<string>${n.s + 1}</string><fret>${n.f}</fret>`);
  if (x.hp === 'h') tech.push('<hammer-on type="start">H</hammer-on>'); if (x.hp === 'p') tech.push('<pull-off type="start">P</pull-off>');
  if (x.bend) tech.push(`<bend><bend-alter>${x.bend.max}</bend-alter>${/release/.test(x.bend.type) && !/bend$/.test(x.bend.type) ? '<release/>' : ''}</bend>`);
  if (x.harm) tech.push(x.harm === 'N' ? '<harmonic><natural/></harmonic>' : '<harmonic><artificial/></harmonic>');
  if (x.tap) tech.push('<tap/>');
  if (x.stroke) tech.push(x.stroke === 'up' ? '<up-bow/>' : '<down-bow/>');
  if (x.pm) tech.push('<other-technical>P.M.</other-technical>');
  if (x.ring) tech.push('<other-technical>let ring</other-technical>');
  if (x.slap) tech.push('<other-technical>slap</other-technical>'); if (x.pop) tech.push('<other-technical>pop</other-technical>');
  if (tech.length) o += `<technical>${tech.join('')}</technical>`;
  return o;
}
