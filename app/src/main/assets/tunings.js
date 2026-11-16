// Строи струнных инструментов: для тюнера и для подписи «какой строй у дорожки».
// Струны перечислены от самой толстой (низкой) к тонкой. В дорожках приложения порядок обратный:
// tuning[0] — первая (самая тонкая) струна.

const NOTE = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
export function noteToMidi(s) {
  const m = /^([A-G])(#|b)?(-?\d)$/.exec(s); if (!m) throw new Error('нота ' + s);
  return 12 * (+m[3] + 1) + NOTE[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0);
}
const SHARP = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const RU = ['до', 'до♯', 'ре', 'ре♯', 'ми', 'фа', 'фа♯', 'соль', 'соль♯', 'ля', 'ля♯', 'си'];
export const midiName = m => SHARP[((m % 12) + 12) % 12];
export const midiNameOct = m => midiName(m) + (Math.floor(m / 12) - 1);
const nice = s => s.replace(/-?\d$/, '').replace('#', '♯').replace(/([A-G])b/, '$1♭');

const T = (id, name, notes, extra = {}) => { const ns = notes ? notes.split(' ') : []; return { id, name, notes: ns, midi: ns.map(noteToMidi), ...extra }; };

export const INSTRUMENTS = [
  { id: 'guitar6', name: 'Гитара (6 струн)', kind: 'guitar', tunings: [
    T('std', 'Стандартный', 'E2 A2 D3 G3 B3 E4'),
    T('dropd', 'Drop D', 'D2 A2 D3 G3 B3 E4'),
    T('eb', 'Полтона ниже (E♭)', 'Eb2 Ab2 Db3 Gb3 Bb3 Eb4'),
    T('dstd', 'Тон ниже (D Standard)', 'D2 G2 C3 F3 A3 D4'),
    T('dropcs', 'Drop C♯', 'C#2 G#2 C#3 F#3 A#3 D#4'),
    T('dropc', 'Drop C', 'C2 G2 C3 F3 A3 D4'),
    T('cstd', 'C Standard', 'C2 F2 Bb2 Eb3 G3 C4'),
    T('dropb', 'Drop B', 'B1 F#2 B2 E3 G#3 C#4'),
    T('bstd', 'B Standard', 'B1 E2 A2 D3 F#3 B3'),
    T('dropa', 'Drop A', 'A1 E2 A2 D3 F#3 B3'),
    T('ddd', 'Double Drop D', 'D2 A2 D3 G3 B3 D4'),
    T('dadgad', 'DADGAD', 'D2 A2 D3 G3 A3 D4'),
    T('openg', 'Open G', 'D2 G2 D3 G3 B3 D4'),
    T('opend', 'Open D', 'D2 A2 D3 F#3 A3 D4'),
    T('opene', 'Open E', 'E2 B2 E3 G#3 B3 E4'),
    T('opena', 'Open A', 'E2 A2 E3 A3 C#4 E4'),
    T('openc', 'Open C', 'C2 G2 C3 G3 C4 E4'),
    T('opendm', 'Open D minor', 'D2 A2 D3 F3 A3 D4'),
    T('nashville', 'Нэшвилл (высокий)', 'E3 A3 D4 G4 B3 E4'),
  ] },
  { id: 'guitar7', name: 'Гитара (7 струн)', kind: 'guitar', tunings: [
    T('std7', 'Стандартный', 'B1 E2 A2 D3 G3 B3 E4'),
    T('dropa7', 'Drop A', 'A1 E2 A2 D3 G3 B3 E4'),
    T('ru7', 'Русская семиструнная (Open G)', 'D2 G2 B2 D3 G3 B3 D4'),
    T('a7std', 'Полтона ниже', 'Bb1 Eb2 Ab2 Db3 Gb3 Bb3 Eb4'),
  ] },
  { id: 'guitar8', name: 'Гитара (8 струн)', kind: 'guitar', tunings: [
    T('std8', 'Стандартный', 'F#1 B1 E2 A2 D3 G3 B3 E4'),
    T('drope8', 'Drop E', 'E1 B1 E2 A2 D3 G3 B3 E4'),
  ] },
  { id: 'bass4', name: 'Бас (4 струны)', kind: 'bass', tunings: [
    T('b4std', 'Стандартный', 'E1 A1 D2 G2'),
    T('b4dropd', 'Drop D', 'D1 A1 D2 G2'),
    T('b4eb', 'Полтона ниже', 'Eb1 Ab1 Db2 Gb2'),
    T('b4dstd', 'Тон ниже (D Standard)', 'D1 G1 C2 F2'),
    T('b4dropc', 'Drop C', 'C1 G1 C2 F2'),
    T('b4bead', 'BEAD', 'B0 E1 A1 D2'),
  ] },
  { id: 'bass5', name: 'Бас (5 струн)', kind: 'bass', tunings: [
    T('b5std', 'Стандартный', 'B0 E1 A1 D2 G2'),
    T('b5dropa', 'Drop A', 'A0 E1 A1 D2 G2'),
    T('b5high', 'С высокой до', 'E1 A1 D2 G2 C3'),
  ] },
  { id: 'bass6', name: 'Бас (6 струн)', kind: 'bass', tunings: [
    T('b6std', 'Стандартный', 'B0 E1 A1 D2 G2 C3'),
  ] },
  { id: 'ukulele', name: 'Укулеле', kind: 'other', tunings: [
    T('ukstd', 'Стандартный (G C E A)', 'G4 C4 E4 A4'),
    T('uklow', 'Low G', 'G3 C4 E4 A4'),
    T('ukd', 'D-строй', 'A4 D4 F#4 B4'),
    T('ukbar', 'Баритон', 'D3 G3 B3 E4'),
  ] },
  { id: 'balalaika', name: 'Балалайка', kind: 'other', tunings: [
    T('balprima', 'Прима — академический', 'E4 E4 A4'),
    T('balnar', 'Прима — народный', 'G4 B4 D5'),
    T('balsec', 'Секунда', 'A3 A3 D4'),
    T('balalt', 'Альт', 'E3 E3 A3'),
    T('balbass', 'Бас', 'E2 A2 D3'),
  ] },
  { id: 'domra', name: 'Домра', kind: 'other', tunings: [
    T('domra3', 'Трёхструнная (малая)', 'E4 A4 D5'),
    T('domra4', 'Четырёхструнная', 'G3 D4 A4 E5'),
  ] },
  { id: 'mandolin', name: 'Мандолина', kind: 'other', tunings: [T('mand', 'Стандартный', 'G3 D4 A4 E5')] },
  { id: 'banjo', name: 'Банджо (5 струн)', kind: 'other', tunings: [
    T('banjog', 'Open G', 'G4 D3 G3 B3 D4'),
    T('banjod', 'Open D', 'F#4 D3 F#3 A3 D4'),
  ] },
  { id: 'violin', name: 'Скрипка', kind: 'other', tunings: [T('vln', 'Стандартный', 'G3 D4 A4 E5')] },
  { id: 'viola', name: 'Альт', kind: 'other', tunings: [T('vla', 'Стандартный', 'C3 G3 D4 A4')] },
  { id: 'cello', name: 'Виолончель', kind: 'other', tunings: [T('vc', 'Стандартный', 'C2 G2 D3 A3')] },
  { id: 'chromatic', name: 'Хроматический (любая нота)', kind: 'other', tunings: [T('chrom', 'Все ноты', '')] },
];

// Какой это строй. tuning — как в дорожке (от первой струны к последней), kind — тип дорожки.
// Возвращает { name, notes: 'D A D G B E', match: true/false, shift }.
export function describeTuning(tuning, kind) {
  if (!tuning || !tuning.length) return null;
  const low = [...tuning].reverse();
  const notesTxt = low.map(midiName).join(' ').replace(/#/g, '♯');
  const pool = INSTRUMENTS.filter(i => i.id !== 'chromatic' && (kind === 'bass' ? i.kind === 'bass' : kind === 'eguitar' || kind === 'aguitar' || kind === 'guitar' ? i.kind === 'guitar' : true));
  const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
  for (const ins of pool) for (const t of ins.tunings) if (same(t.midi, low)) return { name: t.name, notes: t.notes.map(nice).join(' '), match: true, inst: ins.id, id: t.id };
  // тот же строй, но целиком на октаву выше/ниже (так бывает в файлах)
  for (const ins of pool) for (const t of ins.tunings) {
    if (t.midi.length !== low.length) continue;
    const d = low[0] - t.midi[0];
    if (d && d % 12 === 0 && low.every((x, i) => x - t.midi[i] === d)) return { name: t.name, notes: t.notes.map(nice).join(' '), match: true, inst: ins.id, id: t.id };
  }
  return { name: 'Свой строй', notes: notesTxt, match: false };
}
export const tuningLine = (tuning, kind) => { const d = describeTuning(tuning, kind); return d ? `${d.name}: ${d.notes}` : ''; };

// Инструмент и строй тюнера для дорожки (подходящие по числу струн)
export function tunerPresetFor(tuning, kind) {
  const d = describeTuning(tuning, kind);
  if (d && d.match) return { inst: d.inst, tuning: d.id };
  const n = tuning ? tuning.length : 6;
  const ins = kind === 'bass' ? (n === 5 ? 'bass5' : n === 6 ? 'bass6' : 'bass4') : n === 7 ? 'guitar7' : n === 8 ? 'guitar8' : 'guitar6';
  return { inst: ins, tuning: null, custom: tuning ? [...tuning].reverse() : null };
}
