// Автотесты синхронизации и ударных. Запускаются из экрана диагностики и в тестах сборки.
// 1) планирование по фиктивным часам — точное соответствие «время ноты ↔ время звучания»;
// 2) настоящий рендер звука (OfflineAudioContext) и поиск атак нот в полученной записи.
import { PPQ, makeTime } from './model.js';
import { AudioEngine, GM_DRUMS } from './audio.js';
import { drumNote, findRests, buildSong } from './parser.js';
import { detectSections } from './sections.js';

// Тестовая композиция: 4 инструмента, ноты на каждую долю, смена темпа 120 → 90 → 150
export function testSong(opts = {}) {
  const bars = opts.bars || 12;
  const measures = []; for (let i = 0; i < bars; i++) measures.push({ n: i + 1, tick: i * PPQ * 4, len: PPQ * 4, sig: [4, 4] });
  const tempos = [{ tick: 0, bpm: 120 }, { tick: 4 * PPQ * 4, bpm: 90 }, { tick: 8 * PPQ * 4, bpm: 150 }];
  const beats = bars * 4;
  const mk = (fn) => { const out = []; for (let b = 0; b < beats; b++) fn(b, b * PPQ, out); return out; };
  const tracks = [
    { name: 'Фортепиано', kind: 'piano', program: 0, notes: mk((b, t, o) => o.push({ t, d: PPQ / 2, m: 60 + (b % 8), v: 100, real: true })) },
    { name: 'Электрогитара', kind: 'eguitar', program: 30, tuning: [64, 59, 55, 50, 45, 40], notes: mk((b, t, o) => o.push({ t, d: PPQ / 2, m: 52 + (b % 5), v: 100, s: 3, f: 2 + (b % 5), real: true })) },
    { name: 'Бас', kind: 'bass', program: 33, tuning: [43, 38, 33, 28], notes: mk((b, t, o) => o.push({ t, d: PPQ / 2, m: 40 + (b % 5), v: 100, s: 3, f: b % 5, real: true })) },
    { name: 'Ударные', kind: 'drums', program: 0, notes: mk((b, t, o) => { o.push({ t, d: PPQ / 4, m: b % 2 ? 38 : 36, v: 110, real: true }); o.push({ t, d: PPQ / 4, m: 42, v: 90, real: true }); if (b % 8 === 0) o.push({ t, d: PPQ / 4, m: 49, v: 110, real: true }); }) },
  ];
  tracks.forEach(tr => tr.channel = tr.kind === 'drums' ? 9 : 0);
  return { title: 'Тест синхронизации', tempos, measures, totalTicks: bars * PPQ * 4, tracks };
}

function fakeCtx() { return { fake: true, currentTime: 0, state: 'running' }; }
const R = (id, name, ok, detail) => ({ id, name, ok, detail });

