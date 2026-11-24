import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  CornerDownLeft,
  Delete,
  Hand,
  Keyboard,
} from 'lucide-react';
import { useEffect, useRef, type ReactNode } from 'react';
import { DURATIONS, type Duration, type PitchedTrack, type TabBeat, type TabNote } from '../types/song';
import type { NoteFlag, TabCursor } from '../utils/tabEditing';
import { DURATION_LABELS, midiToNoteName } from '../utils/timing';
import { cx } from './ui';

export interface EditorRhythmState {
  duration: Duration;
  dotted: boolean;
  triplet: boolean;
  isRest: boolean;
}

const FLAG_LABELS: { flag: NoteFlag; label: string; key: string }[] = [
  { flag: 'palmMute', label: 'PM', key: 'M' },
  { flag: 'hammerOn', label: 'H/P', key: 'H' },
  { flag: 'bend', label: 'Bend', key: 'B' },
  { flag: 'slide', label: 'Slide', key: 'S' },
  { flag: 'harmonic', label: 'Harm', key: 'N' },
  { flag: 'tied', label: 'Tie', key: 'L' },
];

interface InspectorProps {
  track: PitchedTrack;
  cursor: TabCursor;
  beat: TabBeat | undefined;
  rhythm: EditorRhythmState;
  pendingDigits: string;
  dockOpen: boolean;
  tuningOptions: string[];
  onSelectString: (stringIndex: number) => void;
  onToggleDock: () => void;
  onTuningChange: (preset: string) => void;
}

/** Compact strip showing the cursor beat as a vertical "string rack" (click a string to move the cursor). */
export function BeatInspector({
  track,
  cursor,
  beat,
  rhythm,
  pendingDigits,
  dockOpen,
  tuningOptions,
  onSelectString,
  onToggleDock,
  onTuningChange,
}: InspectorProps) {
  const notesByString = new Map<number, TabNote>((beat?.notes ?? []).map((n) => [n.stringIndex, n]));
  return (
    <div className="flex shrink-0 items-center gap-2 overflow-x-auto border-b border-ink-700 bg-ink-900 px-2 py-1.5 [scrollbar-width:none]">
      <div className="flex shrink-0 flex-col font-mono text-[11px] leading-tight text-mist-400">
        <span>
          Bar <b className="text-zinc-100">{cursor.barIndex + 1}</b> · Beat <b className="text-zinc-100">{cursor.position + 1}</b>
        </span>
        <span>
          {DURATION_LABELS[rhythm.duration]}
          {rhythm.dotted ? ' dotted' : ''}
          {rhythm.triplet ? ' triplet' : ''}
          {rhythm.isRest ? ' · rest' : ''}
          {!beat && <span className="text-sky-300"> · new</span>}
        </span>
      </div>
      <div className="flex shrink-0 gap-1">
        {track.tuning.map((pitch, i) => {
          const s = i + 1;
          const note = notesByString.get(s);
          const selected = cursor.stringIndex === s;
          return (
            <button
              key={s}
              type="button"
              onClick={() => onSelectString(s)}
              title={`String ${s} (${midiToNoteName(pitch)})`}
              className={cx(
                'flex h-10 w-10 flex-col items-center justify-center rounded-lg border text-[10px] leading-none',
                selected ? 'border-sky-400 bg-sky-500/20' : 'border-ink-600 bg-ink-800 hover:bg-ink-700',
              )}
            >
              <span className="text-mist-400">{midiToNoteName(pitch).replace(/-?\d+$/, '')}</span>
              <span className={cx('mt-0.5 font-mono text-sm font-bold', note ? 'text-zinc-50' : 'text-ink-500')}>
                {selected && pendingDigits ? pendingDigits : note ? (note.harmonic ? `<${note.fret}>` : note.fret) : '–'}
              </span>
            </button>
          );
        })}
      </div>
      <select
        aria-label="Tuning"
        title="Track tuning"
        value={tuningOptions.includes(track.tuningPreset) ? track.tuningPreset : 'custom'}
        onChange={(e) => onTuningChange(e.target.value)}
        className="h-8 shrink-0 rounded-lg border border-ink-600 bg-ink-800 px-2 text-xs text-zinc-100 outline-none"
      >
        {!tuningOptions.includes(track.tuningPreset) && <option value="custom">{track.tuningPreset}</option>}
        {tuningOptions.map((t) => (
          <option key={t} value={t}>
            {t}
          </option>
        ))}
      </select>
      <div className="ml-auto flex shrink-0 items-center gap-1">
        <span className="hidden items-center gap-1 text-[10px] text-mist-400 lg:flex">
          <Keyboard size={12} /> ←↑↓→ · 0-9 · +/- · . · T · R · M H B S N L · Ins · Del
        </span>
        <button
          type="button"
          onClick={onToggleDock}
          aria-pressed={dockOpen}
          className={cx(
            'flex h-8 items-center gap-1 rounded-lg border px-2 text-xs',
            dockOpen ? 'border-sky-400 bg-sky-500/20 text-sky-100' : 'border-ink-600 bg-ink-800 text-zinc-300',
          )}
        >
          <Hand size={14} /> Touch Dock
        </button>
      </div>
    </div>
  );
}

