import { createFxChain, findTuningPreset, type FxPresetName } from '../constants/presets';
import {
  clampBpm,
  type Bar,
  type DrumHit,
  type DrumMidiNote,
  type DrumTrack,
  type PitchedTrack,
  type Song,
  type TimeSigDenominator,
  type TimeSigNumerator,
} from '../types/song';
import { barTicks, uid } from '../utils/timing';
import { buildBeats, createDemoSong, type BeatSpec } from './demoSong';

export type TemplateId = 'full-band' | 'riff-sketchpad' | 'dual-harmony' | 'drum-groove';

export interface TemplateInfo {
  id: TemplateId;
  name: string;
  description: string;
  tracks: string[];
}

export const TEMPLATES: readonly TemplateInfo[] = [
  {
    id: 'full-band',
    name: 'Full Rock/Metal Band',
    description: 'The 5-track demo: double-tracked Drop-D rhythm guitars, a lead, bass and drums.',
    tracks: ['Rhythm L', 'Rhythm R', 'Lead', 'Bass', 'Drums'],
  },
  {
    id: 'riff-sketchpad',
    name: 'Riff Sketchpad',
    description: 'A Drop-D high-gain guitar and bass over a ready-made rock beat. Start writing riffs straight away.',
    tracks: ['Drop-D Guitar', 'Bass', 'Rock Drums'],
  },
  {
    id: 'dual-harmony',
    name: 'Dual Guitar Harmony',
    description: 'Two overdriven guitars, panned wide, playing a harmony in thirds, with bass and drums.',
    tracks: ['Guitar 1', 'Guitar 2', 'Bass', 'Rock Drums'],
  },
  {
    id: 'drum-groove',
    name: 'Drum Groove Builder',
    description: 'A standalone rock drum grid with a groove and a tom fill. Build beats on their own.',
    tracks: ['Rock Drums'],
  },
];

function makeBars(count: number, numerator: TimeSigNumerator = 4, denominator: TimeSigDenominator = 4): Bar[] {
  return Array.from({ length: count }, (_, index) => ({ index, numerator, denominator }));
}

function pitchedTrack(opts: {
  name: string;
  color: string;
  instrumentType: PitchedTrack['instrumentType'];
  tuning: string;
  preset: FxPresetName;
  pan?: number;
  volume?: number;
  line?: BeatSpec[][];
}): PitchedTrack {
  const tuning = findTuningPreset(opts.tuning);
  return {
    id: uid('trk'),
    name: opts.name,
    color: opts.color,
    instrumentType: opts.instrumentType,
    volume: opts.volume ?? 0.75,
    pan: opts.pan ?? 0,
    muted: false,
    solo: false,
    tuning: tuning ? [...tuning.pitches] : [64, 59, 55, 50, 45, 40],
    tuningPreset: opts.tuning,
    fxChain: createFxChain(opts.preset),
    beats: opts.line ? buildBeats(opts.line) : [],
  };
}

function drumTrack(hits: DrumHit[], name = 'Rock Drums'): DrumTrack {
  return { id: uid('trk'), name, color: '#f43f5e', instrumentType: 'drums', kit: 'rock', volume: 0.85, pan: 0, muted: false, solo: false, hits };
}

/**
 * Straight rock beat for any bar length: kick on 1 and the "and" of 3, snare on 2 and 4, closed hats on
 * eighths, a crash on bar 1, and an optional tom fill in the last bar.
 */
export function rockGroove(bars: Bar[], withFill = true): DrumHit[] {
  const hits: DrumHit[] = [];
  const add = (barIndex: number, tickOffset: number, midiNote: DrumMidiNote, velocity: number) =>
    hits.push({ id: uid('hit'), barIndex, tickOffset, midiNote, velocity });
  bars.forEach((bar, i) => {
    const length = barTicks(bar);
    const beat = bar.denominator === 8 ? 240 : 480;
    const isFillBar = withFill && i === bars.length - 1 && bars.length > 1;
    const fillStart = isFillBar ? Math.max(0, length - 480) : length;
    for (let t = 0; t < fillStart; t += 240) add(i, t, i === 0 && t === 0 ? 49 : 42, t % 480 === 0 ? 108 : 76);
    for (let t = 0; t < fillStart; t += beat) {
      const beatNo = Math.round(t / beat);
      if (bar.denominator === 4) {
        if (beatNo % 2 === 0) add(i, t, 36, beatNo === 0 ? 122 : 112);
        else add(i, t, 38, 120);
        if (beatNo === 2) add(i, t + 240, 36, 100);
      } else {
        // Compound / odd eighth-note meters: kick on group starts, snare on the middle of each 3-group.
        if (beatNo % 3 === 0) add(i, t, 36, 118);
        else if (beatNo % 3 === 2) add(i, t, 38, 118);
      }
    }
    if (isFillBar) {
      const toms: DrumMidiNote[] = [48, 48, 45, 41];
      toms.forEach((n, k) => add(i, fillStart + k * 120, n, 100 + k * 6));
    }
  });
  return hits;
}

