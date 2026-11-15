// Единый аудиодвижок NotyViz: настоящие семплы инструментов и общие часы для всех дорожек.
//
// Время. Мастер-часы — AudioContext.currentTime. Позиция в композиции определяется «якорем»:
//   songSec = anchor.sec + (ctxTime − anchor.ctx) × скорость.
// Ноты всех дорожек сведены в один список, отсортированный по времени (секунды по темповой карте).
// Планировщик раз в 25 мс ставит в очередь ноты, которые прозвучат в ближайшие 0,3 с (look-ahead),
// и двигает единый курсор: каждая нота планируется ровно один раз, у дорожек нет своих таймеров.
// Пауза, перемотка, смена скорости и повтор — это новый якорь; уже запланированные ноты гасятся.
// Картинка берёт время с тех же часов (getOutputTimestamp — то, что сейчас слышно из динамика).
//
// Звук. Инструмент — набор семплов (pack.json + .ogg): диапазон клавиш, слой громкости, вариации
// (round robin), петля, огибающая. Подтяжки и вибрато — detune голоса, глушение ладонью — фильтр и
// короткая огибающая, у гитары одна струна звучит одним голосом. Электрогитара записана «в линию» и
// проходит через усилитель, кабинет и эффекты (см. FX_PRESETS).
import { PPQ, isStringKind, GM_NAMES } from './model.js';
import { perform } from './techniques.js';

// ---------------- Каталог тембров ----------------
export const TIMBRES = [
  { id: 'grand', gain: 3, name: 'Концертный рояль (Yamaha C5, Salamander)', group: 'piano', pack: 'piano', prog: 'grand' },
  { id: 'upright', gain: 2, name: 'Акустическое пианино', group: 'piano', pack: 'gm', prog: '0' },
  { id: 'bright', gain: 1, name: 'Яркое фортепиано', group: 'piano', pack: 'gm', prog: '1' },
  { id: 'rhodes', gain: -4, name: 'Электропиано Rhodes', group: 'piano', pack: 'rhodes', prog: 'rhodes', fx: 'ep' },
  { id: 'tine', gain: -2, name: 'Электропиано (Tine)', group: 'piano', pack: 'gm', prog: '4', fx: 'ep' },
  { id: 'cp70', name: 'Электрический рояль (CP-70)', group: 'piano', pack: 'gm', prog: '2' },
  { id: 'fmep', gain: -2, name: 'Электропиано FM (DX7)', group: 'piano', pack: 'gm', prog: '5', fx: 'ep' },
  { id: 'egtr_clean', gain: 1, name: 'Электрогитара — Clean', group: 'guitar', pack: 'egtr', prog: 'notes', fx: 'clean' },
  { id: 'egtr_crunch', gain: -3, name: 'Электрогитара — Overdrive', group: 'guitar', pack: 'egtr', prog: 'notes', fx: 'crunch' },
  { id: 'egtr_dist', gain: -3, name: 'Электрогитара — Distortion', group: 'guitar', pack: 'egtr', prog: 'notes', fx: 'dist' },
  { id: 'egtr_lead', gain: -3, name: 'Электрогитара — Lead (дисторшн + дилей)', group: 'guitar', pack: 'egtr', prog: 'notes', fx: 'lead' },
  { id: 'agtr', name: 'Акустическая гитара (Martin)', group: 'guitar', pack: 'agtr', prog: 'steel', fx: 'acoustic' },
  { id: 'nylon', gain: 4, name: 'Классическая гитара (нейлон)', group: 'guitar', pack: 'gm', prog: '24', fx: 'acoustic' },
  { id: 'jazz', gain: 1, name: 'Джазовая гитара', group: 'guitar', pack: 'gm', prog: '26', fx: 'clean' },
  { id: 'bass_finger', name: 'Бас — пальцами (Jazz Bass)', group: 'bass', pack: 'bass', prog: 'finger', fx: 'bass' },
  { id: 'bass_muted', name: 'Бас — приглушённый', group: 'bass', pack: 'bass', prog: 'muted', fx: 'bass' },
  { id: 'bass_pick', name: 'Бас — медиатором', group: 'bass', pack: 'gm', prog: '34', fx: 'bass' },
  { id: 'bass_slap', name: 'Бас — слэп', group: 'bass', pack: 'gm', prog: '36', fx: 'bass' },
  { id: 'bass_pop', name: 'Бас — слэп/поп 2', group: 'bass', pack: 'gm', prog: '37', fx: 'bass' },
  { id: 'bass_fretless', name: 'Безладовый бас', group: 'bass', pack: 'gm', prog: '35', fx: 'bass' },
  { id: 'bass_acoustic', name: 'Контрабас (акустический бас)', group: 'bass', pack: 'gm', prog: '32', fx: 'bass' },
  { id: 'kit_live', name: 'Живая установка (Virtuosity Drums)', group: 'drums', pack: 'kit', prog: 'kit', fallback: { pack: 'gm', prog: 'drums' }, fx: 'drums' },
  { id: 'kit_gm', name: 'Стандартная установка (GeneralUser)', group: 'drums', pack: 'gm', prog: 'drums', fx: 'drums' },
];
export const TIMBRE = Object.fromEntries(TIMBRES.map(t => [t.id, t]));
export const GROUP_LABEL = { piano: 'Клавишные', guitar: 'Гитары', bass: 'Бас-гитары', drums: 'Ударные', gm: 'Другие инструменты General MIDI' };
export function timbreFor(id) {
  if (TIMBRE[id]) return TIMBRE[id];
  const m = /^gm:(\d+)$/.exec(id || '');
  if (m) return { id, name: (GM_NAMES[+m[1]] || 'GM ' + m[1]) + ' (GeneralUser)', group: 'gm', pack: 'gm', prog: m[1], fx: 'none' };
  return TIMBRE.grand;
}
// Тембр по умолчанию — по типу дорожки и номеру инструмента General MIDI
export function defaultTimbre(tr, progOverride, trusted) {
  const p = progOverride != null ? progOverride : (tr.program || 0);
  if (tr.kind === 'drums') return 'kit_live';
  if (p <= 7 && (tr.kind === 'piano' || progOverride != null || trusted || !isStringKind(tr.kind))) return ({ 0: 'grand', 1: 'bright', 2: 'cp70', 3: 'gm:3', 4: 'rhodes', 5: 'fmep', 6: 'gm:6', 7: 'gm:7' })[p];
  if (p >= 24 && p <= 31) return ({ 24: 'nylon', 25: 'agtr', 26: 'jazz', 27: 'egtr_clean', 28: 'egtr_clean', 29: 'egtr_crunch', 30: 'egtr_dist', 31: 'gm:31' })[p];
  if (p >= 32 && p <= 37) return ({ 32: 'bass_acoustic', 33: 'bass_finger', 34: 'bass_pick', 35: 'bass_fretless', 36: 'bass_slap', 37: 'bass_pop' })[p];
  // номер инструмента неизвестен (0 у гитарной/басовой дорожки) — по типу дорожки
  if (p === 0 && progOverride == null && !trusted) {
    if (tr.kind === 'bass') return 'bass_finger';
    if (tr.kind === 'aguitar') return 'agtr';
    if (tr.kind === 'eguitar' || tr.kind === 'guitar') return 'egtr_dist';
  }
  return 'gm:' + p;
}

