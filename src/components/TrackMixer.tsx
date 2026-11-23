import { ChevronDown, ChevronUp, Copy, Drum, Guitar, Piano, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { InstrumentType, Track } from '../types/song';
import { cx } from './ui';

interface TrackMixerProps {
  tracks: Track[];
  activeTrackId: string;
  onSelect: (id: string) => void;
  onChange: (id: string, patch: Partial<Pick<Track, 'name' | 'volume' | 'pan' | 'muted' | 'solo'>>, coalesceKey?: string) => void;
  onDuplicate: (id: string) => void;
  onDelete: (id: string) => void;
  onAdd: () => void;
  /** `sidebar`: desktop column / collapsible strip. `sheet`: full-width list inside a mobile bottom sheet. */
  variant?: 'sidebar' | 'sheet';
}

function InstrumentIcon({ type, size = 14 }: { type: InstrumentType; size?: number }) {
  if (type === 'drums') return <Drum size={size} />;
  if (type === 'synth') return <Piano size={size} />;
  return <Guitar size={size} />;
}

const TYPE_LABEL: Record<InstrumentType, string> = {
  'electric-guitar': 'E.Guitar',
  'acoustic-guitar': 'A.Guitar',
  bass: 'Bass',
  synth: 'Synth',
  drums: 'Drums',
};

function MixerStrip({
  track,
  active,
  fullWidth,
  onlyTrack,
  onSelect,
  onChange,
  onDuplicate,
  onDelete,
}: {
  track: Track;
  active: boolean;
  fullWidth: boolean;
  onlyTrack: boolean;
  onSelect: () => void;
  onChange: TrackMixerProps['onChange'];
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  const panLabel = Math.abs(track.pan) < 0.02 ? 'C' : track.pan < 0 ? `L${Math.round(-track.pan * 100)}` : `R${Math.round(track.pan * 100)}`;
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && e.target === e.currentTarget) onSelect();
      }}
      className={cx(
        'group relative flex shrink-0 cursor-pointer flex-col gap-1.5 rounded-xl border p-2 pl-3 transition-colors',
        fullWidth ? 'w-full gap-2 p-3 pl-4' : 'w-60 md:w-auto',
        active ? 'border-ink-500 bg-ink-800' : 'border-ink-700 bg-ink-900 hover:bg-ink-800/60',
      )}
    >
      <span className="absolute top-2 bottom-2 left-1 w-1 rounded-full" style={{ backgroundColor: track.color }} />
      <div className="flex items-center gap-1.5">
        <span className="text-mist-400" style={{ color: active ? track.color : undefined }}>
          <InstrumentIcon type={track.instrumentType} />
        </span>
        {active ? (
          <input
            value={track.name}
            aria-label="Track name"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
            onChange={(e) => onChange(track.id, { name: e.target.value }, `name-${track.id}`)}
            className="min-w-0 flex-1 rounded border border-transparent bg-transparent px-1 text-sm font-semibold text-zinc-100 outline-none hover:border-ink-600 focus:border-sky-500"
          />
        ) : (
          <span className="min-w-0 flex-1 truncate px-1 text-sm font-semibold text-zinc-200">{track.name}</span>
        )}
        <span className="text-[10px] text-mist-400">{TYPE_LABEL[track.instrumentType]}</span>
      </div>

      <div className="flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
        <button
          type="button"
          title="Mute"
          aria-pressed={track.muted}
          onClick={() => onChange(track.id, { muted: !track.muted })}
          className={cx(
            'rounded-md text-[11px] font-bold',
            fullWidth ? 'h-11 w-11 text-sm' : 'h-6 w-7',
            track.muted ? 'bg-amber-400 text-ink-950' : 'bg-ink-700 text-zinc-300 hover:bg-ink-600',
          )}
        >
          M
        </button>
        <button
          type="button"
          title="Solo"
          aria-pressed={track.solo}
          onClick={() => onChange(track.id, { solo: !track.solo })}
          className={cx(
            'rounded-md text-[11px] font-bold',
            fullWidth ? 'h-11 w-11 text-sm' : 'h-6 w-7',
            track.solo ? 'bg-emerald-400 text-ink-950' : 'bg-ink-700 text-zinc-300 hover:bg-ink-600',
          )}
        >
          S
        </button>
        <input
          type="range"
          min={0}
          max={100}
          value={Math.round(track.volume * 100)}
          aria-label="Volume"
          title={`Volume ${Math.round(track.volume * 100)}%`}
          onChange={(e) => onChange(track.id, { volume: Number(e.target.value) / 100 }, `vol-${track.id}`)}
          className="min-w-0 flex-1"
          style={{ accentColor: track.color }}
        />
        <span className="w-7 text-right font-mono text-[10px] text-mist-400 tabular-nums">{Math.round(track.volume * 100)}</span>
      </div>

      <div className="flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
        <span className="w-7 text-[10px] text-mist-400 uppercase">Pan</span>
        <input
          type="range"
          min={-100}
          max={100}
          value={Math.round(track.pan * 100)}
          aria-label="Pan"
          title="Pan (double-click to center)"
          onDoubleClick={() => onChange(track.id, { pan: 0 })}
          onChange={(e) => onChange(track.id, { pan: Number(e.target.value) / 100 }, `pan-${track.id}`)}
          className="min-w-0 flex-1"
          style={{ accentColor: track.color }}
        />
        <span className="w-7 text-right font-mono text-[10px] text-mist-400 tabular-nums">{panLabel}</span>
        <button
          type="button"
          title="Duplicate track"
          aria-label="Duplicate track"
          onClick={onDuplicate}
          className={cx('flex items-center justify-center rounded-md text-mist-400 hover:bg-ink-700 hover:text-zinc-100', fullWidth ? 'h-11 w-11' : 'p-1')}
        >
          <Copy size={13} />
        </button>
        <button
          type="button"
          title="Delete track"
          aria-label="Delete track"
          disabled={onlyTrack}
          onClick={onDelete}
          className={cx(
            'flex items-center justify-center rounded-md text-mist-400 hover:bg-rose-500/20 hover:text-rose-300 disabled:opacity-30',
            fullWidth ? 'h-11 w-11' : 'p-1',
          )}
        >
          <Trash2 size={13} />
        </button>
      </div>
    </div>
  );
}