interface DockProps {
  rhythm: EditorRhythmState;
  note: TabNote | undefined;
  currentFret: number | null;
  onFret: (fret: number) => void;
  onMove: (dir: 'left' | 'right' | 'up' | 'down') => void;
  onDuration: (d: Duration) => void;
  onDotted: () => void;
  onTriplet: () => void;
  onFlag: (flag: NoteFlag) => void;
  onRest: () => void;
  onInsert: () => void;
  onDelete: () => void;
  onClose: () => void;
}

const FRETS = Array.from({ length: 25 }, (_, i) => i);
const FRET_MARKERS = new Set([0, 3, 5, 7, 9, 12, 15, 17, 19, 21, 24]);

/**
 * Thumb-friendly bottom dock for Android / touch editing. Every control is at least 44×44 px; the 0–24 fret
 * strip scrolls horizontally and keeps the current fret in view.
 */
export function TouchDock(p: DockProps) {
  const fretStrip = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (p.currentFret === null) return;
    const el = fretStrip.current?.querySelector<HTMLElement>(`[data-fret="${p.currentFret}"]`);
    el?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
  }, [p.currentFret]);

  const pill = (active: boolean) =>
    cx(
      'flex h-11 min-w-11 shrink-0 items-center justify-center rounded-xl border px-2.5 text-xs font-semibold select-none',
      active ? 'border-sky-400 bg-sky-500 text-ink-950' : 'border-ink-600 bg-ink-800 text-zinc-200 active:bg-ink-600',
    );
  const nav = (label: string, onClick: () => void, icon: ReactNode, extra?: string) => (
    <button type="button" aria-label={label} title={label} className={cx(pill(false), 'w-11', extra)} onClick={onClick}>
      {icon}
    </button>
  );

  return (
    <div className="shrink-0 border-t border-ink-700 bg-ink-900 px-2 pt-2 pb-[calc(0.5rem+env(safe-area-inset-bottom))]">
      <div className="mx-auto flex max-w-6xl flex-col gap-1.5">
        {/* Fret strip */}
        <div ref={fretStrip} className="touch-pan flex gap-1 overflow-x-auto pb-0.5 [scrollbar-width:none]">
          {FRETS.map((f) => (
            <button
              key={f}
              type="button"
              data-fret={f}
              aria-label={`Fret ${f}`}
              onClick={() => p.onFret(f)}
              className={cx(
                'h-11 w-11 shrink-0 rounded-xl border font-mono text-sm font-bold select-none',
                p.currentFret === f
                  ? 'border-orange-400 bg-orange-500 text-ink-950'
                  : FRET_MARKERS.has(f)
                    ? 'border-ink-500 bg-ink-700 text-zinc-100 active:bg-ink-600'
                    : 'border-ink-600 bg-ink-800 text-zinc-300 active:bg-ink-600',
              )}
            >
              {f}
            </button>
          ))}
        </div>

        <div className="flex flex-wrap gap-1.5">
          {/* Navigation pad */}
          <div className="flex gap-1">
            {nav('Previous beat', () => p.onMove('left'), <ChevronLeft size={18} />)}
            {nav('String up', () => p.onMove('up'), <ChevronUp size={18} />)}
            {nav('String down', () => p.onMove('down'), <ChevronDown size={18} />)}
            {nav('Next beat', () => p.onMove('right'), <ChevronRight size={18} />)}
            {nav('Insert beat', p.onInsert, <CornerDownLeft size={17} />)}
            {nav('Delete', p.onDelete, <Delete size={17} />, 'text-rose-300')}
          </div>
          {/* Rhythm */}
          <div className="flex flex-wrap gap-1">
            {DURATIONS.map((d) => (
              <button key={d} type="button" className={pill(p.rhythm.duration === d)} onClick={() => p.onDuration(d)}>
                {DURATION_LABELS[d]}
              </button>
            ))}
            <button type="button" className={pill(p.rhythm.dotted)} onClick={p.onDotted} title="Dotted" aria-label="Dotted">
              •
            </button>
            <button type="button" className={pill(p.rhythm.triplet)} onClick={p.onTriplet} title="Triplet" aria-label="Triplet">
              3
            </button>
          </div>
        </div>

        {/* Articulations */}
        <div className="touch-pan flex gap-1 overflow-x-auto [scrollbar-width:none]">
          {FLAG_LABELS.map(({ flag, label, key }) => (
            <button key={flag} type="button" title={`${label} (${key})`} className={pill(Boolean(p.note?.[flag]))} onClick={() => p.onFlag(flag)}>
              {label}
            </button>
          ))}
          <button type="button" className={pill(p.rhythm.isRest)} onClick={p.onRest} title="Rest (R)">
            Rest
          </button>
          <div className="flex-1" />
          <button type="button" className={cx(pill(false), 'border-transparent bg-transparent text-mist-400')} onClick={p.onClose}>
            Hide
          </button>
        </div>
      </div>
    </div>
  );
}
