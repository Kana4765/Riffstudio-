import * as alphaTab from '@coderline/alphatab';
import { CUSTOM_PRESET, TRACK_COLORS, TUNING_PRESETS, createFxChain, type FxPresetName } from '../constants/presets';
import {
  DRUM_NOTES,
  MAX_NUMERATOR,
  clampBpm,
  isDrumTrack,
  type Bar,
  type DrumHit,
  type DrumMidiNote,
  type DrumTrack,
  type Duration,
  type PitchedInstrumentType,
  type PitchedTrack,
  type Song,
  type TabBeat,
  type TabNote,
  type TimeSigDenominator,
  type Track,
} from '../types/song';
import { decomposeRest, sanitizedNotes } from './alphaTexGenerator';
import { gmProgram } from './midiExport';
import { barTicks, getBarTempo, layoutBar, uid } from './timing';

/**
 * Guitar Pro interchange via alphaTab (the notation engine the app already ships).
 *
 * Import reads Guitar Pro 3/4/5 (.gp3/.gp4/.gp5), 6 (.gpx) and 7/8 (.gp) files, plus MusicXML.
 * Export writes Guitar Pro 7 (.gp) files, the format Guitar Pro 8 uses natively.
 *
 * alphaTab works at 960 ticks per quarter note and numbers strings from the LOWEST string (1 = low E).
 * RiffForge uses 480 PPQ and numbers strings from the HIGHEST string (1 = high e).
 */

const AT_PPQ = 960;
const OUR_PPQ = 480;
const TICK_RATIO = AT_PPQ / OUR_PPQ;

export const GUITAR_PRO_EXTENSIONS = ['gp', 'gp5', 'gp4', 'gp3', 'gpx', 'musicxml', 'xml', 'mxl'] as const;

export function isGuitarProFileName(name: string): boolean {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  return (GUITAR_PRO_EXTENSIONS as readonly string[]).includes(ext);
}

export interface GpImportReport {
  title: string;
  tracks: number;
  bars: number;
  /** Bars in the file before repeats/alternate endings were written out. */
  sourceBars: number;
  repeatsUnrolled: boolean;
  graceNotesSkipped: number;
  unsupportedTuplets: number;
  extraVoicesIgnored: number;
  notesDropped: number;
  drumNotesUnmapped: number;
  pianoTracksConverted: number;
}

export function describeImport(r: GpImportReport): string {
  const parts = [`${r.tracks} track${r.tracks === 1 ? '' : 's'}, ${r.bars} bars`];
  if (r.repeatsUnrolled) parts.push(`repeats written out (${r.sourceBars} → ${r.bars} bars)`);
  const notes: string[] = [];
  if (r.graceNotesSkipped) notes.push(`${r.graceNotesSkipped} grace notes`);
  if (r.unsupportedTuplets) notes.push(`${r.unsupportedTuplets} non-triplet tuplets`);
  if (r.extraVoicesIgnored) notes.push(`second voices in ${r.extraVoicesIgnored} bars`);
  if (r.notesDropped) notes.push(`${r.notesDropped} unplaceable notes`);
  if (r.drumNotesUnmapped) notes.push(`${r.drumNotesUnmapped} percussion hits outside the 10-piece kit`);
  if (notes.length) parts.push(`skipped ${notes.join(', ')}`);
  return parts.join(' · ');
}

// ------------------------------------------------------------------------------------------------ shared

function settings(): alphaTab.Settings {
  const s = new alphaTab.Settings();
  s.core.logLevel = alphaTab.LogLevel.Error;
  return s;
}

/** GM percussion notes folded onto the app's 10-piece kit. */
const DRUM_FOLD: Record<number, DrumMidiNote> = {
  35: 36, 36: 36,
  37: 38, 38: 38, 39: 38, 40: 38,
  42: 42, 44: 42,
  46: 46,
  41: 41, 43: 41,
  45: 45, 47: 45,
  48: 48, 50: 48,
  49: 49, 55: 49, 57: 49,
  51: 51, 53: 51, 59: 51,
  52: 52,
};

