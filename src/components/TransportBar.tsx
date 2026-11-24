import {
  FileMusic,
  FolderOpen,
  Home,
  MoreHorizontal,
  Pause,
  Play,
  Plus,
  Redo2,
  Repeat,
  Save,
  SlidersHorizontal,
  Square,
  Timer,
  Trash2,
  Undo2,
  X,
} from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import type { TransportState } from '../audio/AudioEngine';
import { TIME_SIGNATURE_OPTIONS } from '../constants/presets';
import { usePlayheadSelector, type PlayheadPosition } from '../state/playhead';
import type { Song } from '../types/song';
import { getBarTempo } from '../utils/timing';
import { BpmControl } from './BpmControl';
import { Divider, IconButton, cx } from './ui';

interface TransportBarProps {
  song: Song;
  isMobile: boolean;
  transport: TransportState;
  selectedBar: number;
  loop: boolean;
  metronome: boolean;
  speed: number;
  fxOpen: boolean;
  fxAvailable: boolean;
  canUndo: boolean;
  canRedo: boolean;
  onHome: () => void;
  onPlayPause: () => void;
  onStop: () => void;
  onToggleLoop: () => void;
  onToggleMetronome: () => void;
  onBpmChange: (bpm: number) => void;
  onSpeedChange: (speed: number) => void;
  onUndo: () => void;
  onRedo: () => void;
  onAddBar: () => void;
  onDeleteBar: () => void;
  onTimeSignature: (numerator: number, denominator: number) => void;
  onToggleFx: () => void;
  onSave: () => void;
  onLoad: () => void;
  onExportMidi: () => void;
  onExportGp: () => void;
  onTitleChange: (title: string) => void;
}

const selectBar = (p: PlayheadPosition | null) => (p ? p.barIndex : -1);
const selectBeat = (p: PlayheadPosition | null) => (p ? Math.floor(p.tickInBar / 480) : -1);

function PositionDisplay({ selectedBar, barCount, bpm, className }: { selectedBar: number; barCount: number; bpm: number; className?: string }) {
  const playBar = usePlayheadSelector(selectBar);
  const playBeat = usePlayheadSelector(selectBeat);
  const bar = playBar >= 0 ? playBar : selectedBar;
  return (
    <div
      className={cx(
        'flex h-9 shrink-0 items-center gap-3 rounded-lg border border-ink-700 bg-ink-950 px-3 font-mono text-xs tabular-nums',
        className,
      )}
    >
      <span className={cx(playBar >= 0 ? 'text-emerald-400' : 'text-zinc-200')}>
        {String(bar + 1).padStart(3, '0')}.{playBeat >= 0 ? playBeat + 1 : 1}
      </span>
      <span className="text-mist-400">/ {barCount}</span>
      <span className="text-amber-300">{Math.round(bpm)} bpm</span>
    </div>
  );
}

function SpeedTrainer({ speed, onChange, wide }: { speed: number; onChange: (s: number) => void; wide?: boolean }) {
  return (
    <label
      className={cx(
        'flex shrink-0 items-center gap-2 rounded-lg border border-ink-600 bg-ink-800 px-2 text-[10px] text-mist-400 uppercase',
        wide ? 'h-11' : 'h-9',
      )}
      title="Speed trainer"
    >
      Speed
      <input
        type="range"
        min={50}
        max={100}
        step={5}
        value={Math.round(speed * 100)}
        aria-label="Speed trainer"
        onChange={(e) => onChange(Number(e.target.value) / 100)}
        className={wide ? 'min-w-0 flex-1' : 'w-20'}
      />
      <span className="w-8 font-mono text-xs text-zinc-200 tabular-nums">{Math.round(speed * 100)}%</span>
    </label>
  );
}

