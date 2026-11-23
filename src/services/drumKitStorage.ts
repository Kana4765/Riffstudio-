import type { BuiltInDrumKitId } from '../types/song';
import { openTextFile, safeFileName, saveTextFile } from './fileService';
import { uid } from '../utils/timing';

/**
 * Persistent store for user-made drum kits (IndexedDB `riffforge_drum_kits` / `kits`).
 *
 * The audio is kept as the original encoded bytes (WAV/MP3/OGG/FLAC/WebM) and decoded and auto-trimmed when
 * the kit is loaded. IndexedDB lives in the WebView profile on Windows (WebView2) and Android, so kits
 * survive restarts, and it has no 5 MB cap like localStorage.
 */

export const KIT_PIECE_NOTES = [36, 38, 42, 46, 48, 45, 41, 49, 51, 52] as const;
export type KitPieceNote = (typeof KIT_PIECE_NOTES)[number];

export const KIT_PIECE_NAMES: Record<KitPieceNote, string> = {
  36: 'Kick',
  38: 'Snare',
  42: 'Closed Hi-Hat',
  46: 'Open Hi-Hat',
  48: 'High Tom',
  45: 'Mid Tom',
  41: 'Floor Tom',
  49: 'Crash',
  51: 'Ride',
  52: 'China',
};

export interface KitSample {
  fileName: string;
  arrayBuffer: ArrayBuffer;
  /** MIME type of the encoded audio, when known (e.g. "audio/webm;codecs=opus" for mic recordings). */
  mimeType?: string;
}

export interface CustomDrumKit {
  id: string;
  name: string;
  /** Built-in kit that plays every piece this kit doesn't have a sample for. */
  baseKit: BuiltInDrumKitId;
  createdAt: number;
  /** Bumped on every change; the sampler re-decodes the kit when this changes. */
  updatedAt: number;
  samples: Partial<Record<number, KitSample>>;
}

/** Lightweight listing entry (no audio data). */
export interface CustomKitSummary {
  id: string;
  name: string;
  baseKit: BuiltInDrumKitId;
  createdAt: number;
  updatedAt: number;
  pieces: number[];
  /** Original file name per filled slot. */
  files: Partial<Record<number, string>>;
}

const DB_NAME = 'riffforge_drum_kits';
const STORE = 'kits';
const DB_VERSION = 1;
/** Upper bound per sample so a mistaken upload (a whole song) can't bloat the database. */
export const MAX_SAMPLE_BYTES = 15 * 1024 * 1024;

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB is not available in this WebView'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => {
      const db = req.result;
      // If another tab upgrades the schema, drop our handle so the next call reopens it.
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };
    req.onerror = () => {
      dbPromise = null;
      reject(req.error ?? new Error('Could not open the drum kit database'));
    };
    req.onblocked = () => reject(new Error('The drum kit database is blocked by another open RiffForge window'));
  });
  return dbPromise;
}

async function withStore<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    let result: T;
    req.onsuccess = () => {
      result = req.result;
    };
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error ?? req.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted (storage full?)'));
  });
}

// --------------------------------------------------------------------------------------- change events

type Listener = () => void;
const listeners = new Set<Listener>();
const channel: BroadcastChannel | null = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('riffforge-drum-kits') : null;
channel?.addEventListener('message', () => listeners.forEach((l) => l()));

function notifyChanged(): void {
  listeners.forEach((l) => l());
  channel?.postMessage('changed');
}

/** Called after any kit is created, edited or deleted (in this window or another one). */
export function onDrumKitsChanged(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// --------------------------------------------------------------------------------------- CRUD

function isBaseKit(v: unknown): v is BuiltInDrumKitId {
  return v === 'rock' || v === 'acoustic';
}

export function summarizeKit(kit: CustomDrumKit): CustomKitSummary {
  return {
    id: kit.id,
    name: kit.name,
    baseKit: kit.baseKit,
    createdAt: kit.createdAt,
    updatedAt: kit.updatedAt,
    pieces: Object.keys(kit.samples)
      .map(Number)
      .filter((n) => kit.samples[n] !== undefined)
      .sort((a, b) => a - b),
    files: Object.fromEntries(
      Object.entries(kit.samples)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => [Number(k), v?.fileName ?? '']),
    ),
  };
}