const DYNAMIC_VELOCITY: Record<number, number> = { 0: 24, 1: 38, 2: 52, 3: 66, 4: 82, 5: 98, 6: 112, 7: 124, 8: 16, 9: 12, 10: 8, 11: 127, 12: 127, 13: 127 };
const VELOCITY_LEVELS = [24, 38, 52, 66, 82, 98, 112, 124];

function velocityFromDynamics(dynamics: number, ghost: boolean, accent: boolean): number {
  let v = DYNAMIC_VELOCITY[dynamics] ?? 98;
  if (ghost) v *= 0.55;
  if (accent) v += 18;
  return Math.max(1, Math.min(127, Math.round(v)));
}

function dynamicsFromVelocity(velocity: number): number {
  let best = 0;
  VELOCITY_LEVELS.forEach((lvl, i) => {
    if (Math.abs(lvl - velocity) < Math.abs(VELOCITY_LEVELS[best] - velocity)) best = i;
  });
  return best;
}

// ------------------------------------------------------------------------------------------------ import

/** Plays repeats and alternate endings in order (a missing repeat start repeats from the song start). */
export function unrollRepeats(masterBars: alphaTab.model.MasterBar[]): number[] {
  const order: number[] = [];
  let i = 0;
  let start = 0;
  let pass = 1;
  let jumped = false;
  while (i < masterBars.length && order.length < 4000) {
    const mb = masterBars[i];
    if (mb.isRepeatStart && !jumped) {
      start = i;
      pass = 1;
    }
    jumped = false;
    const endings = mb.alternateEndings;
    if (endings !== 0 && (endings & (1 << (pass - 1))) === 0) {
      i += 1;
      continue;
    }
    order.push(i);
    if (mb.repeatCount > 1 && pass < mb.repeatCount) {
      pass += 1;
      i = start;
      jumped = true;
      continue;
    }
    if (mb.repeatCount > 0) pass = 1;
    i += 1;
  }
  return order;
}

function toDuration(d: number): Duration {
  if (d <= 1) return 1;
  if (d >= 32) return 32;
  return ([2, 4, 8, 16] as const).includes(d as 2 | 4 | 8 | 16) ? (d as Duration) : 4;
}

function toDenominator(d: number): TimeSigDenominator {
  return ([1, 2, 4, 8, 16, 32] as const).includes(d as TimeSigDenominator) ? (d as TimeSigDenominator) : 4;
}

function instrumentFor(track: alphaTab.model.Track, staff: alphaTab.model.Staff): PitchedInstrumentType {
  const program = track.playbackInfo.program;
  if (!staff.isStringed) return 'synth';
  const tuning = staff.tuning;
  if (program >= 32 && program <= 39) return 'bass';
  if (tuning.length <= 6 && tuning[tuning.length - 1] < 36 && tuning[0] <= 50) return 'bass';
  if (program === 24 || program === 25) return 'acoustic-guitar';
  return 'electric-guitar';
}

function fxPresetFor(type: PitchedInstrumentType, program: number): FxPresetName {
  if (type === 'bass') return program >= 34 ? 'Bass Grit' : 'Clean';
  if (type === 'electric-guitar') {
    if (program === 30) return 'High-Gain Distortion';
    if (program === 29) return 'Warm Overdrive';
    return 'Clean';
  }
  return 'Clean';
}

function tuningPresetName(tuning: number[]): string {
  return TUNING_PRESETS.find((p) => p.pitches.length === tuning.length && p.pitches.every((v, i) => v === tuning[i]))?.name ?? CUSTOM_PRESET;
}

/** A keyboard-style range for non-fretted tracks (piano, strings...): 8 "strings" a fourth apart, E1–E6. */
const KEYS_TUNING = [63, 58, 53, 48, 43, 38, 33, 28];

interface Counters {
  graceNotesSkipped: number;
  unsupportedTuplets: number;
  extraVoicesIgnored: number;
  notesDropped: number;
  drumNotesUnmapped: number;
}

