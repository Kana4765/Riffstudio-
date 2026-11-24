import {
  PPQ,
  isBuiltInKit,
  isDrumTrack,
  type DrumKitId,
  type DrumTrack,
  type FxChainSettings,
  type PitchedTrack,
  type Song,
  type Track,
} from '../types/song';
import { barTicks, beatTicks, getBarTempo, harmonicPitch, layoutBar, notePitch, tieExtensions } from '../utils/timing';
import { GuitarFxChain } from './GuitarFxChain';
import { drumSampler, type DrumKitStatus } from './DrumSampler';
import { DrumBus, SynthKit, calibrateFeedbackLoop, type StringInstrument, type VoiceHandle } from './Synthesizers';

/** Scheduler wake-up interval (ms). */
const LOOKAHEAD_MS = 25;
/** How far ahead of the audio clock events are scheduled (s). */
const SCHEDULE_AHEAD = 0.1;
/** Start offset so the first events are never scheduled in the past (s). */
const START_OFFSET = 0.06;

type BarEvent =
  | {
      kind: 'string';
      tick: number;
      trackId: string;
      stringKey: string;
      durationTicks: number;
      midi: number;
      velocity: number;
      palmMute: boolean;
      hammerOn: boolean;
      harmonic: boolean;
      bend: boolean;
      /** Semitone distance to the slide target, if this note slides. */
      slideSemis: number;
    }
  | { kind: 'drum'; tick: number; trackId: string; midiNote: number; velocity: number }
  | { kind: 'click'; tick: number; accent: boolean };

interface BarMarker {
  barIndex: number;
  startTime: number;
  secPerTick: number;
  ticks: number;
}

export interface PlaybackPosition {
  barIndex: number;
  tickInBar: number;
  isPlaying: boolean;
}

export type TransportState = 'stopped' | 'playing' | 'paused';

class TrackChannel {
  readonly input: GainNode;
  readonly fx: GuitarFxChain | null;
  readonly drums: DrumBus | null;
  private readonly volume: GainNode;
  private readonly panner: StereoPannerNode;
  private fxKey: string;
  private kitKey: string | null = null;
  audible = true;

  constructor(ctx: AudioContext, track: Track, destination: AudioNode) {
    this.input = ctx.createGain();
    this.volume = ctx.createGain();
    this.panner = ctx.createStereoPanner();
    if (isDrumTrack(track)) {
      this.fx = null;
      this.fxKey = '';
      this.drums = new DrumBus(ctx);
      this.input.connect(this.drums.input);
      this.drums.output.connect(this.volume);
    } else {
      this.drums = null;
      this.fx = new GuitarFxChain(ctx, track.fxChain);
      this.fxKey = JSON.stringify(track.fxChain);
      this.input.connect(this.fx.input);
      this.fx.output.connect(this.volume);
    }
    this.volume.connect(this.panner).connect(destination);
    this.apply(ctx, track, true, true);
  }

  apply(ctx: AudioContext, track: Track, audible: boolean, immediate = false): void {
    this.audible = audible;
    const t = ctx.currentTime;
    const vol = audible ? Math.pow(Math.max(0, Math.min(1, track.volume)), 1.6) : 0;
    const pan = Math.max(-1, Math.min(1, track.pan));
    if (immediate) {
      this.volume.gain.value = vol;
      this.panner.pan.value = pan;
    } else {
      this.volume.gain.cancelScheduledValues(t);
      this.volume.gain.setTargetAtTime(vol, t, 0.015);
      this.panner.pan.cancelScheduledValues(t);
      this.panner.pan.setTargetAtTime(pan, t, 0.015);
    }
    if (this.drums && isDrumTrack(track)) {
      const kit = track.kit ?? 'rock';
      const base = isBuiltInKit(kit) ? kit : drumSampler.customKitState(kit) ? drumSampler.baseKitOf(kit) : (track.kitBase ?? 'rock');
      const key = `${kit}:${base}`;
      if (key !== this.kitKey) {
        this.kitKey = key;
        this.drums.setCharacter(base);
      }
    }
    if (this.fx && !isDrumTrack(track)) {
      const key = JSON.stringify(track.fxChain);
      if (key !== this.fxKey) {
        this.fxKey = key;
        this.fx.update(track.fxChain);
      }
    }
  }

