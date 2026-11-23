#!/usr/bin/env node
/**
 * Fetches the recorded General MIDI percussion kit (FluidR3_GM, MIDI.js base64-MP3 format) into
 * src/assets/drumkits/ so Vite can bundle it with `?raw`. The app then runs fully offline in the
 * Windows and Android builds.
 *
 * Runs automatically on `npm install` (postinstall) and before `npm run dev` / `npm run build`.
 * It never fails the install: if every mirror is unreachable it writes an empty placeholder kit and the
 * app falls back to the procedural drum synth. Running it again later replaces the placeholder.
 *
 * Environment:
 *   RIFFFORGE_SKIP_DRUM_DOWNLOAD=1   only make sure a (placeholder) file exists; no network
 *   RIFFFORGE_DRUMKIT_URL=<url>      try this URL before the built-in mirrors
 *   RIFFFORGE_FORCE_DRUM_DOWNLOAD=1  re-download even if a valid kit is already present
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = resolve(ROOT, 'src/assets/drumkits/fluidr3-percussion-mp3.js');
const MIN_SAMPLES = 20;
const TIMEOUT_MS = 60_000;

/** paulrosen's fork of gleitz/midi-js-soundfonts is the one that includes the channel-10 percussion kit. */
const MIRRORS = [
  'https://paulrosen.github.io/midi-js-soundfonts/FluidR3_GM/percussion-mp3.js',
  'https://cdn.jsdelivr.net/gh/paulrosen/midi-js-soundfonts@gh-pages/FluidR3_GM/percussion-mp3.js',
  'https://raw.githubusercontent.com/paulrosen/midi-js-soundfonts/gh-pages/FluidR3_GM/percussion-mp3.js',
];

const SAMPLE_PATTERN = /["']([A-G][b#]?-?\d+)["']\s*:\s*["']data:audio\/mp3;base64,([^"']+)["']/g;

const PLACEHOLDER = `// RiffForge placeholder: the recorded drum kit could not be downloaded during install.
// Run \`npm run fetch-drums\` (with internet access) to fetch it; until then the procedural drum synth is used.
if (typeof(MIDI) === 'undefined') var MIDI = {};
if (typeof(MIDI.Soundfont) === 'undefined') MIDI.Soundfont = {};
MIDI.Soundfont.percussion = {};
`;

function countSamples(text) {
  let n = 0;
  SAMPLE_PATTERN.lastIndex = 0;
  while (SAMPLE_PATTERN.exec(text)) n += 1;
  return n;
}

function isValidKit(text) {
  return text.includes('MIDI.Soundfont') && countSamples(text) >= MIN_SAMPLES;
}

function log(msg) {
  console.log(`[riffforge:drums] ${msg}`);
}

async function download(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    if (!isValidKit(text)) throw new Error(`unexpected content (${text.length} bytes, ${countSamples(text)} samples)`);
    return text;
  } finally {
    clearTimeout(timer);
  }
}

function writeAtomic(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

async function main() {
  const existing = existsSync(TARGET) ? readFileSync(TARGET, 'utf8') : '';
  if (existing && isValidKit(existing) && !process.env.RIFFFORGE_FORCE_DRUM_DOWNLOAD) {
    log(`FluidR3 percussion kit present (${countSamples(existing)} samples) - ok`);
    return;
  }
  if (process.env.RIFFFORGE_SKIP_DRUM_DOWNLOAD) {
    if (!existing) writeAtomic(TARGET, PLACEHOLDER);
    log('download skipped (RIFFFORGE_SKIP_DRUM_DOWNLOAD); procedural drums will be used');
    return;
  }
  if (typeof fetch !== 'function') {
    if (!existing) writeAtomic(TARGET, PLACEHOLDER);
    log('this Node.js has no fetch(); use Node 18+ and run `npm run fetch-drums`');
    return;
  }
  const urls = [process.env.RIFFFORGE_DRUMKIT_URL, ...MIRRORS].filter(Boolean);
  for (const url of urls) {
    try {
      log(`downloading ${url}`);
      const text = await download(url);
      writeAtomic(TARGET, text);
      log(`saved ${countSamples(text)} recorded drum samples (${(text.length / 1024).toFixed(0)} KB)`);
      return;
    } catch (err) {
      log(`  failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (!existing || !isValidKit(existing)) {
    writeAtomic(TARGET, PLACEHOLDER);
    log('WARNING: could not download the drum kit; wrote a placeholder (procedural drums will be used).');
    log('         Run `npm run fetch-drums` once you are online to bundle the recorded kit.');
  }
}

main().catch((err) => {
  // Never break `npm install`.
  log(`unexpected error: ${err instanceof Error ? err.stack : String(err)}`);
  try {
    if (!existsSync(TARGET)) writeAtomic(TARGET, PLACEHOLDER);
  } catch {
    // ignore
  }
});