/** Places pitches (highest first) on distinct strings of KEYS_TUNING; octave-shifts notes outside the range. */
function placeOnStrings(pitches: number[], c: Counters): { stringIndex: number; fret: number }[] {
  const used = new Set<number>();
  const out: { stringIndex: number; fret: number }[] = [];
  for (const raw of [...pitches].sort((a, b) => b - a)) {
    let p = raw;
    while (p > KEYS_TUNING[0] + 24) p -= 12;
    while (p < KEYS_TUNING[KEYS_TUNING.length - 1]) p += 12;
    let placed = false;
    for (let s = 0; s < KEYS_TUNING.length && !placed; s++) {
      const fret = p - KEYS_TUNING[s];
      if (!used.has(s) && fret >= 0 && fret <= 24) {
        used.add(s);
        out.push({ stringIndex: s + 1, fret });
        placed = true;
      }
    }
    if (!placed) c.notesDropped += 1;
  }
  return out;
}

function importPitchedTrack(at: alphaTab.model.Track, order: number[], index: number, c: Counters): PitchedTrack {
  const staff = at.staves[0];
  const type = instrumentFor(at, staff);
  const stringed = staff.isStringed;
  const capo = stringed ? staff.capo : 0;
  const tuning = stringed ? staff.tuning.map((p) => p + capo) : [...KEYS_TUNING];
  const strings = tuning.length;
  const beats: TabBeat[] = [];

  order.forEach((mbIndex, barIndex) => {
    const bar = staff.bars[mbIndex];
    if (!bar) return;
    if (bar.voices.slice(1).some((v) => !v.isEmpty)) c.extraVoicesIgnored += 1;
    const voice = bar.voices[0];
    if (!voice || voice.isEmpty) return;
    let position = 0;
    for (const beat of voice.beats) {
      if (beat.graceType !== alphaTab.model.GraceType.None) {
        c.graceNotesSkipped += 1;
        continue;
      }
      const tb: TabBeat = {
        id: uid('beat'),
        barIndex,
        position,
        duration: toDuration(beat.duration),
        dotted: beat.dots > 0,
        isRest: beat.isRest || beat.notes.length === 0,
        notes: [],
      };
      if (beat.hasTuplet) {
        // 3:2 and 6:4 are triplets; other ratios (5:4, 7:4...) can't be represented exactly.
        if (beat.tupletNumerator * 2 === beat.tupletDenominator * 3) tb.tuplet = 3;
        else c.unsupportedTuplets += 1;
      }
      if (!tb.isRest) {
        const placed: TabNote[] = [];
        if (stringed) {
          for (const n of beat.notes) {
            const stringIndex = strings - n.string + 1;
            if (stringIndex < 1 || stringIndex > strings || !Number.isFinite(n.fret)) {
              c.notesDropped += 1;
              continue;
            }
            const note: TabNote = {
              stringIndex,
              fret: Math.max(0, Math.min(24, n.fret)),
              palmMute: n.isPalmMute || beat.isPalmMute || n.isDead,
              hammerOn: n.isHammerPullOrigin,
              bend: n.hasBend,
              slide: n.slideOutType !== alphaTab.model.SlideOutType.None && n.slideOutType !== alphaTab.model.SlideOutType.PickSlideDown && n.slideOutType !== alphaTab.model.SlideOutType.PickSlideUp,
              harmonic: n.harmonicType !== alphaTab.model.HarmonicType.None,
            };
            if (n.isTieDestination) note.tied = true;
            placed.push(note);
          }
        } else {
          for (const pos of placeOnStrings(beat.notes.map((n) => n.realValue), c)) {
            placed.push({ ...pos, palmMute: false, hammerOn: false, bend: false, slide: false, harmonic: false });
          }
        }
        // One note per string.
        const byString = new Map<number, TabNote>();
        for (const n of placed) byString.set(n.stringIndex, n);
        tb.notes = [...byString.values()].sort((a, b) => a.stringIndex - b.stringIndex);
        if (tb.notes.length === 0) tb.isRest = true;
      }
      beats.push(tb);
      position += 1;
    }
  });

  const program = at.playbackInfo.program;
  return {
    id: uid('trk'),
    name: at.name || `Track ${index + 1}`,
    color: TRACK_COLORS[index % TRACK_COLORS.length],
    instrumentType: type,
    volume: Math.max(0, Math.min(1, at.playbackInfo.volume / 16)),
    pan: Math.max(-1, Math.min(1, (at.playbackInfo.balance - 8) / 8)),
    muted: at.playbackInfo.isMute,
    solo: at.playbackInfo.isSolo,
    tuning,
    tuningPreset: stringed ? tuningPresetName(tuning) : CUSTOM_PRESET,
    fxChain: createFxChain(fxPresetFor(type, program)),
    beats,
  };
}

