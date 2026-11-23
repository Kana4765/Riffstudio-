import type { CustomDrumKit } from '../services/drumKitStorage';
import { isBuiltInKit, type BuiltInDrumKitId, type DrumKitId } from '../types/song';
import type { DrumOutput, VoiceHandle } from './Synthesizers';
import { trimLeadingSilence } from './trimSilence';

/**
 * Recorded General MIDI drum kit player.
 *
 * The samples come from the FluidR3_GM percussion soundfont in MIDI.js format
 * (`MIDI.Soundfont.percussion = { "C2": "data:audio/mp3;base64,..." }`). They are downloaded into
 * src/assets/drumkits by scripts/fetch-drum-kits.mjs and bundled by Vite with `?raw`. The import is lazy,
 * so the ~0.8 MB kit becomes its own local chunk: no network access at runtime and no startup delay.
 *
 * Two built-in kits share the same recordings:
 *  - 'rock'     — rock voicing: kick/snare/toms tuned down, harder hits, more room and bus drive
 *  - 'acoustic' — the kit as recorded
 *
 * Custom kits (IndexedDB, see drumKitStorage.ts) are decoded and auto-trimmed on demand and cached per kit id.
 * A custom sample plays at its natural recorded pitch; empty slots fall back to the kit's built-in `baseKit`.
 * Any note with no sample anywhere makes `play()` return null, and the caller then uses the procedural synth.
 */

export type DrumKitStatus =
  | { state: 'idle' }
  | { state: 'loading' }
  | { state: 'ready'; samples: number; failed: number }
  | { state: 'unavailable'; reason: string };

export interface DrumKitInfo {
  id: BuiltInDrumKitId;
  label: string;
}

export const DRUM_KITS: readonly DrumKitInfo[] = [
  { id: 'rock', label: 'Rock Kit (FluidR3, rock voicing)' },
  { id: 'acoustic', label: 'Studio Acoustic (FluidR3)' },
];

export function builtInKitLabel(id: BuiltInDrumKitId): string {
  return DRUM_KITS.find((k) => k.id === id)?.label ?? id;
}

interface Voicing {
  /** Semitone shift per GM note (playbackRate). */
  pitch: Partial<Record<number, number>>;
  /** Linear gain trim per GM note. */
  gain: Partial<Record<number, number>>;
  /** Room-reverb send per GM note. */
  room: Partial<Record<number, number>>;
  /** Overall kit gain. */
  level: number;
}

const ROOM_DEFAULT: Partial<Record<number, number>> = {
  36: 0,
  38: 0.32,
  42: 0.06,
  46: 0.1,
  41: 0.28,
  45: 0.26,
  48: 0.24,
  49: 0.22,
  51: 0.14,
  52: 0.2,
};

export const KIT_VOICINGS: Record<BuiltInDrumKitId, Voicing> = {
  acoustic: {
    pitch: {},
    gain: { 36: 1.0, 38: 0.95, 42: 0.75, 46: 0.75, 41: 0.95, 45: 0.95, 48: 0.95, 49: 0.75, 51: 0.7, 52: 0.75 },
    room: ROOM_DEFAULT,
    level: 1.0,
  },
  rock: {
    pitch: { 36: -1, 38: -1.5, 41: -2, 45: -2, 48: -2, 49: -0.5, 52: -0.5 },
    gain: { 36: 1.25, 38: 1.15, 42: 0.7, 46: 0.75, 41: 1.1, 45: 1.05, 48: 1.0, 49: 0.85, 51: 0.7, 52: 0.85 },
    room: { ...ROOM_DEFAULT, 38: 0.5, 41: 0.42, 45: 0.4, 48: 0.38, 49: 0.3 },
    level: 1.0,
  },
};