  dispose(): void {
    this.input.disconnect();
    this.fx?.dispose();
    this.drums?.dispose();
    this.volume.disconnect();
    this.panner.disconnect();
  }
}

const SAFETY_PREGAIN = 0.5;

/** Unity gain below -1 dBFS, then a smooth tanh knee that never exceeds ±0.98. */
function createSafetyClipCurve(samples = 4096) {
  const curve = new Float32Array(samples);
  const knee = 0.89;
  const ceiling = 0.98;
  for (let i = 0; i < samples; i++) {
    // The shaper is fed at half level (see SAFETY_PREGAIN), so the curve spans signal values -2..2 and
    // overshoots up to +6 dB are shaped instead of hard-clipped.
    const x = ((i / (samples - 1)) * 2 - 1) / SAFETY_PREGAIN;
    const a = Math.abs(x);
    const y = a <= knee ? a : knee + (ceiling - knee) * Math.tanh((a - knee) / (ceiling - knee));
    curve[i] = Math.sign(x) * y;
  }
  return curve;
}

function stringInstrument(track: PitchedTrack): StringInstrument {
  if (track.instrumentType === 'bass') return 'bass';
  if (track.instrumentType === 'acoustic-guitar') return 'acoustic';
  return 'electric';
}

/**
 * Sample-accurate lookahead scheduler (25 ms wake-ups, 100 ms horizon) on a single 480-PPQ master clock.
 * All tracks feed a master bus protected by a DynamicsCompressor limiter.
 */
export class AudioEngine {
  private static instance: AudioEngine | null = null;

  static get(): AudioEngine {
    AudioEngine.instance ??= new AudioEngine();
    return AudioEngine.instance;
  }

  private constructor() {
    // Decode the bundled recorded drum kit straight away (no user gesture needed). Until it is ready, or if
    // it can't load, drums use the procedural synth.
    if (typeof window !== 'undefined' && typeof OfflineAudioContext !== 'undefined') {
      drumSampler.subscribe(() => this.emit());
      void drumSampler.load();
    }
  }

  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private limiter: DynamicsCompressorNode | null = null;
  private clickBus: GainNode | null = null;
  private kit: SynthKit | null = null;
  private calibration: Promise<void> | null = null;

  private song: Song | null = null;
  private readonly channels = new Map<string, TrackChannel>();
  private readonly stringVoices = new Map<string, VoiceHandle>();
  private readonly openHats = new Map<string, VoiceHandle>();
  private readonly liveVoices = new Set<VoiceHandle>();
  private readonly eventCache = new WeakMap<Song, Map<number, BarEvent[]>>();
  private readonly listeners = new Set<() => void>();

  private timerId: ReturnType<typeof setInterval> | null = null;
  private state: TransportState = 'stopped';
  private loopBar: number | null = null;
  private metronome = false;
  private speed = 1;

  private schedBar = 0;
  private schedBarStart = 0;
  private schedSecPerTick = 0;
  private schedEventIdx = 0;
  private lastScheduledTick = -1;
  private endTime: number | null = null;
  private markers: BarMarker[] = [];
  private pausedAt: { barIndex: number; tick: number } | null = null;
  private autoResumeInstalled = false;

  // ------------------------------------------------------------------------------------------
  // Context & routing
  // ------------------------------------------------------------------------------------------

