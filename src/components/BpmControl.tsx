import { Hand } from 'lucide-react';
import { useRef, useState } from 'react';
import { MAX_BPM, MIN_BPM, clampBpm } from '../types/song';
import { cx } from './ui';

interface BpmControlProps {
  bpm: number;
  onChange: (bpm: number) => void;
  /** `compact`: only -1 / field / +1 (mobile header). `full`: -5 -1 field +1 +5 and Tap Tempo. */
  variant?: 'compact' | 'full';
  /** 44px tall controls (touch layouts). */
  tall?: boolean;
  className?: string;
}

/** Taps further apart than this restart the measurement. */
const TAP_RESET_MS = 2000;
const TAP_WINDOW = 4;

/**
 * BPM entry that keeps a free-form string draft while typing (so "1" on the way to "140" is never clamped),
 * committing and clamping to 30–300 only on blur or Enter. Escape reverts to the current tempo.
 */
export function BpmControl({ bpm, onChange, variant = 'full', tall, className }: BpmControlProps) {
  const isTall = tall ?? variant === 'compact';
  const [draft, setDraft] = useState<string | null>(null);
  const draftRef = useRef<string | null>(null);
  const taps = useRef<number[]>([]);
  const [tapFlash, setTapFlash] = useState(false);

  const setDraftBoth = (value: string | null) => {
    draftRef.current = value;
    setDraft(value);
  };

  const commit = () => {
    const value = draftRef.current;
    setDraftBoth(null);
    if (value === null) return;
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) onChange(clampBpm(parsed));
  };

  const step = (delta: number) => {
    setDraftBoth(null);
    onChange(clampBpm(bpm + delta));
  };

  const tap = () => {
    const now = performance.now();
    const list = taps.current;
    if (list.length > 0 && now - list[list.length - 1] > TAP_RESET_MS) list.length = 0;
    list.push(now);
    if (list.length > TAP_WINDOW) list.splice(0, list.length - TAP_WINDOW);
    setTapFlash(true);
    window.setTimeout(() => setTapFlash(false), 90);
    if (list.length >= 2) {
      const avgInterval = (list[list.length - 1] - list[0]) / (list.length - 1);
      if (avgInterval > 0) onChange(clampBpm(60000 / avgInterval));
    }
  };

  const stepBtn = (delta: number) => (
    <button
      key={delta}
      type="button"
      aria-label={`${delta > 0 ? 'Increase' : 'Decrease'} BPM by ${Math.abs(delta)}`}
      title={`${delta > 0 ? '+' : ''}${delta} BPM`}
      onClick={() => step(delta)}
      disabled={(delta < 0 && bpm <= MIN_BPM) || (delta > 0 && bpm >= MAX_BPM)}
      className={cx(
        'h-full shrink-0 font-mono text-[11px] text-zinc-300 hover:bg-ink-700 hover:text-white disabled:opacity-30',
        variant === 'compact' ? 'w-11' : 'px-1.5',
      )}
    >
      {delta > 0 ? `+${delta}` : delta}
    </button>
  );

  const inEditing = draft !== null;
  return (
    <div className={cx('flex shrink-0 items-center gap-1', className)}>
      <div
        className={cx(
          'flex shrink-0 items-center overflow-hidden rounded-lg bg-ink-800 ring-1',
          inEditing ? 'ring-sky-500' : 'ring-ink-600',
          isTall ? 'h-11' : 'h-9',
        )}
      >
        {variant === 'full' && stepBtn(-5)}
        {stepBtn(-1)}
        <label className="flex h-full items-center gap-1 border-x border-ink-700 px-1.5 text-[10px] text-mist-400 uppercase">
          <span className={variant === 'compact' ? 'sr-only' : undefined}>bpm</span>
          <input
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            aria-label="Tempo (BPM)"
            title={`Tempo ${MIN_BPM}–${MAX_BPM} BPM · Enter to apply · Esc to cancel`}
            value={draft ?? String(Math.round(bpm))}
            onFocus={(e) => {
              setDraftBoth(String(Math.round(bpm)));
              e.target.select();
            }}
            onChange={(e) => setDraftBoth(e.target.value.replace(/[^0-9]/g, '').slice(0, 3))}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                commit();
                e.currentTarget.blur();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                setDraftBoth(null);
                e.currentTarget.blur();
              }
            }}
            className={cx('bg-transparent text-center font-mono text-sm text-zinc-100 outline-none', variant === 'compact' ? 'w-9' : 'w-10')}
          />
        </label>
        {stepBtn(1)}
        {variant === 'full' && stepBtn(5)}
      </div>
      {variant === 'full' && (
        <button
          type="button"
          onClick={tap}
          title="Tap Tempo (averages the last 4 taps)"
          aria-label="Tap tempo"
          className={cx(
            cx('flex shrink-0 items-center gap-1 rounded-lg border px-2 text-xs font-semibold transition-colors', isTall ? 'h-11 px-3' : 'h-9'),
            tapFlash ? 'border-amber-300 bg-amber-400 text-ink-950' : 'border-ink-600 bg-ink-800 text-zinc-200 hover:bg-ink-700',
          )}
        >
          <Hand size={14} /> Tap
        </button>
      )}
    </div>
  );
}