// ---------------- Эффекты ----------------
// Параметры: drive 0..1, gain (дБ), low/mid/high (дБ), cab (кабинет), chorus, delay, delayTime, reverb (посыл)
export const FX_PRESETS = {
  none: { label: 'Без обработки', amp: null, reverb: 0.12 },
  piano: { label: 'Фортепиано', amp: null, reverb: 0.18, low: 0, mid: 0, high: 0 },
  ep: { label: 'Электропиано', amp: 'clean', drive: 0.05, cab: false, chorus: 0.25, reverb: 0.18, low: 1, mid: 0, high: 0 },
  clean: { label: 'Clean', amp: 'clean', drive: 0.12, cab: true, chorus: 0.2, delay: 0, delayTime: 0.36, reverb: 0.2, low: 1, mid: 0, high: 2 },
  crunch: { label: 'Overdrive', amp: 'od', drive: 0.45, cab: true, chorus: 0, delay: 0, delayTime: 0.36, reverb: 0.14, low: 1, mid: 2, high: 1 },
  dist: { label: 'Distortion', amp: 'dist', drive: 0.75, cab: true, chorus: 0, delay: 0, delayTime: 0.36, reverb: 0.12, low: 2, mid: -2, high: 1 },
  lead: { label: 'Lead', amp: 'dist', drive: 0.85, cab: true, chorus: 0, delay: 0.22, delayTime: 0.38, reverb: 0.2, low: 1, mid: 1, high: 1 },
  acoustic: { label: 'Акустика', amp: null, reverb: 0.2, low: 0, mid: 0, high: 1 },
  bass: { label: 'Бас', amp: 'bass', drive: 0.08, cab: true, reverb: 0.04, low: 2, mid: 0, high: 0 },
  drums: { label: 'Ударные', amp: null, reverb: 0.1, low: 0, mid: 0, high: 0 },
};
export const FX_FOR_GROUP = { piano: ['piano', 'ep', 'none'], guitar: ['clean', 'crunch', 'dist', 'lead', 'acoustic', 'none'], bass: ['bass', 'none'], drums: ['drums', 'none'], gm: ['none', 'clean', 'crunch', 'dist'] };

function curve(kind, amount) {
  const n = 2048, c = new Float32Array(n);
  const k = kind === 'dist' ? 2 + amount * 60 : kind === 'od' ? 1 + amount * 18 : kind === 'bass' ? 1 + amount * 6 : 1 + amount * 3;
  for (let i = 0; i < n; i++) {
    const x = i / (n - 1) * 2 - 1;
    if (kind === 'od') c[i] = Math.tanh(k * x + 0.15 * x * x) / Math.tanh(k + 0.15);       // мягкое асимметричное, как ламповый каскад
    else if (kind === 'dist') { const y = Math.tanh(k * x); c[i] = Math.sign(y) * Math.pow(Math.abs(y), 0.85); }
    else c[i] = Math.tanh(k * x) / Math.tanh(k);
  }
  return c;
}
function biq(ctx, type, f, g = 0, q = 0.707) { const b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = f; b.gain.value = g; b.Q.value = q; return b; }
function chainNodes(nodes) { for (let i = 0; i + 1 < nodes.length; i++) nodes[i].connect(nodes[i + 1]); return nodes; }

