// Звук и время: синтезатор alphaTab (SoundFont, все инструменты General MIDI).
// Визуализация берёт позицию в тиках у синтезатора — поэтому картинка и звук совпадают.
import { PPQ, buildMidiFile } from './model.js';

export class Engine {
  constructor(alphaTab, el, onState) {
    this.at = alphaTab;
    this.onState = onState || (() => { });
    this.ready = false; this.playing = false;
    this.tick = 0; this.stamp = 0; this.speed = 1; this.k = 1;
    this.scoreLoaded = false; this.score = null;
    this.api = new alphaTab.AlphaTabApi(el, {
      core: { fontDirectory: 'lib/alphatab/font/', logLevel: 'error', engine: 'svg' },
      display: { scale: 0.85, layoutMode: 'Page' },
      player: {
        playerMode: alphaTab.PlayerMode.EnabledSynthesizer,
        soundFont: 'lib/alphatab/soundfont/sonivox.sf3',
        scrollElement: '#scoreWrap', enableCursor: true, enableUserInteraction: true, scrollOffsetY: -40
      }
    });
    const api = this.api;
    api.soundFontLoaded.on(() => { this.sfReady = true; this.onState('sound'); });
    api.playerReady.on(() => { this.ready = true; this.onState('ready'); });
    api.playerPositionChanged.on(e => {
      this.tick = e.currentTick * this.k; this.stamp = performance.now();
      if (e.isSeek) this.onState('seek');
    });
    api.playerStateChanged.on(e => {
      const was = this.playing; this.playing = e.state === 1; this.stamp = performance.now();
      if (was !== this.playing) this.onState(this.playing ? 'play' : 'pause');
    });
    api.playerFinished.on(() => this.onState('finished'));
    api.midiLoaded.on(() => { this.onState('midi'); if (this.pendingTick != null) { const t = this.pendingTick; this.pendingTick = null; setTimeout(() => this.seekTick(t), 0); } this.applyChannels(); });
  }
  get player() { return this.api.player; }

  // Загрузка композиции в синтезатор
  load(song, time, gpBytes) {
    this.song = song; this.time = time; this.scoreLoaded = false; this.score = null;
    this.tick = 0; this.stamp = performance.now();
    this.channelState = this.channelState || {};
    if (song.source === 'gp' && gpBytes) {
      const settings = this.api.settings;
      this.score = this.at.importer.ScoreLoader.loadScoreFromBytes(gpBytes, settings);
      const M = this.at.midi; const mf = new M.MidiFile();
      new M.MidiFileGenerator(this.score, settings, new M.AlphaSynthMidiFileHandler(mf, true)).generate();
      this.k = PPQ / (mf.division || PPQ);
      this.player.loadMidiFile(mf);
    } else {
      this.k = 1;
      this.player.loadMidiFile(buildMidiFile(this.at, song));
    }
  }
  // Нотный вид (только Guitar Pro / MusicXML): alphaTab рисует партитуру и сам пересоздаёт MIDI
  showScore(trackIdx, stave) {
    if (!this.score) return false;
    const st = this.api.settings.display;
    st.staveProfile = stave === 'tab' ? this.at.StaveProfile.Tab : stave === 'score' ? this.at.StaveProfile.Score : this.at.StaveProfile.Default;
    this.api.updateSettings();
    this.pendingTick = this.tick / this.k;
    this.api.renderScore(this.score, [trackIdx]);
    this.scoreLoaded = true;
    return true;
  }
  rebuildMidi(song) {
    if (song.source === 'gp' && this.score) return;
    this.song = song; this.pendingTick = this.tick;
    this.player.loadMidiFile(buildMidiFile(this.at, song));
  }

  nowTick() {
    if (!this.playing) return this.tick;
    const dt = Math.min(250, performance.now() - this.stamp);
    const bpm = this.time ? this.time.bpmAt(this.tick) : 120;
    return this.tick + dt / 1000 * bpm / 60 * PPQ * this.speed;
  }
  play() { if (this.player) this.player.play(); }
  pause() { if (this.player) this.player.pause(); }
  seekTick(t) { this.tick = t; this.stamp = performance.now(); if (this.player) this.player.tickPosition = t / this.k; }
  setSpeed(s) { this.speed = s; if (this.player) this.player.playbackSpeed = s; }
  setVolume(v) { if (this.player) this.player.masterVolume = v; }
  setMetronome(on) { if (this.player) this.player.metronomeVolume = on ? 1.2 : 0; }
  setLoop(a, b) {
    const p = this.player; if (!p) return;
    if (a == null) { p.isLooping = false; p.playbackRange = null; return; }
    const r = new this.at.synth.PlaybackRange(); r.startTick = a / this.k; r.endTick = b / this.k;
    p.playbackRange = r; p.isLooping = true;
  }
  // Отключение дорожек и сдвиг октавы — по каналам
  setChannels(state) { this.channelState = state; this.applyChannels(); }
  applyChannels() {
    const p = this.player; if (!p || !this.song) return;
    const st = this.channelState || {};
    this.song.tracks.forEach((tr, i) => {
      const chs = [tr.channel]; if (tr.channel2 != null) chs.push(tr.channel2);
      if (this.score && this.score.tracks[tr.scoreTrack]) { const pi = this.score.tracks[tr.scoreTrack].playbackInfo; chs.push(pi.primaryChannel, pi.secondaryChannel); }
      for (const ch of new Set(chs)) {
        p.setChannelMute(ch, !!(st.mute && st.mute[i]));
        if (tr.kind !== 'drums') p.setChannelTranspositionPitch(ch, (st.oct || 0) * 12);
      }
    });
  }
  previewNote(midi, program = 0) {
    const M = this.at.midi; const mf = new M.MidiFile(); mf.division = PPQ;
    const h = new M.AlphaSynthMidiFileHandler(mf, true);
    h.addTempo(0, 120); h.addProgramChange(0, 0, 0, program); h.addNote(0, 0, PPQ, midi, 100, 0); h.finishTrack(0, PPQ);
    try { this.player.playOneTimeMidiFile(mf); } catch (e) { }
  }
}