export function TrackMixer({ tracks, activeTrackId, onSelect, onChange, onDuplicate, onDelete, onAdd, variant = 'sidebar' }: TrackMixerProps) {
  const [collapsed, setCollapsed] = useState(false);
  if (variant === 'sheet') {
    return (
      <div className="flex flex-col gap-2 px-3">
        <button
          type="button"
          onClick={onAdd}
          className="flex h-11 items-center justify-center gap-1.5 rounded-xl bg-orange-500 text-sm font-semibold text-ink-950 active:bg-orange-400"
        >
          <Plus size={16} /> Add Track
        </button>
        {tracks.map((t) => (
          <MixerStrip
            key={t.id}
            track={t}
            active={t.id === activeTrackId}
            fullWidth
            onlyTrack={tracks.length <= 1}
            onSelect={() => onSelect(t.id)}
            onChange={onChange}
            onDuplicate={() => onDuplicate(t.id)}
            onDelete={() => onDelete(t.id)}
          />
        ))}
      </div>
    );
  }
  return (
    <aside className="flex shrink-0 flex-col border-b border-ink-700 bg-ink-950 md:w-72 md:border-r md:border-b-0">
      <div className="flex items-center justify-between px-3 pt-2 pb-1">
        <span className="text-[11px] font-bold tracking-widest text-mist-400 uppercase">Tracks · {tracks.length}</span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={onAdd}
            className="flex h-7 items-center gap-1 rounded-lg bg-orange-500 px-2 text-xs font-semibold text-ink-950 hover:bg-orange-400"
          >
            <Plus size={14} /> Add Track
          </button>
          <button
            type="button"
            aria-label={collapsed ? 'Expand mixer' : 'Collapse mixer'}
            onClick={() => setCollapsed((c) => !c)}
            className="flex h-7 w-7 items-center justify-center rounded-lg text-mist-400 hover:bg-ink-800 md:hidden"
          >
            {collapsed ? <ChevronDown size={16} /> : <ChevronUp size={16} />}
          </button>
        </div>
      </div>
      <div
        className={cx(
          'flex gap-2 overflow-x-auto px-2 pb-2 md:flex-1 md:flex-col md:overflow-x-hidden md:overflow-y-auto',
          collapsed && 'hidden md:flex',
        )}
      >
        {tracks.map((t) => (
          <MixerStrip
            key={t.id}
            track={t}
            active={t.id === activeTrackId}
            fullWidth={false}
            onlyTrack={tracks.length <= 1}
            onSelect={() => onSelect(t.id)}
            onChange={onChange}
            onDuplicate={() => onDuplicate(t.id)}
            onDelete={() => onDelete(t.id)}
          />
        ))}
      </div>
    </aside>
  );
}
