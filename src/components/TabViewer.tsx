import * as alphaTab from '@coderline/alphatab';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { usePlayheadSelector, type PlayheadPosition } from '../state/playhead';
import type { PitchedTrack, Song } from '../types/song';
import { generateAlphaTex, type AlphaTexResult } from '../utils/alphaTexGenerator';
import type { TabCursor } from '../utils/tabEditing';

interface TabViewerProps {
  song: Song;
  track: PitchedTrack;
  cursor: TabCursor;
  isPlaying: boolean;
  onSelect: (barIndex: number, position: number, stringIndex?: number) => void;
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

type AtBeat = alphaTab.model.Beat;
type AtNote = alphaTab.model.Note;

/** Index of the rendered beat that contains `tick`, using the generator's per-bar start ticks. */
function renderedBeatIndexAt(tex: AlphaTexResult, barIndex: number, tick: number): number {
  const starts = tex.beatStartTicks[barIndex];
  if (!starts || starts.length === 0) return -1;
  let idx = 0;
  for (let i = 0; i < starts.length; i++) if (starts[i] <= tick) idx = i;
  return idx;
}

export function TabViewer({ song, track, cursor, isPlaying, onSelect }: TabViewerProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const apiRef = useRef<alphaTab.AlphaTabApi | null>(null);
  const texRef = useRef<AlphaTexResult | null>(null);
  const trackRef = useRef(track);
  const onSelectRef = useRef(onSelect);
  const [renderVersion, setRenderVersion] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [cursorRect, setCursorRect] = useState<Rect | null>(null);

  const tex = useMemo(() => generateAlphaTex(song, track), [song, track]);
  texRef.current = tex;
  trackRef.current = track;
  onSelectRef.current = onSelect;

  const selectFromBeat = useCallback((beat: AtBeat, note: AtNote | null) => {
    const barIndex = beat.voice.bar.index;
    const emitted = texRef.current?.emittedBeatIds[barIndex] ?? [];
    const position = Math.min(beat.index, emitted.length);
    const strings = trackRef.current.tuning.length;
    const stringIndex = note ? Math.min(strings, Math.max(1, strings - note.string + 1)) : undefined;
    onSelectRef.current(barIndex, position, stringIndex);
  }, []);

  // Create the alphaTab renderer once. The internal player is disabled: AudioEngine owns playback.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const settings = new alphaTab.Settings();
    settings.core.engine = 'svg';
    settings.core.logLevel = alphaTab.LogLevel.Warning;
    settings.core.includeNoteBounds = true;
    settings.display.staveProfile = alphaTab.StaveProfile.Tab;
    settings.display.layoutMode = alphaTab.LayoutMode.Page;
    settings.display.scale = window.innerWidth < 640 ? 0.85 : 1;
    settings.notation.rhythmMode = alphaTab.TabRhythmMode.ShowWithBars;
    settings.player.enablePlayer = false;

    const api = new alphaTab.AlphaTabApi(host, settings);
    apiRef.current = api;
    api.renderStarted.on(() => setLoading(true));
    api.postRenderFinished.on(() => {
      setLoading(false);
      setRenderVersion((v) => v + 1);
    });
    api.error.on((e: Error) => {
      setLoading(false);
      setError(e.message || String(e));
    });
    api.beatMouseDown.on((beat: AtBeat) => selectFromBeat(beat, null));
    return () => {
      apiRef.current = null;
      api.destroy();
    };
  }, [selectFromBeat]);

  // Recompile + re-render whenever the song or active track changes.
  useEffect(() => {
    const api = apiRef.current;
    if (!api) return;
    setError(null);
    try {
      api.tex(tex.tex);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [tex.tex]);

  const surfaceOffset = useCallback((): { x: number; y: number } | null => {
    const host = hostRef.current;
    const wrap = wrapRef.current;
    if (!host || !wrap) return null;
    const surface = host.querySelector<HTMLElement>('.at-surface') ?? host;
    const s = surface.getBoundingClientRect();
    const w = wrap.getBoundingClientRect();
    return { x: s.left - w.left, y: s.top - w.top };
  }, []);

  const rectForRenderedBeat = useCallback(
    (barIndex: number, beatIndex: number): Rect | null => {
      const api = apiRef.current;
      const lookup = api?.renderer.boundsLookup;
      const voice = api?.score?.tracks[0]?.staves[0]?.bars[barIndex]?.voices[0];
      if (!lookup || !voice || voice.beats.length === 0) return null;
      const beat = voice.beats[Math.max(0, Math.min(beatIndex, voice.beats.length - 1))];
      const bounds = lookup.findBeat(beat);
      const off = surfaceOffset();
      if (!bounds || !off) return null;
      const vb = bounds.visualBounds;
      const bar = bounds.barBounds.realBounds;
      return { x: vb.x + off.x - 4, y: bar.y + off.y, w: Math.max(14, vb.w + 8), h: bar.h };
    },
    [surfaceOffset],
  );

  /**
   * Keeps a rect comfortably inside the score viewport. The viewport ends above the touch dock (they are
   * siblings in a flex column), and a 20% bottom margin means the playing system scrolls up before it reaches it.
   */
  const scrollIntoView = useCallback((rect: Rect) => {
    const sc = scrollRef.current;
    const wrap = wrapRef.current;
    if (!sc || !wrap) return;
    const offset = wrap.offsetTop;
    const top = rect.y + offset;
    const bottom = top + rect.h;
    const margin = Math.min(120, sc.clientHeight * 0.2);
    if (top < sc.scrollTop + 8 || bottom > sc.scrollTop + sc.clientHeight - margin) {
      sc.scrollTo({ top: Math.max(0, top - Math.max(12, sc.clientHeight * 0.18)), behavior: 'smooth' });
    }
    const left = rect.x;
    if (left < sc.scrollLeft || left + rect.w > sc.scrollLeft + sc.clientWidth) {
      sc.scrollTo({ left: Math.max(0, left - sc.clientWidth / 3), behavior: 'smooth' });
    }
  }, []);

  // Editor cursor overlay.
  useLayoutEffect(() => {
    const emitted = tex.emittedBeatIds[cursor.barIndex] ?? [];
    const idx = Math.min(cursor.position, emitted.length);
    const rect = rectForRenderedBeat(cursor.barIndex, idx);
    setCursorRect(rect);
    if (rect && !isPlaying) scrollIntoView(rect);
  }, [cursor.barIndex, cursor.position, tex, renderVersion, rectForRenderedBeat, isPlaying, scrollIntoView]);

  const lastPointer = useRef('mouse');

  /** Mouse selects on press; touch/pen select on click so swiping scrolls the score instead of moving the cursor. */
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    lastPointer.current = e.pointerType;
    if (e.pointerType === 'mouse') selectAt(e.clientX, e.clientY);
  };

  const onClick = (e: { clientX: number; clientY: number }) => {
    if (lastPointer.current !== 'mouse') selectAt(e.clientX, e.clientY);
  };

  const selectAt = (clientX: number, clientY: number) => {
    const api = apiRef.current;
    const lookup = api?.renderer.boundsLookup;
    const host = hostRef.current;
    if (!lookup || !host) return;
    const surface = host.querySelector<HTMLElement>('.at-surface') ?? host;
    const r = surface.getBoundingClientRect();
    const x = clientX - r.left;
    const y = clientY - r.top;
    const beat = lookup.getBeatAtPos(x, y);
    if (!beat) return;
    selectFromBeat(beat, lookup.getNoteAtPos(beat, x, y));
  };

  return (
    <div ref={scrollRef} className="touch-pan relative min-h-0 flex-1 overflow-auto overscroll-contain bg-ink-950 p-2 sm:p-3">
      {tex.overflowBars.length > 0 && (
        <div className="sticky top-0 z-20 mb-2 flex items-center gap-2 rounded-lg border border-amber-500/40 bg-amber-500/15 px-3 py-1.5 text-xs text-amber-200">
          <AlertTriangle size={14} />
          Bar {tex.overflowBars.map((b) => b + 1).join(', ')} {tex.overflowBars.length > 1 ? 'are' : 'is'} too full — beats past the bar
          line are hidden and muted. Shorten or delete beats.
        </div>
      )}
      {error && (
        <div className="mb-2 rounded-lg border border-rose-500/40 bg-rose-500/15 px-3 py-1.5 text-xs text-rose-200">
          Notation error: {error}
        </div>
      )}
      <div ref={wrapRef} className="relative rounded-xl bg-[#f7f5ef] shadow-inner" onPointerDown={onPointerDown} onClick={onClick}>
        <div ref={hostRef} className="alphatab-host min-h-[220px]" />
        {cursorRect && (
          <div
            className="pointer-events-none absolute z-10 rounded-md border-2 border-sky-500 bg-sky-400/15"
            style={{ left: cursorRect.x, top: cursorRect.y, width: cursorRect.w, height: cursorRect.h }}
          />
        )}
        <PlayheadOverlay
          tex={tex}
          renderVersion={renderVersion}
          rectForRenderedBeat={rectForRenderedBeat}
          onFollow={scrollIntoView}
        />
        {loading && (
          <div className="absolute top-2 right-2 z-20 flex items-center gap-1.5 rounded-full bg-ink-900/80 px-2 py-1 text-[11px] text-zinc-200">
            <Loader2 size={12} className="animate-spin" /> Rendering
          </div>
        )}
      </div>
    </div>
  );
}

function PlayheadOverlay({
  tex,
  renderVersion,
  rectForRenderedBeat,
  onFollow,
}: {
  tex: AlphaTexResult;
  renderVersion: number;
  rectForRenderedBeat: (bar: number, beat: number) => Rect | null;
  onFollow: (rect: Rect) => void;
}) {
  const selector = useCallback(
    (p: PlayheadPosition | null) => (p ? `${p.barIndex}:${renderedBeatIndexAt(tex, p.barIndex, p.tickInBar)}` : null),
    [tex],
  );
  const key = usePlayheadSelector(selector);
  const [rect, setRect] = useState<Rect | null>(null);

  useLayoutEffect(() => {
    if (!key) {
      setRect(null);
      return;
    }
    const [bar, beat] = key.split(':').map(Number);
    const r = beat >= 0 ? rectForRenderedBeat(bar, beat) : null;
    setRect(r);
    if (r) onFollow(r);
  }, [key, renderVersion, rectForRenderedBeat, onFollow]);

  if (!rect) return null;
  return (
    <div
      className="pointer-events-none absolute z-10 rounded-md bg-emerald-400/35 ring-2 ring-emerald-500"
      style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}
    />
  );
}
