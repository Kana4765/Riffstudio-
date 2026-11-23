import { useCallback, useRef, type ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

interface IconButtonProps {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
  accent?: string;
  shortcut?: string;
  showLabel?: boolean;
  className?: string;
  size?: 'sm' | 'md' | 'lg';
}

export function IconButton({
  icon: Icon,
  label,
  onClick,
  active,
  disabled,
  accent,
  shortcut,
  showLabel,
  className,
  size = 'md',
}: IconButtonProps) {
  return (
    <button
      type="button"
      title={shortcut ? `${label} (${shortcut})` : label}
      aria-label={label}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={cx(
        'inline-flex shrink-0 items-center justify-center gap-1.5 rounded-lg border text-xs font-medium transition-colors select-none',
        size === 'sm' ? 'h-7 min-w-7 px-1.5' : size === 'lg' ? 'h-11 min-w-11 px-2.5' : 'h-9 min-w-9 px-2',
        disabled && 'cursor-not-allowed opacity-40',
        active
          ? 'border-transparent text-ink-950'
          : 'border-ink-600 bg-ink-800 text-zinc-200 hover:border-ink-500 hover:bg-ink-700 active:bg-ink-600',
        className,
      )}
      style={active ? { backgroundColor: accent ?? '#f97316' } : undefined}
    >
      <Icon size={size === 'sm' ? 14 : size === 'lg' ? 18 : 16} strokeWidth={2.2} />
      {showLabel && <span className="whitespace-nowrap">{label}</span>}
    </button>
  );
}

interface KnobProps {
  label: string;
  value: number;
  onChange: (value: number) => void;
  color: string;
  disabled?: boolean;
  min?: number;
  max?: number;
  defaultValue?: number;
  size?: number;
}

/** Rotary 0–100 knob: vertical drag (or horizontal on touch), wheel, arrow keys; double-click resets. */
export function Knob({ label, value, onChange, color, disabled, min = 0, max = 100, defaultValue = 50, size = 46 }: KnobProps) {
  const drag = useRef<{ startX: number; startY: number; startValue: number } | null>(null);
  const clampV = useCallback((v: number) => Math.round(Math.min(max, Math.max(min, v))), [min, max]);
  const frac = (value - min) / (max - min);
  const angle = -135 + frac * 270;
  const r = size / 2 - 5;
  const c = size / 2;
  const arc = (from: number, to: number) => {
    const rad = (a: number) => ((a - 90) * Math.PI) / 180;
    const x1 = c + r * Math.cos(rad(from));
    const y1 = c + r * Math.sin(rad(from));
    const x2 = c + r * Math.cos(rad(to));
    const y2 = c + r * Math.sin(rad(to));
    const large = to - from > 180 ? 1 : 0;
    return `M ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2}`;
  };

  return (
    <div className={cx('flex flex-col items-center gap-0.5 select-none', disabled && 'opacity-45')}>
      <div
        role="slider"
        tabIndex={0}
        aria-label={label}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={Math.round(value)}
        className="touch-none cursor-ns-resize rounded-full outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
        style={{ width: size, height: size }}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          drag.current = { startX: e.clientX, startY: e.clientY, startValue: value };
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d) return;
          const delta = (d.startY - e.clientY + (e.clientX - d.startX)) * 0.6;
          onChange(clampV(d.startValue + delta));
        }}
        onPointerUp={() => {
          drag.current = null;
        }}
        onPointerCancel={() => {
          drag.current = null;
        }}
        onDoubleClick={() => onChange(clampV(defaultValue))}
        onWheel={(e) => onChange(clampV(value + (e.deltaY < 0 ? 2 : -2)))}
        onKeyDown={(e) => {
          if (e.key === 'ArrowUp' || e.key === 'ArrowRight') {
            e.preventDefault();
            e.stopPropagation();
            onChange(clampV(value + (e.shiftKey ? 10 : 1)));
          } else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') {
            e.preventDefault();
            e.stopPropagation();
            onChange(clampV(value - (e.shiftKey ? 10 : 1)));
          }
        }}
      >
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
          <path d={arc(-135, 135)} stroke="#2e3446" strokeWidth={4} fill="none" strokeLinecap="round" />
          {frac > 0.005 && <path d={arc(-135, angle)} stroke={color} strokeWidth={4} fill="none" strokeLinecap="round" />}
          <circle cx={c} cy={c} r={r - 6} fill="#1a1f2d" stroke="#3a4157" strokeWidth={1.5} />
          <line
            x1={c}
            y1={c}
            x2={c + (r - 9) * Math.cos(((angle - 90) * Math.PI) / 180)}
            y2={c + (r - 9) * Math.sin(((angle - 90) * Math.PI) / 180)}
            stroke="#f4f4f5"
            strokeWidth={2.4}
            strokeLinecap="round"
          />
        </svg>
      </div>
      <span className="text-[10px] font-semibold tracking-wide text-mist-400 uppercase">{label}</span>
      <span className="font-mono text-[10px] text-zinc-300 tabular-nums">{Math.round(value)}</span>
    </div>
  );
}

export function Panel({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx('rounded-xl border border-ink-700 bg-ink-900', className)}>{children}</div>;
}

export function Divider() {
  return <div className="mx-1 h-6 w-px shrink-0 bg-ink-700" />;
}
