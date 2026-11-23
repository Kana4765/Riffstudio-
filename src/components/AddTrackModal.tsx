import { X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import {
  FX_PRESET_NAMES,
  INSTRUMENT_OPTIONS,
  TRACK_COLORS,
  tuningPresetsFor,
  type FxPresetName,
} from '../constants/presets';
import type { InstrumentType } from '../types/song';
import type { NewTrackOptions } from '../utils/songOps';
import { cx } from './ui';

interface AddTrackModalProps {
  open: boolean;
  existingCount: number;
  onCancel: () => void;
  onCreate: (opts: NewTrackOptions) => void;
}

export function AddTrackModal({ open, existingCount, onCancel, onCreate }: AddTrackModalProps) {
  const [instrumentType, setInstrumentType] = useState<InstrumentType>('electric-guitar');
  const [name, setName] = useState('');
  const [color, setColor] = useState(TRACK_COLORS[0]);
  const [tuningPreset, setTuningPreset] = useState('6-Str Standard E');
  const [fxPreset, setFxPreset] = useState<FxPresetName>('Crunch Rock');

  const option = INSTRUMENT_OPTIONS.find((o) => o.type === instrumentType) ?? INSTRUMENT_OPTIONS[0];
  const tunings = useMemo(() => (instrumentType === 'drums' ? [] : tuningPresetsFor(instrumentType)), [instrumentType]);

  useEffect(() => {
    if (!open) return;
    setColor(TRACK_COLORS[existingCount % TRACK_COLORS.length]);
    setName('');
  }, [open, existingCount]);

  useEffect(() => {
    const opt = INSTRUMENT_OPTIONS.find((o) => o.type === instrumentType);
    if (!opt) return;
    setTuningPreset(opt.defaultTuning);
    setFxPreset(opt.defaultPreset);
  }, [instrumentType]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onCancel]);

  if (!open) return null;

  const submit = () => {
    onCreate({
      instrumentType,
      name: name.trim() || `${option.label} ${existingCount + 1}`,
      color,
      tuningPreset,
      fxPreset,
    });
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-0 backdrop-blur-sm sm:items-center sm:p-4"
      onClick={onCancel}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Add track"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
        className="w-full max-w-lg rounded-t-2xl border border-ink-600 bg-ink-900 p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] shadow-2xl sm:rounded-2xl sm:pb-4"
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-base font-bold text-zinc-100">Add Track</h2>
          <button type="button" aria-label="Close" onClick={onCancel} className="rounded-lg p-1 text-mist-400 hover:bg-ink-700">
            <X size={18} />
          </button>
        </div>

        <div className="mb-3">
          <div className="mb-1.5 text-[11px] font-semibold tracking-wider text-mist-400 uppercase">Instrument</div>
          <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
            {INSTRUMENT_OPTIONS.map((o) => (
              <button
                key={o.type}
                type="button"
                onClick={() => setInstrumentType(o.type)}
                className={cx(
                  'rounded-lg border px-2 py-2 text-sm font-medium',
                  o.type === instrumentType
                    ? 'border-orange-400 bg-orange-500/15 text-orange-200'
                    : 'border-ink-600 bg-ink-800 text-zinc-300 hover:bg-ink-700',
                )}
              >
                {o.label}
              </button>
            ))}
          </div>
        </div>

        <label className="mb-3 block">
          <span className="mb-1.5 block text-[11px] font-semibold tracking-wider text-mist-400 uppercase">Track name</span>
          <input
            autoFocus
            value={name}
            placeholder={`${option.label} ${existingCount + 1}`}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit();
            }}
            className="w-full rounded-lg border border-ink-600 bg-ink-950 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-sky-500"
          />
        </label>

        <div className="mb-3">
          <div className="mb-1.5 text-[11px] font-semibold tracking-wider text-mist-400 uppercase">Accent color</div>
          <div className="flex flex-wrap gap-2">
            {TRACK_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                aria-label={`Color ${c}`}
                onClick={() => setColor(c)}
                className={cx('h-7 w-7 rounded-full border-2', c === color ? 'border-white' : 'border-transparent')}
                style={{ backgroundColor: c }}
              />
            ))}
          </div>
        </div>

        {instrumentType !== 'drums' && (
          <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="mb-1.5 block text-[11px] font-semibold tracking-wider text-mist-400 uppercase">Tuning</span>
              <select
                value={tuningPreset}
                onChange={(e) => setTuningPreset(e.target.value)}
                className="w-full rounded-lg border border-ink-600 bg-ink-950 px-2 py-2 text-sm text-zinc-100 outline-none"
              >
                {tunings.map((t) => (
                  <option key={t.name} value={t.name}>
                    {t.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="mb-1.5 block text-[11px] font-semibold tracking-wider text-mist-400 uppercase">Tone preset</span>
              <select
                value={fxPreset}
                onChange={(e) => setFxPreset(e.target.value as FxPresetName)}
                className="w-full rounded-lg border border-ink-600 bg-ink-950 px-2 py-2 text-sm text-zinc-100 outline-none"
              >
                {FX_PRESET_NAMES.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg border border-ink-600 px-4 py-2 text-sm text-zinc-300 hover:bg-ink-700"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            className="rounded-lg bg-orange-500 px-4 py-2 text-sm font-semibold text-ink-950 hover:bg-orange-400"
          >
            Add Track
          </button>
        </div>
      </div>
    </div>
  );
}