function importDrumTrack(at: alphaTab.model.Track, order: number[], bars: Bar[], c: Counters): DrumTrack {
  const staff = at.staves[0];
  const hits: DrumHit[] = [];
  const seen = new Set<string>();
  order.forEach((mbIndex, barIndex) => {
    const bar = staff.bars[mbIndex];
    if (!bar) return;
    const length = barTicks(bars[barIndex]);
    for (const voice of bar.voices) {
      for (const beat of voice.beats) {
        if (beat.graceType !== alphaTab.model.GraceType.None) {
          c.graceNotesSkipped += 1;
          continue;
        }
        const tick = Math.round(beat.playbackStart / TICK_RATIO);
        if (tick < 0 || tick >= length) continue;
        for (const n of beat.notes) {
          const art = at.percussionArticulations[n.percussionArticulation];
          const midi = art ? art.outputMidiNumber : n.percussionArticulation >= 27 && n.percussionArticulation <= 87 ? n.percussionArticulation : n.realValue;
          const piece = DRUM_FOLD[midi];
          if (!piece) {
            c.drumNotesUnmapped += 1;
            continue;
          }
          const key = `${barIndex}:${tick}:${piece}`;
          if (seen.has(key)) continue;
          seen.add(key);
          hits.push({
            id: uid('hit'),
            barIndex,
            tickOffset: tick,
            midiNote: piece,
            velocity: velocityFromDynamics(n.dynamics, n.isGhost, n.accentuated !== alphaTab.model.AccentuationType.None),
          });
        }
      }
    }
  });
  return {
    id: uid('trk'),
    name: at.name || 'Drums',
    color: '#f43f5e',
    instrumentType: 'drums',
    kit: 'rock',
    volume: Math.max(0, Math.min(1, at.playbackInfo.volume / 16)),
    pan: Math.max(-1, Math.min(1, (at.playbackInfo.balance - 8) / 8)),
    muted: at.playbackInfo.isMute,
    solo: at.playbackInfo.isSolo,
    hits,
  };
}

