import { createFxChain, findTuningPreset } from '../constants/presets';
import type { DrumHit, DrumMidiNote, DrumTrack, Duration, PitchedTrack, Song, TabBeat, TabNote } from '../types/song';
import { uid } from '../utils/timing';

export type NoteSpec = [stringIndex: number, fret: number, flags?: Partial<Omit<TabNote, 'stringIndex' | 'fret'>>];

export interface BeatSpec {
  d: Duration;
  notes?: NoteSpec[];
  dotted?: boolean;
  rest?: boolean;
}

/** Expands compact per-bar beat specs into TabBeats. */
export function buildBeats(bars: BeatSpec[][]): TabBeat[] {
  const out: TabBeat[] = [];
  bars.forEach((bar, barIndex) => {
    bar.forEach((spec, position) => {
      out.push({
        id: uid('beat'),
        barIndex,
        position,
        duration: spec.d,
        dotted: spec.dotted ?? false,
        isRest: spec.rest ?? false,
        notes: (spec.notes ?? []).map(([stringIndex, fret, flags]) => ({
          stringIndex,
          fret,
          palmMute: flags?.palmMute ?? false,
          hammerOn: flags?.hammerOn ?? false,
          bend: flags?.bend ?? false,
          slide: flags?.slide ?? false,
          harmonic: flags?.harmonic ?? false,
        })),
      });
    });
  });
  return out;
}

// --- Rhythm guitar riff in Drop D (string 6 = D2, power chords = same fret on strings 6/5/4) ---
const chug = (d: Duration = 8): BeatSpec => ({ d, notes: [[6, 0, { palmMute: true }]] });
const pc = (fret: number, d: Duration = 8, dotted = false): BeatSpec => ({
  d,
  dotted,
  notes: [
    [6, fret],
    [5, fret],
    [4, fret],
  ],
});

const RHYTHM_RIFF: BeatSpec[][] = [
  [chug(), chug(), pc(5), chug(), chug(), pc(3), chug(), pc(1)],
  [chug(), chug(), pc(5), chug(), chug(), pc(7), pc(8, 4)],
  [chug(), chug(), pc(5), chug(), chug(), pc(3), chug(), pc(1)],
  [pc(5, 4), pc(3, 4), chug(16), chug(16), chug(16), chug(16), pc(0, 4)],
];

// --- Bass in 4-string Drop D (string 4 = D1), locked to the guitar roots and the kick ---
const broot = (fret: number, d: Duration = 8): BeatSpec => ({ d, notes: [[4, fret]] });
const BASS_LINE: BeatSpec[][] = [
  [broot(0), broot(0), broot(5), broot(0), broot(0), broot(3), broot(0), broot(1)],
  [broot(0), broot(0), broot(5), broot(0), broot(0), broot(7), broot(8, 4)],
  [broot(0), broot(0), broot(5), broot(0), broot(0), broot(3), broot(0), broot(1)],
  [broot(5, 4), broot(3, 4), broot(0, 16), broot(0, 16), broot(0, 16), broot(0, 16), broot(0, 4)],
];

// --- Lead line in standard E (D minor melody over the riff) ---
const LEAD_LINE: BeatSpec[][] = [
  [
    { d: 4, notes: [[2, 10]] },
    { d: 8, notes: [[2, 13, { bend: true }]] },
    { d: 8, notes: [[2, 13]] },
    { d: 2, notes: [[1, 10]] },
  ],
  [
    { d: 8, notes: [[1, 8, { slide: true }]] },
    { d: 8, notes: [[1, 10]] },
    { d: 4, notes: [[1, 8]] },
    { d: 8, notes: [[2, 13]] },
    { d: 8, notes: [[2, 10]] },
    { d: 4, notes: [[2, 13, { bend: true }]] },
  ],
  [
    { d: 4, dotted: true, notes: [[2, 10]] },
    { d: 8, notes: [[2, 11]] },
    { d: 8, notes: [[2, 10, { hammerOn: true }]] },
    { d: 8, notes: [[2, 13]] },
    { d: 4, notes: [[2, 10]] },
  ],
  [
    { d: 8, notes: [[3, 12, { hammerOn: true }]] },
    { d: 8, notes: [[3, 14, { slide: true }]] },
    { d: 4, notes: [[3, 17]] },
    { d: 2, notes: [[4, 12, { harmonic: true }]] },
  ],
];

