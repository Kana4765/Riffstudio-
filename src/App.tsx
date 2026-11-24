import { ChevronUp, SlidersHorizontal } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AudioEngine, type TransportState } from './audio/AudioEngine';
import type { DrumKitStatus } from './audio/DrumSampler';
import { AddTrackModal } from './components/AddTrackModal';
import { BottomSheet } from './components/BottomSheet';
import { DrumKitManagerModal } from './components/DrumKitManagerModal';
import { DrumGridEditor } from './components/DrumGridEditor';
import { FxBar } from './components/FxBar';
import { HomePage } from './components/HomePage';
import { TabViewer } from './components/TabViewer';
import { BeatInspector, TouchDock, type EditorRhythmState } from './components/TabEditorPanels';
import { TrackMixer } from './components/TrackMixer';
import { TransportBar } from './components/TransportBar';
import { tuningPresetsFor } from './constants/presets';
import { createDemoSong } from './data/demoSong';
import { useCustomDrumKits } from './hooks/useCustomDrumKits';
import { useCoarsePointer, useIsMobile } from './hooks/useMediaQuery';
import type { CustomKitSummary } from './services/drumKitStorage';
import { openFile, saveBinaryFile, saveTextFile, safeFileName } from './services/fileService';
import {
  deleteRecentProject,
  duplicateRecentProject,
  listRecentProjects,
  saveRecentProject,
  type RecentProject,
} from './services/recentProjects';
import { playheadStore } from './state/playhead';
import { useSongHistory } from './state/useSongHistory';
import {
  clampBpm,
  isBuiltInKit,
  isDrumTrack,
  isPitchedTrack,
  type BuiltInDrumKitId,
  type DrumHit,
  type DrumTrack,
  type DrumMidiNote,
  type Duration,
  type FxChainSettings,
  type PitchedTrack,
  type Song,
  type TimeSigDenominator,
  type TimeSigNumerator,
  type Track,
} from './types/song';
import { GUITAR_PRO_EXTENSIONS, describeImport, exportGuitarPro, importGuitarPro, isGuitarProFileName } from './utils/guitarPro';
import { exportSongToMidi } from './utils/midiExport';
import {
  addBarAfter,
  applyFxPreset,
  applyTuning,
  createTrack,
  deleteBar,
  duplicateTrack,
  normalizeSong,
  setBarTimeSignature,
  updateTrack,
  type NewTrackOptions,
} from './utils/songOps';
import {
  clampCursor,
  deleteAtCursor,
  getBeatAt,
  insertBeatAfter,
  moveCursorHorizontal,
  moveCursorVertical,
  setBeatDuration,
  toggleBeatDotted,
  toggleBeatTriplet,
  toggleNoteFlag,
  toggleRest,
  writeFret,
  type NoteFlag,
  type PendingRhythm,
  type TabCursor,
} from './utils/tabEditing';
import { clamp, uid } from './utils/timing';

const DIGIT_WINDOW_MS = 600;
const AUTOSAVE_DEBOUNCE_MS = 800;

type View = 'home' | 'studio';

function songJson(song: Song): string {
  return JSON.stringify({ format: 'riffforge-song', version: 1, ...song }, null, 2);
}

/** Lowest string of the first pitched track — a sensible default cursor string for riffing. */
function defaultString(song: Song): number {
  const first = song.tracks.find(isPitchedTrack);
  return first ? first.tuning.length : 1;
}