/** Reads a Guitar Pro / MusicXML file into a RiffForge song. Throws a readable error for unsupported files. */
export function importGuitarPro(bytes: Uint8Array, fileName: string): { song: Song; report: GpImportReport } {
  let score: alphaTab.model.Score;
  try {
    score = alphaTab.importer.ScoreLoader.loadScoreFromBytes(bytes, settings());
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Couldn't read "${fileName}" as a Guitar Pro file (${msg.slice(0, 120)})`);
  }
  if (score.masterBars.length === 0 || score.tracks.length === 0) throw new Error(`"${fileName}" has no tracks or bars`);

  const order = unrollRepeats(score.masterBars);
  const bars: Bar[] = order.map((mbIndex, index) => {
    const mb = score.masterBars[mbIndex];
    const numerator = Math.max(1, Math.min(MAX_NUMERATOR, mb.timeSignatureNumerator));
    return { index, numerator, denominator: toDenominator(mb.timeSignatureDenominator) };
  });

  // Tempo: the bar's first tempo marking (mid-bar changes apply from the next bar line).
  const songBpm = clampBpm(score.tempo || 120);
  let current = songBpm;
  order.forEach((mbIndex, i) => {
    const automations = [...score.masterBars[mbIndex].tempoAutomations].sort((a, b) => a.ratioPosition - b.ratioPosition);
    const t = automations.find((a) => a.ratioPosition === 0) ?? automations[0];
    if (!t) return;
    const bpm = clampBpm(t.value);
    if (i > 0 && bpm !== current) bars[i].tempoOverride = bpm;
    if (i === 0 || bpm !== current) current = bpm;
  });
  const firstBpm = (() => {
    const a = score.masterBars[order[0]]?.tempoAutomations.find((x) => x.ratioPosition === 0);
    return a ? clampBpm(a.value) : songBpm;
  })();

  const counters: Counters = { graceNotesSkipped: 0, unsupportedTuplets: 0, extraVoicesIgnored: 0, notesDropped: 0, drumNotesUnmapped: 0 };
  let pianoTracksConverted = 0;
  const tracks: Track[] = score.tracks.map((t, i) => {
    if (t.staves[0]?.isPercussion) return importDrumTrack(t, order, bars, counters);
    if (!t.staves[0]?.isStringed) pianoTracksConverted += 1;
    return importPitchedTrack(t, order, i, counters);
  });

  const title = score.title.trim() || fileName.replace(/\.[^.]+$/, '');
  const song: Song = { id: uid('song'), title, artist: score.artist.trim(), bpm: firstBpm, bars, tracks };
  return {
    song,
    report: {
      title,
      tracks: tracks.length,
      bars: bars.length,
      sourceBars: score.masterBars.length,
      repeatsUnrolled: order.length !== score.masterBars.length || order.some((v, i) => v !== i),
      pianoTracksConverted,
      ...counters,
    },
  };
}

// ------------------------------------------------------------------------------------------------ export

type ArtArgs = ConstructorParameters<typeof alphaTab.model.InstrumentArticulation>;

/** Guitar Pro's own drum articulation definitions for the 10 kit pieces (taken from a GP drum kit). */
const GP_ARTICULATIONS: Record<DrumMidiNote, { id: number; name: string; line: number; heads: [number, number, number] }> = {
  36: { id: 36, name: 'Kick Drum', line: 7, heads: [57508, 57507, 57506] },
  38: { id: 38, name: 'Snare', line: 3, heads: [57508, 57507, 57506] },
  42: { id: 42, name: 'Charley', line: -1, heads: [57513, 57513, 57513] },
  46: { id: 46, name: 'Charley', line: -1, heads: [57523, 57523, 57523] },
  48: { id: 48, name: 'Tom High', line: 2, heads: [57508, 57507, 57506] },
  45: { id: 45, name: 'Tom Low', line: 5, heads: [57508, 57507, 57506] },
  41: { id: 41, name: 'Very Low Floor Tom', line: 5, heads: [57508, 57507, 57506] },
  49: { id: 49, name: 'Crash High', line: -2, heads: [57592, 57592, 57592] },
  51: { id: 51, name: 'Ride', line: 0, heads: [57513, 57513, 57513] },
  52: { id: 52, name: 'China', line: -3, heads: [57593, 57593, 57593] },
};

function makeArticulation(note: DrumMidiNote): alphaTab.model.InstrumentArticulation {
  const a = GP_ARTICULATIONS[note];
  const noTechnique: number = -1;
  const inside: number = 3;
  return new alphaTab.model.InstrumentArticulation(
    a.name,
    a.line,
    note,
    a.heads[0] as ArtArgs[3],
    a.heads[1] as ArtArgs[4],
    a.heads[2] as ArtArgs[5],
    noTechnique as ArtArgs[6],
    inside as ArtArgs[7],
    a.id,
  );
}

function atDuration(d: number): alphaTab.model.Duration {
  return d as alphaTab.model.Duration;
}

interface Piece {
  duration: number;
  dotted: boolean;
  triplet: boolean;
}

function newBeat(voice: alphaTab.model.Voice, p: Piece): alphaTab.model.Beat {
  const beat = new alphaTab.model.Beat();
  beat.duration = atDuration(p.duration);
  if (p.dotted) beat.dots = 1;
  if (p.triplet) {
    beat.tupletNumerator = 3;
    beat.tupletDenominator = 2;
  }
  voice.addBeat(beat);
  return beat;
}

