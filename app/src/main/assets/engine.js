// Связка приложения со звуком: единый аудиодвижок (audio.js) + alphaTab только для нотного вида.
// Время для картинки берётся у тех же часов, по которым звучат ноты (AudioContext).
import { AudioEngine } from './audio.js';

export class Engine {
  constructor(alphaTab, el, onState) {
    this.at = alphaTab; this.el = el;
    this.onState = onState || (() => { });
    this.audio = new AudioEngine();
    this.audio.onEnd = () => this.onState('finished');
    this.ready = true; this.sfReady = true; this.loading = false;
    this.speed = 1; this.score = null; this.scoreLoaded = false;
    this.sound = {}; this.prog = {}; this.channelState = {};
    this.pendingTick = null; this.resume = false;
  }
  get playing() { return this.audio.playing; }
  // alphaTab: рисует ноты, курсор ведём мы (режим «внешнего источника звука»)
  initScoreApi() {
    if (this.api) return this.api;
    const at = this.at;
    this.api = new at.AlphaTabApi(this.el, {
      core: { fontDirectory: 'lib/alphatab/font/', logLevel: 'error', engine: 'svg' },
      display: { scale: 0.85, layoutMode: 'Page' },
      player: { playerMode: at.PlayerMode.EnabledExternalMedia, scrollElement: '#scoreWrap', enableCursor: true, enableUserInteraction: true, scrollOffsetY: -40 }
    });
    const self = this;
    const handler = {
      get backingTrackDuration() { return (self.time ? self.time.total : 0) * 1000; },
      get playbackRate() { return self.speed; }, set playbackRate(v) { },
      get masterVolume() { return 1; }, set masterVolume(v) { },
      seekTo(ms) { if (self.time) self.seekTick(self.time.toTick(ms / 1000)); self.onState('seek'); },
      play() { self.play(); }, pause() { self.pause(); }
    };
    const attach = () => { try { const p = this.api.player; if (p) { if ('handler' in p) p.handler = handler; else if (p.output) p.output.handler = handler; } } catch (e) { } };
    attach(); this.api.playerReady.on(attach); this.attachHandler = attach;
    return this.api;
  }
  // Загрузка композиции: события всех дорожек и семплы нужных инструментов
  load(song, time, gpBytes) {
    this.song = song; this.time = time; this.scoreLoaded = false; this.score = null;
    if (song.source === 'gp' && gpBytes && !song.custom) {
      try { this.initScoreApi(); this.score = this.at.importer.ScoreLoader.loadScoreFromBytes(gpBytes, this.api.settings); } catch (e) { this.score = null; }
    }
    this.reload();
  }
  soundSettings() { return Object.assign({}, this.sound, { prog: this.prog }); }
  async reload() {
    const tick = this.pendingTick != null ? this.pendingTick : (this.time && this.audio.time ? this.nowTick() : 0);
    const resume = this.resume || this.playing; this.pendingTick = null; this.resume = false;
    if (this.playing) this.audio.pause();
    this.loading = true; this.onState('loading');
    const my = this.loadSeq = (this.loadSeq || 0) + 1;
    try {
      this.audio.oct = (this.channelState && this.channelState.oct) || 0;
      await this.audio.load(this.song, this.time, this.soundSettings());
    } catch (e) { console.error(e); this.error = String(e.message || e); }
    if (my !== this.loadSeq) return;
    this.loading = false;
    // перемотка или «играть», нажатые во время загрузки
    const t2 = this.pendingTick != null ? this.pendingTick : tick, r2 = resume || this.resume;
    this.pendingTick = null; this.resume = false;
    this.applyChannels();
    this.audio.setSpeed(this.speed);
    this.audio.seek(this.time.toSec(Math.max(0, t2)));
    this.onState('midi'); this.onState('ready');
    if (r2) this.play();
  }
  setSound(sound) { this.sound = sound || {}; if (this.song) { this.pendingTick = this.nowTick(); this.resume = this.playing; this.reload(); } }
  setPrograms(prog) { this.prog = prog || {}; if (!this.song) return; this.pendingTick = this.nowTick(); this.resume = this.playing; this.reload(); }
  showScore(trackIdx, stave) {
    if (!this.score) return false;
    const api = this.initScoreApi();
    const st = api.settings.display;
    st.staveProfile = stave === 'tab' ? this.at.StaveProfile.Tab : stave === 'score' ? this.at.StaveProfile.Score : this.at.StaveProfile.Default;
    api.updateSettings();
    api.renderScore(this.score, [trackIdx]);
    this.scoreLoaded = true;
    return true;
  }
  // курсор нотного вида следует за нашими часами
  syncScore() {
    if (!this.scoreLoaded || !this.api) return;
    try { const out = this.api.player && (this.api.player.output || this.api.player); if (out && out.updatePosition) out.updatePosition(this.audio.nowSec() * 1000); } catch (e) { }
  }
  rebuildMidi(song) {
    this.song = song; this.pendingTick = this.nowTick(); this.resume = this.playing;
    if (song.custom) { this.score = null; this.scoreLoaded = false; }
    this.reload();
  }
  nowTick() { return this.time ? this.time.toTick(this.audio.nowSec()) : 0; }
  play() { if (this.loading) { this.resume = true; return; } this.audio.play().then(() => this.onState('play')); this.onState('play'); }
  pause() { if (this.loading) this.resume = false; this.audio.pause(); this.onState('pause'); }
  seekTick(t) { if (!this.time) return; if (this.loading) { this.pendingTick = t; return; } this.audio.seek(this.time.toSec(Math.max(0, t))); this.onState('seek'); }
  setSpeed(s) { this.speed = s; this.audio.setSpeed(s); }
  setVolume(v) { this.audio.setVolume(v); }
  setMetronome(on) { this.audio.setMetronome(on); }
  setLoop(a, b) { this.audio.setLoop(a, b); }
  setChannels(state) {
    const octChanged = ((state && state.oct) || 0) !== ((this.channelState && this.channelState.oct) || 0);
    this.channelState = state || {};
    if (octChanged && this.song) { this.pendingTick = this.nowTick(); this.resume = this.playing; this.reload(); return; }
    this.applyChannels();
  }
  applyChannels() {
    if (!this.song) return;
    const st = this.channelState || {};
    const snd = (this.sound && this.sound.tracks) || {};
    this.song.tracks.forEach((tr, i) => this.audio.trackState[i] && Object.assign(this.audio.trackState[i], { mute: !!(st.mute && st.mute[i]), solo: st.solo === i, vol: (tr.volume != null ? tr.volume : 1) * (snd[i] && snd[i].vol != null ? snd[i].vol : 1) }));
    this.audio.applyMix();
  }
  previewNote(midi, program = 0, drum = false, timbre) {
    this.audio.previewNote(midi, timbre || (drum ? 'kit_live' : this.previewTimbre(program)), drum);
  }
  previewTimbre(program) {
    const p = program || 0;
    if (p <= 1) return 'grand'; if (p === 4) return 'rhodes'; if (p === 25) return 'agtr'; if (p === 24) return 'nylon';
    if (p === 27 || p === 28) return 'egtr_clean'; if (p === 29) return 'egtr_crunch'; if (p === 30) return 'egtr_dist'; if (p === 33) return 'bass_finger';
    return 'gm:' + p;
  }
}