// Цепочка дорожки: вход → [усилитель → кабинет] → эквалайзер → [хорус] → [дилей] → громкость → общая шина + посыл в реверб
class TrackChain {
  constructor(eng) {
    const ctx = eng.ctx; this.eng = eng; this.ctx = ctx;
    this.input = ctx.createGain(); this.out = ctx.createGain(); this.send = ctx.createGain(); this.send.gain.value = 0;
    this.mute = ctx.createGain(); this.meter = ctx.createAnalyser(); this.meter.fftSize = 256;
    this.out.connect(this.mute); this.mute.connect(eng.bus); this.mute.connect(this.send); this.send.connect(eng.revIn); this.mute.connect(this.meter);
    this.nodes = []; this.params = null;
  }
  set(params) {
    const ctx = this.ctx, p = Object.assign({}, FX_PRESETS[params.preset] || FX_PRESETS.none, params);
    for (const n of this.nodes) try { n.disconnect(); } catch (e) { }
    for (const o of this.oscs || []) try { o.stop(); } catch (e) { }
    this.input.disconnect(); this.nodes = []; this.oscs = [];
    const lo = this.eng.quality === 'eco';
    let cur = this.input;
    const add = (...ns) => { for (const n of ns) { cur.connect(n); cur = n; this.nodes.push(n); } };
    if (p.amp && p.ampOn !== false) {
      const kind = p.amp;
      const drive = Math.max(0, Math.min(1, p.drive || 0));
      // предусилитель: срез низа перед перегрузом (у дисторшна — плотнее), затем ограничитель
      add(biq(ctx, 'highpass', kind === 'dist' ? 140 : kind === 'bass' ? 30 : 90, 0, 0.7));
      if (kind === 'od') add(biq(ctx, 'peaking', 720, 6 * drive + 2, 0.9)); // «тьюб-скример»: подъём середины до перегруза
      const pre = ctx.createGain(); pre.gain.value = kind === 'dist' ? 2 + drive * 6 : kind === 'od' ? 1.5 + drive * 4 : 1 + drive * 2; add(pre);
      const ws = ctx.createWaveShaper(); ws.curve = curve(kind === 'clean' || kind === 'bass' ? 'soft' : kind, drive); ws.oversample = lo ? '2x' : '4x'; add(ws);
      if (kind === 'dist') { const ws2 = ctx.createWaveShaper(); ws2.curve = curve('od', 0.5); ws2.oversample = lo ? 'none' : '2x'; add(biq(ctx, 'lowpass', 6500, 0, 0.7), ws2); }
      // тембр-блок усилителя
      add(biq(ctx, 'lowshelf', 120, p.low || 0), biq(ctx, 'peaking', kind === 'dist' ? 650 : 900, p.mid || 0, 0.8), biq(ctx, 'highshelf', 2800, p.high || 0));
      // кабинет 4×12 (для баса 1×15): характерная АЧХ динамика
      if (p.cab !== false) {
        if (kind === 'bass') add(biq(ctx, 'peaking', 90, 3, 1), biq(ctx, 'peaking', 800, -2, 1), biq(ctx, 'lowpass', 4200, 0, 0.8));
        else add(biq(ctx, 'highpass', 75, 0, 0.8), biq(ctx, 'peaking', 110, 3, 1.2), biq(ctx, 'peaking', 400, -3, 0.9), biq(ctx, 'peaking', 2400, 4, 1.4), biq(ctx, 'lowpass', 4800, 0, 1.0), biq(ctx, 'lowpass', 7000, 0, 0.6));
      }
      const post = ctx.createGain(); post.gain.value = (kind === 'dist' ? 0.32 : kind === 'od' ? 0.5 : kind === 'bass' ? 0.9 : 0.85) * Math.pow(10, (p.gain || 0) / 20); add(post);
      if (kind === 'bass') { const c = ctx.createDynamicsCompressor(); c.threshold.value = -20; c.ratio.value = 4; c.attack.value = 0.01; c.release.value = 0.2; add(c); }
    } else {
      add(biq(ctx, 'lowshelf', 120, p.low || 0), biq(ctx, 'peaking', 1000, p.mid || 0, 0.8), biq(ctx, 'highshelf', 5000, p.high || 0));
    }
    // хорус: две модулируемые задержки
    if ((p.chorus || 0) > 0 && !lo) {
      const dry = ctx.createGain(), wet = ctx.createGain(), sum = ctx.createGain(); dry.gain.value = 1; wet.gain.value = p.chorus;
      cur.connect(dry); dry.connect(sum);
      [[0.012, 0.7, 0.0025], [0.017, 1.1, 0.002]].forEach(([d, f, depth], i) => {
        const dl = ctx.createDelay(0.05); dl.delayTime.value = d; const lfo = ctx.createOscillator(); lfo.frequency.value = f; const lg = ctx.createGain(); lg.gain.value = depth;
        lfo.connect(lg); lg.connect(dl.delayTime); lfo.start(); this.oscs.push(lfo);
        const pan = ctx.createStereoPanner(); pan.pan.value = i ? 0.6 : -0.6;
        cur.connect(dl); dl.connect(pan); pan.connect(wet); this.nodes.push(dl, lg, pan);
      });
      wet.connect(sum); this.nodes.push(dry, wet, sum); cur = sum;
    }
    // дилей с затуханием и фильтром в петле
    if ((p.delay || 0) > 0) {
      const dry = ctx.createGain(), dl = ctx.createDelay(2), fb = ctx.createGain(), lp = biq(ctx, 'lowpass', 3500), wet = ctx.createGain(), sum = ctx.createGain();
      dl.delayTime.value = p.delayTime || 0.36; fb.gain.value = 0.35; wet.gain.value = p.delay;
      cur.connect(dry); dry.connect(sum); cur.connect(dl); dl.connect(lp); lp.connect(fb); fb.connect(dl); lp.connect(wet); wet.connect(sum);
      this.nodes.push(dry, dl, fb, lp, wet, sum); cur = sum;
    }
    cur.connect(this.out); this.nodes.push(cur);
    this.send.gain.value = this.eng.reverbOn ? (p.reverb || 0) : 0;
    this.params = p;
  }
}

// Импульсная характеристика зала для свёрточного ревербератора (затухающий стереошум с фильтрацией)
function makeIR(ctx, seconds = 2.2, decay = 3.2) {
  const sr = ctx.sampleRate, n = Math.floor(sr * seconds), b = ctx.createBuffer(2, n, sr);
  for (let c = 0; c < 2; c++) {
    const d = b.getChannelData(c); let lp = 0;
    for (let i = 0; i < n; i++) {
      const t = i / n, w = Math.random() * 2 - 1; lp += (w - lp) * (0.25 + 0.6 * (1 - t));
      d[i] = (i < sr * 0.012 ? 0 : lp) * Math.pow(1 - t, decay);
    }
  }
  return b;
}

// ---------------- Банк семплов ----------------
class Bank {
  constructor(eng) { this.eng = eng; this.packs = new Map(); this.buf = new Map(); this.pending = new Map(); this.bytes = 0; }
  async pack(name) {
    if (!this.packs.has(name)) this.packs.set(name, fetch('snd/' + name + '/pack.json').then(r => { if (!r.ok) throw new Error('нет набора ' + name); return r.json(); }));
    return this.packs.get(name);
  }
  // Загрузка нужных семплов программы: только клавиши и слои громкости, которые есть в композиции
  async program(packName, progId, need) {
    const pk = await this.pack(packName); const pr = pk.programs[progId];
    if (!pr) throw new Error('нет инструмента ' + packName + '/' + progId);
    const eco = this.eng.quality === 'eco';
    const regs = pr.regions.filter(r => !need || need(r));
    const ids = [...new Set(regs.map(r => r.s))];
    const work = [];
    let i = 0;
    const next = async () => { while (i < ids.length) { const s = ids[i++]; await this.sample(packName, pk, s, eco); } };
    for (let k = 0; k < 4; k++) work.push(next());
    await Promise.all(work);
    return { pack: packName, prog: progId, name: pr.name, vt: pr.vt != null ? pr.vt : 1, sf2: !!pr.sf2, drum: !!pr.drum, regions: pr.regions, has: s => this.buf.has(this.key(packName, s, eco)), get: s => this.buf.get(this.key(packName, s, eco)) || this.buf.get(this.key(packName, s, !eco)) };
  }
  key(p, s, eco) { return p + '/' + s + (eco ? 'm' : ''); }
  async sample(packName, pk, s, eco) {
    const k = this.key(packName, s, eco);
    if (this.buf.has(k)) return this.buf.get(k);
    if (this.pending.has(k)) return this.pending.get(k);
    const pr = (async () => {
      const r = await fetch('snd/' + packName + '/' + pk.samples[s]);
      const ab = await r.arrayBuffer();
      let b = await this.eng.ctx.decodeAudioData(ab);
      if (eco && b.numberOfChannels > 1) { // экономный режим: моно — вдвое меньше памяти
        const m = this.eng.ctx.createBuffer(1, b.length, b.sampleRate), d = m.getChannelData(0), L = b.getChannelData(0), R = b.getChannelData(1);
        for (let i = 0; i < d.length; i++) d[i] = (L[i] + R[i]) * 0.5; b = m;
      }
      this.bytes += b.length * b.numberOfChannels * 4;
      this.buf.set(k, b); this.pending.delete(k); return b;
    })();
    this.pending.set(k, pr);
    return pr;
  }
}

