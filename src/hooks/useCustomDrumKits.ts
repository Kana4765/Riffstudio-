import { useCallback, useEffect, useState } from 'react';
import { drumSampler } from '../audio/DrumSampler';
import { getDrumKit, listDrumKitSummaries, onDrumKitsChanged, type CustomKitSummary } from '../services/drumKitStorage';

export interface CustomDrumKitsState {
  kits: CustomKitSummary[];
  /** False until IndexedDB has been read once. */
  loaded: boolean;
  /** Set when IndexedDB is unavailable or failed. */
  error: string | null;
  refresh: () => void;
}

/**
 * Lists custom kits from IndexedDB and keeps the sampler's decoded cache in sync with `activeKitIds` (kits
 * used by drum tracks of the open song, plus the one being edited). Unused kits are freed from memory.
 */
export function useCustomDrumKits(activeKitIds: readonly string[]): CustomDrumKitsState {
  const [kits, setKits] = useState<CustomKitSummary[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);

  const refresh = useCallback(() => setVersion((v) => v + 1), []);

  useEffect(() => onDrumKitsChanged(refresh), [refresh]);

  useEffect(() => {
    let cancelled = false;
    listDrumKitSummaries()
      .then((list) => {
        if (cancelled) return;
        setKits(list);
        setError(null);
        setLoaded(true);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [version]);

  const activeKey = [...new Set(activeKitIds)].sort().join('|');
  useEffect(() => {
    if (!loaded) return;
    const needed = activeKey ? activeKey.split('|') : [];
    const known = new Map(kits.map((k) => [k.id, k]));
    const keep = needed.filter((id) => known.has(id));
    drumSampler.retainCustomKits(keep);
    for (const id of keep) {
      const summary = known.get(id);
      const cached = drumSampler.customKitState(id);
      if (cached && summary && cached.updatedAt === summary.updatedAt) continue;
      void getDrumKit(id).then((kit) => {
        if (kit) return drumSampler.ensureCustomKit(kit);
        return undefined;
      });
    }
  }, [activeKey, kits, loaded]);

  return { kits, loaded, error, refresh };
}
