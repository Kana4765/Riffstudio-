import type { PitchedTrack, Song, TabBeat, TabNote } from '../types/song';
import { beatTicks, getBarTempo, layoutBar, midiToNoteName } from './timing';

export interface AlphaTexResult {
  tex: string;
  /** For each bar, the ids of the user beats emitted (in order). Padding rests follow them. */
  emittedBeatIds: string[][];
  /** Bars whose user beats exceed the bar length; overflowing beats are hidden from notation. */
  overflowBars: number[];
  /** For each bar, the 480-PPQ start tick of every rendered beat (user beats followed by padding rests). */
  beatStartTicks: number[][];
}

interface RestPiece {
  duration: 1 | 2 | 4 | 8 | 16 | 32 | 64;
  dotted: boolean;
  triplet: boolean;
  ticks: number;
}

const REST_PIECES: RestPiece[] = (() => {
  const pieces: RestPiece[] = [];
  const durations = [1, 2, 4, 8, 16, 32, 64] as const;
  for (const duration of durations) {
    const base = 1920 / duration;
    pieces.push({ duration, dotted: false, triplet: false, ticks: base });
    if (Number.isInteger(base * 1.5)) pieces.push({ duration, dotted: true, triplet: false, ticks: base * 1.5 });
    if (Number.isInteger((base * 2) / 3)) pieces.push({ duration, dotted: false, triplet: true, ticks: (base * 2) / 3 });
  }
  return pieces;
})();

/**
 * Splits a tick gap into the fewest valid rest values (min-coin DP on a 10-tick lattice), preferring
 * plain values and using short triplet rests only to complete tuplet groups.
 */
export function decomposeRest(ticks: number): RestPiece[] {
  const unit = 10;
  const target = Math.floor(ticks / unit);
  if (target <= 0) return [];
  const best = new Array<number>(target + 1).fill(Number.POSITIVE_INFINITY);
  const choice = new Array<number>(target + 1).fill(-1);
  best[0] = 0;
  const coins = REST_PIECES.map((p) => p.ticks / unit);
  // Triplet rests are only used to complete tuplet groups: penalise them (more so for long values).
  const cost = REST_PIECES.map((p) => 1 + (p.dotted ? 0.01 : 0) + (p.triplet ? 0.3 + p.ticks / 1920 : 0));
  for (let v = 1; v <= target; v++) {
    for (let i = 0; i < coins.length; i++) {
      const c = coins[i];
      if (c <= v && best[v - c] + cost[i] < best[v]) {
        best[v] = best[v - c] + cost[i];
        choice[v] = i;
      }
    }
  }
  if (!Number.isFinite(best[target])) return [];
  const out: RestPiece[] = [];
  let v = target;
  while (v > 0 && choice[v] >= 0) {
    const piece = REST_PIECES[choice[v]];
    out.push(piece);
    v -= piece.ticks / unit;
  }
  // Triplet remainders first (they complete the user's tuplet group), then plain values longest first.
  return out.sort((a, b) => Number(b.triplet) - Number(a.triplet) || b.ticks - a.ticks);
}