// ---------- 1. Планирование по фиктивным часам ----------
export async function scheduleTests() {
  const out = [];
  const song = testSong(), time = makeTime(song);
  const eng = new AudioEngine(); eng.manual = true; eng.useContext(fakeCtx());
  await eng.load(song, time, {});
  const C = eng.ctx;
  const run = (sec) => { const end = C.currentTime + sec; while (C.currentTime < end) { C.currentTime = +(C.currentTime + 0.025).toFixed(6); eng.pump(); } };
  // Проигрывание от начала: каждая нота — ровно один раз, время звучания = время по темповой карте
  await eng.play(); run(time.total + 1.5);
  const log = eng.log.slice();
  const all = eng.events.length;
  const once = new Set(log.map(l => l.i)).size === log.length && log.length === all;
  let maxErr = 0; const a0 = log.length ? log[0].when - log[0].s : 0;
  for (const l of log) maxErr = Math.max(maxErr, Math.abs((l.when - l.s) - a0));
  out.push(R(1, 'Время событий всех инструментов', once && maxErr < 1e-6, `запланировано ${log.length} из ${all} нот, каждая один раз: ${once ? 'да' : 'НЕТ'}; отклонение от темповой карты ${(maxErr * 1000).toFixed(3)} мс`));
  // Нет опережения: все дорожки на одной шкале — у одновременных нот одинаковое время звучания
  const byS = new Map(); for (const l of log) { const k = l.s.toFixed(6); if (!byS.has(k)) byS.set(k, new Set()); byS.get(k).add(l.when.toFixed(6)); }
  const spread = [...byS.values()].every(s => s.size === 1);
  // и ноты ставятся заранее (не позже, чем нужно прозвучать)
  const lateCnt = log.filter(l => l.when < l.now - 1e-9).length;
  out.push(R(2, 'Нет ускорения отдельных дорожек', spread && lateCnt === 0, `одновременные ноты разных дорожек звучат в одно время: ${spread ? 'да' : 'НЕТ'}; опоздавших при планировании: ${lateCnt}`));
  // Длинная композиция: накопления ошибки нет (сравниваем начало и конец)
  const first = log[0], last = log[log.length - 1];
  const drift = Math.abs((last.when - last.s) - (first.when - first.s));
  out.push(R(3, 'Синхронизация на всей композиции', drift < 1e-6, `расхождение в конце (${time.total.toFixed(1)} с) относительно начала: ${(drift * 1000).toFixed(4)} мс`));
  // Пауза / продолжение / перемотка / скорость
  const e2 = new AudioEngine(); e2.manual = true; e2.useContext(fakeCtx()); await e2.load(song, time, {});
  const C2 = e2.ctx, step = sec => { const end = C2.currentTime + sec; while (C2.currentTime < end) { C2.currentTime = +(C2.currentTime + 0.025).toFixed(6); e2.pump(); } };
  await e2.play(); step(3); e2.pause(); const posA = e2.posSec; step(2); e2.log = [];
  await e2.play(); step(1.0);
  const resumeOk = e2.log.length > 0 && e2.log.every(l => l.s >= posA - 1e-6) && Math.abs(e2.log[0].s - eng.events[eng.indexAt(posA)].s) < 1e-6;
  e2.log = []; e2.seek(10); step(1.2);
  const a = e2.anchors[0];
  const seekOk = e2.log.length > 0 && e2.log.every(l => l.s >= 10 - 1e-6 && Math.abs(l.when - (a.ctx + (l.s - a.sec) / a.speed)) < 1e-6);
  e2.log = []; e2.setSpeed(0.5); step(2);
  const b = e2.anchors[0];
  const speedOk = e2.log.length > 0 && e2.log.every(l => Math.abs(l.when - (b.ctx + (l.s - b.sec) / 0.5)) < 1e-6) && e2.stats.dupes === 0;
  // повтор фрагмента: такт 3–4
  e2.pause(); e2.setSpeed(1); e2.setLoop(PPQ * 8, PPQ * 16); e2.seek(time.toSec(PPQ * 8)); e2.log = [];
  await e2.play(); step(time.toSec(PPQ * 16) - time.toSec(PPQ * 8) + 0.6);
  const inLoop = e2.log.every(l => l.s >= time.toSec(PPQ * 8) - 1e-6 && l.s < time.toSec(PPQ * 16));
  const wrapped = e2.log.filter(l => Math.abs(l.s - time.toSec(PPQ * 8)) < 1e-6).length >= 2 * 3;
  e2.setLoop(null); e2.pause();
  out.push(R(4, 'Пауза, продолжение, перемотка, скорость, повтор', resumeOk && seekOk && speedOk && inLoop && wrapped,
    `продолжение с места паузы: ${resumeOk ? 'да' : 'НЕТ'}; перемотка на 10 с: ${seekOk ? 'да' : 'НЕТ'}; скорость 50%: ${speedOk ? 'да' : 'НЕТ'}; повтор такта 3–4 без лишних нот: ${inLoop && wrapped ? 'да' : 'НЕТ'}; дублей: ${e2.stats.dupes}`));
  // Смена темпа внутри композиции: доли в такте 5 (90 BPM) и 9 (150 BPM)
  const expect = (tick) => { const bpms = song.tempos; let s = 0, prev = bpms[0]; for (let i = 1; i < bpms.length && bpms[i].tick <= tick; i++) { s += (bpms[i].tick - prev.tick) / PPQ * 60 / prev.bpm; prev = bpms[i]; } return s + (tick - prev.tick) / PPQ * 60 / prev.bpm; };
  let tErr = 0; for (const e of eng.events) tErr = Math.max(tErr, Math.abs(e.s - expect(e.t)));
  const d1 = expect(PPQ * 17) - expect(PPQ * 16), d2 = expect(PPQ * 33) - expect(PPQ * 32);
  out.push(R(7, 'Смена темпа внутри композиции', tErr < 1e-6 && Math.abs(d1 - 60 / 90) < 1e-9 && Math.abs(d2 - 60 / 150) < 1e-9, `120 → 90 → 150 BPM: длительность доли ${d1.toFixed(4)} с и ${d2.toFixed(4)} с; ошибка пересчёта тиков в секунды ${(tErr * 1000).toFixed(4)} мс`));
  return out;
}

