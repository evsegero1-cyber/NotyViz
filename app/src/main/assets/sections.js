// Разметка частей песни: вступление, куплет, припев, бридж, соло, проигрыш, концовка.
// Если в файле есть метки частей (Guitar Pro) — берём их. Иначе ищем сами:
// 1) «отпечаток» каждого такта (какие ноты в какой доле, ритм ударных);
// 2) матрица сходства тактов и кривая «новизны» — где музыка заметно меняется (метод Фута);
// 3) куски между границами группируются по сходству; повторяющиеся группы — куплет и припев,
//    одиночные — вступление, бридж, соло, концовка.

export const SEC_KINDS = {
  intro: { name: 'Вступление', col: '#8b93a3' },
  verse: { name: 'Куплет', col: '#4c9aff' },
  chorus: { name: 'Припев', col: '#ff8a3d' },
  bridge: { name: 'Бридж', col: '#c77dff' },
  solo: { name: 'Соло', col: '#ff5c5c' },
  inter: { name: 'Проигрыш', col: '#3ccf8e' },
  outro: { name: 'Концовка', col: '#8b93a3' },
  rest: { name: 'Пауза', col: '#3a404c' },
  part: { name: 'Часть', col: '#4dd0e1' }
};

const DRUM_CLASS = m => [35, 36].includes(m) ? 'k' : [37, 38, 39, 40].includes(m) ? 's' : [42, 44, 46, 26].includes(m) ? 'h' : [49, 57, 55, 52].includes(m) ? 'c' : [51, 53, 59].includes(m) ? 'r' : 't';

function guessKind(text) {
  const s = (text || '').toLowerCase();
  if (/intro|вступ/.test(s)) return 'intro';
  if (/pre.?chorus|пред/.test(s)) return 'bridge';
  if (/chorus|припев|refrain/.test(s)) return 'chorus';
  if (/verse|куплет/.test(s)) return 'verse';
  if (/solo|соло/.test(s)) return 'solo';
  if (/bridge|бридж|middle/.test(s)) return 'bridge';
  if (/outro|ending|coda|кода|конц|финал/.test(s)) return 'outro';
  if (/inter|riff|рифф|проигр|break|брейк/.test(s)) return 'inter';
  return 'part';
}

