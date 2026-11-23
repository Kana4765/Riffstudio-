import { useCallback, useReducer } from 'react';
import type { Song } from '../types/song';

const MAX_HISTORY = 150;
const COALESCE_MS = 900;

interface HistoryState {
  past: Song[];
  present: Song;
  future: Song[];
  lastKey: string | null;
  lastTime: number;
}

type HistoryAction =
  | { type: 'commit'; updater: (song: Song) => Song; coalesceKey?: string; now: number }
  | { type: 'replace'; song: Song }
  | { type: 'undo' }
  | { type: 'redo' };

function reducer(state: HistoryState, action: HistoryAction): HistoryState {
  switch (action.type) {
    case 'commit': {
      const next = action.updater(state.present);
      if (next === state.present) return state;
      const coalesce =
        action.coalesceKey !== undefined &&
        action.coalesceKey === state.lastKey &&
        action.now - state.lastTime < COALESCE_MS;
      if (coalesce) {
        return { ...state, present: next, future: [], lastTime: action.now };
      }
      const past = [...state.past, state.present];
      if (past.length > MAX_HISTORY) past.splice(0, past.length - MAX_HISTORY);
      return { past, present: next, future: [], lastKey: action.coalesceKey ?? null, lastTime: action.now };
    }
    case 'replace':
      return { past: [], present: action.song, future: [], lastKey: null, lastTime: 0 };
    case 'undo': {
      if (state.past.length === 0) return state;
      const previous = state.past[state.past.length - 1];
      return {
        past: state.past.slice(0, -1),
        present: previous,
        future: [state.present, ...state.future],
        lastKey: null,
        lastTime: 0,
      };
    }
    case 'redo': {
      if (state.future.length === 0) return state;
      const [next, ...rest] = state.future;
      return { past: [...state.past, state.present], present: next, future: rest, lastKey: null, lastTime: 0 };
    }
  }
}

export interface SongHistory {
  song: Song;
  canUndo: boolean;
  canRedo: boolean;
  /** Applies an immutable update. Consecutive updates with the same coalesceKey merge into one undo step. */
  commit: (updater: (song: Song) => Song, coalesceKey?: string) => void;
  replace: (song: Song) => void;
  undo: () => void;
  redo: () => void;
}

export function useSongHistory(initial: () => Song): SongHistory {
  const [state, dispatch] = useReducer(reducer, undefined, () => ({
    past: [],
    present: initial(),
    future: [],
    lastKey: null,
    lastTime: 0,
  }));
  const commit = useCallback(
    (updater: (song: Song) => Song, coalesceKey?: string) => dispatch({ type: 'commit', updater, coalesceKey, now: Date.now() }),
    [],
  );
  const replace = useCallback((song: Song) => dispatch({ type: 'replace', song }), []);
  const undo = useCallback(() => dispatch({ type: 'undo' }), []);
  const redo = useCallback(() => dispatch({ type: 'redo' }), []);
  return {
    song: state.present,
    canUndo: state.past.length > 0,
    canRedo: state.future.length > 0,
    commit,
    replace,
    undo,
    redo,
  };
}
