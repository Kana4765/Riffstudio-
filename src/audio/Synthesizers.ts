import { midiToFrequency } from '../utils/timing';

/** A scheduled sound that can be choked/released early. */
export interface VoiceHandle {
  /** Fades the voice out starting at `time` (AudioContext seconds). */
  release(time: number): void;
  /** Scheduled natural end of the voice. */
  readonly endTime: number;
}

/** Where drum voices render: the dry bus input and the room-reverb send. */
export interface DrumOutput {
  dry: AudioNode;
  room: AudioNode;
}

export type StringInstrument = 'electric' | 'acoustic' | 'bass';

export interface StringNoteOptions {
  time: number;
  /** Sounding length in seconds (before the release tail). */
  duration: number;
  /** Fractional MIDI pitch. */
  midi: number;
  /** 0–1 */
  velocity: number;
  instrument: StringInstrument;
  palmMute?: boolean;
  hammerOn?: boolean;
  harmonic?: boolean;
  /** Pitch glide in semitones relative to `midi`, ramped between the given times. */
  glide?: { semitones: number; start: number; end: number };
}

export interface KeysNoteOptions {
  time: number;
  duration: number;
  midi: number;
  velocity: number;
  palmMute?: boolean;
  glide?: { semitones: number; start: number; end: number };
}

const RELEASE_TAIL = 0.06;

/**
 * How a DelayNode behaves inside a feedback cycle on this Web Audio implementation.
 * Spec-style engines clamp the delay to >= one render quantum; Chromium (WebView2 on Windows, Android System
 * WebView) instead adds one render quantum of latency to every cycle. Measured once at start-up.
 */
export interface LoopCalibration {
  /** Extra frames added to every pass around a cycle. */
  extraFrames: number;
  /** Minimum effective delayTime (frames) inside a cycle. */
  minFrames: number;
}

/** Chromium behaviour; used until calibration finishes (both Tauri targets embed Chromium). */
export const DEFAULT_LOOP_CALIBRATION: LoopCalibration = { extraFrames: 128, minFrames: 0 };

async function measureLoopPeriod(sampleRate: number, delayFrames: number): Promise<number> {
  const ctx = new OfflineAudioContext(1, 2048, sampleRate);
  const impulse = ctx.createBuffer(1, 1, sampleRate);
  impulse.getChannelData(0)[0] = 1;
  const src = ctx.createBufferSource();
  src.buffer = impulse;
  const delay = ctx.createDelay(0.1);
  delay.delayTime.value = delayFrames / sampleRate;
  const fb = ctx.createGain();
  fb.gain.value = 0.5;
  src.connect(delay);
  delay.connect(fb).connect(delay);
  delay.connect(ctx.destination);
  src.start(0);
  const data = (await ctx.startRendering()).getChannelData(0);
  let first = -1;
  for (let i = 0; i < data.length; i++) {
    if (Math.abs(data[i]) > 0.2) {
      if (first < 0) {
        first = i;
        i += 2;
      } else return i - first;
    }
  }
  return -1;
}

/** Measures the real period of a DelayNode feedback cycle so Karplus-Strong strings stay in tune. */
export async function calibrateFeedbackLoop(sampleRate: number): Promise<LoopCalibration> {
  try {
    const probe = 200;
    const [p0, pProbe] = await Promise.all([measureLoopPeriod(sampleRate, 0), measureLoopPeriod(sampleRate, probe)]);
    if (p0 <= 0 || pProbe <= 0) return DEFAULT_LOOP_CALIBRATION;
    const extraFrames = Math.max(0, pProbe - probe);
    return { extraFrames, minFrames: Math.max(0, p0 - extraFrames) };
  } catch {
    return DEFAULT_LOOP_CALIBRATION;
  }
}

function disconnectAll(nodes: AudioNode[]): void {
  for (const n of nodes) {
    try {
      n.disconnect();
    } catch {
      // Already disconnected.
    }
  }
}

/** Collects nodes created for one voice and tears them down after the voice has fully finished. */
function scheduleCleanup(ctx: BaseAudioContext, nodes: AudioNode[], endTime: number): void {
  const delayMs = Math.max(0, (endTime - ctx.currentTime + 0.25) * 1000);
  globalThis.setTimeout(() => disconnectAll(nodes), delayMs);
}