  private ensureContext(): AudioContext {
    if (this.ctx) return this.ctx;
    const ctx = new AudioContext({ latencyHint: 'interactive' });
    const master = ctx.createGain();
    master.gain.value = 0.8;
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -8;
    limiter.knee.value = 2;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.002;
    limiter.release.value = 0.16;
    // DynamicsCompressorNode is not a brick-wall: a transparent soft-knee safety clipper after it catches the
    // few fast transients (kick/snare attacks) that overshoot, so the output never exceeds 0 dBFS.
    const safetyIn = ctx.createGain();
    safetyIn.gain.value = SAFETY_PREGAIN;
    const safety = ctx.createWaveShaper();
    safety.curve = createSafetyClipCurve();
    safety.oversample = '2x';
    master.connect(limiter).connect(safetyIn).connect(safety).connect(ctx.destination);
    const clickBus = ctx.createGain();
    clickBus.gain.value = 0.8;
    clickBus.connect(limiter);
    this.ctx = ctx;
    this.master = master;
    this.limiter = limiter;
    this.clickBus = clickBus;
    const kit = new SynthKit(ctx);
    this.kit = kit;
    this.calibration = calibrateFeedbackLoop(ctx.sampleRate).then((c) => kit.setLoopCalibration(c));
    if (this.song) this.syncChannels(this.song, true);
    return ctx;
  }

  /** Resumes the AudioContext on the first user gesture (required by browser/WebView autoplay policies). */
  installAutoResume(): void {
    if (this.autoResumeInstalled || typeof window === 'undefined') return;
    this.autoResumeInstalled = true;
    const events: (keyof WindowEventMap)[] = ['pointerdown', 'keydown', 'touchstart'];
    const handler = () => {
      void this.resume().then(() => {
        if (this.ctx?.state === 'running') events.forEach((e) => window.removeEventListener(e, handler, true));
      });
    };
    events.forEach((e) => window.addEventListener(e, handler, { capture: true, passive: true }));
  }

  async resume(): Promise<void> {
    const ctx = this.ensureContext();
    if (this.calibration) await this.calibration;
    if (ctx.state !== 'running') {
      try {
        await ctx.resume();
      } catch {
        // Will retry on the next user gesture.
      }
    }
  }

  get contextState(): AudioContextState | 'uninitialised' {
    return this.ctx?.state ?? 'uninitialised';
  }

  /** Loading state of the bundled recorded drum kit. */
  get drumKitStatus(): DrumKitStatus {
    return drumSampler.kitStatus;
  }

  get limiterReduction(): number {
    return this.limiter?.reduction ?? 0;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }

  // ------------------------------------------------------------------------------------------
  // Song / mixer sync
  // ------------------------------------------------------------------------------------------

  setSong(song: Song): void {
    const prev = this.song;
    this.song = song;
    if (this.ctx) this.syncChannels(song, false);
    if (this.state === 'playing' && prev !== song) {
      if (this.schedBar >= song.bars.length) {
        this.schedBar = Math.max(0, song.bars.length - 1);
        this.schedEventIdx = Number.MAX_SAFE_INTEGER;
      } else {
        // Continue in the current bar right after the last event already handed to the audio thread.
        const events = this.getBarEvents(song, this.schedBar);
        const idx = events.findIndex((e) => e.tick > this.lastScheduledTick);
        this.schedEventIdx = idx < 0 ? events.length : idx;
      }
      if (this.loopBar !== null && this.loopBar >= song.bars.length) this.loopBar = song.bars.length - 1;
    }
  }

  private isAudible(track: Track, anySolo: boolean): boolean {
    return !track.muted && (!anySolo || track.solo);
  }

  private syncChannels(song: Song, immediate: boolean): void {
    const ctx = this.ctx;
    const master = this.master;
    if (!ctx || !master) return;
    const anySolo = song.tracks.some((t) => t.solo);
    const ids = new Set(song.tracks.map((t) => t.id));
    for (const [id, ch] of this.channels) {
      if (!ids.has(id)) {
        ch.dispose();
        this.channels.delete(id);
      }
    }
    for (const track of song.tracks) {
      const audible = this.isAudible(track, anySolo);
      const existing = this.channels.get(track.id);
      const kindMatches = existing ? (existing.fx === null) === isDrumTrack(track) : false;
      if (existing && kindMatches) {
        existing.apply(ctx, track, audible, immediate);
      } else {
        existing?.dispose();
        this.channels.set(track.id, new TrackChannel(ctx, track, master));
        this.channels.get(track.id)?.apply(ctx, track, audible, true);
      }
    }
  }