// ---------- 2. Ударные: каждому номеру — свой звук ----------
export async function drumTests(eng) {
  const out = [];
  const kit = await fetch('snd/kit/pack.json').then(r => r.json());
  const gm = await fetch('snd/gm/pack.json').then(r => r.json());
  const K = kit.programs.kit.regions, G = gm.programs.drums.regions;
  const res = [];
  for (let m = 27; m <= 87; m++) {
    const k = K.filter(r => r.lk === m && r.hk === m);
    const g = G.filter(r => r.lk <= m && r.hk >= m);
    res.push({ m, name: GM_DRUMS[m], src: k.length ? 'живая установка' : g.length ? 'GeneralUser' : 'нет', layers: new Set((k.length ? k : g).map(r => r.lv)).size });
  }
  const missing = res.filter(r => r.src === 'нет');
  const wrongKit = K.filter(r => r.lk !== r.hk); // в живой установке у каждой зоны ровно одна нота
  const coreOk = [35, 36, 38, 40, 42, 44, 46, 49, 51, 57].every(m => res.find(r => r.m === m).src === 'живая установка' && res.find(r => r.m === m).layers >= 3);
  // неизвестный номер не подменяется: 20 и 100 → нет звука
  const silentUnknown = !K.some(r => r.lk <= 20 && r.hk >= 20) && !K.some(r => r.lk <= 100 && r.hk >= 100);
  // PDF (нотация Songsterr/Guitar Pro): положение на стане → элемент установки
  const pdfMap = [['head', 1, 36, 'бочка — 1-й промежуток'], ['head', 5, 38, 'малый — 3-й промежуток'], ['x', 9, 42, 'хай-хэт — над станом'], ['xcirc', 9, 46, 'открытый хай-хэт'], ['x', -1, 44, 'хай-хэт педалью — под станом'], ['x', 10, 49, 'крэш — 1-я добавочная'], ['x', 8, 51, 'райд — 5-я линейка'], ['head', 3, 43, 'напольный том — 2-й промежуток'], ['head', 7, 50, 'высокий том — 4-й промежуток'], ['head', 6, 48, 'средний том — 4-я линейка']];
  const pdfBad = pdfMap.filter(([k, st, want]) => drumNote(k, st) !== want);
  const unkPdf = drumNote('head', 14) == null && drumNote('x', -6) == null;
  out.push(R(5, 'Правильность каждого звука ударных', !missing.length && !wrongKit.length && coreOk && silentUnknown && !pdfBad.length && unkPdf,
    `GM 27–87: живая установка ${res.filter(r => r.src === 'живая установка').length}, GeneralUser ${res.filter(r => r.src === 'GeneralUser').length}, без звука ${missing.length}${missing.length ? ' (' + missing.map(r => r.m).join(', ') + ')' : ''}; ` +
    `основные элементы с 3+ слоями громкости: ${coreOk ? 'да' : 'НЕТ'}; неизвестные номера не подменяются: ${silentUnknown ? 'да' : 'НЕТ'}; ` +
    `раскладка PDF: ${pdfMap.length - pdfBad.length}/${pdfMap.length}${pdfBad.length ? ' ошибки: ' + pdfBad.map(p => p[3]).join(', ') : ''}; неизвестное положение на стане → не распознано: ${unkPdf ? 'да' : 'НЕТ'}`));
  return { out, table: res };
}