function drumHits(): DrumHit[] {
  const hits: DrumHit[] = [];
  const add = (barIndex: number, tickOffset: number, midiNote: DrumMidiNote, velocity: number) =>
    hits.push({ id: uid('hit'), barIndex, tickOffset, midiNote, velocity });
  for (let bar = 0; bar < 4; bar++) {
    // Hi-hat eighths with accents on the beat; open hat on the "and" of 4 in bars 2 and 4.
    for (let i = 0; i < 8; i++) {
      const tick = i * 240;
      if ((bar === 1 || bar === 3) && i === 7) add(bar, tick, 46, 96);
      else if (!(bar === 0 && i === 0) && !(bar === 2 && i === 0)) add(bar, tick, 42, i % 2 === 0 ? 104 : 72);
    }
    // Snare backbeat.
    add(bar, 480, 38, 118);
    add(bar, 1440, 38, 122);
  }
  // Crash accents on the downbeats of bars 1 and 3.
  add(0, 0, 49, 120);
  add(2, 0, 49, 116);
  // Kick locked to the chugs / chord stabs.
  const riffKicks = [0, 240, 480, 720, 960, 1200, 1440, 1680];
  for (const bar of [0, 2]) for (const t of riffKicks) add(bar, t, 36, t % 480 === 0 ? 120 : 100);
  for (const t of [0, 240, 480, 720, 960, 1200, 1440]) add(1, t, 36, t % 480 === 0 ? 120 : 100);
  // Bar 4: quarter stabs then a sixteenth-note gallop into the final hit.
  for (const t of [0, 480, 960, 1080, 1200, 1320, 1440]) add(3, t, 36, t % 480 === 0 ? 122 : 96);
  add(3, 1440, 49, 110);
  add(3, 1200, 45, 90);
  add(3, 1320, 41, 100);
  return hits;
}

function pitched(
  name: string,
  color: string,
  instrumentType: PitchedTrack['instrumentType'],
  tuningName: string,
  preset: Parameters<typeof createFxChain>[0],
  pan: number,
  volume: number,
  line: BeatSpec[][],
): PitchedTrack {
  const tuning = findTuningPreset(tuningName);
  return {
    id: uid('trk'),
    name,
    color,
    instrumentType,
    volume,
    pan,
    muted: false,
    solo: false,
    tuning: tuning ? [...tuning.pitches] : [64, 59, 55, 50, 45, 40],
    tuningPreset: tuningName,
    fxChain: createFxChain(preset),
    beats: buildBeats(line),
  };
}

export function createDemoSong(): Song {
  const drums: DrumTrack = {
    id: uid('trk'),
    name: 'Drums',
    color: '#f43f5e',
    instrumentType: 'drums',
    kit: 'rock',
    volume: 0.85,
    pan: 0,
    muted: false,
    solo: false,
    hits: drumHits(),
  };
  return {
    id: uid('song'),
    title: 'Forge Of Iron',
    artist: 'RiffForge Demo',
    bpm: 140,
    bars: [0, 1, 2, 3].map((index) => ({ index, numerator: 4, denominator: 4 })),
    tracks: [
      pitched('Rhythm Guitar L', '#f97316', 'electric-guitar', '6-Str Drop D', 'High-Gain Distortion', -0.75, 0.72, RHYTHM_RIFF),
      pitched('Rhythm Guitar R', '#eab308', 'electric-guitar', '6-Str Drop D', 'High-Gain Distortion', 0.75, 0.72, RHYTHM_RIFF),
      pitched('Lead Guitar', '#38bdf8', 'electric-guitar', '6-Str Standard E', 'Warm Overdrive', 0, 0.68, LEAD_LINE),
      pitched('Bass Guitar', '#a78bfa', 'bass', '4-Str Bass Drop D', 'Bass Grit', 0, 0.8, BASS_LINE),
      drums,
    ],
  };
}