  // ------------------------------------------------------------------------------------------
  // Event compilation (cached per immutable song object)
  // ------------------------------------------------------------------------------------------

  private getBarEvents(song: Song, barIndex: number): BarEvent[] {
    let perSong = this.eventCache.get(song);
    if (!perSong) {
      perSong = new Map();
      this.eventCache.set(song, perSong);
    }
    const cached = perSong.get(barIndex);
    if (cached) return cached;
    const events = this.compileBar(song, barIndex);
    perSong.set(barIndex, events);
    return events;
  }

  private compileBar(song: Song, barIndex: number): BarEvent[] {
    const bar = song.bars[barIndex];
    if (!bar) return [];
    const events: BarEvent[] = [];
    const length = barTicks(bar);

    const step = bar.denominator === 8 ? PPQ / 2 : PPQ;
    for (let t = 0; t < length; t += step) events.push({ kind: 'click', tick: t, accent: t === 0 });

    for (const track of song.tracks) {
      if (isDrumTrack(track)) {
        for (const hit of track.hits) {
          if (hit.barIndex !== barIndex || hit.tickOffset >= length) continue;
          events.push({ kind: 'drum', tick: hit.tickOffset, trackId: track.id, midiNote: hit.midiNote, velocity: hit.velocity });
        }
        continue;
      }
      const layout = layoutBar(track, bar);
      const fitting = layout.beats.filter((b) => b.fits);
      const ties = tieExtensions(track, song.bars);
      fitting.forEach((lb, i) => {
        if (lb.beat.isRest) return;
        for (const note of lb.beat.notes) {
          if (note.stringIndex < 1 || note.stringIndex > track.tuning.length) continue;
          // Tied notes don't re-pick: the first note of the chain already sustains through them.
          if (note.tied) continue;
          const midi = note.harmonic ? harmonicPitch(track, note) : notePitch(track, note);
          let slideSemis = 0;
          if (note.slide) {
            const nextBeat = fitting[i + 1]?.beat ?? this.firstBeatOfNextBar(song, track, barIndex);
            const target = nextBeat?.notes.find((n) => n.stringIndex === note.stringIndex);
            slideSemis = target ? target.fret - note.fret : -Math.min(5, note.fret);
          }
          events.push({
            kind: 'string',
            tick: lb.startTick,
            trackId: track.id,
            stringKey: `${track.id}:${note.stringIndex}`,
            durationTicks: beatTicks(lb.beat) + (ties.get(`${lb.beat.id}:${note.stringIndex}`) ?? 0),
            midi,
            velocity: note.palmMute ? 0.78 : note.hammerOn ? 0.6 : 0.92,
            palmMute: note.palmMute,
            hammerOn: note.hammerOn,
            harmonic: note.harmonic,
            bend: note.bend,
            slideSemis,
          });
        }
      });
    }
    return events.sort((a, b) => a.tick - b.tick);
  }

  private firstBeatOfNextBar(song: Song, track: PitchedTrack, barIndex: number) {
    const next = song.bars[barIndex + 1];
    if (!next) return undefined;
    return layoutBar(track, next).beats.find((b) => b.fits)?.beat;
  }

  // ------------------------------------------------------------------------------------------
  // Transport
  // ------------------------------------------------------------------------------------------

  get transportState(): TransportState {
    return this.state;
  }

  setLoopBar(barIndex: number | null): void {
    this.loopBar = barIndex;
    if (barIndex !== null) this.endTime = null;
  }

  setMetronome(enabled: boolean): void {
    this.metronome = enabled;
  }

  /** Playback rate multiplier for the speed trainer (0.5–1.0); applied from the next bar. */
  setSpeed(rate: number): void {
    this.speed = Math.max(0.25, Math.min(1.5, rate));
  }