// ---------- 3. Настоящий звук: рендер и поиск атак ----------
function onsets(buf, from = 0) {
  const sr = buf.sampleRate, hop = 32, ch = [];
  for (let c = 0; c < buf.numberOfChannels; c++) ch.push(buf.getChannelData(c));
  const n = Math.floor(buf.length / hop), env = new Float32Array(n);
  for (let i = 0; i < n; i++) { let m = 0; for (const d of ch) for (let j = i * hop; j < (i + 1) * hop; j++) { const a = Math.abs(d[j]); if (a > m) m = a; } env[i] = m; }
  const peak = env.reduce((a, b) => Math.max(a, b), 0);
  const res = []; let last = -1e9;
  const W = Math.round(0.03 * sr / hop);
  for (let i = W; i < n; i++) {
    let prev = 0; for (let j = i - W; j < i - 2; j++) prev = Math.max(prev, env[j]);
    if (env[i] > peak * 0.08 && env[i] > prev * 2.2 && (i - last) * hop / sr > 0.12) { res.push(i * hop / sr + from); last = i; }
  }
  return res;
}
export async function audioTests(progress) {
  const out = [];
  const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (!OAC) return [R(6, 'Одновременные удары', false, 'OfflineAudioContext недоступен')];
  const song = testSong({ bars: 12 }), time = makeTime(song);
  const sr = 44100, len = time.total + 2;
  const perTrack = [];
  for (let ti = 0; ti < song.tracks.length; ti++) {
    if (progress) progress('Рендер: ' + song.tracks[ti].name);
    const ctx = new OAC(2, Math.ceil(len * sr), sr);
    const eng = new AudioEngine(); eng.manual = true; eng.quality = 'eco'; eng.useContext(ctx);
    const one = Object.assign({}, song, { tracks: [song.tracks[ti]] });
    await eng.load(one, time, { reverb: false, quality: 'eco' });
    eng.LOOK = len + 5; await eng.play();
    const buf = await ctx.startRendering();
    const got = onsets(buf);
    const start = eng.anchors.length ? eng.anchors[0].ctx : 0.08;
    const want = [...new Set(eng.events.map(e => +(e.s + start).toFixed(4)))];
    const errs = want.map(w => { let b = 1e9; for (const g of got) if (Math.abs(g - w) < Math.abs(b)) b = g - w; return b; });
    const found = errs.filter(e => Math.abs(e) < 0.05);
    const mean = found.reduce((a, b) => a + b, 0) / Math.max(1, found.length);
    const spread = found.length ? Math.max(...found.map(e => Math.abs(e - mean))) : 1;
    // наклон ошибки во времени (ускорение/замедление дорожки)
    const xs = want.filter((w, i) => Math.abs(errs[i]) < 0.05), ys = found;
    let slope = 0; if (xs.length > 2) { const mx = xs.reduce((a, b) => a + b, 0) / xs.length, my = ys.reduce((a, b) => a + b, 0) / ys.length; let num = 0, den = 0; xs.forEach((x, i) => { num += (x - mx) * (ys[i] - my); den += (x - mx) ** 2; }); slope = num / den; }
    let peak = 0; for (let c = 0; c < buf.numberOfChannels; c++) { const d = buf.getChannelData(c); for (let i = 0; i < d.length; i += 7) peak = Math.max(peak, Math.abs(d[i])); }
    perTrack.push({ name: song.tracks[ti].name, want: want.length, found: found.length, meanMs: mean * 1000, spreadMs: spread * 1000, slopeMsPerMin: slope * 60000, peak, timbre: eng.stats.perTrack[0] && eng.stats.perTrack[0].timbre });
  }
  const ok = perTrack.every(p => p.found >= p.want * 0.95 && p.spreadMs < 12 && Math.abs(p.slopeMsPerMin) < 5 && p.peak > 0.01);
  const offs = perTrack.map(p => p.meanMs); const between = Math.max(...offs) - Math.min(...offs);
  out.push(R(8, 'Звук всех дорожек (рендер): атаки нот на своих местах', ok && between < 15,
    perTrack.map(p => `${p.name} (${p.timbre}): найдено ${p.found}/${p.want}, сдвиг ${p.meanMs.toFixed(1)} мс, разброс ±${p.spreadMs.toFixed(1)} мс, дрейф ${p.slopeMsPerMin.toFixed(2)} мс/мин`).join('; ') + `; разница между дорожками ${between.toFixed(1)} мс`));
  // одновременные удары: бочка + малый + хай-хэт + крэш в одну долю — все звучат, никто не глушит другого
  if (progress) progress('Рендер: одновременные удары');
  const hits = [36, 38, 42, 49], res = [];
  for (const set of [[36], [38], [42], [49], hits]) {
    const ctx = new OAC(2, sr * 2, sr);
    const eng = new AudioEngine(); eng.manual = true; eng.quality = 'eco'; eng.useContext(ctx);
    const s = { tempos: [{ tick: 0, bpm: 120 }], measures: [{ n: 1, tick: 0, len: PPQ * 4, sig: [4, 4] }], totalTicks: PPQ * 4, tracks: [{ name: 'Ударные', kind: 'drums', program: 0, notes: set.map(m => ({ t: PPQ, d: PPQ / 4, m, v: 110, real: true })) }] };
    const tm = makeTime(s);
    await eng.load(s, tm, { reverb: false, quality: 'eco' }); eng.setVolume(0.2); eng.LOOK = 10; await eng.play(); // тихо — чтобы не работал лимитер
    const buf = await ctx.startRendering(); const d = buf.getChannelData(0);
    let e = 0; for (let i = 0; i < d.length; i++) e += d[i] * d[i];
    res.push({ set, energy: e, onset: onsets(buf)[0], voices: eng.events.length });
  }
  const sumSingles = res.slice(0, 4).reduce((a, r) => a + r.energy, 0), both = res[4].energy;
  const onsetsSame = res.every(r => r.onset != null && Math.abs(r.onset - res[0].onset) < 0.006);
  const ratio = both / sumSingles;
  out.push(R(6, 'Одновременные удары', onsetsSame && ratio > 0.6 && ratio < 1.8,
    `бочка, малый, хай-хэт и крэш в одну долю: атаки совпадают (±${(Math.max(...res.map(r => Math.abs(r.onset - res[0].onset))) * 1000).toFixed(1)} мс), энергия вместе / сумма по отдельности = ${ratio.toFixed(2)} (≈1 — никто не заглушён)`));
  return out;
}

