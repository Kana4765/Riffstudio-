import {
  CUSTOM_PRESET,
  createFxChain,
  findTuningPreset,
  isFxPresetName,
  type FxPresetName,
} from '../constants/presets';
import {
  DRUM_NOTES,
  DURATIONS,
  MAX_BPM,
  isBuiltInKit,
  MIN_BPM,
  DENOMINATORS,
  MAX_NUMERATOR,
  type Bar,
  type DrumHit,
  type DrumMidiNote,
  type DrumTrack,
  type Duration,
  type FxChainSettings,
  type InstrumentType,
  type PitchedInstrumentType,
  type PitchedTrack,
  type Song,
  type TabBeat,
  type TabNote,
  type TimeSigDenominator,
  type TimeSigNumerator,
  type Track,
} from '../types/song';
import { barTicks, clamp, uid } from './timing';

export interface NewTrackOptions {
  instrumentType: InstrumentType;
  name: string;
  color: string;
  tuningPreset: string;
  fxPreset: FxPresetName;
}

export function createTrack(opts: NewTrackOptions): Track {
  const base = { id: uid('trk'), name: opts.name, color: opts.color, volume: 0.8, pan: 0, muted: false, solo: false };
  if (opts.instrumentType === 'drums') {
    const drum: DrumTrack = { ...base, instrumentType: 'drums', kit: 'rock', hits: [] };
    return drum;
  }
  const preset =
    findTuningPreset(opts.tuningPreset) ??
    findTuningPreset(opts.instrumentType === 'bass' ? '4-Str Bass Standard' : '6-Str Standard E');
  const pitched: PitchedTrack = {
    ...base,
    instrumentType: opts.instrumentType,
    tuning: preset ? [...preset.pitches] : [64, 59, 55, 50, 45, 40],
    tuningPreset: preset?.name ?? '6-Str Standard E',
    fxChain: createFxChain(opts.fxPreset),
    beats: [],
  };
  return pitched;
}

export function reindexBars(bars: Bar[]): Bar[] {
  return bars.map((b, i) => ({ ...b, index: i }));
}

/** Inserts a bar after `afterIndex`, copying its time signature, and shifts later content. */
export function addBarAfter(song: Song, afterIndex: number): Song {
  const source = song.bars[afterIndex] ?? song.bars[song.bars.length - 1];
  const insertAt = Math.min(afterIndex + 1, song.bars.length);
  const newBar: Bar = { index: insertAt, numerator: source?.numerator ?? 4, denominator: source?.denominator ?? 4 };
  const bars = reindexBars([...song.bars.slice(0, insertAt), newBar, ...song.bars.slice(insertAt)]);
  const tracks = song.tracks.map((t): Track => {
    if (t.instrumentType === 'drums') {
      return { ...t, hits: t.hits.map((h) => (h.barIndex >= insertAt ? { ...h, barIndex: h.barIndex + 1 } : h)) };
    }
    return { ...t, beats: t.beats.map((b) => (b.barIndex >= insertAt ? { ...b, barIndex: b.barIndex + 1 } : b)) };
  });
  return { ...song, bars, tracks };
}

/** Removes a bar and everything in it; the song always keeps at least one bar. */
export function deleteBar(song: Song, barIndex: number): Song {
  if (song.bars.length <= 1) {
    const tracks = song.tracks.map((t): Track =>
      t.instrumentType === 'drums' ? { ...t, hits: [] } : { ...t, beats: [] },
    );
    return { ...song, tracks };
  }
  const bars = reindexBars(song.bars.filter((b) => b.index !== barIndex));
  const tracks = song.tracks.map((t): Track => {
    if (t.instrumentType === 'drums') {
      return {
        ...t,
        hits: t.hits
          .filter((h) => h.barIndex !== barIndex)
          .map((h) => (h.barIndex > barIndex ? { ...h, barIndex: h.barIndex - 1 } : h)),
      };
    }
    return {
      ...t,
      beats: t.beats
        .filter((b) => b.barIndex !== barIndex)
        .map((b) => (b.barIndex > barIndex ? { ...b, barIndex: b.barIndex - 1 } : b)),
    };
  });
  return { ...song, bars, tracks };
}