const SAMPLE_PATTERN = /["']([A-G][b#]?-?\d+)["']\s*:\s*["']data:audio\/mp3;base64,([^"']+)["']/g;

const SEMITONES: Record<string, number> = {
  C: 0,
  Db: 1,
  'C#': 1,
  D: 2,
  Eb: 3,
  'D#': 3,
  E: 4,
  F: 5,
  Gb: 6,
  'F#': 6,
  G: 7,
  Ab: 8,
  'G#': 8,
  A: 9,
  Bb: 10,
  'A#': 10,
  B: 11,
};

/** MIDI.js note name ("C2", "Gb2", "Db3", "C#-1") to MIDI number, with C4 = 60 (so C2 = 36). */
export function noteNameToMidi(name: string): number | null {
  const m = /^([A-G][b#]?)(-?\d+)$/.exec(name);
  if (!m) return null;
  const semitone = SEMITONES[m[1]];
  if (semitone === undefined) return null;
  const midi = (Number(m[2]) + 1) * 12 + semitone;
  return midi >= 0 && midi <= 127 ? midi : null;
}

/** Extracts `{ midiNote -> base64 MP3 }` from a MIDI.js soundfont file. */
export function parseMidiJsSoundfont(source: string): Map<number, string> {
  const out = new Map<number, string>();
  SAMPLE_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SAMPLE_PATTERN.exec(source)) !== null) {
    const midi = noteNameToMidi(match[1]);
    if (midi !== null) out.set(midi, match[2]);
  }
  return out;
}

function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

/** Wraps decodeAudioData in a promise; older WebViews only support the callback form. */
function decode(ctx: BaseAudioContext, data: ArrayBuffer): Promise<AudioBuffer> {
  return new Promise<AudioBuffer>((resolve, reject) => {
    const maybe = ctx.decodeAudioData(data, resolve, (err) => reject(err ?? new Error('decode failed')));
    if (maybe && typeof maybe.then === 'function') maybe.then(resolve, reject);
  });
}

/** Lazily imports the bundled kit text (separate local chunk). */
export async function loadBundledKitSource(): Promise<string> {
  const mod = await import('../assets/drumkits/fluidr3-percussion-mp3.js?raw');
  return mod.default;
}

/** Custom samples: natural pitch, unity gain, standard room sends. */
const CUSTOM_VOICING: Voicing = { pitch: {}, gain: {}, room: ROOM_DEFAULT, level: 1.0 };

export type CustomKitLoadState = 'loading' | 'ready';

interface CustomKitEntry {
  updatedAt: number;
  baseKit: BuiltInDrumKitId;
  name: string;
  buffers: Map<number, AudioBuffer>;
  failed: number[];
  state: CustomKitLoadState;
  promise: Promise<void>;
}

const CHOKE_RAMP = 0.025;
const HUMANIZE_RATE = 0.012;
const HUMANIZE_GAIN = 0.03;

/** AudioBuffers aren't tied to a context, so samples decode in an OfflineAudioContext at app start. */
function createDecodeContext(): BaseAudioContext {
  return new OfflineAudioContext(1, 1, 44100);
}

export class DrumSampler {
  private readonly buffers = new Map<number, AudioBuffer>();
  private readonly custom = new Map<string, CustomKitEntry>();
  private status: DrumKitStatus = { state: 'idle' };
  private loading: Promise<void> | null = null;
  private readonly listeners = new Set<() => void>();
  private readonly makeDecodeContext: () => BaseAudioContext;

  constructor(makeDecodeContext: () => BaseAudioContext = createDecodeContext) {
    this.makeDecodeContext = makeDecodeContext;
  }

  get kitStatus(): DrumKitStatus {
    return this.status;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private setStatus(status: DrumKitStatus): void {
    this.status = status;
    this.emit();
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }

  /**
   * Decodes every sample once, before any user gesture; later calls reuse the same promise. This doesn't need
   * the playback AudioContext.
   */
  load(source: () => Promise<string> = loadBundledKitSource): Promise<void> {
    this.loading ??= this.doLoad(source);
    return this.loading;
  }

  private async doLoad(source: () => Promise<string>): Promise<void> {
    this.setStatus({ state: 'loading' });
    let text: string;
    try {
      text = await source();
    } catch (err) {
      this.setStatus({ state: 'unavailable', reason: `kit file missing (${err instanceof Error ? err.message : String(err)})` });
      return;
    }
    const samples = parseMidiJsSoundfont(text);
    if (samples.size === 0) {
      this.setStatus({ state: 'unavailable', reason: 'kit not downloaded — run `npm run fetch-drums`' });
      return;
    }
    let failed = 0;
    let decodeCtx: BaseAudioContext;
    try {
      decodeCtx = this.makeDecodeContext();
    } catch (err) {
      this.setStatus({ state: 'unavailable', reason: `Web Audio unavailable (${err instanceof Error ? err.message : String(err)})` });
      return;
    }
    await Promise.all(
      [...samples.entries()].map(async ([midi, b64]) => {
        try {
          this.buffers.set(midi, await decode(decodeCtx, base64ToArrayBuffer(b64)));
        } catch {
          failed += 1;
        }
      }),
    );
    if (this.buffers.size === 0) this.setStatus({ state: 'unavailable', reason: 'samples could not be decoded' });
    else this.setStatus({ state: 'ready', samples: this.buffers.size, failed });
  }

  has(midiNote: number): boolean {
    return this.buffers.has(midiNote);
  }

  // ----------------------------------------------------------------------------------- custom kits

  /** Built-in kit that drives the DrumBus character for any kit id (custom kits use their base kit). */
  baseKitOf(kitId: DrumKitId): BuiltInDrumKitId {
    if (isBuiltInKit(kitId)) return kitId;
    return this.custom.get(kitId)?.baseKit ?? 'rock';
  }

  /** Picks the sample for a hit: custom slot (natural pitch) -> base built-in kit (with its voicing). */
  private resolve(kitId: DrumKitId, midiNote: number): { buffer: AudioBuffer; voicing: Voicing } | null {
    let base: BuiltInDrumKitId = 'rock';
    if (isBuiltInKit(kitId)) base = kitId;
    else {
      const entry = this.custom.get(kitId);
      const own = entry?.buffers.get(midiNote);
      if (own) return { buffer: own, voicing: CUSTOM_VOICING };
      base = entry?.baseKit ?? 'rock';
    }
    const buffer = this.buffers.get(midiNote);
    return buffer ? { buffer, voicing: KIT_VOICINGS[base] } : null;
  }

  customKitState(kitId: string): { state: CustomKitLoadState; pieces: number; failed: number[]; updatedAt: number } | null {
    const e = this.custom.get(kitId);
    return e ? { state: e.state, pieces: e.buffers.size, failed: e.failed, updatedAt: e.updatedAt } : null;
  }

  /**
   * Decodes (and auto-trims) a custom kit if it isn't cached at this revision yet. Pieces that fail to
   * decode are reported in `failed` and keep using the base kit.
   */
  ensureCustomKit(kit: CustomDrumKit): Promise<void> {
    const cached = this.custom.get(kit.id);
    if (cached && cached.updatedAt === kit.updatedAt) {
      cached.baseKit = kit.baseKit;
      cached.name = kit.name;
      return cached.promise;
    }
    const entry: CustomKitEntry = {
      updatedAt: kit.updatedAt,
      baseKit: kit.baseKit,
      name: kit.name,
      // Keep the previous buffers audible while the new revision decodes.
      buffers: cached ? new Map(cached.buffers) : new Map(),
      failed: [],
      state: 'loading',
      promise: Promise.resolve(),
    };
    this.custom.set(kit.id, entry);
    entry.promise = (async () => {
      const decoded = new Map<number, AudioBuffer>();
      const failed: number[] = [];
      let decodeCtx: BaseAudioContext;
      try {
        decodeCtx = this.makeDecodeContext();
      } catch {
        entry.state = 'ready';
        return;
      }
      await Promise.all(
        Object.entries(kit.samples).map(async ([note, sample]) => {
          if (!sample) return;
          try {
            decoded.set(Number(note), await decodeUserSample(decodeCtx, sample.arrayBuffer));
          } catch {
            failed.push(Number(note));
          }
        }),
      );
      // A newer revision may have replaced this entry while decoding; only publish if we're still current.
      if (this.custom.get(kit.id) === entry) {
        entry.buffers = decoded;
        entry.failed = failed.sort((a, b) => a - b);
        entry.state = 'ready';
        this.emit();
      }
    })();
    this.emit();
    return entry.promise;
  }

  /** Frees decoded audio for kits that are no longer used or no longer exist. */
  retainCustomKits(ids: Iterable<string>): void {
    const keep = new Set(ids);
    let changed = false;
    for (const id of [...this.custom.keys()]) {
      if (!keep.has(id)) {
        this.custom.delete(id);
        changed = true;
      }
    }
    if (changed) this.emit();
  }

  /** Resolves when every custom kit currently decoding has finished. */
  async whenCustomKitsReady(): Promise<void> {
    await Promise.all([...this.custom.values()].map((e) => e.promise));
  }

  /**
   * Plays one recorded hit into the drum bus. Returns null when no decoded sample exists for the note, so
   * the caller can fall back to the synth.
   */
  play(ctx: BaseAudioContext, out: DrumOutput, midiNote: number, velocity: number, time: number, kit: DrumKitId): VoiceHandle | null {
    const resolved = this.resolve(kit, midiNote);
    if (!resolved) return null;
    const { buffer, voicing } = resolved;
    const v = Math.min(127, Math.max(1, velocity)) / 127;

    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const semis = voicing.pitch[midiNote] ?? 0;
    const rate = Math.pow(2, semis / 12) * (1 + (Math.random() * 2 - 1) * HUMANIZE_RATE);
    src.playbackRate.value = rate;

    // Softer hits are also darker, the way a real drum responds.
    const tone = ctx.createBiquadFilter();
    tone.type = 'lowpass';
    tone.frequency.value = Math.min(ctx.sampleRate * 0.45, 3500 + 18000 * Math.pow(v, 1.3));
    tone.Q.value = 0;

    const level = Math.pow(v, 1.6) * (voicing.gain[midiNote] ?? 1) * voicing.level * (1 + (Math.random() * 2 - 1) * HUMANIZE_GAIN);
    const amp = ctx.createGain();
    amp.gain.setValueAtTime(level, time);

    src.connect(tone).connect(amp).connect(out.dry);
    const nodes: AudioNode[] = [src, tone, amp];
    const roomLevel = voicing.room[midiNote] ?? 0;
    if (roomLevel > 0) {
      const send = ctx.createGain();
      send.gain.value = roomLevel;
      amp.connect(send).connect(out.room);
      nodes.push(send);
    }

    src.start(time);
    const naturalEnd = time + buffer.duration / rate;
    let endTime = naturalEnd;
    src.onended = () => {
      for (const n of nodes) n.disconnect();
    };

    return {
      get endTime() {
        return endTime;
      },
      release(at: number) {
        // Choke (e.g. closed hi-hat cutting an open hi-hat): 25 ms fade, then stop.
        if (at >= endTime) return;
        const t = Math.max(at, time);
        amp.gain.cancelScheduledValues(t);
        amp.gain.setValueAtTime(level, t);
        amp.gain.linearRampToValueAtTime(0, t + CHOKE_RAMP);
        try {
          src.stop(t + CHOKE_RAMP + 0.005);
        } catch {
          // Already stopped.
        }
        endTime = t + CHOKE_RAMP + 0.005;
      },
    };
  }
}

/**
 * Decodes a user-supplied sample (upload or mic recording) and removes leading silence below -48 dBFS.
 * Very long files are cut to 12 s, which is plenty for any single drum hit.
 */
export async function decodeUserSample(ctx: BaseAudioContext, data: ArrayBuffer): Promise<AudioBuffer> {
  // decodeAudioData detaches its input, so decode a copy and leave the stored bytes intact.
  const decoded = await decode(ctx, data.slice(0));
  const { buffer } = trimLeadingSilence(ctx, decoded);
  const maxLength = Math.floor(buffer.sampleRate * 12);
  if (buffer.length <= maxLength) return buffer;
  const cut = ctx.createBuffer(buffer.numberOfChannels, maxLength, buffer.sampleRate);
  for (let c = 0; c < buffer.numberOfChannels; c++) cut.getChannelData(c).set(buffer.getChannelData(c).subarray(0, maxLength));
  return cut;
}

/** App-wide sampler: one decode of the bundled kit, shared by every drum track. */
export const drumSampler = new DrumSampler();