// выбор зоны: клавиша и громкость, вариации по кругу
function pickRegion(inst, m, v, rrState, trig) {
  let best = null, bd = 1e9; const cands = [];
  for (const r of inst.regions) {
    if ((r.trig === 'r') !== (trig === 'r')) continue;
    if (!inst.has(r.s)) continue;
    if (v < r.lv || v > r.hv) continue;
    if (m >= r.lk && m <= r.hk) cands.push(r);
    else { const d = m < r.lk ? r.lk - m : m - r.hk; if (d < bd) { bd = d; best = r; } }
  }
  if (!cands.length) {
    if (trig === 'r') return null;
    if (inst.drum) return null; // у ударных нет «ближайшего» звука: неизвестный элемент не подменяем
    if (best && bd <= 12) return best; return null;
  }
  if (cands.length === 1) return cands[0];
  // несколько: вариации (rr) или стереопара (SF2 — играем все с панорамой)
  if (inst.sf2) return cands;
  const n = cands[0].rrn || cands.length;
  const key = inst.pack + inst.prog + m + ':' + cands[0].lv;
  const k = (rrState.get(key) || 0) % n; rrState.set(key, k + 1);
  const withRr = cands.filter(r => r.rr != null);
  if (withRr.length) { const same = withRr.filter(r => r.rr === k + 1); return same.length ? same[0] : withRr[0]; }
  return cands[k % cands.length];
}