/**
 * All-native Web Audio instrument kit:
 *  - Karplus-Strong plucked strings (noise burst -> feedback DelayNode loop with damping lowpass)
 *  - Dual-oscillator polyphonic keys
 *  - Procedural GM drum voices
 */
export class SynthKit {
  private readonly ctx: BaseAudioContext;
  private readonly noise: AudioBuffer;
  private readonly sampleRate: number;
  private loop: LoopCalibration = DEFAULT_LOOP_CALIBRATION;

  setLoopCalibration(calibration: LoopCalibration): void {
    this.loop = calibration;
  }

  constructor(ctx: BaseAudioContext) {
    this.ctx = ctx;
    this.sampleRate = ctx.sampleRate;
    const len = Math.floor(ctx.sampleRate * 2);
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  }

  // -------------------------------------------------------------------------------------------
  // Karplus-Strong string
  // -------------------------------------------------------------------------------------------

  playString(dest: AudioNode, o: StringNoteOptions): VoiceHandle {
    const ctx = this.ctx;
    const sr = this.sampleRate;
    const f0 = midiToFrequency(o.midi);
    const glideSemis = o.glide?.semitones ?? 0;
    const fMax = f0 * Math.pow(2, Math.max(0, glideSemis) / 12);
    const vel = Math.min(1, Math.max(0.05, o.velocity));
    const isBass = o.instrument === 'bass';

    // --- Damping lowpass inside the feedback loop ---
    const loopFilter = ctx.createBiquadFilter();
    loopFilter.type = 'lowpass';
    loopFilter.Q.value = -3; // Butterworth-ish, never resonant (keeps the loop stable)
    let cutoff: number;
    if (o.palmMute) cutoff = isBass ? 480 : 650;
    else if (isBass) cutoff = Math.min(4200, Math.max(1300, f0 * 14));
    else if (o.instrument === 'acoustic') cutoff = Math.min(12000, Math.max(3800, f0 * 18));
    else cutoff = Math.min(9000, Math.max(2600, f0 * 13));
    if (o.harmonic) cutoff = Math.min(sr * 0.45, cutoff * 1.6);
    loopFilter.frequency.value = Math.min(cutoff, sr * 0.45);

    // Phase delay + magnitude of the loop filter at the fundamental, for tuning and decay compensation.
    const freqArr = new Float32Array([f0]);
    const mag = new Float32Array(1);
    const phase = new Float32Array(1);
    loopFilter.getFrequencyResponse(freqArr, mag, phase);
    const filterDelay = Math.max(0, -phase[0] / (2 * Math.PI * f0));
    const filterMag = Math.max(0.05, mag[0]);

    // A feedback cycle can't be shorter than one render quantum (128 frames): engines either clamp the delay or
    // add a quantum of latency (see LoopCalibration). For high notes the loop therefore spans k whole periods;
    // a k-times repeated one-period burst keeps the tone purely harmonic at the intended pitch.
    const extra = this.loop.extraFrames / sr;
    const minDelay = (this.loop.minFrames + 1) / sr;
    const k = Math.max(1, Math.ceil((extra + filterDelay + minDelay) * fMax));
    const loopDelay = (periods: number, freq: number) => Math.max(minDelay, periods / freq - extra - filterDelay);

    // --- Decay (T60) -> per-loop feedback gain ---
    let t60: number;
    if (o.palmMute) t60 = isBass ? 0.32 : 0.22;
    else if (isBass) t60 = 4.2 * Math.pow(55 / f0, 0.25);
    else if (o.instrument === 'acoustic') t60 = 3.2 * Math.pow(196 / f0, 0.35);
    else t60 = 4.0 * Math.pow(196 / f0, 0.3);
    if (o.harmonic) t60 *= 1.4;
    t60 = Math.max(0.12, Math.min(8, t60));
    const loopSeconds = k / f0;
    const loopGainTotal = Math.pow(10, (-3 * loopSeconds) / t60);
    const feedbackValue = Math.min(0.9985, loopGainTotal / filterMag);

    // --- Excitation burst: one period of shaped noise, repeated k times ---
    const periodSamples = Math.max(2, Math.round(sr / f0));
    const burst = ctx.createBuffer(1, periodSamples * k, sr);
    const data = burst.getChannelData(0);
    const period = new Float32Array(periodSamples);
    let mean = 0;
    for (let i = 0; i < periodSamples; i++) {
      period[i] = Math.random() * 2 - 1;
      mean += period[i];
    }
    mean /= periodSamples;
    // Pick-position comb (pluck at ~1/7 of the string) for a more guitar-like spectrum.
    const pickOffset = Math.max(1, Math.round(periodSamples / 7));
    for (let r = 0; r < k; r++) {
      for (let i = 0; i < periodSamples; i++) {
        const a = period[i] - mean;
        const b = period[(i - pickOffset + periodSamples) % periodSamples] - mean;
        data[r * periodSamples + i] = (a - b * 0.6) * 0.7;
      }
    }

    const src = ctx.createBufferSource();
    src.buffer = burst;
    const exciteFilter = ctx.createBiquadFilter();
    exciteFilter.type = o.harmonic ? 'highpass' : 'lowpass';
    if (o.harmonic) exciteFilter.frequency.value = f0 * 0.8;
    else {
      const bright = o.palmMute ? 1800 : isBass ? 900 + vel * 2200 : 1400 + vel * 7000;
      exciteFilter.frequency.value = Math.min(sr * 0.45, o.hammerOn ? bright * 0.45 : bright);
    }
    exciteFilter.Q.value = 0;
    const exciteGain = ctx.createGain();
    exciteGain.gain.value = (0.3 + 0.6 * vel) * (o.hammerOn ? 0.55 : 1) * (o.harmonic ? 0.9 : 1);

    // --- Feedback loop ---
    const delay = ctx.createDelay(1.5);
    const feedback = ctx.createGain();
    feedback.gain.value = feedbackValue;
    delay.delayTime.value = loopDelay(k, f0);

    const out = ctx.createGain();
    const t = o.time;
    const end = t + Math.max(0.03, o.duration);
    out.gain.setValueAtTime(1, t);
    out.gain.setValueAtTime(1, end);
    out.gain.setTargetAtTime(0, end, RELEASE_TAIL / 3);

    src.connect(exciteFilter).connect(exciteGain).connect(delay);
    delay.connect(loopFilter).connect(feedback).connect(delay);
    delay.connect(out).connect(dest);

    // Bends and slides: ramp the loop delay so the pitch glides organically.
    delay.delayTime.setValueAtTime(loopDelay(k, f0), t);
    if (o.glide && o.glide.semitones !== 0) {
      const target = f0 * Math.pow(2, o.glide.semitones / 12);
      const gStart = Math.max(t, Math.min(o.glide.start, end));
      const gEnd = Math.max(gStart + 0.005, Math.min(o.glide.end, end));
      delay.delayTime.setValueAtTime(loopDelay(k, f0), gStart);
      delay.delayTime.linearRampToValueAtTime(loopDelay(k, target), gEnd);
    }

    src.start(t);
    src.stop(t + burst.duration + 0.01);

    const nodes: AudioNode[] = [src, exciteFilter, exciteGain, delay, loopFilter, feedback, out];
    const hardEnd = end + RELEASE_TAIL * 2;
    scheduleCleanup(ctx, nodes, hardEnd);

    let releasedAt = Number.POSITIVE_INFINITY;
    return {
      endTime: hardEnd,
      release(time: number) {
        if (time >= releasedAt || time >= end) return;
        releasedAt = time;
        const at = Math.max(time, t);
        out.gain.cancelScheduledValues(at);
        out.gain.setValueAtTime(1, at);
        out.gain.setTargetAtTime(0, at, 0.008);
        feedback.gain.cancelScheduledValues(at);
        feedback.gain.setValueAtTime(feedbackValue, at);
        feedback.gain.setTargetAtTime(0.3, at, 0.01);
      },
    };
  }

