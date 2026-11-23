import { Volume2, Zap } from 'lucide-react';
import type { ReactNode } from 'react';
import { CUSTOM_PRESET, FX_PRESET_NAMES } from '../constants/presets';
import type { DistortionSettings, FxChainSettings, OverdriveSettings, PitchedTrack } from '../types/song';
import { Knob, cx } from './ui';

interface FxBarProps {
  track: PitchedTrack;
  onChange: (fx: FxChainSettings, coalesceKey?: string) => void;
  onPreset: (preset: string) => void;
  onTest: () => void;
  /** `bar`: horizontal desktop strip. `sheet`: wrapped, touch-sized layout for the mobile drawer. */
  layout?: 'bar' | 'sheet';
}

function Led({ on, color }: { on: boolean; color: string }) {
  return (
    <span
      className="inline-block h-2.5 w-2.5 rounded-full border border-black/40"
      style={{ backgroundColor: on ? color : '#3a2020', boxShadow: on ? `0 0 8px ${color}` : 'none' }}
    />
  );
}

function Pedal({
  title,
  color,
  enabled,
  onToggle,
  children,
}: {
  title: string;
  color: string;
  enabled: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <div
      className={cx('flex shrink-0 items-center gap-2 rounded-xl border px-2 py-1.5', enabled ? 'border-ink-500' : 'border-ink-700')}
      style={{ background: `linear-gradient(160deg, ${color}26, #131722 70%)` }}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-pressed={enabled}
        title={enabled ? `Bypass ${title}` : `Enable ${title}`}
        className="flex min-h-11 w-16 flex-col items-center justify-center gap-1 rounded-lg border border-ink-600 bg-ink-950/70 px-1 py-1.5 hover:border-ink-500"
      >
        <Led on={enabled} color="#ef4444" />
        <span className="text-[10px] font-black tracking-wider uppercase" style={{ color }}>
          {title}
        </span>
        <span className="text-[9px] text-mist-400">{enabled ? 'ON' : 'BYPASS'}</span>
      </button>
      {children}
    </div>
  );
}

export function FxBar({ track, onChange, onPreset, onTest, layout = 'bar' }: FxBarProps) {
  const sheet = layout === 'sheet';
  const knob = sheet ? 54 : 46;
  const fx = track.fxChain;
  const setOd = (patch: Partial<OverdriveSettings>, key?: string) =>
    onChange({ ...fx, preset: CUSTOM_PRESET, overdrive: { ...fx.overdrive, ...patch } }, key);
  const setDs = (patch: Partial<DistortionSettings>, key?: string) =>
    onChange({ ...fx, preset: CUSTOM_PRESET, distortion: { ...fx.distortion, ...patch } }, key);
  const k = (p: string) => `fx-${track.id}-${p}`;

  return (
    <div
      className={cx(
        'flex shrink-0 gap-2',
        sheet
          ? 'flex-wrap items-stretch justify-center px-3'
          : 'items-center overflow-x-auto border-b border-ink-700 bg-ink-950 px-2 py-2 [scrollbar-width:thin]',
      )}
    >
      <div className={cx('flex shrink-0 flex-col gap-1.5 pr-1', sheet && 'w-full')}>
        <div className="flex items-center gap-1.5 text-[11px] font-bold tracking-widest text-mist-400 uppercase">
          <Zap size={13} style={{ color: track.color }} /> {track.name}
        </div>
        <select
          aria-label="Tone preset"
          value={fx.preset}
          onChange={(e) => onPreset(e.target.value)}
          className={cx('rounded-lg border border-ink-600 bg-ink-800 px-2 text-xs text-zinc-100 outline-none', sheet ? 'h-11 text-sm' : 'h-8')}
        >
          {!FX_PRESET_NAMES.includes(fx.preset as (typeof FX_PRESET_NAMES)[number]) && <option value={fx.preset}>{fx.preset}</option>}
          {FX_PRESET_NAMES.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={onTest}
          className={cx(
            'flex items-center justify-center gap-1 rounded-lg border border-ink-600 bg-ink-800 text-xs text-zinc-200 hover:bg-ink-700',
            sheet ? 'h-11 text-sm' : 'h-7',
          )}
        >
          <Volume2 size={13} /> Test Note
        </button>
      </div>

      <Pedal title="Overdrive" color="#facc15" enabled={fx.overdrive.enabled} onToggle={() => setOd({ enabled: !fx.overdrive.enabled })}>
        <Knob label="Drive" size={knob} color="#facc15" value={fx.overdrive.drive} onChange={(v) => setOd({ drive: v }, k('od-drive'))} disabled={!fx.overdrive.enabled} />
        <Knob label="Tone" size={knob} color="#facc15" value={fx.overdrive.tone} onChange={(v) => setOd({ tone: v }, k('od-tone'))} disabled={!fx.overdrive.enabled} />
        <Knob label="Level" size={knob} color="#facc15" value={fx.overdrive.level} onChange={(v) => setOd({ level: v }, k('od-level'))} disabled={!fx.overdrive.enabled} />
      </Pedal>

      <Pedal title="Distortion" color="#f97316" enabled={fx.distortion.enabled} onToggle={() => setDs({ enabled: !fx.distortion.enabled })}>
        <Knob label="Gain" size={knob} color="#f97316" value={fx.distortion.gain} onChange={(v) => setDs({ gain: v }, k('ds-gain'))} disabled={!fx.distortion.enabled} />
        <Knob label="Tone" size={knob} color="#f97316" value={fx.distortion.tone} onChange={(v) => setDs({ tone: v }, k('ds-tone'))} disabled={!fx.distortion.enabled} />
        <Knob label="Level" size={knob} color="#f97316" value={fx.distortion.level} onChange={(v) => setDs({ level: v }, k('ds-level'))} disabled={!fx.distortion.enabled} />
      </Pedal>
    </div>
  );
}
