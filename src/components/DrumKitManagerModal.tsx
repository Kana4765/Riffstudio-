import {
  Check,
  Copy,
  Download,
  Mic,
  Pencil,
  Play,
  Plus,
  Square,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { builtInKitLabel, decodeUserSample, drumSampler, DRUM_KITS } from '../audio/DrumSampler';
import { extensionForMime, micRecordingSupported, startHitRecording, type HitRecorder } from '../audio/recordHit';
import {
  KIT_PIECE_NAMES,
  KIT_PIECE_NOTES,
  createDrumKit,
  deleteDrumKit,
  duplicateDrumKit,
  exportDrumKit,
  importDrumKit,
  renameDrumKit,
  setKitBase,
  setKitSample,
  type CustomDrumKit,
  type CustomKitSummary,
  type KitPieceNote,
} from '../services/drumKitStorage';
import type { BuiltInDrumKitId } from '../types/song';
import { cx } from './ui';

interface DrumKitManagerModalProps {
  open: boolean;
  kits: CustomKitSummary[];
  /** Kit selected on the active drum track (opened first if it is a custom kit). */
  activeTrackKit: string;
  /** Called whenever the kit shown in the editor changes, so its samples are decoded for auditioning. */
  onEditingKitChange: (kitId: string | null) => void;
  onClose: () => void;
  onUseKit: (kit: CustomKitSummary) => void;
  onKitRenamedOrRebased: (kit: CustomKitSummary) => void;
  onKitDeleted: (kitId: string, baseKit: BuiltInDrumKitId) => void;
  onAudition: (kitId: string, note: number) => void;
  notify: (text: string, kind?: 'info' | 'error') => void;
}

const MAX_RECORD_SECONDS = 4;
const ACCEPT = 'audio/*,.wav,.mp3,.ogg,.flac';

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const btn =
  'flex h-11 min-w-11 shrink-0 items-center justify-center gap-1.5 rounded-xl border border-ink-600 bg-ink-800 px-3 text-xs font-semibold text-zinc-200 hover:bg-ink-700 active:bg-ink-600 disabled:cursor-not-allowed disabled:opacity-35';

function NewKitForm({ onCreate, onCancel }: { onCreate: (name: string, base: BuiltInDrumKitId) => void; onCancel: () => void }) {
  const [name, setName] = useState('');
  const [base, setBase] = useState<BuiltInDrumKitId>('rock');
  return (
    <form
      className="flex flex-col gap-2 rounded-xl border border-sky-500/40 bg-ink-950 p-2.5"
      onSubmit={(e) => {
        e.preventDefault();
        if (name.trim()) onCreate(name.trim(), base);
      }}
    >
      <input
        autoFocus
        value={name}
        maxLength={60}
        placeholder="Kit name, e.g. Tama"
        aria-label="New kit name"
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onCancel();
          e.stopPropagation();
        }}
        className="h-11 rounded-lg border border-ink-600 bg-ink-900 px-3 text-sm text-zinc-100 outline-none focus:border-sky-500"
      />
      <label className="flex flex-col gap-1 text-[11px] text-mist-400">
        Empty slots fall back to
        <select
          value={base}
          aria-label="New kit fallback"
          onChange={(e) => setBase(e.target.value as BuiltInDrumKitId)}
          className="h-11 rounded-lg border border-ink-600 bg-ink-900 px-2 text-sm text-zinc-100 outline-none"
        >
          {DRUM_KITS.map((k) => (
            <option key={k.id} value={k.id}>
              {k.label}
            </option>
          ))}
        </select>
      </label>
      <div className="flex gap-2">
        <button type="button" className={cx(btn, 'flex-1')} onClick={onCancel}>
          Cancel
        </button>
        <button
          type="submit"
          disabled={!name.trim()}
          className="flex h-11 flex-1 items-center justify-center gap-1 rounded-xl bg-orange-500 text-xs font-bold text-ink-950 hover:bg-orange-400 disabled:opacity-40"
        >
          <Check size={15} /> Create
        </button>
      </div>
    </form>
  );
}

interface RecordingState {
  note: number;
  recorder: HitRecorder;
}