// ---------------- Движок ----------------
export class AudioEngine {
  constructor() {
    this.ctx = null; this.bank = null;
    this.events = []; this.cursor = 0; this.anchors = []; this.playing = false; this.speed = 1;
    this.posSec = 0; this.loop = null; this.voices = new Set(); this.strings = new Map();
    this.metro = false; this.vol = 0.9; this.quality = 'high'; this.reverbOn = true; this.oct = 0;
    this.trackState = []; this.chains = []; this.insts = [];
    this.stats = { scheduled: 0, late: 0, maxLateMs: 0, dupes: 0, voicesPeak: 0, perTrack: [], drums: [], lastDrum: null, unknownDrums: 0 };
    this.LOOK = 0.3; this.TICK_MS = 25;
    this.onEnd = null; this.onLoad = null;
    this.timer = null;
  }
  // для тестов: свой контекст (OfflineAudioContext) или «сухой» режим без звука с журналом планирования
  useContext(ctx) { this.ctx = null; this.ensureCtx(ctx); return this; }
  ensureCtx(given) {
    if (this.ctx) return this.ctx;
    if (given && given.fake) { this.ctx = given; this.bank = new Bank(this); return given; }
    const AC = window.AudioContext || window.webkitAudioContext;
    let ctx = given;
    if (!ctx) { try { ctx = new AC({ latencyHint: 'playback', sampleRate: 44100 }); } catch (e) { ctx = new AC(); } }
    this.ctx = ctx; this.bank = new Bank(this);
    this.master = ctx.createGain(); this.master.gain.value = this.vol;
    this.limiter = ctx.createDynamicsCompressor(); this.limiter.threshold.value = -8; this.limiter.knee.value = 4; this.limiter.ratio.value = 16; this.limiter.attack.value = 0.001; this.limiter.release.value = 0.15;
    this.bus = ctx.createGain(); this.bus.gain.value = 0.75; this.revIn = ctx.createGain();
    this.reverb = ctx.createConvolver(); this.reverb.buffer = makeIR(ctx); this.revOut = ctx.createGain(); this.revOut.gain.value = 0.9;
    this.revIn.connect(this.reverb); this.reverb.connect(this.revOut); this.revOut.connect(this.master);
    this.bus.connect(this.master); this.master.connect(this.limiter); this.limiter.connect(ctx.destination);
    this.metroGain = ctx.createGain(); this.metroGain.gain.value = 0.7; this.metroGain.connect(this.limiter);
    return ctx;
  }
  // ---------- загрузка композиции ----------
  // song — внутренняя модель, time — makeTime(song), sound — настройки звука композиции
  async load(song, time, sound = {}, progress) {
    this.stopAll(0.01); this.ensureCtx();
    if (this.ctx.fake) return this.loadDry(song, time, sound);
    this.song = song; this.time = time; this.sound = sound;
    this.quality = sound.quality || (navigator.deviceMemory && navigator.deviceMemory <= 4 ? 'eco' : 'high'); this.reverbOn = sound.reverb !== false;
    // цепочки дорожек
    for (const c of this.chains) try { c.out.disconnect(); c.mute.disconnect(); } catch (e) { }
    this.chains = song.tracks.map(() => new TrackChain(this));
    this.trackState = song.tracks.map((tr, i) => ({ mute: false, solo: false, vol: tr.volume != null ? tr.volume : 1 }));
    // события всех дорожек → секунды
    const evs = [];
    const usedKeys = song.tracks.map(() => new Map());
    song.tracks.forEach((tr, ti) => {
      const perf = perform(tr, PPQ, tr.kind === 'drums' ? 0 : this.oct);
      const bends = perf.bends;
      const ped = tr.pedal || [];
      for (const e of perf.events) {
        const n = tr.notes[e.src];
        let endT = e.t + e.d;
        // педаль сустейна: снятие ноты откладывается до снятия педали
        if (ped.length && tr.kind !== 'drums') for (const [a, b] of ped) if (endT > a && endT < b) { endT = b; break; }
        const x = n && n.x || {};
        const ev = { tr: ti, s: time.toSec(e.t), e: time.toSec(endT), m: e.m, v: Math.max(1, Math.min(127, Math.round(e.v || 96))), ch: e.ch || null, str: n ? n.s : null, x, t: e.t, tEnd: endT };
        if (x.hp || (x.sl === 'legato')) ev.legato = true;
        if (x.slap || x.pop) ev.slap = x.pop ? 'pop' : 'slap';
        evs.push(ev);
        const um = usedKeys[ti]; um.set(e.m, Math.max(um.get(e.m) || 0, 1)); um.set('v' + Math.floor(ev.v / 8), 1);
      }
      tr._bends = bends && bends.length ? bends : null;
    });
    evs.sort((a, b) => a.s - b.s || a.tr - b.tr || a.m - b.m);
    evs.forEach((e, i) => e.i = i);
    this.events = evs; this.cursor = 0;
    this.metroEvents = this.buildMetronome(song, time);
    this.stats.perTrack = song.tracks.map((tr, i) => ({ name: tr.name, kind: tr.kind, count: evs.filter(e => e.tr === i).length, scheduled: 0, lastSec: 0, timbre: '' }));
    this.stats.drums = []; this.stats.unknownDrums = 0;
    // инструменты: грузим только нужное
    if (progress) progress('Загружаю семплы…');
    this.insts = await Promise.all(song.tracks.map((tr, ti) => this.loadTrack(tr, ti, usedKeys[ti], evs.filter(e => e.tr === ti))));
    this.applyMix();
    if (this.onLoad) this.onLoad();
    return true;
  }
  loadDry(song, time, sound) { // только расписание, без семплов
    this.song = song; this.time = time; this.sound = sound; this.trackState = song.tracks.map(() => ({})); this.chains = []; this.insts = song.tracks.map(() => ({ main: {} }));
    const evs = [];
    song.tracks.forEach((tr, ti) => { const perf = perform(tr, PPQ, 0); for (const e of perf.events) evs.push({ tr: ti, s: time.toSec(e.t), e: time.toSec(e.t + e.d), m: e.m, v: e.v || 96, x: {}, t: e.t, tEnd: e.t + e.d }); });
    evs.sort((a, b) => a.s - b.s || a.tr - b.tr || a.m - b.m); evs.forEach((e, i) => e.i = i);
    this.events = evs; this.metroEvents = this.buildMetronome(song, time); this.log = [];
    this.stats.perTrack = song.tracks.map(tr => ({ name: tr.name, count: 0, scheduled: 0, lastSec: 0 }));
    return true;
  }
  timbreOf(ti) {
    const tr = this.song.tracks[ti], st = (this.sound.tracks || {})[ti] || {};
    return st.timbre || defaultTimbre(tr, (this.sound.prog || {})[ti], this.song.source === 'gp' || this.song.source === 'midi');
  }
  async loadTrack(tr, ti, used, evs) {
    const tb = timbreFor(this.timbreOf(ti));
    const st = (this.sound.tracks || {})[ti] || {};
    const keys = new Set(evs.map(e => e.m));
    // пары «клавиша — сила удара», которые реально есть в композиции: грузим только нужные семплы
    const pairs = new Map(); for (const e of evs) { const k = e.m; if (!pairs.has(k)) pairs.set(k, new Set()); pairs.get(k).add(e.v); }
    const eco = this.quality === 'eco';
    const needFor = (drum) => r => {
      if (eco && r.rr > 1) return false;
      const b = drum ? 0 : 3;
      if (r.trig === 'r') return [...keys].some(k => k >= r.lk - b && k <= r.hk + b);
      for (const [k, vs] of pairs) {
        if (k < r.lk - b || k > r.hk + b) continue;
        for (const v of vs) if (v >= r.lv && v <= r.hv) return true;
      }
      return false;
    };
    const res = { timbre: tb, main: null, fallback: null, dead: null, harm: null, muted: null, slap: null, errors: [] };
    const drum = tr.kind === 'drums';
    try { res.main = await this.bank.program(tb.pack, tb.prog, needFor(drum || tb.group === 'drums')); } catch (e) { res.errors.push(String(e.message || e)); }
    if (drum && tb.fallback) { try { res.fallback = await this.bank.program(tb.fallback.pack, tb.fallback.prog, needFor(true)); } catch (e) { } }
    if (!res.main) { try { res.main = await this.bank.program('gm', drum ? 'drums' : String(tr.program || 0), needFor(drum)); } catch (e) { } }
    // тембры техник
    const has = ch => evs.some(e => e.ch === ch);
    if (!drum && has('dead')) {
      try { res.dead = tb.pack === 'egtr' ? await this.bank.program('egtr', 'dead') : tb.group === 'bass' ? await this.bank.program('bass', 'muted', needFor(false)) : await this.bank.program('gm', '28', needFor(false)); } catch (e) { }
    }
    if (!drum && has('harm')) { try { res.harm = await this.bank.program('gm', '31', needFor(false)); } catch (e) { } }
    if (!drum && has('pm') && tb.group === 'bass' && tb.pack === 'bass') { try { res.muted = await this.bank.program('bass', 'muted', needFor(false)); } catch (e) { } }
    if (!drum && tb.group === 'bass' && evs.some(e => e.slap)) { try { res.slap = await this.bank.program('gm', '36', needFor(false)); res.pop = await this.bank.program('gm', '37', needFor(false)); } catch (e) { } }
    const preset = st.fx || tb.fx || (tb.group === 'piano' ? 'piano' : 'none');
    this.chains[ti].set(Object.assign({ preset }, st.fxParams || {}));
    this.chains[ti].out.gain.value = Math.pow(10, (tb.gain || 0) / 20); // выравнивание громкости тембров
    this.stats.perTrack[ti].timbre = tb.name;
    return res;
  }
  buildMetronome(song, time) {
    const out = [];
    for (const m of song.measures) {
      const bt = PPQ * 4 / m.sig[1];
      for (let b = 0; b < m.sig[0]; b++) out.push({ s: time.toSec(m.tick + b * bt), accent: b === 0 });
    }
    return out;
  }
  // ---------- микшер ----------
  setTrackState(i, st) { Object.assign(this.trackState[i] || {}, st); this.applyMix(); }
  applyMix() {
    if (!this.ctx) return;
    const anySolo = this.trackState.some(s => s.solo);
    this.chains.forEach((c, i) => {
      const s = this.trackState[i] || {};
      const on = !s.mute && (!anySolo || s.solo);
      c.mute.gain.setTargetAtTime(on ? (s.vol != null ? s.vol : 1) : 0, this.ctx.currentTime, 0.01);
    });
  }
  setVolume(v) { this.vol = v; if (this.master) this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.02); }
  setReverb(on) { this.reverbOn = on; this.chains.forEach(c => { if (c.params) c.send.gain.value = on ? (c.params.reverb || 0) : 0; }); }
  setFx(i, params) { const c = this.chains[i]; if (c) c.set(params); }
  // ---------- часы ----------
  songSecAt(ct) {
    const A = this.anchors; if (!A.length) return this.posSec;
    let a = A[0]; for (const x of A) if (x.ctx <= ct + 1e-9) a = x;
    return a.sec + Math.max(0, ct - a.ctx) * a.speed;
  }
  ctxAtSong(sec, a) { return a.ctx + (sec - a.sec) / a.speed; }
  // То, что сейчас звучит из динамика (с поправкой на задержку вывода)
  heardCtxTime() {
    const ctx = this.ctx; if (!ctx) return 0;
    if (ctx.fake || this.manual) return ctx.currentTime;
    if (ctx.getOutputTimestamp) {
      const ts = ctx.getOutputTimestamp();
      if (ts && ts.contextTime > 0 && ts.performanceTime > 0) return ts.contextTime + Math.max(0, Math.min(0.2, (performance.now() - ts.performanceTime) / 1000));
    }
    return ctx.currentTime - (ctx.outputLatency || ctx.baseLatency || 0);
  }
  nowSec() { if (!this.playing) return this.posSec; return Math.max(this.anchors.length ? this.anchors[0].sec : 0, this.songSecAt(this.heardCtxTime())); }
  // ---------- транспорт ----------
  async play() {
    const ctx = this.ensureCtx();
    if (ctx.state && ctx.state !== 'running' && ctx.resume) { try { await ctx.resume(); } catch (e) { } }
    if (this.playing) return;
    if (this.posSec >= this.time.total - 0.05) this.posSec = 0;
    this.playing = true;
    this.anchorAt(this.posSec, ctx.currentTime + 0.08);
    this.stats.late = 0; this.stats.maxLateMs = 0;
    this.pump();
    if (!ctx.fake && !this.manual) this.timer = setInterval(() => this.pump(), this.TICK_MS);
  }
  pause() {
    if (!this.playing) return;
    this.posSec = this.nowSec(); this.playing = false;
    clearInterval(this.timer); this.timer = null;
    this.stopAll(0.04); this.anchors = [];
  }
  seek(sec) {
    sec = Math.max(0, Math.min(this.time ? this.time.total : 0, sec));
    if (!this.playing) { this.posSec = sec; return; }
    this.stopAll(0.03);
    this.anchorAt(sec, this.ctx.currentTime + 0.04);
    this.pump();
  }
  setSpeed(s) {
    if (s === this.speed) return;
    if (!this.playing) { this.speed = s; return; }
    const ct = this.ctx.currentTime + 0.04, sec = this.songSecAt(ct);
    this.speed = s; this.stopAll(0.03); this.anchorAt(sec, ct); this.pump();
  }
  setLoop(a, b) { this.loop = a == null ? null : { a, b }; }
  anchorAt(sec, ct) {
    this.anchors = [{ ctx: ct, sec, speed: this.speed }];
    this.cursor = this.indexAt(sec); this.mCursor = this.mIndexAt(sec);
  }
  indexAt(sec) { const E = this.events; let lo = 0, hi = E.length; while (lo < hi) { const m = (lo + hi) >> 1; if (E[m].s < sec - 1e-6) lo = m + 1; else hi = m; } return lo; }
  mIndexAt(sec) { const E = this.metroEvents || []; let lo = 0, hi = E.length; while (lo < hi) { const m = (lo + hi) >> 1; if (E[m].s < sec - 1e-6) lo = m + 1; else hi = m; } return lo; }
  // Планировщик: всё, что прозвучит в ближайшие LOOK секунд
  pump() {
    if (!this.playing) return;
    const ctx = this.ctx, now = ctx.currentTime, horizon = now + this.LOOK;
    let a = this.anchors[this.anchors.length - 1];
    let guard = 0;
    while (guard++ < 8) {
      const endSec = a.sec + (horizon - a.ctx) * a.speed;
      const loopB = this.loop ? this.time.toSec(this.loop.b) : Infinity;
      const lim = Math.min(endSec, loopB);
      const E = this.events;
      while (this.cursor < E.length && E[this.cursor].s < lim) {
        const e = E[this.cursor++];
        if (e.s < a.sec - 1e-6) continue;
        const when = this.ctxAtSong(e.s, a);
        this.startEvent(e, when, a);
      }
      if (this.metro) {
        const M = this.metroEvents;
        while (this.mCursor < M.length && M[this.mCursor].s < lim) { const m = M[this.mCursor++]; if (m.s >= a.sec - 1e-6) this.click(this.ctxAtSong(m.s, a), m.accent); }
      } else this.mCursor = this.mIndexAt(lim);
      if (endSec >= loopB && this.loop) {
        // повтор: новый якорь — начало фрагмента звучит ровно в момент конца фрагмента
        const ct = this.ctxAtSong(loopB, a), sa = this.time.toSec(this.loop.a);
        const na = { ctx: ct, sec: sa, speed: a.speed };
        this.anchors.push(na); if (this.anchors.length > 4) this.anchors.splice(0, this.anchors.length - 4);
        this.cursor = this.indexAt(sa); this.mCursor = this.mIndexAt(sa);
        // заглушить хвосты нот, которые тянутся через конец фрагмента
        for (const v of this.voices) if (v.end > ct) this.release(v, ct, 0.03);
        a = na; continue;
      }
      break;
    }
    // конец композиции
    const s = this.songSecAt(now);
    if (!this.loop && s > this.time.total + 0.6) { this.pause(); this.posSec = this.time.total; if (this.onEnd) this.onEnd(); }
    this.stats.voicesPeak = Math.max(this.stats.voicesPeak, this.voices.size);
  }
  // ---------- голоса ----------
  stopAll(fade = 0.03) {
    if (!this.ctx || this.ctx.fake) { this.voices.clear(); this.strings.clear(); return; }
    const t = this.ctx.currentTime;
    for (const v of this.voices) this.release(v, t, fade, true);
    this.voices.clear(); this.strings.clear();
  }
  release(v, t, fade = 0.03, kill = false) {
    if (v.released && !kill && v.end <= t) return;
    try {
      const g = v.g.gain;
      if (t < v.start) { // ещё не зазвучал — просто отменяем
        v.src.forEach(s => { try { s.stop(); } catch (e) { } }); v.released = true; v.end = t; return;
      }
      g.cancelScheduledValues(t); g.setTargetAtTime(0, t, fade / 3);
      v.src.forEach(s => { try { s.stop(t + fade * 3 + 0.02); } catch (e) { } });
      v.end = Math.min(v.end, t); v.released = true;
    } catch (e) { }
  }
  click(when, accent) {
    const kit = this.metroInst;
    if (!kit) { this.loadMetro(); return; }
    this.playRegionNote(kit, accent ? 34 : 33, accent ? 120 : 95, when, when + 0.15, this.metroGain, {}, null);
  }
  async loadMetro() { if (this.metroLoading) return; this.metroLoading = true; this.metroInst = await this.bank.program('gm', 'drums', r => r.lk <= 34 && r.hk >= 33); }
  setMetronome(on) { this.metro = on; if (on && !this.metroInst) this.loadMetro(); }

  startEvent(e, when, a) {
    if (this.ctx.fake) { if (e._sched === a) this.stats.dupes++; e._sched = a; this.log.push({ i: e.i, tr: e.tr, s: e.s, when, speed: a.speed, now: this.ctx.currentTime }); return; }
    const inst = this.insts[e.tr]; if (!inst || !inst.main) return;
    const tr = this.song.tracks[e.tr];
    const late = this.ctx.currentTime - when;
    const pt0 = this.stats.perTrack[e.tr];
    if (late > 0.002) { this.stats.late++; this.stats.maxLateMs = Math.max(this.stats.maxLateMs, late * 1000); if (pt0) pt0.late = (pt0.late || 0) + 1; }
    if (e._sched === a) { this.stats.dupes++; return; } e._sched = a;
    this.stats.scheduled++;
    const pt = this.stats.perTrack[e.tr]; if (pt) { pt.scheduled++; pt.lastSec = e.s; }
    const dur = Math.max(0.02, (e.e - e.s) / a.speed);
    const off = when + dur;
    const dest = this.chains[e.tr].input;
    const drum = tr.kind === 'drums';
    if (drum) {
      let ok = this.playRegionNote(inst.main, e.m, e.v, when, off, dest, e, null);
      if (!ok && inst.fallback) ok = this.playRegionNote(inst.fallback, e.m, e.v, when, off, dest, e, null);
      const name = GM_DRUMS[e.m] || '—';
      this.stats.lastDrum = { m: e.m, name, ch: 10, ok: !!ok, src: ok ? (ok.inst || '') : 'нет звука', sec: e.s };
      if (!ok) this.stats.unknownDrums++;
      return;
    }
    // струнные: одна струна — один голос (новая нота на той же струне гасит предыдущую)
    const strKey = isStringKind(tr.kind) && e.str != null ? e.tr + ':' + e.str : null;
    let legato = false;
    if (strKey) {
      const prev = this.strings.get(strKey);
      if (prev && prev.end > when - 0.005) { legato = !!e.legato; this.release(prev, when, legato ? 0.012 : 0.02); }
    }
    let src = inst.main, opts = { legato };
    if (e.ch === 'dead' && inst.dead) { src = inst.dead; opts.dead = true; }
    else if (e.ch === 'harm' && inst.harm) src = inst.harm;
    else if (e.ch === 'pm') { if (inst.muted) src = inst.muted; else opts.pm = true; }
    if (e.slap && inst.slap) src = e.slap === 'pop' && inst.pop ? inst.pop : inst.slap;
    const v = this.playRegionNote(src, e.m, e.v, when, off, dest, e, tr._bends, opts);
    if (v && strKey) this.strings.set(strKey, v);
    // звук глушения струны при снятии ноты (если есть в наборе)
    if (v && !opts.dead && src === inst.main && src.regions.some(r => r.trig === 'r') && !e.x.ring) {
      const nx = this.events[e.i + 1];
      const followed = nx && nx.tr === e.tr && nx.str === e.str && nx.s - e.e < 0.02;
      if (!followed) this.playRegionNote(src, e.m, Math.round(e.v * 0.6), off, off + 0.5, dest, e, null, { trig: 'r' });
    }
  }
  // Голос: семпл + огибающая (+ фильтр, панорама, подтяжки)
  playRegionNote(inst, m, vel, when, off, dest, e, bends, opts = {}) {
    const ctx = this.ctx;
    const pick = pickRegion(inst, m, vel, this.rr || (this.rr = new Map()), opts.trig);
    if (!pick) return null;
    const regs = Array.isArray(pick) ? pick : [pick];
    const g = ctx.createGain();
    let node = g;
    // громкость по силе удара: у многослойных наборов мягче (тембр меняет сам слой)
    const vt = inst.vt != null ? inst.vt : 1;
    let amp = Math.pow(vel / 127, 1.6 * vt + 0.2);
    if (opts.legato) amp *= 0.75;
    if (opts.trig === 'r') amp *= 0.5;
    const srcs = [];
    let filt = null;
    const fcBase = regs[0].fc || 0;
    if (inst.sf2 || fcBase || opts.pm || opts.dead) {
      filt = ctx.createBiquadFilter(); filt.type = 'lowpass'; filt.Q.value = 0.5;
      let fc = fcBase || 20000;
      if (inst.sf2) fc = Math.min(fc, 20000 * Math.pow(2, -2.4 * (1 - vel / 127))); // SF2: тише — глуше
      if (opts.pm) fc = Math.min(fc, 700 + vel * 9);
      filt.frequency.value = fc; filt.connect(g); node = filt;
    }
    const peak = amp;
    let rel = regs[0].rel || 0.05;
    for (const r of regs) {
      const buf = inst.get(r.s); if (!buf) continue;
      const s = ctx.createBufferSource(); s.buffer = buf;
      const root = r.root == null ? m : r.root;
      const ks = r.ks != null ? r.ks / 100 : 1;
      const semi = (m - root) * ks + (r.tune || 0) / 100;
      s.playbackRate.value = Math.pow(2, semi / 12);
      if (r.loop) { s.loop = true; s.loopStart = r.loop[0]; s.loopEnd = r.loop[1]; }
      let out = s;
      if (r.pan || regs.length > 1) { const p = ctx.createStereoPanner(); p.pan.value = r.pan || 0; s.connect(p); out = p; }
      const rg = ctx.createGain(); rg.gain.value = Math.pow(10, (r.vol || 0) / 20); out.connect(rg); rg.connect(node);
      // подтяжки, вибрато, слайды, рычаг: кривая дорожки → detune голоса
      if (bends && e) this.applyBends(s, bends, e, when);
      const offset = opts.legato ? Math.min(0.04, buf.duration * 0.1) : 0; // легато: без атаки медиатора
      s.start(when, offset);
      srcs.push(s);
    }
    if (!srcs.length) return null;
    // огибающая
    const G = g.gain, r0 = regs[0];
    const att = Math.max(0.001, opts.legato ? 0.006 : r0.att || 0.001);
    G.setValueAtTime(0, when); G.linearRampToValueAtTime(peak, when + att);
    let t = when + att;
    if (r0.hold > 0.001) { t += r0.hold; G.setValueAtTime(peak, t); }
    if (r0.sus < 0.999 && r0.dec > 0.001) G.setTargetAtTime(peak * Math.max(0.0001, r0.sus), t, r0.dec / 4);
    if (opts.pm) G.setTargetAtTime(peak * 0.05, when + 0.03, 0.09);      // глушение ладонью: быстрое затухание
    if (opts.dead) G.setTargetAtTime(0, when + 0.02, 0.03);
    const relT = Math.max(off, when + att + 0.005);
    G.setTargetAtTime(0, relT, Math.max(0.008, rel / 4));
    const end = relT + rel * 1.6 + 0.05;
    srcs.forEach(s => { try { s.stop(end); } catch (er) { } });
    g.connect(dest);
    const voice = { src: srcs, g, start: when, end, tr: e ? e.tr : -1, inst: inst.pack + '/' + inst.prog };
    this.voices.add(voice);
    srcs[0].onended = () => { this.voices.delete(voice); try { g.disconnect(); } catch (er) { } };
    // эксклюзивные группы (хай-хэт: закрытый глушит открытый)
    for (const r of regs) if (r.excl) {
      for (const o of this.voices) if (o !== voice && o.excl === r.excl && o.tr === voice.tr && o.end > when) this.release(o, when, 0.02);
      voice.excl = r.excl;
    }
    return voice;
  }
  applyBends(s, bends, e, when) {
    const a = this.anchors[this.anchors.length - 1];
    // значение кривой в начале ноты и все точки до её конца
    let i = 0; while (i < bends.length && bends[i][0] <= e.t) i++;
    const v0 = i > 0 ? bends[i - 1][1] : 0;
    if (v0) s.detune.setValueAtTime(v0 * 100, when);
    for (; i < bends.length && bends[i][0] < e.tEnd + PPQ; i++) {
      const at = this.ctxAtSong(this.time.toSec(bends[i][0]), a);
      if (at > when) s.detune.setValueAtTime(bends[i][1] * 100, at);
    }
  }
  previewNote(m, timbreId, drum) {
    const ctx = this.ensureCtx(); if (ctx.state !== 'running') ctx.resume();
    const tb = timbreFor(timbreId || (drum ? 'kit_live' : 'grand'));
    this.bank.program(tb.pack, tb.prog, r => r.lk <= m && r.hk >= m).then(inst => {
      if (!this.previewChain) { this.previewChain = new TrackChain(this); }
      this.previewChain.set({ preset: tb.fx || (tb.group === 'piano' ? 'piano' : 'none') });
      this.playRegionNote(inst, m, 100, ctx.currentTime + 0.02, ctx.currentTime + (drum ? 0.4 : 1.2), this.previewChain.input, null, null);
    }).catch(() => { });
  }
}