function riffSketchpad(): Song {
  const bars = makeBars(4);
  return {
    id: uid('song'),
    title: 'Riff Sketch',
    artist: '',
    bpm: 120,
    bars,
    tracks: [
      pitchedTrack({ name: 'Drop-D Guitar', color: '#f97316', instrumentType: 'electric-guitar', tuning: '6-Str Drop D', preset: 'High-Gain Distortion', volume: 0.75 }),
      pitchedTrack({ name: 'Bass', color: '#a78bfa', instrumentType: 'bass', tuning: '4-Str Bass Drop D', preset: 'Bass Grit', volume: 0.8 }),
      drumTrack(rockGroove(bars)),
    ],
  };
}

function dualHarmony(): Song {
  const bars = makeBars(4);
  // Guitar 1 on the B string (E minor melody); Guitar 2 a diatonic third above on the high E string.
  const g1: BeatSpec[][] = [
    [{ d: 4, notes: [[2, 5]] }, { d: 8, notes: [[2, 7]] }, { d: 8, notes: [[2, 8]] }, { d: 4, notes: [[2, 10]] }, { d: 4, notes: [[2, 8]] }],
    [{ d: 4, dotted: true, notes: [[2, 7]] }, { d: 8, notes: [[2, 3]] }, { d: 2, notes: [[2, 5]] }],
    [{ d: 8, notes: [[2, 8]] }, { d: 8, notes: [[2, 10]] }, { d: 8, notes: [[2, 12]] }, { d: 8, notes: [[2, 10]] }, { d: 4, notes: [[2, 8]] }, { d: 4, notes: [[2, 7]] }],
    [{ d: 1, notes: [[2, 5]] }],
  ];
  const g2: BeatSpec[][] = [
    [{ d: 4, notes: [[1, 3]] }, { d: 8, notes: [[1, 5]] }, { d: 8, notes: [[1, 7]] }, { d: 4, notes: [[1, 8]] }, { d: 4, notes: [[1, 7]] }],
    [{ d: 4, dotted: true, notes: [[1, 5]] }, { d: 8, notes: [[1, 2]] }, { d: 2, notes: [[1, 3]] }],
    [{ d: 8, notes: [[1, 7]] }, { d: 8, notes: [[1, 8]] }, { d: 8, notes: [[1, 10]] }, { d: 8, notes: [[1, 8]] }, { d: 4, notes: [[1, 7]] }, { d: 4, notes: [[1, 5]] }],
    [{ d: 1, notes: [[1, 3]] }],
  ];
  const root = (s: number, f: number): BeatSpec[] => Array.from({ length: 8 }, () => ({ d: 8 as const, notes: [[s, f]] }));
  // E (s4 f0), D (s3 f5), G (s4 f3), E (s4 f0) on a standard 4-string bass.
  const bass: BeatSpec[][] = [root(4, 0), root(3, 5), root(4, 3), root(4, 0)];
  return {
    id: uid('song'),
    title: 'Twin Harmony',
    artist: '',
    bpm: 128,
    bars,
    tracks: [
      pitchedTrack({ name: 'Guitar 1', color: '#38bdf8', instrumentType: 'electric-guitar', tuning: '6-Str Standard E', preset: 'Warm Overdrive', pan: -0.6, volume: 0.7, line: g1 }),
      pitchedTrack({ name: 'Guitar 2', color: '#22d3ee', instrumentType: 'electric-guitar', tuning: '6-Str Standard E', preset: 'Warm Overdrive', pan: 0.6, volume: 0.66, line: g2 }),
      pitchedTrack({ name: 'Bass', color: '#a78bfa', instrumentType: 'bass', tuning: '4-Str Bass Standard', preset: 'Bass Grit', volume: 0.78, line: bass }),
      drumTrack(rockGroove(bars)),
    ],
  };
}

function drumGroove(): Song {
  const bars = makeBars(4);
  return { id: uid('song'), title: 'Drum Groove', artist: '', bpm: 110, bars, tracks: [drumTrack(rockGroove(bars))] };
}

export function createTemplate(id: TemplateId): Song {
  switch (id) {
    case 'full-band':
      return createDemoSong();
    case 'riff-sketchpad':
      return riffSketchpad();
    case 'dual-harmony':
      return dualHarmony();
    case 'drum-groove':
      return drumGroove();
  }
}

export interface NewProjectOptions {
  title: string;
  bpm: number;
  numerator: TimeSigNumerator;
  denominator: TimeSigDenominator;
}

/** Empty 8-bar project with a guitar, bass and an empty drum grid in the chosen meter. */
export function createBlankProject(opts: NewProjectOptions): Song {
  const bars = makeBars(8, opts.numerator, opts.denominator);
  return {
    id: uid('song'),
    title: opts.title.trim() || 'Untitled',
    artist: '',
    bpm: clampBpm(opts.bpm),
    bars,
    tracks: [
      pitchedTrack({ name: 'Electric Guitar', color: '#f97316', instrumentType: 'electric-guitar', tuning: '6-Str Standard E', preset: 'Crunch Rock' }),
      pitchedTrack({ name: 'Bass', color: '#a78bfa', instrumentType: 'bass', tuning: '4-Str Bass Standard', preset: 'Bass Grit', volume: 0.8 }),
      drumTrack([], 'Drums'),
    ],
  };
}