// ---------- 4. Ритм PDF Songsterr: паузы ----------
// Синтетический такт 4/4: половинная пауза, восьмая пауза, восьмая нота, четыре шестнадцатые (как такт 4 «Осени пьяной»)
export function pdfRhythmTests() {
  const ys = [100, 108, 116, 124, 132, 140], st = { top: 100, bot: 140, sp: 8, ys, sx0: 0, sx1: 300 };
  const R4 = (x, y, w, h) => ({ t: ['M', 'L', 'L', 'L', 'L', 'Z'], b: { x0: x, y0: y, x1: x + w, y1: y + h } });
  const P = (x, y, w, h, t) => ({ t: t.split(''), b: { x0: x, y0: y, x1: x + w, y1: y + h } });
  const out = [{ kind: 'F', color: [22, 22, 22], subs: [
    R4(20, 120.05, 7.9, 3.95),                        // половинная: лежит на линии 124
    P(60, 113, 5.9, 9.8, 'MLLCCCCCCLLZ'),             // восьмая
    R4(200, 124, 7.9, 3.95),                          // целая: висит под линией 124 (в другом такте)
    P(230, 110, 7.2, 14.8, 'MLLCCCCCCLCCCCCCLLZ'),    // шестнадцатая
    P(238.3, 116, 2, 2.1, 'MCCCCCC')                  // точка после неё
  ] }];
  const rs = findRests(out, st);
  const kinds = rs.map(r => r.kind + ':' + r.dur).join(' ');
  const restsOk = kinds === 'half:2 8:0.5 whole:4 16:0.375';
  const notes = [100, 130, 150, 170, 190].map((x, i) => ({ si: 2, digits: '10', fret: 10, paren: false, x0: x - 3, x1: x + 3, cx: x, gray: false, b: { x0: x - 3, y0: 113, x1: x + 3, y1: 119 } }));
  const sy = { page: 1, top: 100, bot: 140, sp: 8, ys, sx0: 0, sx1: 210, measures: [{ x0: 0, x1: 210, n: 1, tempo: 95, sig: [4, 4] }], tun: [],
    notes, heads: [], dead: [], arcs: [], marks: [], rests: rs.filter(r => r.x < 210),
    voices: [[{ x: 100, dur: 0.5 }, { x: 130, dur: 0.25 }, { x: 150, dur: 0.25 }, { x: 170, dur: 0.25 }, { x: 190, dur: 0.25 }]] };
  const song = buildSong([sy], { title: 't', track: 'Guitar', instrument: '' });
  const starts = song.notes.map(n => n.start).join(' ');
  const timeOk = starts === '2.5 3 3.25 3.5 3.75';
  return [R(9, 'Ритм PDF Songsterr: паузы', restsOk && timeOk, `паузы: ${kinds}${restsOk ? '' : ' (ожидалось half:2 8:0.5 whole:4 16:0.375)'}; ноты после паузы на долях ${starts}${timeOk ? '' : ' (ожидалось 2.5 3 3.25 3.5 3.75)'}`)];
}

