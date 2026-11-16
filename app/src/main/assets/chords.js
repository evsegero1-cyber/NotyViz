// Названия аккордов по звучащим нотам и перестройка гитарной партии в другой строй.
const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
// интервалы от тоники → обозначение (чем раньше в списке, тем предпочтительнее)
const SHAPES = [
  [[0, 4, 7], ''], [[0, 3, 7], 'm'], [[0, 7], '5'], [[0, 4, 7, 10], '7'], [[0, 4, 7, 11], 'maj7'], [[0, 3, 7, 10], 'm7'],
  [[0, 2, 7], 'sus2'], [[0, 5, 7], 'sus4'], [[0, 3, 6], 'dim'], [[0, 4, 8], 'aug'], [[0, 3, 6, 9], 'dim7'], [[0, 3, 6, 10], 'm7♭5'],
  [[0, 4, 7, 9], '6'], [[0, 3, 7, 9], 'm6'], [[0, 4, 7, 2], 'add9'], [[0, 3, 7, 2], 'm(add9)'], [[0, 4, 7, 10, 2], '9'], [[0, 3, 7, 10, 2], 'm9'],
  [[0, 4, 7, 11, 2], 'maj9'], [[0, 5, 7, 10], '7sus4'], [[0, 4, 10], '7'], [[0, 3, 10], 'm7'], [[0, 4], ''], [[0, 3], 'm'],
];
// ms — высоты (MIDI) одновременно звучащих нот. Возвращает «Am», «D5», «G/B» или null.
export function chordName(ms) {
  const pcs = [...new Set(ms.map(m => ((m % 12) + 12) % 12))];
  if (pcs.length < 2) return null;
  const bass = ((Math.min(...ms) % 12) + 12) % 12;
  let best = null;
  for (const root of pcs) {
    const set = new Set(pcs.map(p => (p - root + 12) % 12));
    SHAPES.forEach(([iv, suf], rank) => {
      if (iv.length !== set.size || !iv.every(x => set.has(x))) return;
      const score = rank + (root === bass ? 0 : 30);
      if (!best || score < best.score) best = { root, suf, score };
    });
  }
  if (!best) return null;
  let name = NAMES[best.root].replace('#', '♯') + best.suf;
  if (best.root !== bass) name += '/' + NAMES[bass].replace('#', '♯');
  return name;
}

// Перестройка: ноты дорожки (s — струна, f — лад, m — высота) в новый строй newTun (как tuning дорожки:
// [0] — первая, тонкая струна). Высота нот не меняется. Ноты ниже самой низкой открытой струны
// поднимаются на октаву (помечаются octUp). Позиция руки по возможности сохраняется.
export function retuneNotes(notes, newTun, maxFret = 24) {
  const n = newTun.length, out = [];
  let pos = 0; // средний лад последних нот — «где рука»
  const sorted = notes.map((q, i) => ({ q, i })).sort((a, b) => a.q.t - b.q.t || b.q.m - a.q.m);
  let lastT = null, used = new Set(), pitches = new Set();
  for (const { q, i } of sorted) {
    if (q.t !== lastT) { used = new Set(); pitches = new Set(); lastT = q.t; }
    let m = q.m, octUp = false;
    while (m < newTun[n - 1]) { m += 12; octUp = true; }
    if (octUp && pitches.has(m)) { out[i] = { s: q.s, f: q.f, m, dup: true }; continue; } // та же нота уже есть в аккорде
    pitches.add(m);
    let best = null;
    for (let s = 0; s < n; s++) {
      const f = m - newTun[s]; if (f < 0 || f > maxFret || used.has(s)) continue;
      let c = Math.abs(f - pos) + (f === 0 ? -1 : 0) + (s === q.s ? -0.5 : 0);
      if (!best || c < best.c) best = { s, f, c };
    }
    if (!best) { out[i] = { s: q.s, f: q.f, m: q.m, bad: true }; continue; }
    used.add(best.s);
    if (best.f > 0) pos = pos * 0.6 + best.f * 0.4;
    out[i] = { s: best.s, f: best.f, m, octUp };
  }
  return out;
}