  async play(fromBar: number): Promise<void> {
    if (!this.song || this.state === 'playing') return;
    await this.resume();
    if (drumSampler.kitStatus.state === 'loading') await drumSampler.load();
    await drumSampler.whenCustomKitsReady();
    // Another play() may have started while we awaited (read via the getter: the state can change across awaits).
    if (this.transportState === 'playing') return;
    const ctx = this.ctx;
    if (!ctx) return;
    const song = this.song;
    let barIndex = Math.max(0, Math.min(fromBar, song.bars.length - 1));
    let startTick = 0;
    if (this.state === 'paused' && this.pausedAt) {
      barIndex = Math.min(this.pausedAt.barIndex, song.bars.length - 1);
      startTick = this.pausedAt.tick;
    }
    if (this.loopBar !== null && barIndex !== this.loopBar) {
      barIndex = this.loopBar;
      startTick = 0;
    }
    this.pausedAt = null;
    this.endTime = null;
    this.markers = [];
    this.schedBar = barIndex;
    this.schedSecPerTick = this.secPerTick(barIndex);
    this.schedBarStart = ctx.currentTime + START_OFFSET - startTick * this.schedSecPerTick;
    const events = this.getBarEvents(song, barIndex);
    const firstIdx = events.findIndex((e) => e.tick >= startTick);
    this.schedEventIdx = firstIdx < 0 ? events.length : firstIdx;
    this.lastScheduledTick = startTick - 1;
    this.pushMarker();
    this.state = 'playing';
    this.timerId = setInterval(() => this.schedule(), LOOKAHEAD_MS);
    this.schedule();
    this.emit();
  }

  pause(): void {
    if (this.state !== 'playing') return;
    const pos = this.getPosition();
    this.haltAudio();
    this.pausedAt = pos ? { barIndex: pos.barIndex, tick: Math.max(0, Math.floor(pos.tickInBar)) } : null;
    this.state = 'paused';
    this.emit();
  }

  stop(): void {
    this.haltAudio();
    this.pausedAt = null;
    this.state = 'stopped';
    this.emit();
  }

  private haltAudio(): void {
    if (this.timerId !== null) clearInterval(this.timerId);
    this.timerId = null;
    const now = this.ctx?.currentTime ?? 0;
    for (const v of this.liveVoices) v.release(now);
    this.liveVoices.clear();
    this.stringVoices.clear();
    this.openHats.clear();
    this.markers = [];
    this.endTime = null;
  }

  private secPerTick(barIndex: number): number {
    const song = this.song;
    const bpm = song ? getBarTempo(song, barIndex) : 120;
    return 60 / (bpm * this.speed * PPQ);
  }

  private pushMarker(): void {
    const bar = this.song?.bars[this.schedBar];
    if (!bar) return;
    this.markers.push({
      barIndex: this.schedBar,
      startTime: this.schedBarStart,
      secPerTick: this.schedSecPerTick,
      ticks: barTicks(bar),
    });
    if (this.markers.length > 16) this.markers.splice(0, this.markers.length - 16);
  }

  private schedule(): void {
    const ctx = this.ctx;
    const song = this.song;
    if (!ctx || !song || this.state !== 'playing') return;
    const now = ctx.currentTime;

    if (this.endTime !== null) {
      if (now >= this.endTime) this.stop();
      return;
    }

    const horizon = now + SCHEDULE_AHEAD;
    for (let guard = 0; guard < 256; guard++) {
      const bar = song.bars[this.schedBar];
      if (!bar) {
        this.stop();
        return;
      }
      const events = this.getBarEvents(song, this.schedBar);
      while (this.schedEventIdx < events.length) {
        const ev = events[this.schedEventIdx];
        const time = this.schedBarStart + ev.tick * this.schedSecPerTick;
        if (time >= horizon) return;
        if (time >= now - 0.005) this.dispatch(song, ev, time);
        this.lastScheduledTick = ev.tick;
        this.schedEventIdx += 1;
      }
      const barEnd = this.schedBarStart + barTicks(bar) * this.schedSecPerTick;
      if (barEnd >= horizon) return;

      let next: number;
      if (this.loopBar !== null) next = Math.min(this.loopBar, song.bars.length - 1);
      else if (this.schedBar + 1 < song.bars.length) next = this.schedBar + 1;
      else {
        this.endTime = barEnd + 0.05;
        return;
      }
      this.schedBar = next;
      this.schedBarStart = barEnd;
      this.schedSecPerTick = this.secPerTick(next);
      this.schedEventIdx = 0;
      this.lastScheduledTick = -1;
      this.pushMarker();
    }
  }

