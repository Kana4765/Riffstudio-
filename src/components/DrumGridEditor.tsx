import { CheckCircle2, Library, Loader2, Play, TriangleAlert } from 'lucide-react';
import { DRUM_KITS, builtInKitLabel, type DrumKitStatus } from '../audio/DrumSampler';
import type { CustomKitSummary } from '../services/drumKitStorage';
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { DRUM_VOICES } from '../constants/presets';
import { usePlayheadSelector, type PlayheadPosition } from '../state/playhead';
import { isBuiltInKit, type DrumHit, type DrumKitId, type DrumMidiNote, type DrumTrack, type Song } from '../types/song';
import { barTicks, uid } from '../utils/timing';
import { cx } from './ui';

export type GridResolution = '1/8' | '1/16' | '1/16T' | '1/32';

export const GRID_TICKS: Record<GridResolution, number> = {
  '1/8': 240,
  '1/16': 120,
  '1/16T': 80,
  '1/32': 60,
};

interface DrumGridEditorProps {
  song: Song;
  track: DrumTrack;
  selectedBar: number;
  onSelectBar: (barIndex: number) => void;
  onChangeHits: (updater: (hits: DrumHit[]) => DrumHit[], coalesceKey?: string) => void;
  onAudition: (note: DrumMidiNote, velocity: number) => void;
  /** Touch layout: 44×44 px pads, tap-to-toggle and native pan scrolling. */
  touch?: boolean;
  kitStatus: DrumKitStatus;
  onKitChange: (kit: DrumKitId) => void;
  customKits: CustomKitSummary[];
  onManageKits: () => void;
}

function KitBadge({ status, custom }: { status: DrumKitStatus; custom: CustomKitSummary | null }) {
  if (custom) {
    return (
      <span
        className="flex h-7 shrink-0 items-center gap-1 rounded-full border border-sky-500/40 bg-sky-500/10 px-2 text-[11px] font-semibold text-sky-200"
        title={`${custom.pieces.length} of 10 pieces are custom samples; the rest use ${builtInKitLabel(custom.baseKit)}`}
      >
        <CheckCircle2 size={12} /> Custom kit · {custom.pieces.length}/10
      </span>
    );
  }
  if (status.state === 'ready') {
    return (
      <span
        className="flex h-7 shrink-0 items-center gap-1 rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2 text-[11px] font-semibold text-emerald-300"
        title={`${status.samples} recorded samples decoded${status.failed ? `, ${status.failed} failed (synth used for those)` : ''}`}
      >
        <CheckCircle2 size={12} /> Real Kit Loaded
      </span>
    );
  }
  if (status.state === 'loading' || status.state === 'idle') {
    return (
      <span className="flex h-7 shrink-0 items-center gap-1 rounded-full border border-ink-600 px-2 text-[11px] text-mist-400">
        <Loader2 size={12} className="animate-spin" /> Loading kit…
      </span>
    );
  }
  return (
    <span
      className="flex h-7 shrink-0 items-center gap-1 rounded-full border border-amber-500/40 bg-amber-500/10 px-2 text-[11px] text-amber-200"
      title={status.reason}
    >
      <TriangleAlert size={12} /> Synth drums
    </span>
  );
}

const VEL_H = 84;
const selectPlayBar = (p: PlayheadPosition | null) => (p ? p.barIndex : -1);

function cellKey(bar: number, note: number, cell: number): string {
  return `${bar}|${note}|${cell}`;
}

