/**
 * Storage abstraction: native Tauri dialog + fs plugins when running inside the Tauri shell
 * (Windows / Android), browser file input + Blob download everywhere else.
 */

export interface FileFilter {
  name: string;
  extensions: string[];
}

export interface OpenedTextFile {
  name: string;
  content: string;
}

export interface OpenedFile {
  name: string;
  bytes: Uint8Array;
}

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

export function isTauri(): boolean {
  return typeof window !== 'undefined' && window.__TAURI_INTERNALS__ !== undefined;
}

function baseName(path: string): string {
  const parts = path.split(/[\\/]/);
  return decodeURIComponent(parts[parts.length - 1] || path);
}

function browserDownload(fileName: string, data: BlobPart, mime: string): void {
  const blob = new Blob([data], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function browserPickFile(filter: FileFilter): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = filter.extensions.map((e) => `.${e}`).join(',');
    input.style.display = 'none';
    input.addEventListener('change', () => {
      resolve(input.files?.[0] ?? null);
      input.remove();
    });
    input.addEventListener('cancel', () => {
      resolve(null);
      input.remove();
    });
    document.body.appendChild(input);
    input.click();
  });
}

function isAndroid(): boolean {
  return typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent);
}

/** Prompts for any file and returns its raw bytes (e.g. Guitar Pro files), or null if cancelled. */
export async function openFile(filter: FileFilter): Promise<OpenedFile | null> {
  if (isTauri()) {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const { readFile } = await import('@tauri-apps/plugin-fs');
    // Android's picker filters by MIME type and has none for .gp/.gpx, which would make them unselectable,
    // so show every file there and let the caller check the extension.
    const selected = await open({ multiple: false, directory: false, filters: isAndroid() ? [] : [filter] });
    if (typeof selected !== 'string') return null;
    return { name: baseName(selected), bytes: await readFile(selected) };
  }
  const file = await browserPickFile(filter);
  if (!file) return null;
  return { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) };
}

function browserPickText(filter: FileFilter): Promise<OpenedTextFile | null> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = filter.extensions.map((e) => `.${e}`).join(',');
    input.style.display = 'none';
    const cleanup = () => input.remove();
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      cleanup();
      if (!file) {
        resolve(null);
        return;
      }
      file
        .text()
        .then((content) => resolve({ name: file.name, content }))
        .catch((err: unknown) => reject(err instanceof Error ? err : new Error(String(err))));
    });
    input.addEventListener('cancel', () => {
      cleanup();
      resolve(null);
    });
    document.body.appendChild(input);
    input.click();
  });
}

/** Saves text. Returns the saved file name/path, or null if the user cancelled. */
export async function saveTextFile(defaultName: string, content: string, filter: FileFilter, mime = 'application/json'): Promise<string | null> {
  if (isTauri()) {
    const { save } = await import('@tauri-apps/plugin-dialog');
    const { writeTextFile } = await import('@tauri-apps/plugin-fs');
    const path = await save({ defaultPath: defaultName, filters: [filter] });
    if (!path) return null;
    await writeTextFile(path, content);
    return baseName(path);
  }
  browserDownload(defaultName, content, mime);
  return defaultName;
}

/** Saves binary data. Returns the saved file name/path, or null if the user cancelled. */
export async function saveBinaryFile(defaultName: string, data: Uint8Array, filter: FileFilter, mime: string): Promise<string | null> {
  if (isTauri()) {
    const { save } = await import('@tauri-apps/plugin-dialog');
    const { writeFile } = await import('@tauri-apps/plugin-fs');
    const path = await save({ defaultPath: defaultName, filters: [filter] });
    if (!path) return null;
    await writeFile(path, data);
    return baseName(path);
  }
  const copy = new Uint8Array(data.byteLength);
  copy.set(data);
  browserDownload(defaultName, copy.buffer, mime);
  return defaultName;
}

/** Prompts for a text file and returns its name and content, or null if cancelled. */
export async function openTextFile(filter: FileFilter): Promise<OpenedTextFile | null> {
  if (isTauri()) {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const { readTextFile } = await import('@tauri-apps/plugin-fs');
    const selected = await open({ multiple: false, directory: false, filters: [filter] });
    if (typeof selected !== 'string') return null;
    const content = await readTextFile(selected);
    return { name: baseName(selected), content };
  }
  return browserPickText(filter);
}

export function safeFileName(title: string, fallback = 'song'): string {
  const cleaned = title.trim().replace(/[^a-zA-Z0-9-_ ]+/g, '').replace(/\s+/g, '-');
  return cleaned || fallback;
}