function escapeText(text: string): string {
  return text.replace(/[\\"]/g, "'").replace(/[\r\n]+/g, ' ').trim();
}

function beatEffects(dotted: boolean, triplet: boolean): string {
  const fx: string[] = [];
  if (dotted) fx.push('d');
  if (triplet) fx.push('tu 3');
  return fx.length ? `{${fx.join(' ')}}` : '';
}

function restTex(piece: RestPiece): string {
  return `r.${piece.duration}${beatEffects(piece.dotted, piece.triplet)}`;
}

/** Returns true when the next sounding beat after `beatIndex` (within the track) has a note on `stringIndex`. */
function hasFollowingNoteOnString(ordered: TabBeat[], beatIndex: number, stringIndex: number): boolean {
  const next = ordered[beatIndex + 1];
  if (!next || next.isRest) return false;
  return next.notes.some((n) => n.stringIndex === stringIndex);
}

function noteTex(note: TabNote, ordered: TabBeat[], beatIndex: number): string {
  const fx: string[] = [];
  const legatoTarget = hasFollowingNoteOnString(ordered, beatIndex, note.stringIndex);
  if (note.palmMute) fx.push('pm');
  if (note.hammerOn && legatoTarget) fx.push('h');
  if (note.bend) fx.push('b (0 4)');
  if (note.slide) fx.push(legatoTarget ? 'sl' : 'sod');
  if (note.harmonic) fx.push('nh');
  return `${note.fret}.${note.stringIndex}${fx.length ? `{${fx.join(' ')}}` : ''}`;
}

/** Notes of a beat, deduplicated per string and clamped to the track's string count. */
export function sanitizedNotes(track: PitchedTrack, beat: TabBeat): TabNote[] {
  const byString = new Map<number, TabNote>();
  for (const note of beat.notes) {
    if (note.stringIndex < 1 || note.stringIndex > track.tuning.length) continue;
    byString.set(note.stringIndex, { ...note, fret: Math.max(0, Math.min(24, Math.round(note.fret))) });
  }
  return [...byString.values()].sort((a, b) => a.stringIndex - b.stringIndex);
}

/** Compiles one pitched track into alphaTex, padding incomplete bars with rests and hiding overflow. */
export function generateAlphaTex(song: Song, track: PitchedTrack): AlphaTexResult {
  const tuning = track.tuning.map(midiToNoteName).join(' ');
  const header =
    `\\title "${escapeText(song.title) || 'Untitled'}" ` +
    `\\artist "${escapeText(song.artist) || 'Unknown'}" ` +
    `\\tempo ${Math.round(song.bpm)} ` +
    `\\tuning ${tuning} .`;

  // Global order of all user beats that fit, used to find legato (hammer/slide) targets across bars.
  const layouts = song.bars.map((bar) => layoutBar(track, bar));
  const ordered: TabBeat[] = [];
  for (const layout of layouts) for (const lb of layout.beats) if (lb.fits) ordered.push(lb.beat);
  const orderIndex = new Map<string, number>(ordered.map((b, i) => [b.id, i]));

  const emittedBeatIds: string[][] = [];
  const beatStartTicks: number[][] = [];
  const overflowBars: number[] = [];
  const barTexts: string[] = [];
  let previousTempo = song.bpm;

  song.bars.forEach((bar, barIdx) => {
    const layout = layouts[barIdx];
    const parts: string[] = [`\\ts ${bar.numerator} ${bar.denominator}`];
    const tempo = getBarTempo(song, barIdx);
    if (barIdx > 0 && tempo !== previousTempo) parts.push(`\\tempo ${Math.round(tempo)}`);
    previousTempo = tempo;

    const ids: string[] = [];
    const starts: number[] = [];
    for (const lb of layout.beats) {
      if (!lb.fits) continue;
      const beat = lb.beat;
      starts.push(lb.startTick);
      const notes = beat.isRest ? [] : sanitizedNotes(track, beat);
      const effects = beatEffects(beat.dotted, beat.tuplet === 3);
      if (notes.length === 0) {
        parts.push(`r.${beat.duration}${effects}`);
      } else {
        const idx = orderIndex.get(beat.id) ?? -1;
        const body =
          notes.length === 1
            ? noteTex(notes[0], ordered, idx)
            : `(${notes.map((n) => noteTex(n, ordered, idx)).join(' ')})`;
        parts.push(`${body}.${beat.duration}${effects}`);
      }
      ids.push(beat.id);
    }
    if (layout.overflowTicks > 0) overflowBars.push(bar.index);

    const used = layout.beats.filter((lb) => lb.fits).reduce((sum, lb) => sum + beatTicks(lb.beat), 0);
    let padCursor = used;
    for (const piece of decomposeRest(layout.totalTicks - used)) {
      parts.push(restTex(piece));
      starts.push(padCursor);
      padCursor += piece.ticks;
    }

    emittedBeatIds.push(ids);
    beatStartTicks.push(starts);
    barTexts.push(parts.join(' '));
  });

  return { tex: `${header}\n${barTexts.join(' |\n')}`, emittedBeatIds, overflowBars, beatStartTicks };
}