function TimeSignatureSelect({ label, onChange, tall }: { label: string; onChange: (n: number, d: number) => void; tall?: boolean }) {
  const known = TIME_SIGNATURE_OPTIONS.some((o) => o.label === label);
  return (
    <select
      aria-label="Bar time signature"
      title="Time signature of the active bar"
      value={known ? label : 'custom'}
      onChange={(e) => {
        const opt = TIME_SIGNATURE_OPTIONS.find((o) => o.label === e.target.value);
        if (opt) onChange(opt.numerator, opt.denominator);
      }}
      className={cx(
        'shrink-0 rounded-lg border border-ink-600 bg-ink-800 px-2 font-mono text-xs text-zinc-100 outline-none',
        tall ? 'h-11' : 'h-9',
      )}
    >
      {!known && <option value="custom">{label}</option>}
      {TIME_SIGNATURE_OPTIONS.map((o) => (
        <option key={o.label} value={o.label}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

function MenuButton({
  icon,
  label,
  onClick,
  active,
  disabled,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      className={cx(
        'flex h-11 items-center gap-2 rounded-xl border px-3 text-sm font-medium disabled:opacity-35',
        active ? 'border-sky-400 bg-sky-500/20 text-sky-100' : 'border-ink-600 bg-ink-800 text-zinc-200 active:bg-ink-600',
      )}
    >
      {icon}
      <span className="truncate">{label}</span>
    </button>
  );
}

export function TransportBar(props: TransportBarProps) {
  const { song, transport, selectedBar, isMobile } = props;
  const [moreOpen, setMoreOpen] = useState(false);
  const bar = song.bars[selectedBar] ?? song.bars[0];
  const tsLabel = `${bar.numerator}/${bar.denominator}`;
  const playing = transport === 'playing';

  useEffect(() => {
    if (!isMobile) setMoreOpen(false);
  }, [isMobile]);

  useEffect(() => {
    if (!moreOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMoreOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [moreOpen]);

  const closeThen = (fn: () => void) => () => {
    setMoreOpen(false);
    fn();
  };

  if (isMobile) {
    return (
      <>
        <header className="flex shrink-0 items-center gap-1 border-b border-ink-700 bg-ink-900 px-2 py-1.5">
          <IconButton icon={Home} label="Home" onClick={props.onHome} size="lg" />
          <IconButton
            icon={playing ? Pause : Play}
            label={playing ? 'Pause' : 'Play'}
            onClick={props.onPlayPause}
            active={playing}
            accent="#34d399"
            size="lg"
          />
          <IconButton icon={Square} label="Stop" onClick={props.onStop} disabled={transport === 'stopped'} size="lg" />
          <BpmControl bpm={song.bpm} onChange={props.onBpmChange} variant="compact" />
          <IconButton
            icon={MoreHorizontal}
            label="More"
            onClick={() => setMoreOpen((o) => !o)}
            active={moreOpen}
            accent="#e4e4e7"
            size="lg"
            className="ml-auto"
          />
        </header>

        {moreOpen && (
          <div className="fixed inset-0 z-40" onClick={() => setMoreOpen(false)}>
            <div
              role="menu"
              aria-label="More controls"
              onClick={(e) => e.stopPropagation()}
              className="popover-panel absolute top-[calc(env(safe-area-inset-top)+3.6rem)] right-2 left-2 flex max-h-[75dvh] flex-col gap-2 overflow-y-auto rounded-2xl border border-ink-600 bg-ink-900 p-3 shadow-2xl"
            >
              <div className="flex items-center gap-2">
                <input
                  value={song.title}
                  onChange={(e) => props.onTitleChange(e.target.value)}
                  aria-label="Song title"
                  className="h-11 min-w-0 flex-1 rounded-xl border border-ink-600 bg-ink-950 px-3 text-sm font-semibold text-zinc-100 outline-none focus:border-sky-500"
                />
                <button
                  type="button"
                  aria-label="Close menu"
                  onClick={() => setMoreOpen(false)}
                  className="flex h-11 w-11 items-center justify-center rounded-xl text-mist-400 hover:bg-ink-700"
                >
                  <X size={18} />
                </button>
              </div>
              <PositionDisplay selectedBar={selectedBar} barCount={song.bars.length} bpm={getBarTempo(song, selectedBar)} className="h-11 justify-center" />
              <BpmControl bpm={song.bpm} onChange={props.onBpmChange} variant="full" tall className="justify-center" />
              <SpeedTrainer speed={props.speed} onChange={props.onSpeedChange} wide />
              <div className="grid grid-cols-2 gap-2">
                <MenuButton icon={<Undo2 size={16} />} label="Undo" onClick={props.onUndo} disabled={!props.canUndo} />
                <MenuButton icon={<Redo2 size={16} />} label="Redo" onClick={props.onRedo} disabled={!props.canRedo} />
                <MenuButton icon={<Repeat size={16} />} label="Loop bar" onClick={props.onToggleLoop} active={props.loop} />
                <MenuButton icon={<Timer size={16} />} label="Metronome" onClick={props.onToggleMetronome} active={props.metronome} />
                <MenuButton icon={<Plus size={16} />} label="Add bar" onClick={props.onAddBar} />
                <MenuButton icon={<Trash2 size={16} />} label="Delete bar" onClick={props.onDeleteBar} />
              </div>
              <label className="flex items-center justify-between gap-2 text-xs text-mist-400">
                Bar {selectedBar + 1} time signature
                <TimeSignatureSelect label={tsLabel} onChange={props.onTimeSignature} tall />
              </label>
              <div className="grid grid-cols-2 gap-2">
                <MenuButton icon={<Save size={16} />} label="Save .json" onClick={closeThen(props.onSave)} />
                <MenuButton icon={<FolderOpen size={16} />} label="Open song / .gp" onClick={closeThen(props.onLoad)} />
                <MenuButton icon={<FileMusic size={16} />} label="Export .gp" onClick={closeThen(props.onExportGp)} />
                <MenuButton icon={<FileMusic size={16} />} label="Export .mid" onClick={closeThen(props.onExportMidi)} />
              </div>
            </div>
          </div>
        )}
      </>
    );
  }

  return (
    <header className="flex shrink-0 items-center gap-1.5 overflow-x-auto border-b border-ink-700 bg-ink-900 px-2 py-2 [scrollbar-width:none]">
      <IconButton icon={Home} label="Home" onClick={props.onHome} />
      <div className="mr-1 hidden shrink-0 items-center gap-2 xl:flex">
        <input
          value={song.title}
          onChange={(e) => props.onTitleChange(e.target.value)}
          aria-label="Song title"
          className="w-36 rounded-md border border-transparent bg-transparent px-1.5 py-1 text-sm font-semibold text-zinc-100 outline-none hover:border-ink-600 focus:border-sky-500"
        />
      </div>
      <Divider />
      <IconButton
        icon={playing ? Pause : Play}
        label={playing ? 'Pause' : 'Play'}
        shortcut="Space"
        onClick={props.onPlayPause}
        active={playing}
        accent="#34d399"
      />
      <IconButton icon={Square} label="Stop" onClick={props.onStop} disabled={transport === 'stopped'} />
      <IconButton icon={Repeat} label="Loop active bar" onClick={props.onToggleLoop} active={props.loop} accent="#38bdf8" />
      <IconButton icon={Timer} label="Metronome" onClick={props.onToggleMetronome} active={props.metronome} accent="#facc15" />

      <PositionDisplay selectedBar={selectedBar} barCount={song.bars.length} bpm={getBarTempo(song, selectedBar)} />
      <BpmControl bpm={song.bpm} onChange={props.onBpmChange} variant="full" />
      <SpeedTrainer speed={props.speed} onChange={props.onSpeedChange} />

      <Divider />
      <IconButton icon={Undo2} label="Undo" shortcut="Ctrl+Z" onClick={props.onUndo} disabled={!props.canUndo} />
      <IconButton icon={Redo2} label="Redo" shortcut="Ctrl+Y" onClick={props.onRedo} disabled={!props.canRedo} />
      <Divider />

      <IconButton icon={Plus} label="Add bar" onClick={props.onAddBar} showLabel className="!px-2" />
      <IconButton icon={Trash2} label="Delete bar" onClick={props.onDeleteBar} />
      <TimeSignatureSelect label={tsLabel} onChange={props.onTimeSignature} />

      <Divider />
      <IconButton
        icon={SlidersHorizontal}
        label="Drive/Distortion FX"
        onClick={props.onToggleFx}
        active={props.fxOpen && props.fxAvailable}
        disabled={!props.fxAvailable}
        accent="#fb923c"
      />
      <IconButton icon={Save} label="Save .json" onClick={props.onSave} />
      <IconButton icon={FolderOpen} label="Open .json / Guitar Pro" onClick={props.onLoad} />
      <IconButton icon={FileMusic} label="Export .gp" onClick={props.onExportGp} showLabel />
      <IconButton icon={FileMusic} label="Export .mid" onClick={props.onExportMidi} showLabel />
    </header>
  );
}
