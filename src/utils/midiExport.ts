import { PPQ, isDrumTrack, type FxChainSettings, type PitchedTrack, type Song, type Track } from '../types/song';
import { barStartTicks, beatTicks, getBarTempo, harmonicPitch, layoutBar, notePitch } from './timing';

interface MidiEvent {
  tick: number;
  /** Lower sorts first at equal ticks (meta < control < note-off < bend < note-on). */
  order: number;
  data: number[];
}

function vlq(value: number): number[] {
  let v = Math.max(0, Math.floor(value));
  const bytes = [v & 0x7f];
  v >>= 7;
  while (v > 0) {
    bytes.unshift((v & 0x7f) | 0x80);
    v >>= 7;
  }
  return bytes;
}

function textBytes(text: string): number[] {
  const encoded = new TextEncoder().encode(text);
  return Array.from(encoded.slice(0, 127));
}

function metaEvent(type: number, payload: number[]): number[] {
  return [0xff, type, ...vlq(payload.length), ...payload];
}

function u32(n: number): number[] {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}

function u16(n: number): number[] {
  return [(n >>> 8) & 0xff, n & 0xff];
}

function buildTrackChunk(events: MidiEvent[]): number[] {
  const sorted = [...events].sort((a, b) => a.tick - b.tick || a.order - b.order);
  const body: number[] = [];
  let last = 0;
  for (const ev of sorted) {
    body.push(...vlq(ev.tick - last), ...ev.data);
    last = ev.tick;
  }
  body.push(...vlq(0), ...metaEvent(0x2f, []));
  return [0x4d, 0x54, 0x72, 0x6b, ...u32(body.length), ...body];
}

function gmProgram(track: PitchedTrack): number {
  const fx: FxChainSettings = track.fxChain;
  switch (track.instrumentType) {
    case 'acoustic-guitar':
      return 25; // Acoustic Guitar (steel)
    case 'bass':
      return fx.distortion.enabled || fx.overdrive.enabled ? 34 : 33; // Picked / Finger bass
    case 'synth':
      return 81; // Lead 2 (sawtooth)
    case 'electric-guitar':
      if (fx.distortion.enabled) return 30; // Distortion Guitar
      if (fx.overdrive.enabled) return 29; // Overdriven Guitar
      return 27; // Electric Guitar (clean)
  }
}

function pan14(pan: number): number {
  return Math.max(0, Math.min(127, Math.round(64 + pan * 63)));
}

function trackHeaderEvents(track: Track, channel: number): MidiEvent[] {
  const events: MidiEvent[] = [
    { tick: 0, order: 0, data: metaEvent(0x03, textBytes(track.name)) },
    { tick: 0, order: 1, data: [0xb0 | channel, 7, Math.round(Math.max(0, Math.min(1, track.volume)) * 127)] },
    { tick: 0, order: 1, data: [0xb0 | channel, 10, pan14(track.pan)] },
  ];
  if (!isDrumTrack(track)) {
    // Pitch-bend sensitivity = 2 semitones (RPN 0,0) so full-step bends map to the bend range.
    events.push(
      { tick: 0, order: 1, data: [0xb0 | channel, 101, 0] },
      { tick: 0, order: 1, data: [0xb0 | channel, 100, 0] },
      { tick: 0, order: 1, data: [0xb0 | channel, 6, 2] },
      { tick: 0, order: 1, data: [0xb0 | channel, 38, 0] },
      { tick: 0, order: 2, data: [0xc0 | channel, gmProgram(track)] },
    );
  }
  return events;
}

function pitchBendEvent(tick: number, channel: number, value14: number): MidiEvent {
  const v = Math.max(0, Math.min(16383, Math.round(value14)));
  return { tick, order: 3, data: [0xe0 | channel, v & 0x7f, (v >> 7) & 0x7f] };
}

