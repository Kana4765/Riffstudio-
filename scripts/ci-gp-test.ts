/**
 * CI test for Guitar Pro interchange (runs in Node with the real alphaTab):
 *  1. every built-in song/template survives RiffForge -> .gp -> RiffForge with identical notes, drums, tempo, meter
 *  2. real Guitar Pro 7/8 files (alphaTab's own test-data, written by Guitar Pro) import, and the result
 *     renders back through alphaTab via our alphaTex generator
 *  3. repeats with alternate endings are written out in the right order
 */
import * as alphaTab from '@coderline/alphatab';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createDemoSong } from '../src/data/demoSong';
import { TEMPLATES, createBlankProject, createTemplate } from '../src/data/templates';
import { isDrumTrack, isPitchedTrack, type Song } from '../src/types/song';
import { generateAlphaTex } from '../src/utils/alphaTexGenerator';
import { describeImport, exportGuitarPro, importGuitarPro, unrollRepeats } from '../src/utils/guitarPro';
import { normalizeSong } from '../src/utils/songOps';
import { getBarTempo, layoutBar } from '../src/utils/timing';

let failures = 0;
const check = (ok: boolean, msg: string) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`);
  if (!ok) failures += 1;
};

/** Guitar Pro has 8 loudness levels (ppp..fff); compare velocities at that resolution. */
const LEVELS = [24, 38, 52, 66, 82, 98, 112, 124];
const dynLevel = (v: number) => LEVELS.reduce((best, l, i) => (Math.abs(l - v) < Math.abs(LEVELS[best] - v) ? i : best), 0);

function timeline(song: Song): string[] {
  const out: string[] = [];
  song.bars.forEach((bar, i) => out.push(`bar${i} ${bar.numerator}/${bar.denominator} @${getBarTempo(song, i)}`));
  song.tracks.forEach((t, ti) => {
    if (isDrumTrack(t)) {
      for (const h of [...t.hits].sort((a, b) => a.barIndex - b.barIndex || a.tickOffset - b.tickOffset || a.midiNote - b.midiNote)) {
        out.push(`t${ti} drum b${h.barIndex} +${h.tickOffset} n${h.midiNote} dyn${dynLevel(h.velocity)}`);
      }
      return;
    }
    out.push(`t${ti} ${t.instrumentType} tuning ${t.tuning.join(',')}`);
    for (const bar of song.bars) {
      for (const lb of layoutBar(t, bar).beats) {
        if (!lb.fits || lb.beat.isRest) continue;
        for (const n of [...lb.beat.notes].sort((a, b) => a.stringIndex - b.stringIndex)) {
          out.push(
            `t${ti} b${bar.index} +${lb.startTick} len${lb.ticks} s${n.stringIndex} f${n.fret}` +
              `${n.palmMute ? ' pm' : ''}${n.hammerOn ? ' h' : ''}${n.bend ? ' b' : ''}${n.slide ? ' sl' : ''}${n.harmonic ? ' nh' : ''}${n.tied ? ' tie' : ''}`,
          );
        }
      }
    }
  });
  return out;
}

// ---- 1. round trips
mkdirSync('ci-out', { recursive: true });
const songs: [string, Song][] = [
  ['demo', createDemoSong()],
  ...TEMPLATES.map((t) => [t.id, createTemplate(t.id)] as [string, Song]),
  ['blank 7/8', createBlankProject({ title: 'Odd', bpm: 95, numerator: 7, denominator: 8 })],
];
// Ties + tempo change + triplets + odd meters.
{
  const s = createDemoSong();
  const lead = s.tracks[2];
  if (isPitchedTrack(lead)) lead.beats[0].notes[0] = { ...lead.beats[0].notes[0] };
  const tied = structuredClone(s);
  const t2 = tied.tracks[2];
  if (isPitchedTrack(t2)) {
    const b = t2.beats.find((x) => x.barIndex === 0 && x.position === 2);
    if (b) b.notes = b.notes.map((n) => ({ ...n, tied: true }));
  }
  tied.bars[2] = { ...tied.bars[2], tempoOverride: 160 };
  songs.push(['demo + tie + tempo change', tied]);
}
for (const [name, song] of songs) {
  const bytes = exportGuitarPro(song);
  writeFileSync(`ci-out/${name.replace(/[^a-z0-9]+/gi, '-')}.gp`, bytes);
  const { song: back, report } = importGuitarPro(bytes, `${name}.gp`);
  const a = timeline(normalizeSong(JSON.parse(JSON.stringify(song))));
  const b = timeline(normalizeSong(back));
  const diff = a.filter((x, i) => x !== b[i]);
  check(a.length === b.length && diff.length === 0, `round trip "${name}": ${bytes.length} bytes, ${a.length} events identical (${describeImport(report)})`);
  if (diff.length) {
    console.log('   first differences:');
    a.forEach((x, i) => {
      if (x !== b[i] && i < 400) console.log(`   - ${x}\n   + ${b[i]}`);
    });
  }
  check(back.title === song.title && back.tracks.map((t) => t.name).join('|') === song.tracks.map((t) => t.name).join('|'), `"${name}": title and track names kept`);
}

// ---- 2. real Guitar Pro files
const settings = new alphaTab.Settings();
const dir = 'gp-samples';
let files: string[] = [];
try {
  files = readdirSync(dir).filter((f) => /\.(gp|gpx|gp5|gp4|gp3)$/i.test(f));
} catch {
  files = [];
}
check(files.length >= 10, `${files.length} real Guitar Pro sample files downloaded`);
for (const f of files) {
  try {
    const { song, report } = importGuitarPro(new Uint8Array(readFileSync(`${dir}/${f}`)), f);
    const normalized = normalizeSong(JSON.parse(JSON.stringify(song)));
    let texOk = 0;
    for (const t of normalized.tracks) {
      if (!isPitchedTrack(t)) continue;
      const tex = generateAlphaTex(normalized, t).tex;
      try {
        alphaTab.importer.ScoreLoader.loadAlphaTex(tex, settings);
        texOk += 1;
      } catch (e) {
        console.log(`   alphaTex for track "${t.name}" did not parse: ${(e as Error).message.slice(0, 160)}\n${tex.slice(0, 400)}`);
        throw e;
      }
    }
    check(normalized.tracks.length > 0 && normalized.bars.length > 0, `import ${f}: ${describeImport(report)}; ${texOk} tab track(s) render`);
  } catch (e) {
    check(false, `import ${f}: ${(e as Error).message}`);
  }
}

// ---- 3. repeats
const rep = files.find((f) => f.includes('repeat-close-alternate-endings'));
if (rep) {
  const score = alphaTab.importer.ScoreLoader.loadScoreFromBytes(new Uint8Array(readFileSync(`${dir}/${rep}`)), settings);
  const order = unrollRepeats(score.masterBars).join(',');
  check(order === '0,1,3,0,2,3,0,1,3,0,3,4', `alternate endings play in order: ${order}`);
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL GUITAR PRO CHECKS PASSED');
process.exit(failures ? 1 : 0);