// markers: [{ idx: индекс такта в порядке проигрывания, text }]
export function detectSections(song, markers) {
  const ms = song.measures, M = ms.length;
  if (!M) return [];
  if (markers && markers.length) {
    const out = [];
    const mk = markers.slice().sort((a, b) => a.idx - b.idx);
    if (mk[0].idx <= 1) mk[0] = { ...mk[0], idx: 0 }; // затакт — часть первой части
    else mk.unshift({ idx: 0, text: 'Intro' });
    mk.forEach((m, i) => {
      const b = (mk[i + 1] ? mk[i + 1].idx : M) - 1; if (b < m.idx) return;
      const kind = guessKind(m.text), num = (/\b(\d+)\b/.exec(m.text) || [])[1];
      // название по-русски (Verse 2 → Куплет 2); незнакомое — как в файле
      const name = kind === 'part' ? m.text.trim() : num ? SEC_KINDS[kind].name + ' ' + num : undefined;
      out.push({ a: m.idx, b, kind, name, fromFile: true });
    });
    return finish(out);
  }
  // --- отпечатки тактов ---
  const starts = ms.map(m => m.tick);
  const idxOf = t => { let lo = 0, hi = M - 1; while (lo < hi) { const k = (lo + hi + 1) >> 1; if (starts[k] <= t) lo = k; else hi = k - 1; } return lo; };
  const mel = ms.map(() => new Set()), drm = ms.map(() => new Set());
  const dens = new Float32Array(M), crash = new Float32Array(M), lead = new Float32Array(M), pitch = new Float32Array(M);
  let leadTi = -1, best = 0;
  song.tracks.forEach((tr, ti) => { if (tr.kind === 'drums') return; const c = tr.notes.filter(n => !n.deleted).length; const w = (tr.tuning ? 1.3 : 1) * c; if (w > best) { best = w; leadTi = ti; } });
  song.tracks.forEach((tr, ti) => {
    for (const n of tr.notes) {
      if (n.deleted || n.tie) continue;
      const i = idxOf(n.t), m = ms[i], rel = Math.round((n.t - m.tick) / Math.max(1, m.len) * 24);
      if (tr.kind === 'drums') { const c = DRUM_CLASS(n.m); drm[i].add(c + rel); if (c === 'c') crash[i]++; }
      else { mel[i].add(ti + ':' + n.m + '@' + rel); dens[i]++; pitch[i] += n.m; if (ti === leadTi) lead[i]++; }
    }
  });
  for (let i = 0; i < M; i++) if (dens[i]) pitch[i] /= dens[i];
  const empty = i => !mel[i].size && !drm[i].size;
  const jac = (A, B) => { if (!A.size && !B.size) return -1; let c = 0; for (const x of A) if (B.has(x)) c++; return c / (A.size + B.size - c); };
  const S = Array.from({ length: M }, () => new Float32Array(M));
  for (let i = 0; i < M; i++) for (let j = i; j < M; j++) {
    let v;
    if (i === j) v = 1;
    else if (empty(i) && empty(j)) v = 1;
    else if (empty(i) || empty(j)) v = 0;
    else { const a = jac(mel[i], mel[j]), b = jac(drm[i], drm[j]); v = a < 0 ? b : b < 0 ? a : a * 0.75 + b * 0.25; }
    S[i][j] = S[j][i] = v;
  }
  // --- новизна на границах тактов ---
  const L = M < 24 ? 2 : 4;
  const avg = (a0, a1, b0, b1) => { let s = 0, c = 0; for (let i = a0; i < a1; i++) for (let j = b0; j < b1; j++) { s += S[i][j]; c++; } return c ? s / c : 0; };
  const nov = new Float32Array(M + 1);
  for (let k = 1; k < M; k++) {
    const a0 = Math.max(0, k - L), b1 = Math.min(M, k + L);
    nov[k] = (avg(a0, k, a0, k) + avg(k, b1, k, b1)) / 2 - avg(a0, k, k, b1);
  }
  let mx = 0; for (const v of nov) mx = Math.max(mx, v);
  const thr = Math.max(0.1, mx * 0.3);
  const firstNote = (() => { for (let i = 0; i < M; i++) if (!empty(i)) return i; return 0; })();
  const bounds = new Set([0, M]);
  // тишина: в начале и в конце — часть соседнего куска; в середине — отдельная «Пауза», если она не короче 4 тактов
  let lastNote = M - 1; while (lastNote > 0 && empty(lastNote)) lastNote--;
  const forced = new Set();
  for (let k = firstNote; k <= lastNote; k++) if (empty(k) && (k === firstNote || !empty(k - 1))) {
    let e = k; while (e + 1 <= lastNote && empty(e + 1)) e++;
    if (e - k + 1 >= 4) { bounds.add(k); bounds.add(e + 1); forced.add(k); forced.add(e + 1); }
    k = e;
  }
  const quiet = new Set(); // такты коротких пауз не участвуют в поиске границ
  for (let k = 0; k < M; k++) if (empty(k)) quiet.add(k);
  const cand = [];
  for (let k = 1; k < M; k++) if (nov[k] >= thr && nov[k] >= nov[k - 1] && nov[k] >= nov[k + 1]) {
    // ровная фраза (кратно 4 тактам от первой ноты) — небольшое предпочтение
    let kk = k; for (const d of [-1, 1]) { const k2 = k + d; if (k2 > 0 && k2 < M && (k2 - firstNote) % 4 === 0 && (k - firstNote) % 4 !== 0 && nov[k2] > nov[k] * 0.85) kk = k2; }
    cand.push({ k: kk, v: nov[k] });
  }
  cand.sort((a, b) => b.v - a.v);
  const minLen = L;
  for (const c of cand) { if (c.k <= firstNote || c.k > lastNote || quiet.has(c.k) && quiet.has(c.k - 1)) continue; let ok = true; for (const b of bounds) if (Math.abs(b - c.k) < minLen) { ok = false; break; } if (ok) bounds.add(c.k); }
  const B = [...bounds].sort((a, b) => a - b);
  let segs = [];
  for (let i = 0; i + 1 < B.length; i++) if (B[i + 1] > B[i]) segs.push({ a: B[i], b: B[i + 1] - 1 });
  // --- группировка похожих кусков ---
  const segSim = (p, q) => { const la = p.b - p.a + 1, lb = q.b - q.a + 1, n = Math.min(la, lb); let s = 0; for (let k = 0; k < n; k++) s += S[p.a + k][q.a + k]; return s / n * Math.pow(n / Math.max(la, lb), 0.3); };
  const clusters = [];
  for (const sg of segs) {
    sg.empty = (() => { for (let i = sg.a; i <= sg.b; i++) if (!empty(i)) return false; return true; })();
    if (sg.empty && !forced.has(sg.a)) sg.empty = false;
    if (sg.empty) { sg.cl = -1; continue; }
    let bc = -1, bs = 0.42;
    clusters.forEach((c, ci) => { const v = segSim(sg, c[0]); if (v > bs) { bs = v; bc = ci; } });
    if (bc < 0) { clusters.push([sg]); sg.cl = clusters.length - 1; } else { clusters[bc].push(sg); sg.cl = bc; }
  }
  // соседние куски одной группы — одна часть
  const merged = [];
  for (const sg of segs) { const p = merged[merged.length - 1]; if (p && p.cl === sg.cl) p.b = sg.b; else merged.push({ ...sg }); }
  segs = merged;
  const occ = new Map(); for (const s of segs) if (s.cl >= 0) occ.set(s.cl, (occ.get(s.cl) || 0) + 1);
  const energy = s => { let d = 0, c = 0; for (let i = s.a; i <= s.b; i++) { d += dens[i]; c += crash[i]; } const n = s.b - s.a + 1; return d / n + 3 * c / n; };
  const songLead = lead.reduce((a, b) => a + b, 0) / M, songPitch = (() => { let s = 0, c = 0; for (let i = 0; i < M; i++) if (dens[i]) { s += pitch[i]; c++; } return c ? s / c : 60; })();
  // повторяющиеся группы по порядку появления
  const rep = []; for (const s of segs) if (s.cl >= 0 && occ.get(s.cl) > 1 && !rep.includes(s.cl)) rep.push(s.cl);
  const clKind = new Map();
  const segE = c => { const ss = segs.filter(s => s.cl === c); return ss.reduce((a, s) => a + energy(s), 0) / ss.length; };
  const meanE = (() => { const ss = segs.filter(s => !s.empty); return ss.reduce((a, s) => a + energy(s), 0) / Math.max(1, ss.length); })();
  if (rep.length === 1) clKind.set(rep[0], segE(rep[0]) >= meanE ? 'chorus' : 'verse');
  else if (rep.length >= 2) {
    const e = segE;
    const [x, y] = rep;
    if (e(y) >= e(x) * 0.95) { clKind.set(x, 'verse'); clKind.set(y, 'chorus'); } else { clKind.set(x, 'chorus'); clKind.set(y, 'verse'); }
    // если «припев» звучит раньше куплета и он первый — всё равно оставляем по энергии
    for (const c of rep.slice(2)) clKind.set(c, 'inter');
  }
  const firstRep = segs.findIndex(s => clKind.has(s.cl));
  segs.forEach((s, i) => {
    if (s.empty) { s.kind = 'rest'; return; }
    if (clKind.has(s.cl)) { s.kind = clKind.get(s.cl); return; }
    if (i === 0 || (firstRep > 0 && i < firstRep && segs.slice(0, i).every(p => p.empty || !clKind.has(p.cl)) && i === segs.findIndex(p => !p.empty))) { s.kind = 'intro'; return; }
    if (i === segs.length - 1 || segs.slice(i + 1).every(p => p.empty)) { s.kind = 'outro'; return; }
    let ld = 0, pt = 0, c = 0; for (let k = s.a; k <= s.b; k++) { ld += lead[k]; if (dens[k]) { pt += pitch[k]; c++; } }
    ld /= (s.b - s.a + 1); pt = c ? pt / c : songPitch;
    s.kind = (ld > songLead * 1.4 && pt > songPitch + 2) ? 'solo' : 'bridge';
  });
  // куплета среди повторов нет: часть прямо перед припевом — куплет
  if (![...clKind.values()].includes('verse')) segs.forEach((s, i) => { if (s.kind === 'bridge' && segs[i + 1] && segs[i + 1].kind === 'chorus') s.kind = 'verse'; });
  // подряд идущие бриджи — одна часть
  segs = segs.reduce((o, s) => { const p = o[o.length - 1]; if (p && p.kind === s.kind && (s.kind === 'bridge' || s.kind === 'verse' && p.cl === s.cl)) p.b = s.b; else o.push(s); return o; }, []);
  // вся песня — одна часть: делим на равные куски по 8 тактов, чтобы было что выбрать
  if (segs.filter(s => !s.empty).length <= 1 && M >= 16) {
    const out = []; for (let a = 0; a < M; a += 8) out.push({ a, b: Math.min(M - 1, a + 7), kind: 'part' });
    return finish(out);
  }
  return finish(segs.map(s => ({ a: s.a, b: s.b, kind: s.kind })));
}

function finish(list) {
  const cnt = {}, tot = {};
  for (const s of list) if (!s.name) tot[s.kind] = (tot[s.kind] || 0) + 1;
  for (const s of list) {
    if (!s.name) cnt[s.kind] = (cnt[s.kind] || 0) + 1;
    const base = s.name || SEC_KINDS[s.kind].name;
    if (!s.name) s.name = tot[s.kind] > 1 && s.kind !== 'rest' ? base + ' ' + cnt[s.kind] : base;
    s.col = (SEC_KINDS[s.kind] || SEC_KINDS.part).col;
  }
  return list;
}

// часть, в которой такт idx
export function sectionAt(secs, idx) {
  if (!secs) return null;
  for (const s of secs) if (idx >= s.a && idx <= s.b) return s;
  return null;
}