interface Toast {
  id: number;
  text: string;
  kind: 'info' | 'error';
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

export default function App() {
  const history = useSongHistory(createDemoSong);
  const { song, commit } = history;
  const engine = useMemo(() => AudioEngine.get(), []);

  const isMobile = useIsMobile();
  const coarse = useCoarsePointer();
  const [view, setView] = useState<View>('home');
  const [projectOpen, setProjectOpen] = useState(false);
  const [recent, setRecent] = useState<RecentProject[]>(() => listRecentProjects());
  const [mixerSheet, setMixerSheet] = useState(false);
  const [kitManagerOpen, setKitManagerOpen] = useState(false);
  const [editingKitId, setEditingKitId] = useState<string | null>(null);
  const [fxSheet, setFxSheet] = useState(false);
  const [activeTrackId, setActiveTrackId] = useState<string>(() => song.tracks[0].id);
  const [rawCursor, setCursor] = useState<TabCursor>({ barIndex: 0, position: 0, stringIndex: 6 });
  const [pending, setPending] = useState<PendingRhythm>({ duration: 8, dotted: false, tuplet: false });
  const [transport, setTransport] = useState<TransportState>('stopped');
  const [kitStatus, setKitStatus] = useState<DrumKitStatus>(() => engine.drumKitStatus);
  const [loop, setLoop] = useState(false);
  const [metronome, setMetronome] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [fxOpen, setFxOpen] = useState(true);
  // Touch devices start with the thumb dock open.
  const [dockOpen, setDockOpen] = useState(() => window.matchMedia?.('(pointer: coarse)').matches ?? false);
  const [addOpen, setAddOpen] = useState(false);
  const [toast, setToast] = useState<Toast | null>(null);
  const [pendingDigits, setPendingDigits] = useState('');
  const digitBuffer = useRef<{ value: string; time: number; key: string } | null>(null);
  const digitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const activeTrack: Track = song.tracks.find((t) => t.id === activeTrackId) ?? song.tracks[0];
  const pitchedTrack: PitchedTrack | null = isPitchedTrack(activeTrack) ? activeTrack : null;
  const cursor: TabCursor = pitchedTrack
    ? clampCursor(pitchedTrack, song.bars, rawCursor)
    : { ...rawCursor, barIndex: clamp(rawCursor.barIndex, 0, song.bars.length - 1) };
  const cursorBeat = pitchedTrack ? getBeatAt(pitchedTrack, cursor.barIndex, cursor.position) : undefined;
  const cursorNote = cursorBeat?.notes.find((n) => n.stringIndex === cursor.stringIndex);
  const rhythm: EditorRhythmState = cursorBeat
    ? { duration: cursorBeat.duration, dotted: cursorBeat.dotted, triplet: cursorBeat.tuplet === 3, isRest: cursorBeat.isRest }
    : { duration: pending.duration, dotted: pending.dotted, triplet: pending.tuplet, isRest: false };

  const notify = useCallback((text: string, kind: Toast['kind'] = 'info') => setToast({ id: Date.now(), text, kind }), []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3200);
    return () => clearTimeout(t);
  }, [toast]);

  useEffect(() => {
    if (!song.tracks.some((t) => t.id === activeTrackId)) setActiveTrackId(song.tracks[0].id);
  }, [song.tracks, activeTrackId]);

  // ---------------------------------------------------------------- audio engine wiring
  useEffect(() => {
    engine.installAutoResume();
    setKitStatus(engine.drumKitStatus);
    return engine.subscribe(() => {
      setTransport(engine.transportState);
      setKitStatus(engine.drumKitStatus);
    });
  }, [engine]);
  useEffect(() => engine.setSong(song), [engine, song]);
  useEffect(() => engine.setMetronome(metronome), [engine, metronome]);
  useEffect(() => engine.setSpeed(speed), [engine, speed]);
  useEffect(() => engine.setLoopBar(loop ? cursor.barIndex : null), [engine, loop, cursor.barIndex]);
  useEffect(() => () => engine.stop(), [engine]);

  useEffect(() => {
    if (transport !== 'playing') {
      playheadStore.set(null);
      return;
    }
    let raf = 0;
    const frame = () => {
      const p = engine.getPosition();
      playheadStore.set(p ? { barIndex: p.barIndex, tickInBar: p.tickInBar } : null);
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [transport, engine]);

  const playPause = useCallback(() => {
    if (engine.transportState === 'playing') engine.pause();
    else void engine.play(cursor.barIndex);
  }, [engine, cursor.barIndex]);

  // ---------------------------------------------------------------- projects, home page & auto-save
  const latestSong = useRef(song);
  latestSong.current = song;
  const autosaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dirty = useRef(false);

  const flushAutosave = useCallback(() => {
    if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
    autosaveTimer.current = null;
    if (!dirty.current) return;
    dirty.current = false;
    saveRecentProject(latestSong.current);
  }, []);

  // Debounced auto-save of the open project to localStorage (riffforge_recent_projects).
  useEffect(() => {
    if (!projectOpen) return;
    dirty.current = true;
    if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
    autosaveTimer.current = setTimeout(flushAutosave, AUTOSAVE_DEBOUNCE_MS);
  }, [song, projectOpen, flushAutosave]);

  // Never lose the last edits when the window closes or the Android app is backgrounded.
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === 'hidden') flushAutosave();
    };
    window.addEventListener('pagehide', flushAutosave);
    document.addEventListener('visibilitychange', onHide);
    return () => {
      window.removeEventListener('pagehide', flushAutosave);
      document.removeEventListener('visibilitychange', onHide);
    };
  }, [flushAutosave]);

  const refreshRecent = useCallback(() => setRecent(listRecentProjects()), []);

  const openProject = useCallback(
    (next: Song) => {
      flushAutosave();
      engine.stop();
      history.replace(next);
      setActiveTrackId(next.tracks[0].id);
      setCursor({ barIndex: 0, position: 0, stringIndex: defaultString(next) });
      setLoop(false);
      setMixerSheet(false);
      setFxSheet(false);
      saveRecentProject(next);
      dirty.current = false;
      setProjectOpen(true);
      setView('studio');
    },
    [engine, history, flushAutosave],
  );

  const goHome = useCallback(() => {
    flushAutosave();
    engine.stop();
    setAddOpen(false);
    setMixerSheet(false);
    setFxSheet(false);
    refreshRecent();
    setView('home');
  }, [engine, flushAutosave, refreshRecent]);

  // ---------------------------------------------------------------- song-level actions
  const updatePitched = useCallback(
    (fn: (t: PitchedTrack) => PitchedTrack, coalesceKey?: string) => {
      commit((s) => updateTrack(s, activeTrack.id, (t) => (isPitchedTrack(t) ? fn(t) : t)), coalesceKey);
    },
    [commit, activeTrack.id],
  );

  const audition = useCallback(
    (stringIndex: number, fret: number) => {
      if (!pitchedTrack || engine.transportState === 'playing') return;
      void engine.auditionNote(pitchedTrack, stringIndex, fret, 0.7);
    },
    [engine, pitchedTrack],
  );

  const clearDigitBuffer = useCallback(() => {
    digitBuffer.current = null;
    setPendingDigits('');
    if (digitTimer.current) clearTimeout(digitTimer.current);
  }, []);

  const writeFretAt = useCallback(
    (fret: number, coalesceKey?: string) => {
      if (!pitchedTrack) return;
      updatePitched((t) => writeFret(t, cursor, fret, pending), coalesceKey);
      audition(cursor.stringIndex, fret);
    },
    [pitchedTrack, updatePitched, cursor, pending, audition],
  );

  const handleDigit = useCallback(
    (digit: number) => {
      const key = `${activeTrack.id}:${cursor.barIndex}:${cursor.position}:${cursor.stringIndex}`;
      const now = performance.now();
      const buf = digitBuffer.current;
      if (buf && buf.key === key && now - buf.time < DIGIT_WINDOW_MS && buf.value.length === 1) {
        const combined = Number(`${buf.value}${digit}`);
        if (combined <= 24) {
          clearDigitBuffer();
          writeFretAt(combined, `digit-${key}`);
          return;
        }
      }
      digitBuffer.current = { value: String(digit), time: now, key };
      setPendingDigits(String(digit));
      if (digitTimer.current) clearTimeout(digitTimer.current);
      digitTimer.current = setTimeout(() => {
        digitBuffer.current = null;
        setPendingDigits('');
      }, DIGIT_WINDOW_MS);
      writeFretAt(digit, `digit-${key}`);
    },
    [activeTrack.id, cursor, clearDigitBuffer, writeFretAt],
  );

  const move = useCallback(
    (dir: 'left' | 'right' | 'up' | 'down') => {
      if (!pitchedTrack) return;
      clearDigitBuffer();
      if (dir === 'left' || dir === 'right') {
        setCursor(moveCursorHorizontal(pitchedTrack, song.bars, cursor, dir === 'left' ? -1 : 1));
      } else {
        setCursor(moveCursorVertical(pitchedTrack, cursor, dir === 'up' ? -1 : 1));
      }
    },
    [pitchedTrack, song.bars, cursor, clearDigitBuffer],
  );

  const setDuration = useCallback(
    (d: Duration) => {
      setPending((p) => ({ ...p, duration: d }));
      if (cursorBeat) updatePitched((t) => setBeatDuration(t, cursor, d));
    },
    [cursorBeat, updatePitched, cursor],
  );

  const toggleDotted = useCallback(() => {
    if (cursorBeat) {
      setPending((p) => ({ ...p, dotted: !cursorBeat.dotted }));
      updatePitched((t) => toggleBeatDotted(t, cursor));
    } else setPending((p) => ({ ...p, dotted: !p.dotted }));
  }, [cursorBeat, updatePitched, cursor]);

  const toggleTriplet = useCallback(() => {
    if (cursorBeat) {
      setPending((p) => ({ ...p, tuplet: cursorBeat.tuplet !== 3 }));
      updatePitched((t) => toggleBeatTriplet(t, cursor));
    } else setPending((p) => ({ ...p, tuplet: !p.tuplet }));
  }, [cursorBeat, updatePitched, cursor]);

  const toggleFlag = useCallback((flag: NoteFlag) => updatePitched((t) => toggleNoteFlag(t, cursor, flag)), [updatePitched, cursor]);
  const toggleRestAction = useCallback(() => updatePitched((t) => toggleRest(t, cursor, pending)), [updatePitched, cursor, pending]);

  const insertBeat = useCallback(() => {
    if (!pitchedTrack) return;
    clearDigitBuffer();
    const result = insertBeatAfter(pitchedTrack, cursor, pending);
    commit((s) => updateTrack(s, pitchedTrack.id, (t) => (isPitchedTrack(t) ? insertBeatAfter(t, cursor, pending).track : t)));
    setCursor({ ...cursor, position: result.position });
  }, [pitchedTrack, cursor, pending, commit, clearDigitBuffer]);

  const deleteAction = useCallback(() => {
    if (!pitchedTrack) return;
    clearDigitBuffer();
    updatePitched((t) => deleteAtCursor(t, cursor).track);
  }, [pitchedTrack, updatePitched, cursor, clearDigitBuffer]);

  const selectBeat = useCallback(
    (barIndex: number, position: number, stringIndex?: number) => {
      clearDigitBuffer();
      setCursor((c) => ({ barIndex, position, stringIndex: stringIndex ?? c.stringIndex }));
    },
    [clearDigitBuffer],
  );

  const selectTrack = useCallback((id: string) => {
    setActiveTrackId(id);
    setCursor((c) => ({ ...c, position: 0 }));
  }, []);

  const addBar = useCallback(() => {
    commit((s) => addBarAfter(s, cursor.barIndex));
    setCursor((c) => ({ ...c, barIndex: cursor.barIndex + 1, position: 0 }));
  }, [commit, cursor.barIndex]);

  const removeBar = useCallback(() => {
    commit((s) => deleteBar(s, cursor.barIndex));
    setCursor((c) => ({ ...c, barIndex: Math.max(0, cursor.barIndex - (cursor.barIndex >= song.bars.length - 1 ? 1 : 0)), position: 0 }));
  }, [commit, cursor.barIndex, song.bars.length]);

  const setTimeSig = useCallback(
    (numerator: number, denominator: number) =>
      commit((s) => setBarTimeSignature(s, cursor.barIndex, numerator as TimeSigNumerator, denominator as TimeSigDenominator)),
    [commit, cursor.barIndex],
  );

  const exportSongJson = useCallback(
    async (target: Song) => {
      try {
        const saved = await saveTextFile(`${safeFileName(target.title)}.json`, songJson(target), { name: 'RiffForge Song', extensions: ['json'] });
        if (saved) notify(`Saved ${saved}`);
      } catch (e) {
        notify(`Save failed: ${e instanceof Error ? e.message : String(e)}`, 'error');
      }
    },
    [notify],
  );

  const saveSong = useCallback(() => {
    flushAutosave();
    void exportSongJson(song);
  }, [song, exportSongJson, flushAutosave]);

  const loadSong = useCallback(async () => {
    try {
      const file = await openFile({ name: 'RiffForge song or Guitar Pro file', extensions: ['json', ...GUITAR_PRO_EXTENSIONS] });
      if (!file) return;
      if (isGuitarProFileName(file.name)) {
        const { song: imported, report } = importGuitarPro(file.bytes, file.name);
        openProject(normalizeSong(imported));
        notify(`Imported “${report.title}”: ${describeImport(report)}`);
        return;
      }
      const loaded: Song = normalizeSong(JSON.parse(new TextDecoder().decode(file.bytes)));
      openProject(loaded);
      notify(`Loaded ${file.name}`);
    } catch (e) {
      notify(`Load failed: ${e instanceof Error ? e.message : String(e)}`, 'error');
    }
  }, [openProject, notify]);


  const exportGp = useCallback(async () => {
    try {
      const saved = await saveBinaryFile(
        `${safeFileName(song.title)}.gp`,
        exportGuitarPro(song),
        { name: 'Guitar Pro 7/8', extensions: ['gp'] },
        'application/octet-stream',
      );
      if (saved) notify(`Exported ${saved} (opens in Guitar Pro 7 and 8)`);
    } catch (e) {
      notify(`Guitar Pro export failed: ${e instanceof Error ? e.message : String(e)}`, 'error');
    }
  }, [song, notify]);

  const exportMidi = useCallback(async () => {
    try {
      const saved = await saveBinaryFile(
        `${safeFileName(song.title)}.mid`,
        exportSongToMidi(song),
        { name: 'Standard MIDI File', extensions: ['mid'] },
        'audio/midi',
      );
      if (saved) notify(`Exported ${saved}`);
    } catch (e) {
      notify(`MIDI export failed: ${e instanceof Error ? e.message : String(e)}`, 'error');
    }
  }, [song, notify]);

  // ---------------------------------------------------------------- keyboard shortcuts
  const keyHandler = useRef<(e: KeyboardEvent) => void>(() => undefined);
  keyHandler.current = (e: KeyboardEvent) => {
    if (view !== 'studio' || addOpen || mixerSheet || fxSheet || kitManagerOpen || isTypingTarget(e.target)) return;
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key;
    if (mod) {
      const lower = key.toLowerCase();
      if (lower === 'z' && !e.shiftKey) {
        e.preventDefault();
        history.undo();
      } else if (lower === 'y' || (lower === 'z' && e.shiftKey)) {
        e.preventDefault();
        history.redo();
      } else if (lower === 's') {
        e.preventDefault();
        saveSong();
      }
      return;
    }
    if (key === ' ' || e.code === 'Space') {
      e.preventDefault();
      playPause();
      return;
    }
    if (!pitchedTrack || e.altKey) return;
    if (/^[0-9]$/.test(key)) {
      e.preventDefault();
      handleDigit(Number(key));
      return;
    }
    const arrows: Record<string, 'left' | 'right' | 'up' | 'down'> = {
      ArrowLeft: 'left',
      ArrowRight: 'right',
      ArrowUp: 'up',
      ArrowDown: 'down',
    };
    if (arrows[key]) {
      e.preventDefault();
      move(arrows[key]);
      return;
    }
    const lower = key.length === 1 ? key.toLowerCase() : key;
    const current = rhythm.duration;
    switch (lower) {
      case '+':
        e.preventDefault();
        setDuration(Math.min(32, current * 2) as Duration);
        break;
      case '-':
        e.preventDefault();
        setDuration(Math.max(1, current / 2) as Duration);
        break;
      case '.':
        e.preventDefault();
        toggleDotted();
        break;
      case 't':
        toggleTriplet();
        break;
      case 'r':
        toggleRestAction();
        break;
      case 'm':
        toggleFlag('palmMute');
        break;
      case 'h':
        toggleFlag('hammerOn');
        break;
      case 'b':
        toggleFlag('bend');
        break;
      case 's':
        toggleFlag('slide');
        break;
      case 'n':
        toggleFlag('harmonic');
        break;
      case 'l':
        toggleFlag('tied');
        break;
      case 'Insert':
      case 'Enter':
        e.preventDefault();
        insertBeat();
        break;
      case 'Delete':
      case 'Backspace':
        e.preventDefault();
        deleteAction();
        break;
      default:
        break;
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => keyHandler.current(e);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // ---------------------------------------------------------------- mixer / tracks
  const changeTrack = useCallback(
    (id: string, patch: Partial<Pick<Track, 'name' | 'volume' | 'pan' | 'muted' | 'solo'>>, coalesceKey?: string) =>
      commit((s) => updateTrack(s, id, (t) => ({ ...t, ...patch }) as Track), coalesceKey),
    [commit],
  );

  const createNewTrack = useCallback(
    (opts: NewTrackOptions) => {
      const track = createTrack(opts);
      commit((s) => ({ ...s, tracks: [...s.tracks, track] }));
      setActiveTrackId(track.id);
      setCursor({ barIndex: cursor.barIndex, position: 0, stringIndex: 1 });
      setAddOpen(false);
      notify(`Added ${track.name}`);
    },
    [commit, cursor.barIndex, notify],
  );

  const duplicate = useCallback(
    (id: string) => {
      const newId = uid('trk');
      commit((s) => duplicateTrack(s, id, newId));
      setActiveTrackId(newId);
    },
    [commit],
  );

  const removeTrack = useCallback(
    (id: string) => {
      if (song.tracks.length <= 1) return;
      const idx = song.tracks.findIndex((t) => t.id === id);
      const fallback = song.tracks[idx + 1] ?? song.tracks[idx - 1];
      commit((s) => ({ ...s, tracks: s.tracks.filter((t) => t.id !== id) }));
      if (id === activeTrackId && fallback) setActiveTrackId(fallback.id);
    },
    [song.tracks, commit, activeTrackId],
  );

  const changeFx = useCallback(
    (fx: FxChainSettings, coalesceKey?: string) => {
      engine.updateFx(activeTrack.id, fx);
      updatePitched((t) => ({ ...t, fxChain: fx }), coalesceKey);
    },
    [engine, activeTrack.id, updatePitched],
  );

  const changeDrumHits = useCallback(
    (updater: (hits: DrumHit[]) => DrumHit[], coalesceKey?: string) =>
      commit((s) => updateTrack(s, activeTrack.id, (t) => (isDrumTrack(t) ? { ...t, hits: updater(t.hits) } : t)), coalesceKey),
    [commit, activeTrack.id],
  );

  // ---------------------------------------------------------------- custom drum kits (IndexedDB)
  const usedKitIds = song.tracks.flatMap((t) => (isDrumTrack(t) && t.kit && !isBuiltInKit(t.kit) ? [t.kit] : []));
  const neededKitIds = editingKitId ? [...usedKitIds, editingKitId] : usedKitIds;
  const customDrumKits = useCustomDrumKits(neededKitIds);

  const withKit = (t: DrumTrack, kitId: string, summary: CustomKitSummary | undefined): DrumTrack => {
    const { kitName: _name, kitBase: _base, ...rest } = t;
    void _name;
    void _base;
    if (isBuiltInKit(kitId) || !summary) return { ...rest, kit: kitId };
    return { ...rest, kit: kitId, kitName: summary.name, kitBase: summary.baseKit };
  };

  const selectDrumKit = useCallback(
    (kitId: string) => {
      const summary = customDrumKits.kits.find((k) => k.id === kitId);
      commit((s) => updateTrack(s, activeTrack.id, (t) => (isDrumTrack(t) ? withKit(t, kitId, summary) : t)));
    },
    [commit, activeTrack.id, customDrumKits.kits],
  );

  /** Keeps every track that uses a kit in sync after a rename / fallback change (one undo step). */
  const syncKitOnTracks = useCallback(
    (summary: CustomKitSummary) =>
      commit((s) => ({
        ...s,
        tracks: s.tracks.map((t) => (isDrumTrack(t) && t.kit === summary.id ? withKit(t, summary.id, summary) : t)),
      })),
    [commit],
  );

  const kitDeleted = useCallback(
    (kitId: string, baseKit: BuiltInDrumKitId) =>
      commit((s) => ({
        ...s,
        tracks: s.tracks.map((t) => (isDrumTrack(t) && t.kit === kitId ? withKit(t, baseKit, undefined) : t)),
      })),
    [commit],
  );

  const auditionKitPiece = useCallback(
    (kitId: string, note: number) => {
      if (isDrumTrack(activeTrack)) void engine.auditionDrum(activeTrack, note, 110, kitId);
    },
    [engine, activeTrack],
  );

  const auditionDrum = useCallback(
    (note: DrumMidiNote, velocity: number) => {
      if (isDrumTrack(activeTrack) && engine.transportState !== 'playing') void engine.auditionDrum(activeTrack, note, velocity);
    },
    [engine, activeTrack],
  );

  const tuningOptions = useMemo(
    () => (pitchedTrack ? tuningPresetsFor(pitchedTrack.instrumentType).map((p) => p.name) : []),
    [pitchedTrack],
  );

  const toastNode = toast && (
    <div
      key={toast.id}
      role="status"
      className={`pointer-events-none fixed bottom-[calc(1rem+env(safe-area-inset-bottom))] left-1/2 z-50 max-w-[90vw] -translate-x-1/2 rounded-full border px-4 py-2 text-sm shadow-xl ${
        toast.kind === 'error' ? 'border-rose-500/50 bg-rose-950 text-rose-100' : 'border-ink-600 bg-ink-800 text-zinc-100'
      }`}
    >
      {toast.text}
    </div>
  );

  if (view === 'home') {
    return (
      <div className="app-shell flex flex-col overflow-hidden bg-ink-950 text-zinc-100">
        <HomePage
          recent={recent}
          currentSong={projectOpen ? song : null}
          onContinue={() => setView('studio')}
          onOpenSong={openProject}
          onOpenFile={() => void loadSong()}
          onDuplicateRecent={(id) => {
            const copy = duplicateRecentProject(id);
            refreshRecent();
            if (copy) notify(`Duplicated as “${copy.title}”`);
          }}
          onExportRecent={(target) => void exportSongJson(target)}
          onDeleteRecent={(id) => {
            deleteRecentProject(id);
            refreshRecent();
          }}
        />
        {toastNode}
      </div>
    );
  }

  const mixer = (variant: 'sidebar' | 'sheet') => (
    <TrackMixer
      variant={variant}
      tracks={song.tracks}
      activeTrackId={activeTrack.id}
      onSelect={(id) => {
        selectTrack(id);
        // On phones, picking a track closes the sheet so the editor for that track is visible.
        if (variant === 'sheet') setMixerSheet(false);
      }}
      onChange={changeTrack}
      onDuplicate={duplicate}
      onDelete={removeTrack}
      onAdd={() => {
        setMixerSheet(false);
        setAddOpen(true);
      }}
    />
  );

  const fxBar = (layout: 'bar' | 'sheet') =>
    pitchedTrack && (
      <FxBar
        layout={layout}
        track={pitchedTrack}
        onChange={changeFx}
        onPreset={(preset) => updatePitched((t) => applyFxPreset(t, preset))}
        onTest={() => void engine.auditionTestChord(pitchedTrack)}
      />
    );

  return (
    <div className="app-shell flex flex-col overflow-hidden bg-ink-950 text-zinc-100">
      <TransportBar
        song={song}
        isMobile={isMobile}
        transport={transport}
        selectedBar={cursor.barIndex}
        loop={loop}
        metronome={metronome}
        speed={speed}
        fxOpen={fxOpen}
        fxAvailable={pitchedTrack !== null}
        canUndo={history.canUndo}
        canRedo={history.canRedo}
        onHome={goHome}
        onPlayPause={playPause}
        onStop={() => engine.stop()}
        onToggleLoop={() => setLoop((l) => !l)}
        onToggleMetronome={() => setMetronome((m) => !m)}
        onBpmChange={(bpm) => commit((s) => ({ ...s, bpm: clampBpm(bpm) }), 'bpm')}
        onSpeedChange={setSpeed}
        onUndo={history.undo}
        onRedo={history.redo}
        onAddBar={addBar}
        onDeleteBar={removeBar}
        onTimeSignature={setTimeSig}
        onToggleFx={() => setFxOpen((o) => !o)}
        onSave={saveSong}
        onLoad={() => void loadSong()}
        onExportMidi={() => void exportMidi()}
        onExportGp={() => void exportGp()}
        onTitleChange={(title) => commit((s) => ({ ...s, title }), 'title')}
      />

      {isMobile && (
        <nav aria-label="Studio panels" className="flex shrink-0 items-center gap-2 border-b border-ink-700 bg-ink-950 px-2 py-1.5">
          <button
            type="button"
            onClick={() => setMixerSheet(true)}
            className="flex h-11 min-w-0 flex-1 items-center gap-2 rounded-full border border-ink-600 bg-ink-800 px-3 text-sm text-zinc-100 active:bg-ink-700"
          >
            <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: activeTrack.color }} />
            <span className="truncate font-semibold">{activeTrack.name}</span>
            <span className="ml-auto shrink-0 text-[11px] text-mist-400">Mixer · {song.tracks.length}</span>
            <ChevronUp size={16} className="shrink-0 text-mist-400" />
          </button>
          {pitchedTrack && (
            <button
              type="button"
              onClick={() => setFxSheet(true)}
              className="flex h-11 shrink-0 items-center gap-1.5 rounded-full border border-orange-500/40 bg-orange-500/15 px-4 text-sm font-semibold text-orange-200 active:bg-orange-500/25"
            >
              <SlidersHorizontal size={15} /> FX
            </button>
          )}
        </nav>
      )}

      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        {!isMobile && mixer('sidebar')}

        <main className="flex min-h-0 min-w-0 flex-1 flex-col">
          {pitchedTrack ? (
            <>
              {!isMobile && fxOpen && fxBar('bar')}
              <BeatInspector
                track={pitchedTrack}
                cursor={cursor}
                beat={cursorBeat}
                rhythm={rhythm}
                pendingDigits={pendingDigits}
                dockOpen={dockOpen}
                tuningOptions={tuningOptions}
                onSelectString={(s) => {
                  setCursor({ ...cursor, stringIndex: s });
                  const n = cursorBeat?.notes.find((x) => x.stringIndex === s);
                  if (n) audition(s, n.fret);
                }}
                onToggleDock={() => setDockOpen((d) => !d)}
                onTuningChange={(name) => updatePitched((t) => applyTuning(t, name))}
              />
              <TabViewer
                song={song}
                track={pitchedTrack}
                cursor={cursor}
                isPlaying={transport === 'playing'}
                onSelect={selectBeat}
              />
              {dockOpen && (
                <TouchDock
                  rhythm={rhythm}
                  note={cursorNote}
                  currentFret={cursorNote?.fret ?? null}
                  onFret={(f) => {
                    clearDigitBuffer();
                    writeFretAt(f);
                  }}
                  onMove={move}
                  onDuration={setDuration}
                  onDotted={toggleDotted}
                  onTriplet={toggleTriplet}
                  onFlag={toggleFlag}
                  onRest={toggleRestAction}
                  onInsert={insertBeat}
                  onDelete={deleteAction}
                  onClose={() => setDockOpen(false)}
                />
              )}
            </>
          ) : isDrumTrack(activeTrack) ? (
            <DrumGridEditor
              song={song}
              track={activeTrack}
              selectedBar={cursor.barIndex}
              touch={isMobile || coarse}
              onSelectBar={(barIndex) => setCursor((c) => ({ ...c, barIndex, position: 0 }))}
              onChangeHits={changeDrumHits}
              onAudition={auditionDrum}
              kitStatus={kitStatus}
              onKitChange={selectDrumKit}
              customKits={customDrumKits.kits}
              onManageKits={() => {
                if (customDrumKits.error) notify(`Custom kits unavailable: ${customDrumKits.error}`, 'error');
                else setKitManagerOpen(true);
              }}
            />
          ) : null}
        </main>
      </div>

      {isMobile && (
        <>
          <BottomSheet open={mixerSheet} title="Mixer & Tracks" onClose={() => setMixerSheet(false)}>
            {mixer('sheet')}
          </BottomSheet>
          <BottomSheet open={fxSheet && pitchedTrack !== null} title={`Pedalboard · ${activeTrack.name}`} onClose={() => setFxSheet(false)}>
            {fxBar('sheet')}
          </BottomSheet>
        </>
      )}

      {isDrumTrack(activeTrack) && (
        <DrumKitManagerModal
          open={kitManagerOpen}
          kits={customDrumKits.kits}
          activeTrackKit={activeTrack.kit ?? 'rock'}
          onEditingKitChange={setEditingKitId}
          onClose={() => setKitManagerOpen(false)}
          onUseKit={(k) => selectDrumKit(k.id)}
          onKitRenamedOrRebased={syncKitOnTracks}
          onKitDeleted={kitDeleted}
          onAudition={auditionKitPiece}
          notify={notify}
        />
      )}

      <AddTrackModal open={addOpen} existingCount={song.tracks.length} onCancel={() => setAddOpen(false)} onCreate={createNewTrack} />
      {toastNode}
    </div>
  );
}