function pitchedTrackEvents(song: Song, track: PitchedTrack, channel: number): MidiEvent[] {
  const events = trackHeaderEvents(track, channel);
  const { starts } = barStartTicks(song.bars);
  song.bars.forEach((bar, barIdx) => {
    const layout = layoutBar(track, bar);
    for (const lb of layout.beats) {
      if (!lb.fits || lb.beat.isRest) continue;
      const start = starts[barIdx] + lb.startTick;
      const length = beatTicks(lb.beat);
      const hasBend = lb.beat.notes.some((n) => n.bend);
      for (const note of lb.beat.notes) {
        if (note.stringIndex < 1 || note.stringIndex > track.tuning.length) continue;
        const pitch = Math.round(note.harmonic ? harmonicPitch(track, note) : notePitch(track, note));
        if (pitch < 0 || pitch > 127) continue;
        const velocity = note.palmMute ? 84 : note.hammerOn ? 76 : 104;
        // Palm mutes are short and percussive; everything else rings for ~95% of the value.
        const gate = note.palmMute ? Math.min(length, PPQ / 4) : Math.max(1, Math.round(length * 0.95));
        events.push({ tick: start, order: 4, data: [0x90 | channel, pitch, velocity] });
        events.push({ tick: start + gate, order: 2, data: [0x80 | channel, pitch, 0] });
      }
      if (hasBend) {
        const rise = Math.max(1, Math.round(length * 0.35));
        const steps = 8;
        for (let s = 0; s <= steps; s++) {
          events.push(pitchBendEvent(start + Math.round((rise * s) / steps), channel, 8192 + (8191 * s) / steps));
        }
        events.push(pitchBendEvent(start + length, channel, 8192));
      }
    }
  });
  return events;
}

function drumTrackEvents(song: Song, track: Track & { instrumentType: 'drums' }): MidiEvent[] {
  const channel = 9;
  const events = trackHeaderEvents(track, channel);
  // GM2 / GS drum-kit program on channel 10: 0 = Standard (acoustic), 16 = Rock (power) kit.
  // Custom kits use the program of the built-in kit they fall back to.
  const base = track.kit === 'acoustic' || track.kit === 'rock' ? track.kit : (track.kitBase ?? 'rock');
  events.push({ tick: 0, order: 2, data: [0xc9, base === 'acoustic' ? 0 : 16] });
  const { starts } = barStartTicks(song.bars);
  for (const hit of track.hits) {
    const barStart = starts[hit.barIndex];
    if (barStart === undefined) continue;
    const tick = barStart + hit.tickOffset;
    const vel = Math.max(1, Math.min(127, Math.round(hit.velocity)));
    events.push({ tick, order: 4, data: [0x99, hit.midiNote, vel] });
    events.push({ tick: tick + PPQ / 8, order: 2, data: [0x89, hit.midiNote, 0] });
  }
  return events;
}

function conductorEvents(song: Song): MidiEvent[] {
  const events: MidiEvent[] = [{ tick: 0, order: 0, data: metaEvent(0x03, textBytes(song.title || 'Untitled')) }];
  const { starts } = barStartTicks(song.bars);
  let prevSig = '';
  let prevTempo = -1;
  song.bars.forEach((bar, i) => {
    const sig = `${bar.numerator}/${bar.denominator}`;
    if (sig !== prevSig) {
      const dd = Math.log2(bar.denominator);
      const clocks = bar.denominator === 8 ? 12 : 24;
      events.push({ tick: starts[i], order: 0, data: metaEvent(0x58, [bar.numerator, dd, clocks, 8]) });
      prevSig = sig;
    }
    const tempo = getBarTempo(song, i);
    if (tempo !== prevTempo) {
      const mpqn = Math.round(60_000_000 / tempo);
      events.push({ tick: starts[i], order: 0, data: metaEvent(0x51, [(mpqn >> 16) & 0xff, (mpqn >> 8) & 0xff, mpqn & 0xff]) });
      prevTempo = tempo;
    }
  });
  return events;
}

/** Builds a Standard MIDI File (format 1, 480 PPQ): conductor track + one MTrk per song track. */
export function exportSongToMidi(song: Song): Uint8Array {
  const chunks: number[][] = [buildTrackChunk(conductorEvents(song))];
  let nextChannel = 0;
  for (const track of song.tracks) {
    if (isDrumTrack(track)) {
      chunks.push(buildTrackChunk(drumTrackEvents(song, track)));
    } else {
      if (nextChannel === 9) nextChannel = 10;
      const channel = nextChannel % 16 === 9 ? 10 : nextChannel % 16;
      nextChannel += 1;
      chunks.push(buildTrackChunk(pitchedTrackEvents(song, track, channel)));
    }
  }
  const header = [0x4d, 0x54, 0x68, 0x64, ...u32(6), ...u16(1), ...u16(chunks.length), ...u16(PPQ)];
  const total = header.length + chunks.reduce((s, c) => s + c.length, 0);
  const out = new Uint8Array(total);
  out.set(header, 0);
  let offset = header.length;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