/** All kits, sorted by name (includes the audio data). */
export async function listDrumKits(): Promise<CustomDrumKit[]> {
  const all = await withStore<CustomDrumKit[]>('readonly', (s) => s.getAll() as IDBRequest<CustomDrumKit[]>);
  return all
    .map((k) => ({ ...k, updatedAt: k.updatedAt ?? k.createdAt, baseKit: isBaseKit(k.baseKit) ? k.baseKit : 'rock' }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.createdAt - b.createdAt);
}

/** Kit list without audio data, for menus and the kit sidebar. */
export async function listDrumKitSummaries(): Promise<CustomKitSummary[]> {
  return (await listDrumKits()).map(summarizeKit);
}

export async function getDrumKit(id: string): Promise<CustomDrumKit | null> {
  const kit = await withStore<CustomDrumKit | undefined>('readonly', (s) => s.get(id) as IDBRequest<CustomDrumKit | undefined>);
  return kit ?? null;
}

let persistRequested = false;

export async function saveDrumKit(kit: CustomDrumKit): Promise<CustomDrumKit> {
  const record: CustomDrumKit = { ...kit, name: kit.name.trim() || 'Untitled Kit', updatedAt: Date.now() };
  await withStore('readwrite', (s) => s.put(record));
  // Ask the browser/WebView not to evict the kits under storage pressure (granted silently in installed apps).
  if (!persistRequested && typeof navigator !== 'undefined' && navigator.storage?.persist) {
    persistRequested = true;
    void navigator.storage.persist().catch(() => false);
  }
  notifyChanged();
  return record;
}

export async function deleteDrumKit(id: string): Promise<void> {
  await withStore('readwrite', (s) => s.delete(id));
  notifyChanged();
}

export function createEmptyKit(name: string, baseKit: BuiltInDrumKitId): CustomDrumKit {
  const now = Date.now();
  return { id: uid('kit'), name: name.trim() || 'Untitled Kit', baseKit, createdAt: now, updatedAt: now, samples: {} };
}

export async function createDrumKit(name: string, baseKit: BuiltInDrumKitId): Promise<CustomDrumKit> {
  return saveDrumKit(createEmptyKit(name, baseKit));
}

export async function renameDrumKit(id: string, name: string): Promise<CustomDrumKit | null> {
  const kit = await getDrumKit(id);
  return kit ? saveDrumKit({ ...kit, name }) : null;
}

export async function setKitBase(id: string, baseKit: BuiltInDrumKitId): Promise<CustomDrumKit | null> {
  const kit = await getDrumKit(id);
  return kit ? saveDrumKit({ ...kit, baseKit }) : null;
}

export async function duplicateDrumKit(id: string): Promise<CustomDrumKit | null> {
  const kit = await getDrumKit(id);
  if (!kit) return null;
  const now = Date.now();
  return saveDrumKit({ ...kit, id: uid('kit'), name: `${kit.name} (copy)`, createdAt: now, updatedAt: now, samples: { ...kit.samples } });
}

export async function setKitSample(id: string, note: number, sample: KitSample | null): Promise<CustomDrumKit | null> {
  const kit = await getDrumKit(id);
  if (!kit) return null;
  if (sample && sample.arrayBuffer.byteLength > MAX_SAMPLE_BYTES) {
    throw new Error(`"${sample.fileName}" is larger than ${Math.round(MAX_SAMPLE_BYTES / 1024 / 1024)} MB — use a single drum hit`);
  }
  const samples = { ...kit.samples };
  if (sample) samples[note] = sample;
  else delete samples[note];
  return saveDrumKit({ ...kit, samples });
}

// --------------------------------------------------------------------------------------- portable .rfkit.json

interface PortableKit {
  format: 'riffforge-drumkit';
  version: 1;
  name: string;
  baseKit: BuiltInDrumKitId;
  createdAt: number;
  samples: Record<string, { fileName: string; mimeType?: string; data: string }>;
}

export function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  const chunk = 0x8000;
  let bin = '';
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

export function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const bin = atob(b64.replace(/\s+/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

export function kitToPortableJson(kit: CustomDrumKit): string {
  const samples: PortableKit['samples'] = {};
  for (const [note, s] of Object.entries(kit.samples)) {
    if (!s) continue;
    samples[note] = { fileName: s.fileName, mimeType: s.mimeType, data: arrayBufferToBase64(s.arrayBuffer) };
  }
  const portable: PortableKit = { format: 'riffforge-drumkit', version: 1, name: kit.name, baseKit: kit.baseKit, createdAt: kit.createdAt, samples };
  return JSON.stringify(portable);
}

/** Validates a portable kit file and returns a new kit record with a fresh id (never overwrites a kit). */
export function kitFromPortableJson(text: string): CustomDrumKit {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Not a valid .rfkit.json file (invalid JSON)');
  }
  const p = parsed as Partial<PortableKit> | null;
  if (!p || typeof p !== 'object' || p.format !== 'riffforge-drumkit') throw new Error('Not a RiffForge drum kit file');
  const samples: CustomDrumKit['samples'] = {};
  const valid = new Set<number>(KIT_PIECE_NOTES);
  for (const [key, s] of Object.entries(p.samples ?? {})) {
    const note = Number(key);
    if (!valid.has(note) || !s || typeof s.data !== 'string') continue;
    const arrayBuffer = base64ToArrayBuffer(s.data);
    if (arrayBuffer.byteLength === 0 || arrayBuffer.byteLength > MAX_SAMPLE_BYTES) continue;
    samples[note] = { fileName: typeof s.fileName === 'string' ? s.fileName.slice(0, 120) : `piece-${note}`, mimeType: s.mimeType, arrayBuffer };
  }
  const now = Date.now();
  return {
    id: uid('kit'),
    name: (typeof p.name === 'string' && p.name.trim() ? p.name : 'Imported Kit').slice(0, 60),
    baseKit: isBaseKit(p.baseKit) ? p.baseKit : 'rock',
    createdAt: typeof p.createdAt === 'number' ? p.createdAt : now,
    updatedAt: now,
    samples,
  };
}

/** Saves a kit as `<name>.rfkit.json` (native save dialog in Tauri, download in a browser). */
export async function exportDrumKit(id: string): Promise<string | null> {
  const kit = await getDrumKit(id);
  if (!kit) throw new Error('Kit not found');
  return saveTextFile(`${safeFileName(kit.name, 'drum-kit')}.rfkit.json`, kitToPortableJson(kit), { name: 'RiffForge Drum Kit', extensions: ['json'] });
}

/** Opens a `.rfkit.json` file and stores it as a new kit. Returns null if the user cancelled. */
export async function importDrumKit(): Promise<CustomDrumKit | null> {
  const file = await openTextFile({ name: 'RiffForge Drum Kit', extensions: ['json'] });
  if (!file) return null;
  const kit = kitFromPortableJson(file.content);
  const existing = await listDrumKits();
  if (existing.some((k) => k.name.toLowerCase() === kit.name.toLowerCase())) kit.name = `${kit.name} (imported)`;
  return saveDrumKit(kit);
}