  // -------------------------------------------------------------------------------------------
  // Polyphonic keys: detuned saw + triangle, lowpass, ADSR
  // -------------------------------------------------------------------------------------------

  playKeys(dest: AudioNode, o: KeysNoteOptions): VoiceHandle {
    const ctx = this.ctx;
    const f = midiToFrequency(o.midi);
    const vel = Math.min(1, Math.max(0.05, o.velocity));
    const t = o.time;
    const end = t + Math.max(0.04, o.duration);
    const attack = 0.008;
    const decay = 0.22;
    const sustain = o.palmMute ? 0.25 : 0.62;
    const releaseTime = o.palmMute ? 0.06 : 0.28;

    const saw = ctx.createOscillator();
    saw.type = 'sawtooth';
    saw.frequency.value = f;
    saw.detune.value = -7;
    const tri = ctx.createOscillator();
    tri.type = 'triangle';
    tri.frequency.value = f;
    tri.detune.value = 7;
    const sawGain = ctx.createGain();
    sawGain.gain.value = 0.55;
    const triGain = ctx.createGain();
    triGain.gain.value = 0.75;

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.Q.value = 3;
    const peak = Math.min(ctx.sampleRate * 0.45, (o.palmMute ? 900 : 2200) + vel * 4200);
    const rest = o.palmMute ? 500 : 1300;
    filter.frequency.setValueAtTime(rest, t);
    filter.frequency.linearRampToValueAtTime(peak, t + attack);
    filter.frequency.setTargetAtTime(rest, t + attack, 0.18);

    const amp = ctx.createGain();
    const level = 0.22 * vel;
    amp.gain.setValueAtTime(0, t);
    amp.gain.linearRampToValueAtTime(level, t + attack);
    amp.gain.setTargetAtTime(level * sustain, t + attack, decay / 3);
    amp.gain.setTargetAtTime(0, end, releaseTime / 4);

    if (o.glide && o.glide.semitones !== 0) {
      for (const osc of [saw, tri]) {
        const base = osc.detune.value;
        osc.detune.setValueAtTime(base, Math.max(t, o.glide.start));
        osc.detune.linearRampToValueAtTime(base + o.glide.semitones * 100, Math.max(o.glide.start + 0.005, o.glide.end));
      }
    }

    saw.connect(sawGain).connect(filter);
    tri.connect(triGain).connect(filter);
    filter.connect(amp).connect(dest);

    const stopAt = end + releaseTime * 1.5;
    saw.start(t);
    tri.start(t);
    saw.stop(stopAt);
    tri.stop(stopAt);
    const nodes: AudioNode[] = [saw, tri, sawGain, triGain, filter, amp];
    scheduleCleanup(ctx, nodes, stopAt);

    let releasedAt = Number.POSITIVE_INFINITY;
    return {
      endTime: stopAt,
      release(time: number) {
        if (time >= releasedAt || time >= end) return;
        releasedAt = time;
        const at = Math.max(time, t);
        amp.gain.cancelScheduledValues(at);
        amp.gain.setTargetAtTime(0, at, 0.01);
      },
    };
  }

