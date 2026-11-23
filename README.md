# RiffForge Studio

Multi-track Guitar Pro-style tablature, overdrive/distortion and MIDI drum songwriting workstation for **Windows** (Tauri v2 `.exe`/`.msi`) and **Android** (Tauri v2 `.apk`), also runnable in any modern browser.

- **Notation:** alphaTab (tab + rhythm stems), compiled from the song model to alphaTex. alphaTab's own player is disabled; it only renders and reports clicks.
- **Audio:** a native Web Audio engine using a 480-PPQ master clock. The scheduler wakes every 25 ms and schedules 100 ms ahead. Strings use Karplus-Strong synthesis, keys use a detuned saw + triangle, drums are procedural, and each pitched track has its own Overdrive → Distortion chain. Everything feeds a master limiter.
- **Files:** Save/Load `.json` and export Format-1 `.mid`. Inside Tauri these use native dialogs; in a browser they use file input and download.
- **Home page:** create a new project (title, BPM, time signature) or start from one of four templates: Full Rock/Metal Band, Riff Sketchpad, Dual Guitar Harmony and Drum Groove Builder. You can also open a `.json` file or pick a recent project. The open project auto-saves to `localStorage` (`riffforge_recent_projects`) 0.8 s after each edit, and also when the app is hidden or closed.
- **Tempo:** 30–300 BPM. While you type in the BPM field nothing is applied; the value is checked and set on Enter or when you leave the field, and Esc puts the old tempo back. There are −5/−1/+1/+5 buttons, and Tap Tempo averages your last 4 taps.
- **Drums:** recorded samples from the FluidR3_GM General MIDI percussion set. They're downloaded when you run `npm install` and bundled into the app, so desktop and Android builds play them with no network access. Each drum track picks a kit in the drum-grid toolbar: **Rock Kit (FluidR3, rock voicing)**, the default, which tunes the kick, snare and toms down and adds more drive and room, or **Studio Acoustic (FluidR3)**, the kit as recorded. Hits are scaled by velocity as `(v/127)^1.6`, with small random variations in pitch (±1.2%) and level (±3%), and a closed hi-hat cuts a ringing open hat within 25 ms. Everything goes through the track's drum bus: saturation, a glue compressor and a 0.35 s stereo room. If the kit isn't available, the procedural drum synth plays instead, and the toolbar badge shows whether you're hearing the recorded kit or the synth.
- **Mobile (< 768 px):** the header keeps only Home, Play, Stop, the BPM stepper and a More menu. The mixer and the pedalboard open as slide-up sheets. Every touch target is at least 44 px, and the score and drum grid follow the playhead as it moves.

## Commands

```bash
# 1. Install dependencies. This also downloads the recorded drum kit (~0.8 MB) into src/assets/drumkits/.
npm install

# 2. Web dev mode (http://localhost:1420)
npm run dev

# 3. Desktop dev window (Tauri)
npm run tauri dev

# 4. Windows installer (.exe via NSIS + .msi via WiX) — run on Windows
npm run tauri build
#   -> src-tauri/target/release/bundle/nsis/*.exe and bundle/msi/*.msi

# 5. Android (.apk) — needs Android Studio, SDK, NDK, JAVA_HOME / ANDROID_HOME / NDK_HOME set
rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android
npm run android:init     # tauri android init + microphone permissions + Android icons
npm run android:dev      # run on a device/emulator
npm run android:build    # -> src-tauri/gen/android/app/build/outputs/apk/universal/release/
```

The release APK is unsigned. Sign it with `apksigner` (or set up signing in `src-tauri/gen/android`) before installing it outside of dev mode.

## Custom drum kits

Use **Manage Kits** in the drum-grid toolbar to make as many named kits as you like (for example "Tama", "Pearl" or "Mapex"). For each of the
10 pieces you can **upload** a file (WAV, MP3, OGG or FLAC) or **record** one hit from a microphone or audio interface, then **play**
it through the drum bus or **clear** it. Echo cancellation, noise suppression and auto-gain are switched off for recording.

