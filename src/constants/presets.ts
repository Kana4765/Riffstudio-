import type { DrumMidiNote, FxChainSettings, InstrumentType, PitchedInstrumentType } from '../types/song';

export interface TuningPreset {
  name: string;
  /** MIDI pitches, highest string first. */
  pitches: number[];
  kind: 'guitar' | 'bass';
}

export const TUNING_PRESETS: readonly TuningPreset[] = [
  { name: '6-Str Standard E', pitches: [64, 59, 55, 50, 45, 40], kind: 'guitar' },
  { name: '6-Str Drop D', pitches: [64, 59, 55, 50, 45, 38], kind: 'guitar' },
  { name: '6-Str Drop C', pitches: [62, 57, 53, 48, 43, 36], kind: 'guitar' },
  { name: '6-Str Drop B', pitches: [61, 56, 52, 47, 42, 35], kind: 'guitar' },
  { name: '7-Str Standard B', pitches: [64, 59, 55, 50, 45, 40, 35], kind: 'guitar' },
  { name: '7-Str Drop A', pitches: [64, 59, 55, 50, 45, 40, 33], kind: 'guitar' },
  { name: '4-Str Bass Standard', pitches: [43, 38, 33, 28], kind: 'bass' },
  { name: '4-Str Bass Drop D', pitches: [43, 38, 33, 26], kind: 'bass' },
  { name: '5-Str Bass Standard', pitches: [43, 38, 33, 28, 23], kind: 'bass' },
];

export function findTuningPreset(name: string): TuningPreset | undefined {
  return TUNING_PRESETS.find((p) => p.name === name);
}

export function tuningPresetsFor(instrument: PitchedInstrumentType): TuningPreset[] {
  const kind = instrument === 'bass' ? 'bass' : 'guitar';
  return TUNING_PRESETS.filter((p) => p.kind === kind);
}

export const FX_PRESET_NAMES = ['Clean', 'Warm Overdrive', 'Crunch Rock', 'High-Gain Distortion', 'Bass Grit'] as const;
export type FxPresetName = (typeof FX_PRESET_NAMES)[number];
export const CUSTOM_PRESET = 'Custom';

const FX_PRESETS: Record<FxPresetName, Omit<FxChainSettings, 'preset'>> = {
  Clean: {
    overdrive: { enabled: false, drive: 20, tone: 55, level: 70 },
    distortion: { enabled: false, gain: 40, tone: 50, level: 55 },
  },
  'Warm Overdrive': {
    overdrive: { enabled: true, drive: 58, tone: 52, level: 68 },
    distortion: { enabled: false, gain: 40, tone: 50, level: 55 },
  },
  'Crunch Rock': {
    overdrive: { enabled: true, drive: 35, tone: 62, level: 62 },
    distortion: { enabled: true, gain: 38, tone: 58, level: 58 },
  },
  'High-Gain Distortion': {
    overdrive: { enabled: true, drive: 18, tone: 72, level: 72 },
    distortion: { enabled: true, gain: 82, tone: 48, level: 56 },
  },
  'Bass Grit': {
    overdrive: { enabled: true, drive: 42, tone: 35, level: 72 },
    distortion: { enabled: false, gain: 30, tone: 40, level: 55 },
  },
};

export function createFxChain(preset: FxPresetName): FxChainSettings {
  const p = FX_PRESETS[preset];
  return { preset, overdrive: { ...p.overdrive }, distortion: { ...p.distortion } };
}

export function isFxPresetName(name: string): name is FxPresetName {
  return (FX_PRESET_NAMES as readonly string[]).includes(name);
}

export interface DrumVoiceInfo {
  note: DrumMidiNote;
  name: string;
  short: string;
}

/** Display order for the drum grid (cymbals on top, kick at the bottom). */
export const DRUM_VOICES: readonly DrumVoiceInfo[] = [
  { note: 49, name: 'Crash', short: 'CR' },
  { note: 52, name: 'China', short: 'CH' },
  { note: 51, name: 'Ride', short: 'RD' },
  { note: 46, name: 'Open Hat', short: 'OH' },
  { note: 42, name: 'Closed Hat', short: 'HH' },
  { note: 48, name: 'High Tom', short: 'T1' },
  { note: 45, name: 'Mid Tom', short: 'T2' },
  { note: 41, name: 'Floor Tom', short: 'FT' },
  { note: 38, name: 'Snare', short: 'SN' },
  { note: 36, name: 'Kick', short: 'KD' },
];

export interface InstrumentOption {
  type: InstrumentType;
  label: string;
  defaultTuning: string;
  defaultPreset: FxPresetName;
  defaultColor: string;
}

export const INSTRUMENT_OPTIONS: readonly InstrumentOption[] = [
  { type: 'electric-guitar', label: 'Electric Guitar', defaultTuning: '6-Str Standard E', defaultPreset: 'Crunch Rock', defaultColor: '#f97316' },
  { type: 'acoustic-guitar', label: 'Acoustic Guitar', defaultTuning: '6-Str Standard E', defaultPreset: 'Clean', defaultColor: '#facc15' },
  { type: 'bass', label: 'Bass', defaultTuning: '4-Str Bass Standard', defaultPreset: 'Bass Grit', defaultColor: '#a78bfa' },
  { type: 'synth', label: 'Synth/Keys', defaultTuning: '6-Str Standard E', defaultPreset: 'Clean', defaultColor: '#34d399' },
  { type: 'drums', label: 'MIDI Drums', defaultTuning: '', defaultPreset: 'Clean', defaultColor: '#f43f5e' },
];

export const TRACK_COLORS: readonly string[] = [
  '#f97316', '#eab308', '#38bdf8', '#a78bfa', '#f43f5e', '#34d399', '#fb7185', '#22d3ee', '#c084fc', '#84cc16',
];

export const TIME_SIGNATURE_OPTIONS = [
  { label: '4/4', numerator: 4, denominator: 4 },
  { label: '3/4', numerator: 3, denominator: 4 },
  { label: '5/4', numerator: 5, denominator: 4 },
  { label: '6/8', numerator: 6, denominator: 8 },
  { label: '7/8', numerator: 7, denominator: 8 },
] as const;