  // -------------------------------------------------------------------------------------------
  // Acoustic rock drum kit (GM note numbers), rendered into a DrumBus (dry + room send)
  // -------------------------------------------------------------------------------------------

  playDrum(out: DrumOutput, midiNote: number, velocity: number, time: number): VoiceHandle {
    const v = Math.pow(Math.min(127, Math.max(1, velocity)) / 127, 1.25);
    switch (midiNote) {
      case 36:
        return this.kick(out, v, time);
      case 38:
        return this.snare(out, v, time);
      case 42:
        return this.cymbal(out, v, time, 'closed-hat');
      case 46:
        return this.cymbal(out, v, time, 'open-hat');
      case 48:
        return this.tom(out, v, time, 215, 135, 0.42);
      case 45:
        return this.tom(out, v, time, 165, 105, 0.52);
      case 41:
        return this.tom(out, v, time, 118, 70, 0.72);
      case 49:
        return this.cymbal(out, v, time, 'crash');
      case 51:
        return this.cymbal(out, v, time, 'ride');
      case 52:
        return this.cymbal(out, v, time, 'china');
      default:
        return this.tom(out, v, time, 180, 120, 0.4);
    }
  }

  private noiseSource(time: number, duration: number): AudioBufferSourceNode {
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    const offset = Math.random() * Math.max(0, this.noise.duration - duration - 0.05);
    src.start(time, offset);
    src.stop(time + duration);
    return src;
  }