function addRests(voice: alphaTab.model.Voice, ticks: number): void {
  for (const piece of decomposeRest(ticks)) newBeat(voice, piece);
}

function exportPitchedTrack(score: alphaTab.model.Score, song: Song, track: PitchedTrack, channel: number): void {
  const t = new alphaTab.model.Track();
  t.name = track.name;
  t.playbackInfo.program = gmProgram(track);
  t.playbackInfo.primaryChannel = channel;
  t.playbackInfo.secondaryChannel = channel;
  t.playbackInfo.volume = Math.round(track.volume * 16);
  t.playbackInfo.balance = Math.round(8 + track.pan * 8);
  t.playbackInfo.isMute = track.muted;
  t.playbackInfo.isSolo = track.solo;
  const staff = new alphaTab.model.Staff();
  staff.stringTuning = new alphaTab.model.Tuning(track.tuningPreset === CUSTOM_PRESET ? '' : track.tuningPreset, [...track.tuning], false);
  staff.showTablature = true;
  staff.showStandardNotation = true;
  t.addStaff(staff);
  score.addTrack(t);
  const strings = track.tuning.length;

  song.bars.forEach((bar) => {
    const b = new alphaTab.model.Bar();
    staff.addBar(b);
    const voice = new alphaTab.model.Voice();
    b.addVoice(voice);
    const layout = layoutBar(track, bar);
    const fitting = layout.beats.filter((lb) => lb.fits);
    fitting.forEach((lb, i) => {
      const beat = newBeat(voice, { duration: lb.beat.duration, dotted: lb.beat.dotted, triplet: lb.beat.tuplet === 3 });
      if (lb.beat.isRest) return;
      const next = fitting[i + 1]?.beat;
      for (const n of sanitizedNotes(track, lb.beat)) {
        const note = new alphaTab.model.Note();
        note.string = strings - n.stringIndex + 1;
        note.fret = n.fret;
        note.isPalmMute = n.palmMute;
        if (n.tied) note.isTieDestination = true;
        const hasTarget = !!next && !next.isRest && next.notes.some((m) => m.stringIndex === n.stringIndex);
        if (n.hammerOn && hasTarget) note.isHammerPullOrigin = true;
        if (n.slide) note.slideOutType = hasTarget ? alphaTab.model.SlideOutType.Legato : alphaTab.model.SlideOutType.OutDown;
        if (n.harmonic) {
          note.harmonicType = alphaTab.model.HarmonicType.Natural;
          note.harmonicValue = n.fret;
        }
        if (n.bend) {
          note.addBendPoint(new alphaTab.model.BendPoint(0, 0));
          note.addBendPoint(new alphaTab.model.BendPoint(15, 4));
          note.addBendPoint(new alphaTab.model.BendPoint(60, 4));
        }
        beat.addNote(note);
      }
    });
    const used = fitting.reduce((s, lb) => s + lb.ticks, 0);
    addRests(voice, layout.totalTicks - used);
  });
}

const MAX_DRUM_VOICES = 4;

/** Writes one voice of a drum bar: beats at the given hit ticks, rests everywhere else. */
function writeDrumVoice(
  voice: alphaTab.model.Voice,
  hitsByTick: Map<number, DrumHit[]>,
  length: number,
  articulation: Map<number, number>,
  dynamics: number,
): void {
  const ticks = [...hitsByTick.keys()].sort((a, b) => a - b);
  addRests(voice, ticks.length ? ticks[0] : length);
  ticks.forEach((tick, i) => {
    const end = ticks[i + 1] ?? length;
    const pieces = decomposeRest(end - tick);
    // The hits go on the first piece starting at `tick`; any remainder is written as rests.
    const [first, ...rest] = pieces.length ? pieces : [{ duration: 32 as const, dotted: false, triplet: false, ticks: 60 }];
    const beat = newBeat(voice, first);
    // Guitar Pro stores loudness per beat, so each voice carries a single dynamic level.
    beat.dynamics = dynamics as alphaTab.model.DynamicValue;
    for (const hit of hitsByTick.get(tick) ?? []) {
      const note = new alphaTab.model.Note();
      note.percussionArticulation = articulation.get(hit.midiNote) ?? 0;
      note.dynamics = dynamics as alphaTab.model.DynamicValue;
      beat.addNote(note);
    }
    for (const r of rest) newBeat(voice, r);
  });
}