export function setBarTimeSignature(
  song: Song,
  barIndex: number,
  numerator: TimeSigNumerator,
  denominator: TimeSigDenominator,
): Song {
  const bars = song.bars.map((b) => (b.index === barIndex ? { ...b, numerator, denominator } : b));
  const length = barTicks({ numerator, denominator });
  const tracks = song.tracks.map((t): Track =>
    t.instrumentType === 'drums'
      ? { ...t, hits: t.hits.filter((h) => h.barIndex !== barIndex || h.tickOffset < length) }
      : t,
  );
  return { ...song, bars, tracks };
}

/** Inserts a deep copy of a track right after it. `newId` is supplied by the caller so it can select the copy. */
export function duplicateTrack(song: Song, trackId: string, newId: string): Song {
  const idx = song.tracks.findIndex((t) => t.id === trackId);
  if (idx < 0) return song;
  const src = song.tracks[idx];
  let copy: Track;
  if (src.instrumentType === 'drums') {
    copy = { ...src, id: newId, name: `${src.name} (copy)`, solo: false, hits: src.hits.map((h) => ({ ...h, id: uid('hit') })) };
  } else {
    copy = {
      ...src,
      id: newId,
      name: `${src.name} (copy)`,
      solo: false,
      tuning: [...src.tuning],
      fxChain: {
        preset: src.fxChain.preset,
        overdrive: { ...src.fxChain.overdrive },
        distortion: { ...src.fxChain.distortion },
      },
      beats: src.beats.map((b) => ({ ...b, id: uid('beat'), notes: b.notes.map((n) => ({ ...n })) })),
    };
  }
  const tracks = [...song.tracks.slice(0, idx + 1), copy, ...song.tracks.slice(idx + 1)];
  return { ...song, tracks };
}

export function updateTrack(song: Song, trackId: string, updater: (t: Track) => Track): Song {
  return { ...song, tracks: song.tracks.map((t) => (t.id === trackId ? updater(t) : t)) };
}

/** Changes tuning; notes on strings that no longer exist are dropped. */
export function applyTuning(track: PitchedTrack, presetName: string): PitchedTrack {
  const preset = findTuningPreset(presetName);
  if (!preset) return track;
  const strings = preset.pitches.length;
  return {
    ...track,
    tuning: [...preset.pitches],
    tuningPreset: preset.name,
    beats: track.beats.map((b) => ({ ...b, notes: b.notes.filter((n) => n.stringIndex <= strings) })),
  };
}

export function applyFxPreset(track: PitchedTrack, presetName: string): PitchedTrack {
  if (!isFxPresetName(presetName)) return { ...track, fxChain: { ...track.fxChain, preset: CUSTOM_PRESET } };
  return { ...track, fxChain: createFxChain(presetName) };
}

// ---------------------------------------------------------------------------------------------
// JSON validation / normalisation for loaded project files
// ---------------------------------------------------------------------------------------------

type Rec = Record<string, unknown>;