  /** Exponential attack/decay envelope (decay = time to fall ~80 dB). */
  private envGain(time: number, peak: number, decay: number, attack = 0.001): GainNode {
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, time);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), time + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, time + attack + decay);
    return g;
  }

  private filter(type: BiquadFilterType, frequency: number, q = 0.7071, gain = 0): BiquadFilterNode {
    const f = this.ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = Math.min(this.sampleRate * 0.45, frequency);
    f.Q.value = q;
    f.gain.value = gain;
    return f;
  }

  /** Sends `node` into the room reverb at `level`, returning the send gain for cleanup. */
  private roomSend(out: DrumOutput, node: AudioNode, level: number): GainNode {
    const send = this.ctx.createGain();
    send.gain.value = level;
    node.connect(send).connect(out.room);
    return send;
  }

  private chokeable(nodes: AudioNode[], gains: GainNode[], start: number, end: number): VoiceHandle {
    scheduleCleanup(this.ctx, nodes, end);
    let releasedAt = Number.POSITIVE_INFINITY;
    return {
      endTime: end,
      release(time: number) {
        if (time >= releasedAt || time >= end) return;
        releasedAt = time;
        const at = Math.max(time, start + 0.002);
        for (const g of gains) {
          g.gain.cancelScheduledValues(at);
          g.gain.setTargetAtTime(0, at, 0.012);
        }
      },
    };
  }

  /** Kick: 135→46 Hz pitch-drop punch + 80 Hz chest thump + 3.2 kHz beater click (12 ms). */
  private kick(out: DrumOutput, v: number, t: number): VoiceHandle {
    const ctx = this.ctx;
    const sum = ctx.createGain();
    sum.gain.value = 1;

    const punch = ctx.createOscillator();
    punch.type = 'sine';
    punch.frequency.setValueAtTime(135, t);
    punch.frequency.exponentialRampToValueAtTime(46, t + 0.085);
    punch.frequency.exponentialRampToValueAtTime(42, t + 0.4);
    const punchEnv = this.envGain(t, 1.0 * v, 0.38, 0.0015);
    punch.connect(punchEnv).connect(sum);

    const thump = ctx.createOscillator();
    thump.type = 'sine';
    thump.frequency.setValueAtTime(80, t);
    thump.frequency.exponentialRampToValueAtTime(72, t + 0.12);
    const thumpEnv = this.envGain(t, 0.55 * v, 0.2, 0.003);
    thump.connect(thumpEnv).connect(sum);

    const click = this.noiseSource(t, 0.03);
    const clickBp = this.filter('bandpass', 3200, 1.4);
    const clickEnv = this.envGain(t, (0.5 + 0.6 * v) * v, 0.012, 0.0005);
    click.connect(clickBp).connect(clickEnv).connect(sum);

    sum.connect(out.dry);
    punch.start(t);
    thump.start(t);
    punch.stop(t + 0.45);
    thump.stop(t + 0.3);
    return this.chokeable(
      [punch, punchEnv, thump, thumpEnv, click, clickBp, clickEnv, sum],
      [punchEnv, thumpEnv, clickEnv],
      t,
      t + 0.45,
    );
  }

  /** Snare: two detuned shell modes + 1.2 kHz wire body + 5.8 kHz wire rattle + 8 ms stick crack. */
  private snare(out: DrumOutput, v: number, t: number): VoiceHandle {
    const ctx = this.ctx;
    const sum = ctx.createGain();
    const nodes: AudioNode[] = [sum];

    const shell = (f: number, drop: number, peak: number, decay: number, type: OscillatorType) => {
      const osc = ctx.createOscillator();
      osc.type = type;
      osc.frequency.setValueAtTime(f, t);
      osc.frequency.exponentialRampToValueAtTime(f * drop, t + 0.07);
      const env = this.envGain(t, peak * v, decay, 0.001);
      osc.connect(env).connect(sum);
      osc.start(t);
      osc.stop(t + decay + 0.02);
      nodes.push(osc, env);
      return env;
    };
    const shellA = shell(185, 0.94, 0.78, 0.15, 'triangle');
    const shellB = shell(330, 0.95, 0.3, 0.09, 'sine');

    // Wire body (midrange) — lengthens a little with harder hits.
    const wires = this.noiseSource(t, 0.35);
    const bodyBp = this.filter('bandpass', 1200, 0.8);
    const bodyEnv = this.envGain(t, 0.85 * v, 0.16 + 0.06 * v, 0.001);
    wires.connect(bodyBp).connect(bodyEnv).connect(sum);

    // Wire rattle (top end) — brighter with velocity.
    const rattleHp = this.filter('highpass', 2400, 0.7);
    const rattleShelf = this.filter('highshelf', 5800, 0.7, 1 + 6 * v);
    const rattleEnv = this.envGain(t, (0.1 + 0.18 * v) * v, 0.2 + 0.05 * v, 0.001);
    wires.connect(rattleHp).connect(rattleShelf).connect(rattleEnv).connect(sum);

    // Stick crack transient.
    const crack = this.noiseSource(t, 0.02);
    const crackHp = this.filter('highpass', 1500 + 1500 * v, 0.9);
    const crackEnv = this.envGain(t, (0.22 + 0.33 * v) * v, 0.008, 0.0003);
    crack.connect(crackHp).connect(crackEnv).connect(sum);

    sum.connect(out.dry);
    const send = this.roomSend(out, sum, 0.42);
    nodes.push(wires, bodyBp, bodyEnv, rattleHp, rattleShelf, rattleEnv, crack, crackHp, crackEnv, send);
    return this.chokeable(nodes, [shellA, shellB, bodyEnv, rattleEnv, crackEnv], t, t + 0.4);
  }

  /** Tom: swept membrane + slightly inharmonic overtone + stick attack + warm low-mid decay. */
  private tom(out: DrumOutput, v: number, t: number, fStart: number, fEnd: number, decay: number): VoiceHandle {
    const ctx = this.ctx;
    const sum = ctx.createGain();
    const warm = this.filter('lowpass', 1400, 0.5);
    sum.connect(warm);

    const membrane = ctx.createOscillator();
    membrane.type = 'sine';
    membrane.frequency.setValueAtTime(fStart, t);
    membrane.frequency.exponentialRampToValueAtTime(fEnd, t + decay * 0.55);
    const memEnv = this.envGain(t, 0.95 * v, decay, 0.002);
    membrane.connect(memEnv).connect(sum);

    const overtone = ctx.createOscillator();
    overtone.type = 'triangle';
    overtone.frequency.setValueAtTime(fStart * 1.58, t);
    overtone.frequency.exponentialRampToValueAtTime(fEnd * 1.58, t + decay * 0.45);
    const ovEnv = this.envGain(t, 0.22 * v, decay * 0.45, 0.002);
    overtone.connect(ovEnv).connect(sum);

    const lowMid = this.noiseSource(t, decay * 0.6);
    const lowMidBp = this.filter('bandpass', fEnd * 3.2, 1.1);
    const lowMidEnv = this.envGain(t, 0.3 * v, decay * 0.35, 0.002);
    lowMid.connect(lowMidBp).connect(lowMidEnv).connect(sum);

    const stick = this.noiseSource(t, 0.02);
    const stickHp = this.filter('highpass', 2200, 0.8);
    const stickEnv = this.envGain(t, 0.25 * v, 0.007, 0.0003);
    stick.connect(stickHp).connect(stickEnv);

    warm.connect(out.dry);
    stickEnv.connect(out.dry);
    const send = this.roomSend(out, warm, 0.36);
    membrane.start(t);
    overtone.start(t);
    membrane.stop(t + decay + 0.05);
    overtone.stop(t + decay + 0.05);
    return this.chokeable(
      [membrane, memEnv, overtone, ovEnv, lowMid, lowMidBp, lowMidEnv, stick, stickHp, stickEnv, sum, warm, send],
      [memEnv, ovEnv, lowMidEnv, stickEnv],
      t,
      t + decay + 0.06,
    );
  }

  /**
   * Hi-hats and cymbals: six inharmonic square oscillators (205/304/369/522/540/800 Hz, scaled by cymbal size)
   * through a resonant 7 kHz bandpass + 5.5 kHz highpass, blended with shaped high-frequency air noise.
   */
  private cymbal(out: DrumOutput, v: number, t: number, kind: 'closed-hat' | 'open-hat' | 'crash' | 'ride' | 'china'): VoiceHandle {
    const ctx = this.ctx;
    const spec = {
      'closed-hat': { scale: 1.0, decay: 0.07, metal: 1.0, air: 0.55, room: 0.06, level: 0.95, bpQ: 2.4 },
      'open-hat': { scale: 1.0, decay: 0.48, metal: 1.0, air: 0.5, room: 0.12, level: 0.75, bpQ: 2.4 },
      crash: { scale: 0.86, decay: 1.9, metal: 0.9, air: 0.85, room: 0.3, level: 0.5, bpQ: 1.4 },
      ride: { scale: 1.12, decay: 1.5, metal: 1.0, air: 0.3, room: 0.2, level: 0.4, bpQ: 3.2 },
      china: { scale: 0.74, decay: 1.2, metal: 1.15, air: 0.9, room: 0.28, level: 0.55, bpQ: 1.1 },
    }[kind];
    const dur = spec.decay + 0.12;
    const nodes: AudioNode[] = [];

    const metal = ctx.createGain();
    metal.gain.value = 0.16 * spec.metal;
    nodes.push(metal);
    for (const f of [205.3, 304.4, 369.6, 522.7, 540.0, 800.0]) {
      const osc = ctx.createOscillator();
      osc.type = 'square';
      osc.frequency.value = f * spec.scale;
      osc.connect(metal);
      osc.start(t);
      osc.stop(t + dur);
      nodes.push(osc);
    }
    const bp = this.filter('bandpass', 7000, spec.bpQ);
    const hp = this.filter('highpass', 5500, 0.9);
    metal.connect(bp).connect(hp);

    const air = this.noiseSource(t, dur);
    const airHp = this.filter('highpass', 8000, 0.7);
    const airShelf = this.filter('highshelf', 11000, 0.7, 4);
    const airLevel = ctx.createGain();
    airLevel.gain.value = spec.air * 0.35;
    air.connect(airHp).connect(airShelf).connect(airLevel);

    const mix = ctx.createGain();
    hp.connect(mix);
    airLevel.connect(mix);
    nodes.push(bp, hp, air, airHp, airShelf, airLevel, mix);

    let tone: AudioNode = mix;
    if (kind === 'china') {
      const trash = this.filter('peaking', 3400, 1.3, 8);
      mix.connect(trash);
      tone = trash;
      nodes.push(trash);
    }

    // Dynamic brightness: soft hits are darker.
    const bright = this.filter('lowpass', 7000 + 11000 * v, 0.5);
    const decay = spec.decay * (0.65 + 0.35 * v);
    const env = this.envGain(t, spec.level * 1.5 * v, decay, kind === 'crash' || kind === 'china' ? 0.003 : 0.0008);
    tone.connect(bright).connect(env).connect(out.dry);
    const send = this.roomSend(out, env, spec.room);
    nodes.push(bright, env, send);
    const gains: GainNode[] = [env];

    if (kind === 'ride') {
      // Bell "ping" for stick definition.
      const ping = ctx.createOscillator();
      ping.type = 'sine';
      ping.frequency.value = 2650;
      const ping2 = ctx.createOscillator();
      ping2.type = 'sine';
      ping2.frequency.value = 3920;
      const pingEnv = this.envGain(t, 0.1 * v, 0.6);
      ping.connect(pingEnv);
      ping2.connect(pingEnv);
      pingEnv.connect(out.dry);
      for (const o of [ping, ping2]) {
        o.start(t);
        o.stop(t + 0.65);
      }
      nodes.push(ping, ping2, pingEnv);
      gains.push(pingEnv);
    }
    return this.chokeable(nodes, gains, t, t + dur);
  }

  // -------------------------------------------------------------------------------------------
  // Metronome
  // -------------------------------------------------------------------------------------------

  playClick(dest: AudioNode, time: number, accent: boolean): void {
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    osc.type = 'square';
    osc.frequency.value = accent ? 1760 : 1175;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 4000;
    const env = this.envGain(time, accent ? 0.35 : 0.22, 0.035);
    osc.connect(lp).connect(env).connect(dest);
    osc.start(time);
    osc.stop(time + 0.06);
    scheduleCleanup(ctx, [osc, lp, env], time + 0.06);
  }
}