function exportDrumTrack(score: alphaTab.model.Score, song: Song, track: DrumTrack): void {
  const t = new alphaTab.model.Track();
  t.name = track.name;
  t.playbackInfo.program = 0;
  t.playbackInfo.primaryChannel = 9;
  t.playbackInfo.secondaryChannel = 9;
  t.playbackInfo.volume = Math.round(track.volume * 16);
  t.playbackInfo.balance = Math.round(8 + track.pan * 8);
  t.playbackInfo.isMute = track.muted;
  t.playbackInfo.isSolo = track.solo;
  const staff = new alphaTab.model.Staff();
  staff.isPercussion = true;
  staff.showTablature = false;
  staff.showStandardNotation = true;
  t.addStaff(staff);
  score.addTrack(t);
  const articulation = new Map<number, number>();
  for (const note of DRUM_NOTES) articulation.set(note, t.getOrRegisterPercussionArticulation(makeArticulation(note)));

  song.bars.forEach((bar) => {
    const b = new alphaTab.model.Bar();
    staff.addBar(b);
    const length = barTicks(bar);
    const hits = track.hits.filter((h) => h.barIndex === bar.index && h.tickOffset < length);
    // Distinct loudness levels in this bar, loudest first; each gets its own voice (up to 4, as in Guitar Pro).
    const levels = [...new Set(hits.map((h) => dynamicsFromVelocity(h.velocity)))].sort((a, b) => b - a);
    const voiceLevels = levels.length ? levels.slice(0, MAX_DRUM_VOICES) : [dynamicsFromVelocity(100)];
    const voiceFor = (level: number) =>
      voiceLevels.reduce((best, l, i) => (Math.abs(l - level) < Math.abs(voiceLevels[best] - level) ? i : best), 0);
    const perVoice = voiceLevels.map(() => new Map<number, DrumHit[]>());
    for (const h of hits) {
      const map = perVoice[voiceFor(dynamicsFromVelocity(h.velocity))];
      const list = map.get(h.tickOffset) ?? [];
      list.push(h);
      map.set(h.tickOffset, list);
    }
    perVoice.forEach((map, i) => {
      const voice = new alphaTab.model.Voice();
      b.addVoice(voice);
      writeDrumVoice(voice, map, length, articulation, voiceLevels[i]);
    });
  });
}

/** Writes the song as a Guitar Pro 7/8 (.gp) file. */
export function exportGuitarPro(song: Song): Uint8Array {
  const s = settings();
  const score = new alphaTab.model.Score();
  score.title = song.title;
  score.artist = song.artist;
  let previousTempo = -1;
  song.bars.forEach((bar, i) => {
    const mb = new alphaTab.model.MasterBar();
    mb.timeSignatureNumerator = bar.numerator;
    mb.timeSignatureDenominator = bar.denominator;
    const tempo = getBarTempo(song, i);
    if (tempo !== previousTempo) {
      mb.tempoAutomations.push(alphaTab.model.Automation.buildTempoAutomation(false, 0, tempo, 2));
      previousTempo = tempo;
    }
    score.addMasterBar(mb);
  });
  let channel = 0;
  for (const track of song.tracks) {
    if (isDrumTrack(track)) exportDrumTrack(score, song, track);
    else {
      if (channel === 9) channel += 1;
      exportPitchedTrack(score, song, track, channel % 16 === 9 ? 10 : channel % 16);
      channel += 1;
    }
  }
  score.finish(s);
  return new alphaTab.exporter.Gp7Exporter().export(score, s);
}
