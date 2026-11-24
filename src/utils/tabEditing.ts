import type { Bar, Duration, PitchedTrack, TabBeat, TabNote } from '../types/song';
import { barTicks, beatTicks, beatsInBar, clamp, uid } from './timing';

export interface TabCursor {
  barIndex: number;
  /** Beat position; may equal the beat count of the bar (an empty slot ready for input). */
  position: number;
  /** 1-based, 1 = highest string. */
  stringIndex: number;
}

export interface PendingRhythm {
  duration: Duration;
  dotted: boolean;
  tuplet: boolean;
}

export type NoteFlag = 'palmMute' | 'hammerOn' | 'bend' | 'slide' | 'harmonic' | 'tied';

export function getBeatAt(track: PitchedTrack, barIndex: number, position: number): TabBeat | undefined {
  return track.beats.find((b) => b.barIndex === barIndex && b.position === position);
}

function replaceBeat(track: PitchedTrack, beat: TabBeat): PitchedTrack {
  return { ...track, beats: track.beats.map((b) => (b.id === beat.id ? beat : b)) };
}

function emptyNote(stringIndex: number, fret: number): TabNote {
  return { stringIndex, fret, palmMute: false, hammerOn: false, bend: false, slide: false, harmonic: false };
}

function newBeat(barIndex: number, position: number, rhythm: PendingRhythm, isRest: boolean, notes: TabNote[]): TabBeat {
  const beat: TabBeat = {
    id: uid('beat'),
    barIndex,
    position,
    duration: rhythm.duration,
    dotted: rhythm.dotted,
    isRest,
    notes,
  };
  if (rhythm.tuplet) beat.tuplet = 3;
  return beat;
}

/** Places a new beat at the end of the bar (the cursor's "empty slot"). */
function appendBeat(track: PitchedTrack, barIndex: number, beat: Omit<TabBeat, 'position'>): { track: PitchedTrack; position: number } {
  const count = beatsInBar(track, barIndex).length;
  return { track: { ...track, beats: [...track.beats, { ...beat, position: count }] }, position: count };
}

export function writeFret(track: PitchedTrack, cursor: TabCursor, fret: number, rhythm: PendingRhythm): PitchedTrack {
  const safeFret = clamp(Math.round(fret), 0, 24);
  const existing = getBeatAt(track, cursor.barIndex, cursor.position);
  if (existing) {
    const prev = existing.notes.find((n) => n.stringIndex === cursor.stringIndex);
    const note: TabNote = prev ? { ...prev, fret: safeFret } : emptyNote(cursor.stringIndex, safeFret);
    const notes = [...existing.notes.filter((n) => n.stringIndex !== cursor.stringIndex), note].sort(
      (a, b) => a.stringIndex - b.stringIndex,
    );
    return replaceBeat(track, { ...existing, isRest: false, notes });
  }
  const beat = newBeat(cursor.barIndex, 0, rhythm, false, [emptyNote(cursor.stringIndex, safeFret)]);
  return appendBeat(track, cursor.barIndex, beat).track;
}

export function toggleNoteFlag(track: PitchedTrack, cursor: TabCursor, flag: NoteFlag): PitchedTrack {
  const beat = getBeatAt(track, cursor.barIndex, cursor.position);
  if (!beat) return track;
  const note = beat.notes.find((n) => n.stringIndex === cursor.stringIndex);
  if (note) {
    const updated: TabNote = { ...note, [flag]: !note[flag] };
    return replaceBeat(track, { ...beat, notes: beat.notes.map((n) => (n === note ? updated : n)) });
  }
  // No note on the cursor string: palm mute applies to the whole beat (common for chugged chords).
  if (flag === 'palmMute' && beat.notes.length > 0) {
    const allOn = beat.notes.every((n) => n.palmMute);
    return replaceBeat(track, { ...beat, notes: beat.notes.map((n) => ({ ...n, palmMute: !allOn })) });
  }
  return track;
}

export function setBeatDuration(track: PitchedTrack, cursor: TabCursor, duration: Duration): PitchedTrack {
  const beat = getBeatAt(track, cursor.barIndex, cursor.position);
  return beat ? replaceBeat(track, { ...beat, duration }) : track;
}

export function toggleBeatDotted(track: PitchedTrack, cursor: TabCursor): PitchedTrack {
  const beat = getBeatAt(track, cursor.barIndex, cursor.position);
  return beat ? replaceBeat(track, { ...beat, dotted: !beat.dotted }) : track;
}

export function toggleBeatTriplet(track: PitchedTrack, cursor: TabCursor): PitchedTrack {
  const beat = getBeatAt(track, cursor.barIndex, cursor.position);
  if (!beat) return track;
  const next: TabBeat = { ...beat };
  if (beat.tuplet === 3) delete next.tuplet;
  else next.tuplet = 3;
  return replaceBeat(track, next);
}

