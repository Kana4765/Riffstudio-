import type { Song } from '../types/song';
import { normalizeSong } from '../utils/songOps';
import { uid } from '../utils/timing';

export const RECENT_PROJECTS_KEY = 'riffforge_recent_projects';
const MAX_PROJECTS = 24;

export interface RecentProject {
  song: Song;
  updatedAt: number;
}

interface StoredPayload {
  version: 1;
  projects: { updatedAt: number; song: unknown }[];
}

function storage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

/** Reads and validates all stored projects (corrupt entries are skipped), newest first. */
export function listRecentProjects(): RecentProject[] {
  const store = storage();
  if (!store) return [];
  let raw: string | null = null;
  try {
    raw = store.getItem(RECENT_PROJECTS_KEY);
  } catch {
    return [];
  }
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as Partial<StoredPayload>;
    const entries = Array.isArray(parsed.projects) ? parsed.projects : [];
    const out: RecentProject[] = [];
    for (const entry of entries) {
      try {
        const updatedAt = typeof entry.updatedAt === 'number' ? entry.updatedAt : 0;
        out.push({ song: normalizeSong(entry.song), updatedAt });
      } catch {
        // Skip entries that no longer validate.
      }
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  } catch {
    return [];
  }
}

function writeAll(projects: RecentProject[]): boolean {
  const store = storage();
  if (!store) return false;
  let list = [...projects].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_PROJECTS);
  // On quota errors drop the oldest projects until the payload fits.
  while (list.length > 0) {
    const payload: StoredPayload = { version: 1, projects: list.map((p) => ({ updatedAt: p.updatedAt, song: p.song })) };
    try {
      store.setItem(RECENT_PROJECTS_KEY, JSON.stringify(payload));
      return true;
    } catch {
      list = list.slice(0, -1);
    }
  }
  try {
    store.removeItem(RECENT_PROJECTS_KEY);
  } catch {
    // Storage unavailable.
  }
  return false;
}

/** Inserts or updates a project (matched by song id) and marks it as most recently edited. */
export function saveRecentProject(song: Song, updatedAt = Date.now()): boolean {
  const others = listRecentProjects().filter((p) => p.song.id !== song.id);
  return writeAll([{ song, updatedAt }, ...others]);
}

export function deleteRecentProject(id: string): void {
  writeAll(listRecentProjects().filter((p) => p.song.id !== id));
}

/** Stores a copy of a project under a new id and returns it. */
export function duplicateRecentProject(id: string): Song | null {
  const source = listRecentProjects().find((p) => p.song.id === id);
  if (!source) return null;
  const copy: Song = { ...source.song, id: uid('song'), title: `${source.song.title} (copy)` };
  saveRecentProject(copy);
  return copy;
}