  private track(song: Song, id: string): Track | undefined {
    return song.tracks.find((t) => t.id === id);
  }

  private dispatch(song: Song, ev: BarEvent, time: number): void {
    const kit = this.kit;
    if (!kit) return;
    if (ev.kind === 'click') {
      if (this.metronome && this.clickBus) kit.playClick(this.clickBus, time, ev.accent);
      return;
    }
    const channel = this.channels.get(ev.trackId);
    if (!channel || !channel.audible) return;
    const track = this.track(song, ev.trackId);
    if (!track) return;

    if (ev.kind === 'drum') {
      const key = ev.trackId;
      if (ev.midiNote === 42 || ev.midiNote === 46) {
        this.openHats.get(key)?.release(time);
        this.openHats.delete(key);
      }
      if (!channel.drums) return;
      const voice = this.triggerDrum(channel.drums, isDrumTrack(track) ? (track.kit ?? 'rock') : 'rock', ev.midiNote, ev.velocity, time);
      if (ev.midiNote === 46) this.openHats.set(key, voice);
      this.track_(voice);
      return;
    }

    if (isDrumTrack(track)) return;
    const humanize = track.instrumentType === 'synth' ? 0 : Math.random() * 0.004;
    const t = time + humanize;
    const duration = ev.durationTicks * this.schedSecPerTick;
    this.stringVoices.get(ev.stringKey)?.release(t);
    const glide = ev.bend
      ? { semitones: 2, start: t + duration * 0.08, end: t + duration * 0.4 }
      : ev.slideSemis !== 0
        ? { semitones: ev.slideSemis, start: t + duration * 0.45, end: t + duration * 0.92 }
        : undefined;
    const voice = this.playPitched(track, channel.input, {
      time: t,
      duration: ev.palmMute ? Math.min(duration, 0.2) : duration,
      midi: ev.midi,
      velocity: ev.velocity,
      palmMute: ev.palmMute,
      hammerOn: ev.hammerOn,
      harmonic: ev.harmonic,
      glide,
    });
    this.stringVoices.set(ev.stringKey, voice);
    this.track_(voice);
  }

  /** Recorded sample when available (DrumSampler -> DrumBus), procedural synth otherwise. */
  private triggerDrum(bus: DrumBus, kitId: DrumKitId, midiNote: number, velocity: number, time: number): VoiceHandle {
    const kit = this.kit;
    if (!kit) throw new Error('Audio engine not initialised');
    const ctx = this.ctx;
    const sampled = ctx ? drumSampler.play(ctx, bus.out, midiNote, velocity, time, kitId) : null;
    return sampled ?? kit.playDrum(bus.out, midiNote, velocity, time);
  }

  private playPitched(
    track: PitchedTrack,
    dest: AudioNode,
    o: {
      time: number;
      duration: number;
      midi: number;
      velocity: number;
      palmMute: boolean;
      hammerOn: boolean;
      harmonic: boolean;
      glide?: { semitones: number; start: number; end: number };
    },
  ): VoiceHandle {
    const kit = this.kit;
    if (!kit) throw new Error('Audio engine not initialised');
    if (track.instrumentType === 'synth') {
      return kit.playKeys(dest, { time: o.time, duration: o.duration, midi: o.midi, velocity: o.velocity, palmMute: o.palmMute, glide: o.glide });
    }
    return kit.playString(dest, { ...o, instrument: stringInstrument(track) });
  }

  private track_(voice: VoiceHandle): void {
    this.liveVoices.add(voice);
    const ctx = this.ctx;
    if (!ctx) return;
    const ms = Math.max(0, (voice.endTime - ctx.currentTime) * 1000 + 50);
    globalThis.setTimeout(() => this.liveVoices.delete(voice), ms);
  }