// Части песни: вступление A×4, B×8 (тихий куплет), C×8 (громкий припев с крэшем), B, C, D×4 (концовка)
export function sectionTests() {
  const M = PPQ * 4, plan = 'AAAABBBBBBBBCCCCCCCCBBBBBBBBCCCCCCCCDDDD'.split('');
  const pat = { A: [40, 40, 43, 45], B: [45, 45, 48, 45], C: [50, 53, 55, 57], D: [40, 43, 40, 36] };
  const g = [], d = [];
  plan.forEach((k, i) => { pat[k].forEach((m, j) => { g.push({ t: i * M + j * PPQ, d: PPQ, m, v: 100 }); if (k === 'C') g.push({ t: i * M + j * PPQ + PPQ / 2, d: PPQ / 2, m: m + 7, v: 100 }); });
    for (let j = 0; j < 4; j++) { d.push({ t: i * M + j * PPQ, d: 60, m: j % 2 ? 38 : 36, v: 100 }); if (k === 'C' && j === 0) d.push({ t: i * M, d: 60, m: 49, v: 110 }); } });
  const song = { measures: plan.map((k, i) => ({ n: i + 1, tick: i * M, len: M, sig: [4, 4] })), tracks: [{ kind: 'eguitar', tuning: [64, 59, 55, 50, 45, 40], notes: g }, { kind: 'drums', notes: d }] };
  const secs = detectSections(song);
  const got = secs.map(s => `${s.kind}:${s.a + 1}-${s.b + 1}`).join(' ');
  const want = 'intro:1-4 verse:5-12 chorus:13-20 verse:21-28 chorus:29-36 outro:37-40';
  return [R(10, 'Разметка частей песни', got === want, `найдено: ${secs.map(s => `${s.name} ${s.a + 1}–${s.b + 1}`).join(', ')}${got === want ? '' : ' (ожидалось: ' + want + ')'}`)];
}

export async function runAll(progress) {
  const res = [];
  res.push(...await scheduleTests());
  try { res.push(...pdfRhythmTests()); } catch (e) { res.push(R(9, 'Ритм PDF Songsterr: паузы', false, String(e && e.message || e))); }
  try { res.push(...sectionTests()); } catch (e) { res.push(R(10, 'Разметка частей песни', false, String(e && e.message || e))); }
  const d = await drumTests(); res.push(...d.out);
  try { res.push(...await audioTests(progress)); } catch (e) { res.push(R(8, 'Рендер звука', false, String(e && e.message || e))); }
  return { results: res.sort((a, b) => a.id - b.id), drums: d.table };
}