// Ударные General MIDI (канал 10): номер ноты → элемент установки
export const GM_DRUMS = {
  27: 'High Q', 28: 'Slap', 29: 'Scratch Push', 30: 'Scratch Pull', 31: 'Sticks', 32: 'Square Click', 33: 'Metronome Click', 34: 'Metronome Bell',
  35: 'Бочка 2 (Acoustic Bass Drum)', 36: 'Бочка (Bass Drum)', 37: 'Боковой удар (Side Stick)', 38: 'Малый барабан', 39: 'Хлопок (Clap)', 40: 'Малый (римшот)',
  41: 'Низкий напольный том', 42: 'Хай-хэт закрытый', 43: 'Высокий напольный том', 44: 'Хай-хэт педалью', 45: 'Низкий том', 46: 'Хай-хэт открытый',
  47: 'Средний том', 48: 'Высокий средний том', 49: 'Крэш', 50: 'Высокий том', 51: 'Райд', 52: 'Чайна', 53: 'Колокол райда', 54: 'Тамбурин',
  55: 'Сплэш', 56: 'Ковбелл', 57: 'Крэш 2', 58: 'Вибраслэп', 59: 'Райд 2', 60: 'Бонго высокий', 61: 'Бонго низкий', 62: 'Конга приглушённая',
  63: 'Конга открытая', 64: 'Конга низкая', 65: 'Тимбалес высокий', 66: 'Тимбалес низкий', 67: 'Агого высокий', 68: 'Агого низкий', 69: 'Кабаса',
  70: 'Маракасы', 71: 'Свисток короткий', 72: 'Свисток длинный', 73: 'Гуиро короткий', 74: 'Гуиро длинный', 75: 'Клавес', 76: 'Вуд-блок высокий',
  77: 'Вуд-блок низкий', 78: 'Куика приглушённая', 79: 'Куика открытая', 80: 'Треугольник приглушённый', 81: 'Треугольник открытый', 82: 'Шейкер',
  83: 'Бубенцы', 84: 'Колокольчики (Bell Tree)', 85: 'Кастаньеты', 86: 'Сурдо приглушённое', 87: 'Сурдо открытое'
};
