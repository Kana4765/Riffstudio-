import { useCallback, useSyncExternalStore } from 'react';

export interface PlayheadPosition {
  barIndex: number;
  tickInBar: number;
}

type Listener = () => void;

let current: PlayheadPosition | null = null;
const listeners = new Set<Listener>();

/** Tiny external store so only playhead-aware widgets re-render on every animation frame. */
export const playheadStore = {
  get(): PlayheadPosition | null {
    return current;
  },
  set(next: PlayheadPosition | null): void {
    if (next === current) return;
    if (next && current && next.barIndex === current.barIndex && next.tickInBar === current.tickInBar) return;
    current = next;
    for (const l of listeners) l();
  },
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

/**
 * Subscribes to a derived primitive of the playhead (e.g. "bar:beat"); the component only re-renders when
 * the derived value changes. The selector must return a primitive for referential stability.
 */
export function usePlayheadSelector<T extends string | number | boolean | null>(
  selector: (pos: PlayheadPosition | null) => T,
): T {
  const getSnapshot = useCallback(() => selector(playheadStore.get()), [selector]);
  return useSyncExternalStore(playheadStore.subscribe, getSnapshot, getSnapshot);
}
