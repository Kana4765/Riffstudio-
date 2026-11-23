/** Master clock resolution shared by the scheduler, drum grid, alphaTex padding and MIDI export. */
export const PPQ = 480;

/** Supported tempo range (BPM) for the song tempo and per-bar tempo overrides. */
export const MIN_BPM = 30;
export const MAX_BPM = 300;

export function clampBpm(bpm: number): number {
  if (!Number.isFinite(bpm)) return 120;
  return Math.min(MAX_BPM, Math.max(MIN_BPM, Math.round(bpm)));
}

export type TimeSigNumerator = 2 | 3 | 4 | 5 | 6 | 7;
export type TimeSigDenominator = 4 | 8;
export type Duration = 1 | 2 | 4 | 8 | 16 | 32;

export const DURATIONS: readonly Duration[] = [1, 2, 4, 8, 16, 32];
export const NUMERATORS: readonly TimeSigNumerator[] = [2, 3, 4, 5, 6, 7];

export type InstrumentType = 'electric-guitar' | 'acoustic-guitar' | 'bass' | 'synth' | 'drums';
export type PitchedInstrumentType = Exclude<InstrumentType, 'drums'>;

export const DRUM_NOTES = [36, 38, 42, 46, 48, 45, 41, 49, 51, 52] as const;
export type DrumMidiNote = (typeof DRUM_NOTES)[number];

export interface Bar {
  index: number;
  numerator: TimeSigNumerator;
  denominator: TimeSigDenominator;
  /** Tempo (BPM) taking effect from this bar onwards until the next override. */
  tempoOverride?: number;
}

export interface TabNote {
  /** 1-based; 1 = highest string. */
  stringIndex: number;
  /** 0–24 */
  fret: number;
  palmMute: boolean;
  /** Hammer-on / pull-off from this note into the next note on the same string. */
  hammerOn: boolean;
  /** Full-step (2 semitone) bend. */
  bend: boolean;
  /** Legato slide from this note into the next note on the same string. */
  slide: boolean;
  /** Natural harmonic. */
  harmonic: boolean;
}

export interface TabBeat {
  id: string;
  barIndex: number;
  /** 0-based order of the beat inside its bar. */
  position: number;
  duration: Duration;
  dotted: boolean;
  tuplet?: 3;
  isRest: boolean;
  notes: TabNote[];
}

export interface DrumHit {
  id: string;
  barIndex: number;
  /** 480-PPQ tick offset from the start of the bar. */
  tickOffset: number;
  midiNote: DrumMidiNote;
  /** 1–127 */
  velocity: number;
}

export interface OverdriveSettings {
  enabled: boolean;
  drive: number;
  tone: number;
  level: number;
}

export interface DistortionSettings {
  enabled: boolean;
  gain: number;
  tone: number;
  level: number;
}

export interface FxChainSettings {
  preset: string;
  overdrive: OverdriveSettings;
  distortion: DistortionSettings;
}

interface TrackBase {
  id: string;
  name: string;
  color: string;
  /** 0–1 */
  volume: number;
  /** -1 (left) to +1 (right) */
  pan: number;
  muted: boolean;
  solo: boolean;
}

export interface PitchedTrack extends TrackBase {
  instrumentType: PitchedInstrumentType;
  /** MIDI pitches ordered from highest string to lowest string. */
  tuning: number[];
  tuningPreset: string;
  fxChain: FxChainSettings;
  beats: TabBeat[];
}

/** Built-in recorded kits shipped with the app. */
export type BuiltInDrumKitId = 'rock' | 'acoustic';
export const BUILT_IN_DRUM_KIT_IDS: readonly BuiltInDrumKitId[] = ['rock', 'acoustic'];
/** 'rock', 'acoustic', or the id of a user-created custom kit stored in IndexedDB. */
export type DrumKitId = string;

export function isBuiltInKit(id: string): id is BuiltInDrumKitId {
  return (BUILT_IN_DRUM_KIT_IDS as readonly string[]).includes(id);
}

export interface DrumTrack extends TrackBase {
  instrumentType: 'drums';
  /** Recorded sample kit used for playback: 'rock' (default), 'acoustic', or a custom kit id. */
  kit?: DrumKitId;
  /** Name of the selected custom kit (shown if the kit is missing on another device). */
  kitName?: string;
  /** Built-in kit a custom kit falls back to (also used for the MIDI drum-kit program). */
  kitBase?: BuiltInDrumKitId;
  hits: DrumHit[];
}

export type Track = PitchedTrack | DrumTrack;

export interface Song {
  id: string;
  title: string;
  artist: string;
  bpm: number;
  bars: Bar[];
  tracks: Track[];
}

export function isDrumTrack(track: Track): track is DrumTrack {
  return track.instrumentType === 'drums';
}

export function isPitchedTrack(track: Track): track is PitchedTrack {
  return track.instrumentType !== 'drums';
}