/** Builds a short (0.35 s) decorrelated stereo room impulse: early reflections + darkening diffuse tail. */
function createRoomImpulse(ctx: BaseAudioContext, seconds = 0.35): AudioBuffer {
  const sr = ctx.sampleRate;
  const length = Math.floor(sr * seconds);
  const ir = ctx.createBuffer(2, length, sr);
  const reflections = [
    [0.0071, 0.55],
    [0.0113, 0.42],
    [0.0167, 0.36],
    [0.0229, 0.3],
    [0.0311, 0.24],
    [0.0397, 0.18],
  ];
  for (let ch = 0; ch < 2; ch++) {
    const data = ir.getChannelData(ch);
    let lp = 0;
    for (let i = 0; i < length; i++) {
      const time = i / sr;
      // One-pole lowpass whose cutoff falls over time: the tail gets darker like a real room.
      const coeff = 0.25 + 0.65 * (time / seconds);
      lp = lp * coeff + (Math.random() * 2 - 1) * (1 - coeff);
      const fadeIn = Math.min(1, time / 0.004);
      const fadeOut = Math.min(1, (seconds - time) / 0.03);
      data[i] = lp * Math.exp(-time / 0.075) * fadeIn * fadeOut * 1.6;
    }
    for (const [at, gain] of reflections) {
      const idx = Math.floor((at + ch * 0.0013 * (Math.random() + 0.5)) * sr);
      if (idx < length) data[idx] += (Math.random() < 0.5 ? -1 : 1) * gain;
    }
  }
  return ir;
}