export function toggleRest(track: PitchedTrack, cursor: TabCursor, rhythm: PendingRhythm): PitchedTrack {
  const beat = getBeatAt(track, cursor.barIndex, cursor.position);
  if (beat) {
    return replaceBeat(track, beat.isRest ? { ...beat, isRest: false } : { ...beat, isRest: true, notes: [] });
  }
  return appendBeat(track, cursor.barIndex, newBeat(cursor.barIndex, 0, rhythm, true, [])).track;
}

/** Inserts a rest beat after the cursor beat (or at the cursor slot) and returns its position. */
export function insertBeatAfter(
  track: PitchedTrack,
  cursor: TabCursor,
  rhythm: PendingRhythm,
): { track: PitchedTrack; position: number } {
  const current = getBeatAt(track, cursor.barIndex, cursor.position);
  const template: PendingRhythm = current
    ? { duration: current.duration, dotted: current.dotted, tuplet: current.tuplet === 3 }
    : rhythm;
  if (!current) {
    return appendBeat(track, cursor.barIndex, newBeat(cursor.barIndex, 0, template, true, []));
  }
  const insertPos = cursor.position + 1;
  const shifted = track.beats.map((b) =>
    b.barIndex === cursor.barIndex && b.position >= insertPos ? { ...b, position: b.position + 1 } : b,
  );
  const beat = newBeat(cursor.barIndex, insertPos, template, true, []);
  return { track: { ...track, beats: [...shifted, beat] }, position: insertPos };
}

/** Clears the note under the cursor; if the beat has no note there, deletes the whole beat. */
export function deleteAtCursor(track: PitchedTrack, cursor: TabCursor): { track: PitchedTrack; removedBeat: boolean } {
  const beat = getBeatAt(track, cursor.barIndex, cursor.position);
  if (!beat) return { track, removedBeat: false };
  if (beat.notes.some((n) => n.stringIndex === cursor.stringIndex)) {
    const notes = beat.notes.filter((n) => n.stringIndex !== cursor.stringIndex);
    return { track: replaceBeat(track, { ...beat, notes, isRest: notes.length === 0 ? true : beat.isRest }), removedBeat: false };
  }
  const beats = track.beats
    .filter((b) => b.id !== beat.id)
    .map((b) => (b.barIndex === beat.barIndex && b.position > beat.position ? { ...b, position: b.position - 1 } : b));
  return { track: { ...track, beats }, removedBeat: true };
}

/** True when the bar still has room for another beat of the given rhythm. */
export function barHasRoom(track: PitchedTrack, bar: Bar): boolean {
  const used = beatsInBar(track, bar.index).reduce((s, b) => s + beatTicks(b), 0);
  return used < barTicks(bar);
}

/** Moves the cursor one beat left/right, crossing bar lines like Guitar Pro. */
export function moveCursorHorizontal(track: PitchedTrack, bars: Bar[], cursor: TabCursor, dir: -1 | 1): TabCursor {
  const count = beatsInBar(track, cursor.barIndex).length;
  const bar = bars[cursor.barIndex];
  if (dir === 1) {
    const maxSlot = bar && barHasRoom(track, bar) ? count : Math.max(0, count - 1);
    if (cursor.position < maxSlot) return { ...cursor, position: cursor.position + 1 };
    if (cursor.barIndex < bars.length - 1) return { ...cursor, barIndex: cursor.barIndex + 1, position: 0 };
    return cursor;
  }
  if (cursor.position > 0) return { ...cursor, position: Math.min(cursor.position - 1, count) };
  if (cursor.barIndex > 0) {
    const prevCount = beatsInBar(track, cursor.barIndex - 1).length;
    return { ...cursor, barIndex: cursor.barIndex - 1, position: Math.max(0, prevCount - 1) };
  }
  return cursor;
}

export function moveCursorVertical(track: PitchedTrack, cursor: TabCursor, dir: -1 | 1): TabCursor {
  return { ...cursor, stringIndex: clamp(cursor.stringIndex + dir, 1, track.tuning.length) };
}

/** Keeps a cursor valid after the song or track changes. */
export function clampCursor(track: PitchedTrack, bars: Bar[], cursor: TabCursor): TabCursor {
  const barIndex = clamp(cursor.barIndex, 0, Math.max(0, bars.length - 1));
  const count = beatsInBar(track, barIndex).length;
  return {
    barIndex,
    position: clamp(cursor.position, 0, count),
    stringIndex: clamp(cursor.stringIndex, 1, track.tuning.length),
  };
}