export function DrumKitManagerModal(props: DrumKitManagerModalProps) {
  const { open, kits, activeTrackKit, notify } = props;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [renameDraft, setRenameDraft] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busyNote, setBusyNote] = useState<number | null>(null);
  const [recording, setRecording] = useState<RecordingState | null>(null);
  const [level, setLevel] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const fileInputs = useRef(new Map<number, HTMLInputElement>());
  const recordingRef = useRef<RecordingState | null>(null);
  recordingRef.current = recording;

  const selected = kits.find((k) => k.id === selectedId) ?? null;

  // Choose a kit when opening: the active track's custom kit, else the first kit.
  useEffect(() => {
    if (!open) return;
    setSelectedId((cur) => {
      if (cur && kits.some((k) => k.id === cur)) return cur;
      if (kits.some((k) => k.id === activeTrackKit)) return activeTrackKit;
      return kits[0]?.id ?? null;
    });
  }, [open, kits, activeTrackKit]);

  const { onEditingKitChange } = props;
  useEffect(() => {
    onEditingKitChange(open ? selectedId : null);
  }, [open, selectedId, onEditingKitChange]);

  useEffect(() => {
    setRenameDraft(null);
    setConfirmDelete(false);
  }, [selectedId]);

  // Stop any recording when the modal closes or unmounts.
  useEffect(() => {
    if (!open) recordingRef.current?.recorder.cancel();
  }, [open]);
  useEffect(() => () => recordingRef.current?.recorder.cancel(), []);

  // Level meter + elapsed time while recording.
  useEffect(() => {
    if (!recording) return;
    let raf = 0;
    const tick = () => {
      setLevel(recording.recorder.level());
      setElapsed((performance.now() - recording.recorder.startedAt) / 1000);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [recording]);

  const close = useCallback(() => {
    recordingRef.current?.recorder.cancel();
    setRecording(null);
    props.onClose();
  }, [props]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !creating && renameDraft === null) close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, close, creating, renameDraft]);

  /** Validates (decodes + trims) audio, stores it in the slot and refreshes the sampler cache. */
  const storeSample = async (note: number, fileName: string, arrayBuffer: ArrayBuffer, mimeType?: string) => {
    if (!selected) return;
    setBusyNote(note);
    try {
      const probe = new OfflineAudioContext(1, 1, 44100);
      let trimmedMs = 0;
      let seconds = 0;
      try {
        const original = await probe.decodeAudioData(arrayBuffer.slice(0));
        const trimmed = await decodeUserSample(probe, arrayBuffer);
        trimmedMs = Math.max(0, Math.round((original.duration - trimmed.duration) * 1000));
        seconds = trimmed.duration;
      } catch {
        throw new Error(`"${fileName}" isn't an audio format this device can decode (try WAV or MP3)`);
      }
      const saved: CustomDrumKit | null = await setKitSample(selected.id, note, { fileName, arrayBuffer, mimeType });
      if (saved) await drumSampler.ensureCustomKit(saved);
      notify(
        `${KIT_PIECE_NAMES[note as KitPieceNote]}: ${fileName} (${seconds.toFixed(2)} s${trimmedMs > 0 ? `, ${trimmedMs} ms silence trimmed` : ''})`,
      );
    } catch (err) {
      notify(errText(err), 'error');
    } finally {
      setBusyNote(null);
    }
  };

  const onFile = async (note: number, file: File | undefined) => {
    if (!file) return;
    await storeSample(note, file.name, await file.arrayBuffer(), file.type || undefined);
  };

  const finishRecording = async (state: RecordingState) => {
    setRecording(null);
    try {
      const hit = await state.recorder.stop();
      const piece = KIT_PIECE_NAMES[state.note as KitPieceNote].toLowerCase().replace(/[^a-z]+/g, '-');
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      await storeSample(state.note, `recorded-${piece}-${stamp}.${extensionForMime(hit.mimeType)}`, hit.arrayBuffer, hit.mimeType);
    } catch (err) {
      notify(errText(err), 'error');
    }
  };

  const toggleRecord = async (note: number) => {
    const current = recordingRef.current;
    if (current) {
      await finishRecording(current);
      if (current.note === note) return;
    }
    try {
      let state: RecordingState | null = null;
      const recorder = await startHitRecording(MAX_RECORD_SECONDS, () => {
        if (state && recordingRef.current === state) void finishRecording(state);
      });
      state = { note, recorder };
      setElapsed(0);
      setRecording(state);
    } catch (err) {
      notify(errText(err), 'error');
    }
  };

  const run = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (err) {
      notify(errText(err), 'error');
    }
  };

  if (!open) return null;

  const commitRename = () => {
    if (!selected || renameDraft === null) return;
    const name = renameDraft.trim();
    setRenameDraft(null);
    if (!name || name === selected.name) return;
    void run(async () => {
      const kit = await renameDrumKit(selected.id, name);
      if (kit) props.onKitRenamedOrRebased({ ...selected, name: kit.name, updatedAt: kit.updatedAt });
    });
  };

  const usedByTrack = selected?.id === activeTrackKit;

  return (
    <div className="fixed inset-0 z-50 flex items-stretch justify-center bg-black/65 sm:items-center sm:p-4" onClick={close}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Drum kit manager"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
        className="flex h-full w-full flex-col overflow-hidden bg-ink-900 pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] shadow-2xl sm:h-[88dvh] sm:max-w-5xl sm:rounded-2xl sm:border sm:border-ink-600 sm:pt-0 sm:pb-0"
      >
        <header className="flex shrink-0 items-center gap-2 border-b border-ink-700 px-3 py-2">
          <h2 className="flex-1 text-base font-bold text-zinc-100">Drum Kits</h2>
          <button type="button" aria-label="Close kit manager" onClick={close} className={cx(btn, 'border-transparent bg-transparent')}>
            <X size={18} />
          </button>
        </header>

        <div className="flex min-h-0 flex-1 flex-col md:flex-row">
          {/* Kit list */}
          <aside className="flex shrink-0 flex-col gap-2 border-b border-ink-700 p-3 md:w-64 md:border-r md:border-b-0">
            {creating ? (
              <NewKitForm
                onCancel={() => setCreating(false)}
                onCreate={(name, base) =>
                  void run(async () => {
                    const kit = await createDrumKit(name, base);
                    setCreating(false);
                    setSelectedId(kit.id);
                    notify(`Created kit “${kit.name}”`);
                  })
                }
              />
            ) : (
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setCreating(true)}
                  className="flex h-11 flex-1 items-center justify-center gap-1.5 rounded-xl bg-orange-500 text-sm font-bold text-ink-950 hover:bg-orange-400"
                >
                  <Plus size={16} /> New Kit
                </button>
                <button
                  type="button"
                  title="Import .rfkit.json"
                  className={btn}
                  onClick={() =>
                    void run(async () => {
                      const kit = await importDrumKit();
                      if (kit) {
                        setSelectedId(kit.id);
                        notify(`Imported “${kit.name}” (${Object.keys(kit.samples).length} pieces)`);
                      }
                    })
                  }
                >
                  <Upload size={15} /> Import
                </button>
              </div>
            )}
            <div className="touch-pan flex gap-2 overflow-x-auto pb-1 md:flex-col md:overflow-x-visible md:overflow-y-auto">
              {kits.length === 0 && !creating && (
                <p className="text-xs leading-relaxed text-mist-400">
                  No custom kits yet. Create one (e.g. “Tama”), then upload or record a sample for each piece you want to replace.
                </p>
              )}
              {kits.map((k) => (
                <button
                  key={k.id}
                  type="button"
                  onClick={() => setSelectedId(k.id)}
                  className={cx(
                    'flex min-h-11 shrink-0 flex-col items-start justify-center rounded-xl border px-3 py-1.5 text-left',
                    k.id === selectedId ? 'border-sky-400 bg-sky-500/15' : 'border-ink-700 bg-ink-950 hover:bg-ink-800',
                  )}
                >
                  <span className="max-w-[12rem] truncate text-sm font-semibold text-zinc-100">{k.name}</span>
                  <span className="text-[11px] text-mist-400">
                    {k.pieces.length}/10 custom · {k.baseKit === 'rock' ? 'Rock' : 'Acoustic'} fallback
                  </span>
                </button>
              ))}
            </div>
          </aside>

          {/* Kit editor */}
          <section className="touch-pan min-h-0 flex-1 overflow-y-auto p-3">
            {!selected ? (
              <div className="flex h-full items-center justify-center text-sm text-mist-400">Create or import a kit to start.</div>
            ) : (
              <div className="flex flex-col gap-3">
                <div className="flex flex-wrap items-center gap-2">
                  {renameDraft !== null ? (
                    <input
                      autoFocus
                      value={renameDraft}
                      maxLength={60}
                      aria-label="Kit name"
                      onChange={(e) => setRenameDraft(e.target.value)}
                      onBlur={commitRename}
                      onKeyDown={(e) => {
                        e.stopPropagation();
                        if (e.key === 'Enter') commitRename();
                        if (e.key === 'Escape') setRenameDraft(null);
                      }}
                      className="h-11 min-w-0 flex-1 rounded-xl border border-sky-500 bg-ink-950 px-3 text-lg font-bold text-zinc-100 outline-none"
                    />
                  ) : (
                    <h3 className="min-w-0 flex-1 truncate text-lg font-bold text-zinc-50">{selected.name}</h3>
                  )}
                  <button type="button" className={btn} title="Rename" onClick={() => setRenameDraft(selected.name)}>
                    <Pencil size={14} /> Rename
                  </button>
                  <button
                    type="button"
                    className={btn}
                    title="Duplicate"
                    onClick={() =>
                      void run(async () => {
                        const kit = await duplicateDrumKit(selected.id);
                        if (kit) setSelectedId(kit.id);
                      })
                    }
                  >
                    <Copy size={14} /> Duplicate
                  </button>
                  <button
                    type="button"
                    className={btn}
                    title="Export .rfkit.json"
                    onClick={() =>
                      void run(async () => {
                        const saved = await exportDrumKit(selected.id);
                        if (saved) notify(`Exported ${saved}`);
                      })
                    }
                  >
                    <Download size={14} /> Export
                  </button>
                  {confirmDelete ? (
                    <>
                      <button type="button" className={btn} onClick={() => setConfirmDelete(false)}>
                        Keep
                      </button>
                      <button
                        type="button"
                        className="flex h-11 items-center gap-1 rounded-xl bg-rose-500 px-3 text-xs font-bold text-ink-950 hover:bg-rose-400"
                        onClick={() =>
                          void run(async () => {
                            const { id, baseKit, name } = selected;
                            await deleteDrumKit(id);
                            props.onKitDeleted(id, baseKit);
                            setSelectedId(null);
                            notify(`Deleted “${name}”`);
                          })
                        }
                      >
                        <Trash2 size={14} /> Delete kit
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className={cx(btn, 'hover:border-rose-500/60 hover:text-rose-300')}
                      title="Delete kit"
                      aria-label="Delete kit"
                      onClick={() => setConfirmDelete(true)}
                    >
                      <Trash2 size={14} />
                    </button>
                  )}
                </div>

                <div className="flex flex-wrap items-center gap-2 rounded-xl border border-ink-700 bg-ink-950 p-2">
                  <label className="flex items-center gap-2 text-xs text-mist-400">
                    Fallback kit for empty slots
                    <select
                      value={selected.baseKit}
                      aria-label="Fallback kit"
                      onChange={(e) =>
                        void run(async () => {
                          const kit = await setKitBase(selected.id, e.target.value as BuiltInDrumKitId);
                          if (kit) {
                            await drumSampler.ensureCustomKit(kit);
                            props.onKitRenamedOrRebased({ ...selected, baseKit: kit.baseKit, updatedAt: kit.updatedAt });
                          }
                        })
                      }
                      className="h-11 rounded-lg border border-ink-600 bg-ink-800 px-2 text-sm text-zinc-100 outline-none"
                    >
                      {DRUM_KITS.map((k) => (
                        <option key={k.id} value={k.id}>
                          {k.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <div className="flex-1" />
                  <button
                    type="button"
                    disabled={usedByTrack}
                    onClick={() => props.onUseKit(selected)}
                    className="flex h-11 items-center gap-1.5 rounded-xl bg-sky-500 px-4 text-xs font-bold text-ink-950 hover:bg-sky-400 disabled:bg-emerald-500/20 disabled:text-emerald-300"
                  >
                    {usedByTrack ? (
                      <>
                        <Check size={14} /> Used on this track
                      </>
                    ) : (
                      'Use on this track'
                    )}
                  </button>
                </div>

                <ul className="flex flex-col gap-2">
                  {KIT_PIECE_NOTES.map((note) => {
                    const file = selected.files[note];
                    const isRec = recording?.note === note;
                    const busy = busyNote === note;
                    return (
                      <li
                        key={note}
                        className={cx(
                          'flex flex-wrap items-center gap-2 rounded-xl border p-2',
                          isRec ? 'border-rose-500/60 bg-rose-500/10' : 'border-ink-700 bg-ink-900',
                        )}
                      >
                        <div className="flex min-w-[10rem] flex-1 flex-col">
                          <span className="text-sm font-semibold text-zinc-100">
                            {KIT_PIECE_NAMES[note]} <span className="font-mono text-[10px] text-mist-400">#{note}</span>
                          </span>
                          {isRec ? (
                            <span className="flex items-center gap-2 text-[11px] text-rose-200">
                              <span className="h-2 w-2 animate-pulse rounded-full bg-rose-500" />
                              Recording {elapsed.toFixed(1)} / {MAX_RECORD_SECONDS}s — hit the drum
                              <span className="h-1.5 w-20 overflow-hidden rounded-full bg-ink-700">
                                <span className="block h-full bg-emerald-400" style={{ width: `${Math.round(Math.sqrt(level) * 100)}%` }} />
                              </span>
                            </span>
                          ) : busy ? (
                            <span className="text-[11px] text-sky-300">Processing…</span>
                          ) : file ? (
                            <span className="truncate text-[11px] text-emerald-300" title={file}>
                              Custom: {file}
                            </span>
                          ) : (
                            <span className="text-[11px] text-mist-400">Using fallback: {builtInKitLabel(selected.baseKit)}</span>
                          )}
                        </div>
                        <input
                          ref={(el) => {
                            if (el) fileInputs.current.set(note, el);
                            else fileInputs.current.delete(note);
                          }}
                          type="file"
                          accept={ACCEPT}
                          className="hidden"
                          aria-label={`Upload ${KIT_PIECE_NAMES[note]} sample`}
                          onChange={(e) => {
                            const f = e.target.files?.[0];
                            e.target.value = '';
                            void onFile(note, f);
                          }}
                        />
                        <div className="flex gap-1.5">
                          <button
                            type="button"
                            className={btn}
                            disabled={busy || isRec}
                            title="Upload an audio file"
                            aria-label={`Upload ${KIT_PIECE_NAMES[note]}`}
                            onClick={() => fileInputs.current.get(note)?.click()}
                          >
                            <Upload size={14} /> <span className="hidden sm:inline">Upload</span>
                          </button>
                          <button
                            type="button"
                            disabled={busy || !micRecordingSupported()}
                            aria-pressed={isRec}
                            title={isRec ? 'Stop and keep the recording' : 'Record from microphone / audio input'}
                            aria-label={`${isRec ? 'Stop recording' : 'Record'} ${KIT_PIECE_NAMES[note]}`}
                            onClick={() => void toggleRecord(note)}
                            className={cx(btn, isRec && 'border-rose-400 bg-rose-500 text-ink-950 hover:bg-rose-400')}
                          >
                            {isRec ? <Square size={14} /> : <Mic size={14} />}
                            <span className="hidden sm:inline">{isRec ? 'Stop' : 'Record'}</span>
                          </button>
                          <button
                            type="button"
                            className={btn}
                            disabled={busy || isRec}
                            title="Audition through the drum bus"
                            aria-label={`Play ${KIT_PIECE_NAMES[note]}`}
                            onClick={() => props.onAudition(selected.id, note)}
                          >
                            <Play size={14} />
                          </button>
                          <button
                            type="button"
                            className={btn}
                            disabled={!file || busy || isRec}
                            title="Clear (use the fallback kit)"
                            aria-label={`Clear ${KIT_PIECE_NAMES[note]}`}
                            onClick={() =>
                              void run(async () => {
                                const kit = await setKitSample(selected.id, note, null);
                                if (kit) await drumSampler.ensureCustomKit(kit);
                              })
                            }
                          >
                            <X size={14} />
                          </button>
                        </div>
                      </li>
                    );
                  })}
                </ul>
                <p className="text-[11px] leading-relaxed text-mist-400">
                  Samples play at their recorded pitch. Leading silence below −48 dBFS is trimmed automatically (with a 2 ms fade-in), so
                  recordings land exactly on the beat. Kits are stored on this device; use Export / Import to move them between your PC and
                  phone.
                </p>
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