function isRec(v: unknown): v is Rec {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function num(v: unknown, fallback: number, min: number, max: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? clamp(v, min, max) : fallback;
}

function str(v: unknown, fallback: string): string {
  return typeof v === 'string' ? v : fallback;
}

function bool(v: unknown): boolean {
  return v === true;
}

function normalizeBar(v: unknown, index: number): Bar {
  const r = isRec(v) ? v : {};
  const rawNum = typeof r.numerator === 'number' ? Math.round(r.numerator) : 4;
  const numerator: TimeSigNumerator = rawNum >= 1 && rawNum <= MAX_NUMERATOR ? rawNum : 4;
  const denominator: TimeSigDenominator = (DENOMINATORS as readonly number[]).includes(r.denominator as number)
    ? (r.denominator as TimeSigDenominator)
    : 4;
  const bar: Bar = { index, numerator, denominator };
  if (typeof r.tempoOverride === 'number' && r.tempoOverride >= MIN_BPM && r.tempoOverride <= MAX_BPM) {
    bar.tempoOverride = r.tempoOverride;
  }
  return bar;
}

function normalizeNote(v: unknown, strings: number): TabNote | null {
  if (!isRec(v)) return null;
  const stringIndex = Math.round(num(v.stringIndex, 0, 0, 12));
  if (stringIndex < 1 || stringIndex > strings) return null;
  return {
    stringIndex,
    fret: Math.round(num(v.fret, 0, 0, 24)),
    palmMute: bool(v.palmMute),
    hammerOn: bool(v.hammerOn),
    bend: bool(v.bend),
    slide: bool(v.slide),
    harmonic: bool(v.harmonic),
    ...(v.tied === true ? { tied: true } : {}),
  };
}

function normalizeBeat(v: unknown, strings: number, barCount: number): TabBeat | null {
  if (!isRec(v)) return null;
  const barIndex = Math.round(num(v.barIndex, -1, -1, 100000));
  if (barIndex < 0 || barIndex >= barCount) return null;
  const duration = (DURATIONS as readonly number[]).includes(v.duration as number) ? (v.duration as Duration) : 4;
  const notes = Array.isArray(v.notes)
    ? v.notes.map((n) => normalizeNote(n, strings)).filter((n): n is TabNote => n !== null)
    : [];
  const beat: TabBeat = {
    id: str(v.id, uid('beat')),
    barIndex,
    position: Math.round(num(v.position, 0, 0, 1000)),
    duration,
    dotted: bool(v.dotted),
    isRest: bool(v.isRest),
    notes,
  };
  if (v.tuplet === 3) beat.tuplet = 3;
  return beat;
}

function normalizeFx(v: unknown): FxChainSettings {
  const base = createFxChain('Clean');
  if (!isRec(v)) return base;
  const od = isRec(v.overdrive) ? v.overdrive : {};
  const ds = isRec(v.distortion) ? v.distortion : {};
  return {
    preset: str(v.preset, CUSTOM_PRESET),
    overdrive: {
      enabled: bool(od.enabled),
      drive: num(od.drive, base.overdrive.drive, 0, 100),
      tone: num(od.tone, base.overdrive.tone, 0, 100),
      level: num(od.level, base.overdrive.level, 0, 100),
    },
    distortion: {
      enabled: bool(ds.enabled),
      gain: num(ds.gain, base.distortion.gain, 0, 100),
      tone: num(ds.tone, base.distortion.tone, 0, 100),
      level: num(ds.level, base.distortion.level, 0, 100),
    },
  };
}

function normalizeHit(v: unknown, bars: Bar[]): DrumHit | null {
  if (!isRec(v)) return null;
  const barIndex = Math.round(num(v.barIndex, -1, -1, 100000));
  const bar = bars[barIndex];
  if (!bar) return null;
  const tickOffset = Math.round(num(v.tickOffset, -1, -1, 100000));
  if (tickOffset < 0 || tickOffset >= barTicks(bar)) return null;
  const midiNote = v.midiNote as number;
  if (!(DRUM_NOTES as readonly number[]).includes(midiNote)) return null;
  return {
    id: str(v.id, uid('hit')),
    barIndex,
    tickOffset,
    midiNote: midiNote as DrumMidiNote,
    velocity: Math.round(num(v.velocity, 100, 1, 127)),
  };
}

const INSTRUMENTS: readonly InstrumentType[] = ['electric-guitar', 'acoustic-guitar', 'bass', 'synth', 'drums'];

function normalizeTrack(v: unknown, bars: Bar[], index: number): Track | null {
  if (!isRec(v)) return null;
  const instrumentType = INSTRUMENTS.includes(v.instrumentType as InstrumentType)
    ? (v.instrumentType as InstrumentType)
    : null;
  if (!instrumentType) return null;
  const base = {
    id: str(v.id, uid('trk')),
    name: str(v.name, `Track ${index + 1}`),
    color: /^#[0-9a-fA-F]{6}$/.test(str(v.color, '')) ? str(v.color, '#f97316') : '#f97316',
    volume: num(v.volume, 0.8, 0, 1),
    pan: num(v.pan, 0, -1, 1),
    muted: bool(v.muted),
    solo: bool(v.solo),
  };
  if (instrumentType === 'drums') {
    const hits = Array.isArray(v.hits) ? v.hits.map((h) => normalizeHit(h, bars)).filter((h): h is DrumHit => h !== null) : [];
    // 'studio' was the pre-1.2 name of the acoustic kit.
    const rawKit = typeof v.kit === 'string' && v.kit.trim() ? (v.kit === 'studio' ? 'acoustic' : v.kit.slice(0, 80)) : 'rock';
    const drum: DrumTrack = { ...base, instrumentType: 'drums', kit: rawKit, hits };
    if (!isBuiltInKit(rawKit)) {
      if (typeof v.kitName === 'string') drum.kitName = v.kitName.slice(0, 80);
      drum.kitBase = v.kitBase === 'acoustic' ? 'acoustic' : 'rock';
    }
    return drum;
  }
  const pitchedType: PitchedInstrumentType = instrumentType;
  const tuning = Array.isArray(v.tuning)
    ? v.tuning.filter((p): p is number => typeof p === 'number' && p >= 0 && p <= 127).map((p) => Math.round(p))
    : [];
  const safeTuning = tuning.length >= 4 && tuning.length <= 8 ? tuning : [64, 59, 55, 50, 45, 40];
  const beats = Array.isArray(v.beats)
    ? v.beats.map((b) => normalizeBeat(b, safeTuning.length, bars.length)).filter((b): b is TabBeat => b !== null)
    : [];
  return {
    ...base,
    instrumentType: pitchedType,
    tuning: safeTuning,
    tuningPreset: str(v.tuningPreset, 'Custom'),
    fxChain: normalizeFx(v.fxChain),
    beats: renumberAllPositions(beats),
  };
}

/** Re-numbers beat positions to 0..n-1 per bar, preserving order. */
export function renumberAllPositions(beats: TabBeat[]): TabBeat[] {
  const byBar = new Map<number, TabBeat[]>();
  for (const b of beats) {
    const list = byBar.get(b.barIndex) ?? [];
    list.push(b);
    byBar.set(b.barIndex, list);
  }
  const out: TabBeat[] = [];
  for (const [, list] of [...byBar.entries()].sort((a, b) => a[0] - b[0])) {
    list.sort((a, b) => a.position - b.position).forEach((b, i) => out.push({ ...b, position: i }));
  }
  return out;
}

/** Validates arbitrary JSON and converts it into a safe Song, throwing on unusable input. */
export function normalizeSong(input: unknown): Song {
  if (!isRec(input)) throw new Error('File is not a RiffForge song (expected a JSON object).');
  const rawBars = Array.isArray(input.bars) ? input.bars : [];
  if (rawBars.length === 0) throw new Error('Song has no bars.');
  const bars = rawBars.slice(0, 2000).map((b, i) => normalizeBar(b, i));
  const rawTracks = Array.isArray(input.tracks) ? input.tracks : [];
  const tracks = rawTracks.map((t, i) => normalizeTrack(t, bars, i)).filter((t): t is Track => t !== null);
  if (tracks.length === 0) throw new Error('Song has no valid tracks.');
  return {
    id: str(input.id, uid('song')),
    title: str(input.title, 'Untitled'),
    artist: str(input.artist, ''),
    bpm: Math.round(num(input.bpm, 120, MIN_BPM, MAX_BPM)),
    bars,
    tracks,
  };
}