/**
 * Per-drum-track bus: warm console saturation (WaveShaper) -> glue/punch compressor (slow-ish attack keeps
 * transients) -> output, plus a short stereo room (ConvolverNode) fed by per-voice sends (snare, toms, cymbals).
 */
export class DrumBus {
  readonly input: GainNode;
  readonly roomSend: GainNode;
  readonly output: GainNode;
  private readonly nodes: AudioNode[];
  private readonly ctx: BaseAudioContext;
  private readonly driveGain: GainNode;
  private readonly makeupGain: GainNode;
  private readonly roomGain: GainNode;

  constructor(ctx: BaseAudioContext) {
    this.ctx = ctx;
    this.input = ctx.createGain();
    this.roomSend = ctx.createGain();
    this.output = ctx.createGain();

    const drive = ctx.createGain();
    drive.gain.value = 0.7;
    const saturator = ctx.createWaveShaper();
    const curve = new Float32Array(2048);
    const k = 1.8;
    for (let i = 0; i < curve.length; i++) {
      const x = (i / (curve.length - 1)) * 2 - 1;
      // Gentle, slightly asymmetric tape/console curve.
      curve[i] = Math.tanh(k * (x + 0.04 * x * x)) / Math.tanh(k);
    }
    saturator.curve = curve;
    saturator.oversample = '2x';

    const glue = ctx.createDynamicsCompressor();
    glue.threshold.value = -16;
    glue.knee.value = 6;
    glue.ratio.value = 4;
    glue.attack.value = 0.012;
    glue.release.value = 0.14;
    const makeup = ctx.createGain();
    makeup.gain.value = 1.15;

    const room = ctx.createConvolver();
    room.normalize = true;
    room.buffer = createRoomImpulse(ctx);
    const roomReturn = ctx.createGain();
    roomReturn.gain.value = 0.55;
    const roomTone = ctx.createBiquadFilter();
    roomTone.type = 'highpass';
    roomTone.frequency.value = 180;

    this.input.connect(drive).connect(saturator).connect(glue).connect(makeup).connect(this.output);
    this.roomSend.connect(roomTone).connect(room).connect(roomReturn).connect(this.output);
    this.nodes = [this.input, drive, saturator, glue, makeup, this.roomSend, roomTone, room, roomReturn, this.output];
    this.driveGain = drive;
    this.makeupGain = makeup;
    this.roomGain = roomReturn;
  }

  /**
   * Bus character. 'rock' drives the console saturation harder and opens up the room; 'acoustic' is cleaner.
   * Applied with a short glide so switching kits while playing doesn't click.
   */
  setCharacter(character: 'rock' | 'acoustic' | 'synth'): void {
    const presets = {
      rock: { drive: 1.0, makeup: 1.0, room: 0.75 },
      acoustic: { drive: 0.6, makeup: 1.2, room: 0.45 },
      synth: { drive: 0.7, makeup: 1.15, room: 0.55 },
    } as const;
    const p = presets[character];
    const t = this.ctx.currentTime;
    this.driveGain.gain.setTargetAtTime(p.drive, t, 0.02);
    this.makeupGain.gain.setTargetAtTime(p.makeup, t, 0.02);
    this.roomGain.gain.setTargetAtTime(p.room, t, 0.02);
  }

  get out(): DrumOutput {
    return { dry: this.input, room: this.roomSend };
  }

  dispose(): void {
    disconnectAll(this.nodes);
  }
}