- **Fallback:** any piece without a sample uses the kit's fallback (Rock or Acoustic), so a kit with only a custom snare and hats works straight away.
- **Pitch:** custom samples play at their recorded pitch. The Rock kit's downward retuning only applies to the built-in pieces it falls back to.
- **Trimming:** silence before the hit (anything below −48 dBFS) is cut off automatically, keeping a 2 ms fade-in, so recordings land on the beat.
- **Storage:** kits are stored in IndexedDB (`riffforge_drum_kits` database). A song saves which kit its drum track uses, plus that kit's name and fallback.
  If you open the song on a device that doesn't have the kit, the track plays the fallback kit instead.
- **Moving kits:** **Export** saves a portable `.rfkit.json` file with the audio inside, and **Import** loads it on another device, for example from your PC to your phone.
- **Android microphone:** `npm run android:init` (and `android:dev` / `android:build`) adds `RECORD_AUDIO` and
  `MODIFY_AUDIO_SETTINGS` to the generated `AndroidManifest.xml`. Android asks the user for permission the first time they record.

## Recorded drum kit download

`scripts/fetch-drum-kits.mjs` runs on `npm install` and again before `npm run dev` and `npm run build`. It downloads
`FluidR3_GM/percussion-mp3.js` from Paul Rosen's fork of gleitz/midi-js-soundfonts (the fork that includes
the percussion channel). It tries GitHub Pages first, then jsDelivr, then raw.githubusercontent. The file is saved to
`src/assets/drumkits/fluidr3-percussion-mp3.js`, which is git-ignored, and Vite bundles it with `?raw`.

- If the download fails (for example when you're offline or behind a proxy that Node's `fetch` doesn't go through), the install
  still succeeds. The script writes a placeholder and the app uses synth drums. Run `npm run fetch-drums` later, or put any
  MIDI.js-format percussion file at that path yourself.
- To use a different source, set `RIFFFORGE_DRUMKIT_URL=<url>`. To skip the network entirely, set `RIFFFORGE_SKIP_DRUM_DOWNLOAD=1`.
- The npm package called `midi-js-soundfonts` is an empty placeholder (version 1.0.0, containing only a package.json), so it is not used.

## Credits

FluidR3_GM soundfont by Frank Wen. MIDI.js pre-rendering by Benjamin Gleitzman (gleitz/midi-js-soundfonts),
with the percussion set from Paul Rosen's fork (paulrosen/midi-js-soundfonts). See those repositories for license terms.

## Keyboard shortcuts (tab editor)

| Key | Action |
| --- | --- |
| Space | Play / pause |
| Ctrl+Z / Ctrl+Y | Undo / redo |
| ← → / ↑ ↓ | Move across beats / strings |
| 0–9 | Write a fret. A second digit typed within 600 ms makes frets 10–24 |
| + / - | Halve / double the duration |
| . / T / R | Dotted / triplet / rest |
| M / H / B / S / N | Palm mute / hammer-on / bend / slide / natural harmonic |
| Insert or Enter | Insert the next beat |
| Delete or Backspace | Clear the note, or the beat if it's empty |

## Project layout

```
src/audio/        AudioEngine.ts (scheduler, mixer, limiter), Synthesizers.ts, GuitarFxChain.ts
src/types/        song.ts — unified 480-PPQ data model
src/utils/        alphaTexGenerator.ts, midiExport.ts, tabEditing.ts, songOps.ts, timing.ts
src/services/     fileService.ts — Tauri dialog/fs ↔ browser fallback
src/components/   TransportBar, TrackMixer, AddTrackModal, FxBar, TabViewer, TabEditorPanels, DrumGridEditor
src/data/         demoSong.ts — 4-bar, 5-track demo
src-tauri/        Tauri v2 config, capabilities, Rust entry points, icons
```

## Notes

- **Karplus-Strong tuning.** A feedback loop can't be shorter than one 128-frame render quantum, and Chromium adds a full quantum of latency to every cycle. At start-up the engine measures this behaviour on the current WebView, and high notes run the loop over several whole periods. Strings stay within about 1 cent from E1 to E6.
- **Tempo, speed and loop changes** take effect from the next bar.
- **Overfull bars.** Beats that go past the end of a bar are hidden in the notation and are not played. A warning banner names the bar.
