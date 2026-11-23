import type { FxChainSettings } from '../types/song';

const SMOOTH = 0.012;

function makeOverdriveCurve(samples = 2048) {
  // Asymmetric tanh soft clipper: the negative half clips earlier and softer, adding even harmonics.
  const curve = new Float32Array(samples);
  const kPos = 2.6;
  const kNeg = 1.9;
  const normPos = Math.tanh(kPos);
  const normNeg = Math.tanh(kNeg);
  for (let i = 0; i < samples; i++) {
    const x = (i / (samples - 1)) * 2 - 1;
    curve[i] = x >= 0 ? Math.tanh(kPos * x) / normPos : (Math.tanh(kNeg * x) / normNeg) * 0.88;
  }
  return curve;
}

function makeDistortionCurve(samples = 4096) {
  // Steep, nearly rectangular transfer curve for high-gain hard clipping.
  const curve = new Float32Array(samples);
  const k = 7;
  const norm = 1 - Math.exp(-k);
  for (let i = 0; i < samples; i++) {
    const x = (i / (samples - 1)) * 2 - 1;
    curve[i] = (Math.sign(x) * (1 - Math.exp(-k * Math.abs(x)))) / norm;
  }
  return curve;
}

let sharedOdCurve: ReturnType<typeof makeOverdriveCurve> | null = null;
let sharedDsCurve: ReturnType<typeof makeDistortionCurve> | null = null;

/**
 * Lean per-track two-pedal chain: Overdrive -> Distortion, each with an independent click-free bypass.
 *
 * Overdrive: peaking mid-hump (750 Hz) -> drive gain -> asymmetric tanh WaveShaper -> lowpass tone (1.5–6 kHz) -> level
 * Distortion: tightening highpass -> gain -> hard-clip WaveShaper (4x oversampling) -> lowpass tone (<= 4.5 kHz) -> level
 */
export class GuitarFxChain {
  readonly input: GainNode;
  readonly output: GainNode;

  private readonly ctx: BaseAudioContext;
  private readonly odDry: GainNode;
  private readonly odWet: GainNode;
  private readonly odMid: BiquadFilterNode;
  private readonly odDrive: GainNode;
  private readonly odShaper: WaveShaperNode;
  private readonly odTone: BiquadFilterNode;
  private readonly odLevel: GainNode;
  private readonly odSum: GainNode;

  private readonly dsDry: GainNode;
  private readonly dsWet: GainNode;
  private readonly dsTight: BiquadFilterNode;
  private readonly dsGain: GainNode;
  private readonly dsShaper: WaveShaperNode;
  private readonly dsTone: BiquadFilterNode;
  private readonly dsLevel: GainNode;
  private readonly dsSum: GainNode;

  private readonly dcBlock: BiquadFilterNode;
  private readonly nodes: AudioNode[];

  constructor(ctx: BaseAudioContext, settings: FxChainSettings) {
    this.ctx = ctx;
    this.input = ctx.createGain();
    this.output = ctx.createGain();

    this.odDry = ctx.createGain();
    this.odWet = ctx.createGain();
    this.odMid = ctx.createBiquadFilter();
    this.odMid.type = 'peaking';
    this.odMid.frequency.value = 750;
    this.odMid.Q.value = 0.85;
    this.odDrive = ctx.createGain();
    this.odShaper = ctx.createWaveShaper();
    sharedOdCurve ??= makeOverdriveCurve();
    this.odShaper.curve = sharedOdCurve;
    this.odShaper.oversample = '2x';
    this.odTone = ctx.createBiquadFilter();
    this.odTone.type = 'lowpass';
    this.odTone.Q.value = 0;
    this.odLevel = ctx.createGain();
    this.odSum = ctx.createGain();

    this.dsDry = ctx.createGain();
    this.dsWet = ctx.createGain();
    this.dsTight = ctx.createBiquadFilter();
    this.dsTight.type = 'highpass';
    this.dsTight.frequency.value = 95;
    this.dsTight.Q.value = 0;
    this.dsGain = ctx.createGain();
    this.dsShaper = ctx.createWaveShaper();
    sharedDsCurve ??= makeDistortionCurve();
    this.dsShaper.curve = sharedDsCurve;
    this.dsShaper.oversample = '4x';
    this.dsTone = ctx.createBiquadFilter();
    this.dsTone.type = 'lowpass';
    this.dsTone.Q.value = 0.5;
    this.dsLevel = ctx.createGain();
    this.dsSum = ctx.createGain();

    this.dcBlock = ctx.createBiquadFilter();
    this.dcBlock.type = 'highpass';
    this.dcBlock.frequency.value = 28;
    this.dcBlock.Q.value = -3;

    // Overdrive stage
    this.input.connect(this.odDry).connect(this.odSum);
    this.input
      .connect(this.odMid)
      .connect(this.odDrive)
      .connect(this.odShaper)
      .connect(this.odTone)
      .connect(this.odLevel)
      .connect(this.odWet)
      .connect(this.odSum);
    // Distortion stage
    this.odSum.connect(this.dsDry).connect(this.dsSum);
    this.odSum
      .connect(this.dsTight)
      .connect(this.dsGain)
      .connect(this.dsShaper)
      .connect(this.dsTone)
      .connect(this.dsLevel)
      .connect(this.dsWet)
      .connect(this.dsSum);
    this.dsSum.connect(this.dcBlock).connect(this.output);

    this.nodes = [
      this.input, this.odDry, this.odWet, this.odMid, this.odDrive, this.odShaper, this.odTone, this.odLevel, this.odSum,
      this.dsDry, this.dsWet, this.dsTight, this.dsGain, this.dsShaper, this.dsTone, this.dsLevel, this.dsSum,
      this.dcBlock, this.output,
    ];
    this.update(settings, true);
  }

  /** Applies settings with short parameter smoothing (or instantly when `immediate`). */
  update(settings: FxChainSettings, immediate = false): void {
    const t = this.ctx.currentTime;
    const set = (param: AudioParam, value: number) => {
      if (immediate) {
        param.cancelScheduledValues(0);
        param.value = value;
      } else {
        param.cancelScheduledValues(t);
        param.setTargetAtTime(value, t, SMOOTH);
      }
    };
    const od = settings.overdrive;
    const ds = settings.distortion;
    const n = (v: number) => Math.min(100, Math.max(0, v)) / 100;

    set(this.odDry.gain, od.enabled ? 0 : 1);
    set(this.odWet.gain, od.enabled ? 1 : 0);
    set(this.odMid.gain, 3 + n(od.drive) * 6);
    set(this.odDrive.gain, 0.6 + Math.pow(n(od.drive), 1.6) * 11);
    set(this.odTone.frequency, 1500 * Math.pow(4, n(od.tone)));
    set(this.odLevel.gain, Math.pow(n(od.level), 1.5) * 0.95);

    set(this.dsDry.gain, ds.enabled ? 0 : 1);
    set(this.dsWet.gain, ds.enabled ? 1 : 0);
    set(this.dsGain.gain, 3 + Math.pow(n(ds.gain), 1.5) * 140);
    set(this.dsTone.frequency, Math.min(4500, 900 * Math.pow(5, n(ds.tone))));
    set(this.dsLevel.gain, Math.pow(n(ds.level), 1.5) * 0.85);
  }

  dispose(): void {
    for (const node of this.nodes) node.disconnect();
  }
}