export function DrumGridEditor({
  song,
  track,
  selectedBar,
  onSelectBar,
  onChangeHits,
  onAudition,
  touch = false,
  kitStatus,
  onKitChange,
  customKits,
  onManageKits,
}: DrumGridEditorProps) {
  const kitId = track.kit ?? 'rock';
  const customKit = isBuiltInKit(kitId) ? null : (customKits.find((k) => k.id === kitId) ?? null);
  const missingCustom = !isBuiltInKit(kitId) && !customKit;
  const CELL_W = touch ? 44 : 26;
  const ROW_H = touch ? 44 : 30;
  const LABEL_W = touch ? 112 : 92;
  const scrollRef = useRef<HTMLDivElement>(null);
  const lastPointer = useRef<string>('mouse');
  const [resolution, setResolution] = useState<GridResolution>('1/16');
  const [velocity, setVelocity] = useState(100);
  const [lane, setLane] = useState<DrumMidiNote>(38);
  const paint = useRef<{ mode: 'add' | 'remove'; stroke: string } | null>(null);
  const velDrag = useRef<string | null>(null);
  const res = GRID_TICKS[resolution];

  const bars = useMemo(
    () =>
      song.bars.map((bar) => {
        const ticks = barTicks(bar);
        return { bar, ticks, cells: Math.ceil(ticks / res) };
      }),
    [song.bars, res],
  );

  /** Hits grouped by grid cell (hits between grid lines land in the cell that contains them). */
  const cellHits = useMemo(() => {
    const map = new Map<string, DrumHit[]>();
    for (const hit of track.hits) {
      const k = cellKey(hit.barIndex, hit.midiNote, Math.floor(hit.tickOffset / res));
      const list = map.get(k);
      if (list) list.push(hit);
      else map.set(k, [hit]);
    }
    return map;
  }, [track.hits, res]);

  const playSelector = useCallback((p: PlayheadPosition | null) => (p ? `${p.barIndex}:${Math.floor(p.tickInBar / res)}` : ''), [res]);
  const playKey = usePlayheadSelector(playSelector);
  const playBar = usePlayheadSelector(selectPlayBar);

  // Follow playback: keep the playing bar in view horizontally (the row labels stay sticky on the left).
  useEffect(() => {
    if (playBar < 0) return;
    const sc = scrollRef.current;
    const header = sc?.querySelector<HTMLElement>(`[data-bar-header="${playBar}"]`);
    if (!sc || !header) return;
    const left = header.offsetLeft - LABEL_W;
    const right = header.offsetLeft + header.offsetWidth;
    if (left < sc.scrollLeft || right > sc.scrollLeft + sc.clientWidth) {
      sc.scrollTo({ left: Math.max(0, left - 8), behavior: 'smooth' });
    }
  }, [playBar, LABEL_W]);

  const applyCell = (barIndex: number, cell: number, note: DrumMidiNote, mode: 'add' | 'remove' | 'toggle', stroke?: string) => {
    const existing = cellHits.get(cellKey(barIndex, note, cell)) ?? [];
    const effective = mode === 'toggle' ? (existing.length > 0 ? 'remove' : 'add') : mode;
    if (effective === 'add' && existing.length > 0) return effective;
    if (effective === 'remove' && existing.length === 0) return effective;
    const tickOffset = cell * res;
    const inCell = (h: DrumHit) => h.barIndex === barIndex && h.midiNote === note && Math.floor(h.tickOffset / res) === cell;
    onChangeHits((hits) => {
      if (effective === 'remove') return hits.filter((h) => !inCell(h));
      if (hits.some(inCell)) return hits;
      return [...hits, { id: uid('hit'), barIndex, tickOffset, midiNote: note, velocity }];
    }, stroke);
    if (effective === 'add') onAudition(note, velocity);
    return effective;
  };

  const onCellDown = (e: ReactPointerEvent, barIndex: number, cell: number, note: DrumMidiNote) => {
    lastPointer.current = e.pointerType;
    // Touch/pen toggles on click so a swipe can scroll the grid natively instead of painting.
    if (e.pointerType !== 'mouse') return;
    e.preventDefault();
    const stroke = uid('stroke');
    const mode = applyCell(barIndex, cell, note, 'toggle', stroke);
    setLane(note);
    paint.current = { mode, stroke };
    if (barIndex !== selectedBar) onSelectBar(barIndex);
  };

  const onCellClick = (barIndex: number, cell: number, note: DrumMidiNote) => {
    if (lastPointer.current === 'mouse') return;
    applyCell(barIndex, cell, note, 'toggle', uid('stroke'));
    setLane(note);
    if (barIndex !== selectedBar) onSelectBar(barIndex);
  };

  const onCellEnter = (e: ReactPointerEvent, barIndex: number, cell: number, note: DrumMidiNote) => {
    if (!paint.current || e.buttons !== 1) return;
    applyCell(barIndex, cell, note, paint.current.mode, paint.current.stroke);
  };

  const setVelocityFromPointer = (clientX: number, clientY: number, stroke: string) => {
    const el = document.elementFromPoint(clientX, clientY) as HTMLElement | null;
    const col = el?.closest<HTMLElement>('[data-vel-bar]');
    if (!col) return;
    const barIndex = Number(col.dataset.velBar);
    const cell = Number(col.dataset.velCell);
    const hits = cellHits.get(cellKey(barIndex, lane, cell));
    if (!hits || hits.length === 0) return;
    const rect = col.getBoundingClientRect();
    const v = Math.round(Math.min(127, Math.max(1, ((rect.bottom - clientY) / rect.height) * 127)));
    const ids = new Set(hits.map((h) => h.id));
    onChangeHits((all) => all.map((h) => (ids.has(h.id) ? { ...h, velocity: v } : h)), stroke);
  };

  const laneInfo = DRUM_VOICES.find((d) => d.note === lane) ?? DRUM_VOICES[0];
  const totalWidth = bars.reduce((s, b) => s + b.cells * CELL_W + 6, 0);

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-ink-950">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-ink-700 bg-ink-900 px-2 py-1.5">
        <label className="flex items-center gap-1.5 text-[11px] font-bold tracking-widest text-mist-400 uppercase">
          Kit
          <select
            aria-label="Drum kit"
            value={kitId}
            onChange={(e) => onKitChange(e.target.value as DrumKitId)}
            className={cx(
              'max-w-[15rem] rounded-lg border border-ink-600 bg-ink-800 px-2 text-xs font-medium tracking-normal text-zinc-100 normal-case outline-none',
              touch ? 'h-11' : 'h-8',
            )}
          >
            <optgroup label="Built-in Kits">
              {DRUM_KITS.map((k) => (
                <option key={k.id} value={k.id}>
                  {k.label}
                </option>
              ))}
            </optgroup>
            <optgroup label="My Custom Kits">
              {customKits.map((k) => (
                <option key={k.id} value={k.id}>
                  {k.name} ({k.pieces.length}/10)
                </option>
              ))}
              {missingCustom && (
                <option value={kitId}>
                  {track.kitName ?? 'Custom kit'} — not on this device (using {track.kitBase === 'acoustic' ? 'Acoustic' : 'Rock'})
                </option>
              )}
            </optgroup>
          </select>
        </label>
        <button
          type="button"
          onClick={onManageKits}
          className={cx(
            'flex shrink-0 items-center gap-1.5 rounded-lg border border-ink-600 bg-ink-800 px-2.5 text-xs font-semibold text-zinc-100 hover:bg-ink-700',
            touch ? 'h-11 min-w-11' : 'h-8',
          )}
        >
          <Library size={14} /> Manage Kits
        </button>
        <KitBadge status={kitStatus} custom={customKit} />
        <span className="text-[11px] font-bold tracking-widest text-mist-400 uppercase">Grid</span>
        <div className="flex rounded-lg border border-ink-600 bg-ink-800 p-0.5">
          {(Object.keys(GRID_TICKS) as GridResolution[]).map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => setResolution(r)}
              className={cx(
                'h-7 rounded-md px-2.5 font-mono text-xs',
                r === resolution ? 'bg-rose-500 text-ink-950' : 'text-zinc-300 hover:bg-ink-700',
              )}
            >
              {r}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-2 text-[11px] text-mist-400 uppercase">
          Velocity
          <input type="range" min={1} max={127} value={velocity} onChange={(e) => setVelocity(Number(e.target.value))} className="w-24" />
          <span className="w-7 font-mono text-xs text-zinc-200">{velocity}</span>
        </label>
        <span className="ml-auto text-[11px] text-mist-400">
          Click a cell to toggle · drag to paint · edit <b className="text-zinc-200">{laneInfo.name}</b> velocities below
        </span>
      </div>

      <div ref={scrollRef} className="touch-pan min-h-0 flex-1 overflow-auto overscroll-contain">
        <div className="relative" style={{ width: LABEL_W + totalWidth + 12 }}>
          {/* Bar header */}
          <div className="sticky top-0 z-20 flex border-b border-ink-700 bg-ink-900">
            <div className="sticky left-0 z-30 shrink-0 border-r border-ink-700 bg-ink-900" style={{ width: LABEL_W }} />
            {bars.map(({ bar, cells }) => (
              <button
                key={bar.index}
                type="button"
                data-bar-header={bar.index}
                onClick={() => onSelectBar(bar.index)}
                className={cx(
                  'mr-1.5 flex shrink-0 items-center gap-2 border-l-2 px-1.5 text-left font-mono text-[11px]',
                  bar.index === selectedBar ? 'border-sky-400 bg-sky-500/15 text-sky-100' : 'border-ink-600 text-mist-400 hover:bg-ink-800',
                )}
                style={{ width: cells * CELL_W, height: touch ? 36 : 28 }}
              >
                <b>{bar.index + 1}</b>
                <span>
                  {bar.numerator}/{bar.denominator}
                </span>
              </button>
            ))}
          </div>

          {/* Lanes */}
          {DRUM_VOICES.map((voice) => (
            <div key={voice.note} className="flex" style={{ height: ROW_H }}>
              <div
                className={cx(
                  'sticky left-0 z-10 flex shrink-0 items-center gap-1 border-r border-b border-ink-700 px-1.5',
                  voice.note === lane ? 'bg-ink-700' : 'bg-ink-900',
                )}
                style={{ width: LABEL_W }}
              >
                <button
                  type="button"
                  aria-label={`Audition ${voice.name}`}
                  onClick={() => {
                    setLane(voice.note);
                    onAudition(voice.note, velocity);
                  }}
                  className={cx(
                    'flex shrink-0 items-center justify-center rounded-md bg-ink-800 text-rose-300 hover:bg-rose-500 hover:text-ink-950 active:bg-rose-500',
                    touch ? 'h-11 w-11 rounded-xl' : 'h-6 w-6',
                  )}
                >
                  <Play size={touch ? 15 : 11} />
                </button>
                <button type="button" onClick={() => setLane(voice.note)} className="min-w-0 truncate text-left text-[11px] text-zinc-200">
                  {voice.name}
                </button>
              </div>
              {bars.map(({ bar, cells }) => (
                <div key={bar.index} className="mr-1.5 flex shrink-0">
                  {Array.from({ length: cells }, (_, cell) => {
                    const hits = cellHits.get(cellKey(bar.index, voice.note, cell));
                    const hit = hits?.[0];
                    const onGrid = hit ? hit.tickOffset % res === 0 : true;
                    const beatStart = (cell * res) % (bar.denominator === 8 ? 240 * 3 : 480) === 0;
                    const playing = playKey === `${bar.index}:${cell}`;
                    return (
                      <div
                        key={cell}
                        onPointerDown={(e) => onCellDown(e, bar.index, cell, voice.note)}
                        onPointerEnter={(e) => onCellEnter(e, bar.index, cell, voice.note)}
                        onClick={() => onCellClick(bar.index, cell, voice.note)}
                        onPointerUp={() => {
                          paint.current = null;
                        }}
                        className={cx(
                          'drum-cell flex shrink-0 cursor-pointer items-center justify-center border-b border-ink-800',
                          beatStart ? 'border-l border-l-ink-600' : 'border-l border-l-ink-800',
                          playing ? 'bg-emerald-500/20' : bar.index === selectedBar ? 'bg-ink-900' : 'bg-ink-950',
                        )}
                        style={{ width: CELL_W, height: ROW_H }}
                      >
                        {hit && (
                          <span
                            className={cx(
                              'pointer-events-none block rounded-[5px]',
                              onGrid ? (touch ? 'h-[34px] w-[34px] rounded-lg' : 'h-[22px] w-[20px]') : touch ? 'h-[20px] w-[20px] rotate-45' : 'h-[14px] w-[14px] rotate-45',
                            )}
                            style={{
                              backgroundColor: track.color,
                              opacity: 0.25 + (hit.velocity / 127) * 0.75,
                              boxShadow: hit.velocity > 110 ? `0 0 6px ${track.color}` : undefined,
                            }}
                            title={`${voice.name} · vel ${hit.velocity}${hits && hits.length > 1 ? ` · ${hits.length} hits` : ''}`}
                          />
                        )}
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          ))}

          {/* Velocity editor for the selected lane */}
          <div className="flex border-t-2 border-ink-600" style={{ height: VEL_H + 8 }}>
            <div
              className="sticky left-0 z-10 flex shrink-0 flex-col justify-center border-r border-ink-700 bg-ink-900 px-2 text-[10px] text-mist-400 uppercase"
              style={{ width: LABEL_W }}
            >
              Velocity
              <span className="text-[11px] font-semibold text-zinc-200 normal-case">{laneInfo.name}</span>
            </div>
            <div
              className="flex touch-none items-end pt-2"
              onPointerDown={(e) => {
                e.currentTarget.setPointerCapture(e.pointerId);
                velDrag.current = uid('vel');
                setVelocityFromPointer(e.clientX, e.clientY, velDrag.current);
              }}
              onPointerMove={(e) => {
                if (velDrag.current) setVelocityFromPointer(e.clientX, e.clientY, velDrag.current);
              }}
              onPointerUp={() => {
                velDrag.current = null;
              }}
              onPointerCancel={() => {
                velDrag.current = null;
              }}
            >
              {bars.map(({ bar, cells }) => (
                <div key={bar.index} className="mr-1.5 flex shrink-0 items-end">
                  {Array.from({ length: cells }, (_, cell) => {
                    const hit = cellHits.get(cellKey(bar.index, lane, cell))?.[0];
                    return (
                      <div
                        key={cell}
                        data-vel-bar={bar.index}
                        data-vel-cell={cell}
                        className="flex shrink-0 items-end justify-center border-l border-ink-800"
                        style={{ width: CELL_W, height: VEL_H }}
                      >
                        {hit && (
                          <div
                            className="pointer-events-none w-[14px] rounded-t-sm"
                            style={{ height: `${(hit.velocity / 127) * 100}%`, backgroundColor: track.color }}
                          />
                        )}
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
