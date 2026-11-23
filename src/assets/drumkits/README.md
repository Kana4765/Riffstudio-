# Recorded drum kits

`fluidr3-percussion-mp3.js` is downloaded here by `scripts/fetch-drum-kits.mjs`. That script runs
automatically on `npm install`, `npm run dev` and `npm run build`, and you can also run it yourself with
`npm run fetch-drums`. Vite bundles the file with `?raw`, so desktop and Android builds play the
recorded kit with no network access.

The file is in the MIDI.js soundfont format: `MIDI.Soundfont.percussion = { "C2": "data:audio/mp3;base64,…", … }`.
It comes from the FluidR3_GM General MIDI percussion set (Frank Wen; pre-rendered by
gleitz/midi-js-soundfonts, with the percussion channel added in paulrosen/midi-js-soundfonts).

If the download fails, the script writes an empty placeholder and RiffForge uses its procedural drum synth.
You can also drop any MIDI.js-format `percussion-mp3.js` file in here under the same name yourself.
