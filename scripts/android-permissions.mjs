#!/usr/bin/env node
/**
 * Adds the microphone permissions that the drum-kit recorder needs to the generated Android project.
 * `tauri android init` creates src-tauri/gen/android; run this after it (npm run android:init does both).
 * Safe to run repeatedly. Tauri's Android WebChromeClient asks the user for the runtime permission the first
 * time getUserMedia() is called.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = resolve(ROOT, 'src-tauri/gen/android/app/src/main/AndroidManifest.xml');
const PERMISSIONS = ['android.permission.RECORD_AUDIO', 'android.permission.MODIFY_AUDIO_SETTINGS'];

if (!existsSync(MANIFEST)) {
  console.log('[riffforge:android] no generated Android project yet - run `npm run android:init` first');
  process.exit(0);
}
let xml = readFileSync(MANIFEST, 'utf8');
const missing = PERMISSIONS.filter((p) => !xml.includes(`"${p}"`));
if (missing.length === 0) {
  console.log('[riffforge:android] microphone permissions already present');
  process.exit(0);
}
const lines = missing.map((p) => `    <uses-permission android:name="${p}" />`).join('\n');
if (!/<application[\s>]/.test(xml)) {
  console.error('[riffforge:android] could not find <application> in AndroidManifest.xml; add these manually:\n' + lines);
  process.exit(1);
}
xml = xml.replace(/(\n?)([ \t]*)<application([\s>])/, `\n${lines}\n$2<application$3`);
writeFileSync(MANIFEST, xml);
console.log(`[riffforge:android] added ${missing.join(', ')}`);
