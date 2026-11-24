import { PPQ, type Bar, type Duration, type PitchedTrack, type Song, type TabBeat, type TabNote } from '../types/song';

/** Length of a bar in 480-PPQ ticks. */
export function barTicks(bar: Pick<Bar, 'numerator' | 'denominator'>): number {
  return Math.round((bar.numerator * PPQ * 4) / bar.denominator);
}

/** Length of a single beat in ticks, including dotted and triplet modifiers. */
export function beatTicks(beat: Pick<TabBeat, 'duration' | 'dotted' | 'tuplet'>): number {
  let ticks = (PPQ * 4) / beat.duration;
  if (beat.dotted) ticks *= 1.5;
  if (beat.tuplet === 3) ticks = (ticks * 2) / 3;
  return Math.round(ticks);
}

/** Tempo in effect for a bar: the latest override at or before it, otherwise the song tempo. */
export function getBarTempo(song: Pick<Song, 'bpm' | 'bars'>, barIndex: number): number {
  for (let i = Math.min(barIndex, song.bars.length - 1); i >= 0; i--) {
    const override = song.bars[i]?.tempoOverride;
    if (override !== undefined && override > 0) return override;
  }
  return song.bpm;
}

export interface LaidOutBeat {
  beat: TabBeat;
  startTick: number;
  ticks: number;
  /** False when the beat starts or ends beyond the end of the bar (overflow). */
  fits: boolean;
}

export interface BarLayout {
  beats: LaidOutBeat[];
  totalTicks: number;
  usedTicks: number;
  overflowTicks: number;
}

/** Beats of one bar sorted by position. */
export function beatsInBar(track: PitchedTrack, barIndex: number): TabBeat[] {
  return track.beats.filter((b) => b.barIndex === barIndex).sort((a, b) => a.position - b.position);
}

export function layoutBar(track: PitchedTrack, bar: Bar): BarLayout {
  const total = barTicks(bar);
  let cursor = 0;
  const beats = beatsInBar(track, bar.index).map((beat) => {
    const ticks = beatTicks(beat);
    const laid: LaidOutBeat = { beat, startTick: cursor, ticks, fits: cursor + ticks <= total };
    cursor += ticks;
    return laid;
  });
  return { beats, totalTicks: total, usedTicks: Math.min(cursor, total), overflowTicks: Math.max(0, cursor - total) };
}

/** Absolute start tick of every bar plus the total song length. */
export function barStartTicks(bars: Bar[]): { starts: number[]; total: number } {
  const starts: number[] = [];
  let acc = 0;
  for (const bar of bars) {
    starts.push(acc);
    acc += barTicks(bar);
  }
  return { starts, total: acc };
}

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;

export function midiToNoteName(midi: number): string {
  const name = NOTE_NAMES[((midi % 12) + 12) % 12];
  const octave = Math.floor(midi / 12) - 1;
  return `${name}${octave}`;
}

export function midiToFrequency(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

/** Sounding MIDI pitch of a fretted note (harmonics are handled separately by the synth). */
export function notePitch(track: PitchedTrack, note: Pick<TabNote, 'stringIndex' | 'fret'>): number {
  const open = track.tuning[note.stringIndex - 1] ?? track.tuning[track.tuning.length - 1] ?? 40;
  return open + note.fret;
}

/** Pitch multiple produced by touching a string at the given fret (natural harmonic nodes). */
export function harmonicMultiplier(fret: number): number {
  switch (fret) {
    case 12:
      return 2;
    case 7:
    case 19:
      return 3;
    case 5:
    case 24:
      return 4;
    case 4:
    case 9:
    case 16:
      return 5;
    case 3:
      return 6;
    default:
      return 2;
  }
}

/** Sounding pitch of a natural harmonic, expressed as a (possibly fractional) MIDI pitch. */
export function harmonicPitch(track: PitchedTrack, note: Pick<TabNote, 'stringIndex' | 'fret'>): number {
  const open = track.tuning[note.stringIndex - 1] ?? 40;
  const mult = harmonicMultiplier(note.fret);
  if ([12, 7, 19, 5, 24, 4, 9, 16, 3].includes(note.fret)) {
    return open + 12 * Math.log2(mult);
  }
  return open + note.fret + 12;
}

let uidCounter = 0;
export function uid(prefix = 'id'): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return `${prefix}-${c.randomUUID().slice(0, 13)}`;
  uidCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${uidCounter.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export const DURATION_LABELS: Record<Duration, string> = {
  1: '1/1',
  2: '1/2',
  4: '1/4',
  8: '1/8',
  16: '1/16',
  32: '1/32',
};

const tieCache = new WeakMap<PitchedTrack, { bars: Bar[]; map: Map<string, number> }>();

/**
 * For every note that starts a tie chain, the extra ticks it sustains through the following tied notes on the
 * same string (across bar lines). Keyed by `${beatId}:${stringIndex}`. Only beats that fit their bar count.
 */
export function tieExtensions(track: PitchedTrack, bars: Bar[]): Map<string, number> {
  const cached = tieCache.get(track);
  if (cached && cached.bars === bars) return cached.map;
  const ordered: { beat: TabBeat; ticks: number }[] = [];
  for (const bar of bars) for (const lb of layoutBar(track, bar).beats) if (lb.fits) ordered.push({ beat: lb.beat, ticks: lb.ticks });
  const map = new Map<string, number>();
  ordered.forEach(({ beat }, i) => {
    if (beat.isRest) return;
    for (const note of beat.notes) {
      if (note.tied) continue;
      let extra = 0;
      for (let j = i + 1; j < ordered.length; j++) {
        const next = ordered[j].beat;
        if (next.isRest || !next.notes.some((n) => n.stringIndex === note.stringIndex && n.tied)) break;
        extra += ordered[j].ticks;
      }
      if (extra > 0) map.set(`${beat.id}:${note.stringIndex}`, extra);
    }
  });
  tieCache.set(track, { bars, map });
  return map;
}