  /** Current playhead (derived from the audio clock), or null when not playing. */
  getPosition(): PlaybackPosition | null {
    const ctx = this.ctx;
    if (!ctx || this.state !== 'playing' || this.markers.length === 0) return null;
    const now = ctx.currentTime;
    let marker = this.markers[0];
    for (const m of this.markers) if (m.startTime <= now) marker = m;
    const tick = Math.max(0, Math.min(marker.ticks - 1, (now - marker.startTime) / marker.secPerTick));
    return { barIndex: marker.barIndex, tickInBar: tick, isPlaying: true };
  }

  // ------------------------------------------------------------------------------------------
  // Auditioning
  // ------------------------------------------------------------------------------------------

  private async prepareAudition(track: Track): Promise<{ ctx: AudioContext; dest: AudioNode; channel: TrackChannel } | null> {
    await this.resume();
    const ctx = this.ctx;
    if (!ctx || !this.song) return null;
    this.syncChannels(this.song, false);
    const ch = this.channels.get(track.id);
    if (!ch) return null;
    return { ctx, dest: ch.input, channel: ch };
  }

  /** Plays a single fretted note through the track's FX chain. */
  async auditionNote(track: PitchedTrack, stringIndex: number, fret: number, seconds = 0.9): Promise<void> {
    const prep = await this.prepareAudition(track);
    if (!prep) return;
    const t = prep.ctx.currentTime + 0.01;
    const key = `${track.id}:${stringIndex}:audition`;
    this.stringVoices.get(key)?.release(t);
    const voice = this.playPitched(track, prep.dest, {
      time: t,
      duration: seconds,
      midi: notePitch(track, { stringIndex, fret }),
      velocity: 0.9,
      palmMute: false,
      hammerOn: false,
      harmonic: false,
    });
    this.stringVoices.set(key, voice);
  }

  /** "Test Note": a power chord (or root note for bass) on the lowest strings. */
  async auditionTestChord(track: PitchedTrack): Promise<void> {
    const prep = await this.prepareAudition(track);
    if (!prep) return;
    const t = prep.ctx.currentTime + 0.01;
    const strings = track.tuning.length;
    const low = track.tuning[strings - 1];
    const next = track.tuning[strings - 2];
    const dropped = next - low === 7;
    const shape: { s: number; f: number }[] =
      track.instrumentType === 'bass'
        ? [{ s: strings, f: 0 }]
        : [
            { s: strings, f: 0 },
            { s: strings - 1, f: dropped ? 0 : 2 },
            { s: strings - 2, f: dropped ? 0 : 2 },
          ];
    shape.forEach(({ s, f }, i) => {
      this.playPitched(track, prep.dest, {
        time: t + i * 0.012,
        duration: 1.4,
        midi: notePitch(track, { stringIndex: s, fret: f }),
        velocity: 0.95,
        palmMute: false,
        hammerOn: false,
        harmonic: false,
      });
    });
  }

  /** Plays one drum piece through the track's DrumBus; `kitOverride` auditions another kit (e.g. in the kit editor). */
  async auditionDrum(track: DrumTrack, midiNote: number, velocity = 110, kitOverride?: DrumKitId): Promise<void> {
    const prep = await this.prepareAudition(track);
    if (!prep || !this.kit || !prep.channel.drums) return;
    if (drumSampler.kitStatus.state === 'loading') await drumSampler.load();
    await drumSampler.whenCustomKitsReady();
    const t = prep.ctx.currentTime + 0.005;
    const key = `${track.id}:audition`;
    // Same hi-hat choke group as playback: a closed (or new open) hat cuts a ringing open hat.
    if (midiNote === 42 || midiNote === 46) {
      this.openHats.get(key)?.release(t);
      this.openHats.delete(key);
    }
    const voice = this.triggerDrum(prep.channel.drums, kitOverride ?? track.kit ?? 'rock', midiNote, velocity, t);
    if (midiNote === 46) this.openHats.set(key, voice);
  }

  /** Applies FX changes instantly (used while dragging knobs). */
  updateFx(trackId: string, fx: FxChainSettings): void {
    this.channels.get(trackId)?.fx?.update(fx);
  }
}
