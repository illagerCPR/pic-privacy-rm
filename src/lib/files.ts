const SUPPORTED_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif']);
// Recognised as images so we can tell the user they are unsupported, rather than silently skipping them.
const KNOWN_IMAGE_EXTENSIONS = new Set([
  ...SUPPORTED_EXTENSIONS,
  'heic',
  'heif',
  'avif',
  'tif',
  'tiff',
  'bmp',
  'jxl',
  'svg',
  'ico',
]);
const SPREADSHEET_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

/**
 * A file plus the folder it was dropped in. Photographers hand over a shoot as
 * a tree, and the archive should hand it back the same way instead of dropping
 * every photo into one flat pile.
 */
export interface IncomingFile {
  file: File;
  /** Directory inside the drop, empty for files that were not in a folder. */
  dir: string;
}

const MAX_DROP_DEPTH = 4;
const MAX_SEGMENT = 120;
/** Characters Windows refuses in a path; the archive is meant to be opened anywhere. */
const UNSAFE_SEGMENT = /[\u0000-\u001f<>:"|?*]/g;

/** Directory part of a path, normalised to `/`. */
export function directoryOf(path: string): string {
  const normalised = path.replace(/\\/g, '/');
  const slash = normalised.lastIndexOf('/');
  return slash === -1 ? '' : normalised.slice(0, slash);
}

/**
 * Build the member path that keeps the drop's folder structure. Segments that
 * could escape the archive (`..`, absolute paths, control characters) are
 * dropped or replaced rather than handed to the ZIP writer, which would refuse
 * the whole archive over one odd file name.
 */
export function safeArchivePath(dir: string, filename: string): string {
  const segments: string[] = [];
  for (const segment of `${dir}/${filename}`.replace(/\\/g, '/').split('/')) {
    const clean = segment.replace(UNSAFE_SEGMENT, '_').trim();
    if (clean === '' || clean === '.' || clean === '..') continue;
    segments.push(clean.slice(0, MAX_SEGMENT));
  }
  if (segments.length === 0) return 'image';
  // Keep the file name even when the tree is deeper than the limit.
  return segments.slice(-(MAX_DROP_DEPTH + 1)).join('/');
}

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot + 1).toLowerCase();
}

export function baseNameOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? name : name.slice(0, dot);
}

export function looksLikeImage(file: File): boolean {
  if (SPREADSHEET_MIMES.has(file.type)) return true;
  if (file.type.startsWith('image/')) return true;
  return KNOWN_IMAGE_EXTENSIONS.has(extensionOf(file.name));
}

export function outputName(original: string, ext: string): string {
  const base = baseNameOf(original).replace(/[\\/:*?"<>|]+/g, '_') || 'image';
  return `${base}-clean.${ext}`;
}

export function uniqueName(name: string, taken: Set<string>): string {
  if (!taken.has(name)) {
    taken.add(name);
    return name;
  }
  // Only the file name may change: a dotted folder (`2024.05/`) must not be
  // mistaken for an extension.
  const slash = name.lastIndexOf('/');
  const dir = slash === -1 ? '' : name.slice(0, slash + 1);
  const file = name.slice(dir.length);
  const dot = file.lastIndexOf('.');
  const base = dot === -1 ? file : file.slice(0, dot);
  const ext = dot === -1 ? '' : file.slice(dot);
  let index = 2;
  while (taken.has(`${dir}${base} (${index})${ext}`)) index += 1;
  const next = `${dir}${base} (${index})${ext}`;
  taken.add(next);
  return next;
}

function readDirectory(entry: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> {
  return new Promise((resolve) => {
    const reader = entry.createReader();
    const all: FileSystemEntry[] = [];
    const readBatch = () => {
      reader.readEntries(
        (batch) => {
          if (batch.length === 0) {
            resolve(all);
            return;
          }
          all.push(...batch);
          readBatch();
        },
        () => resolve(all),
      );
    };
    readBatch();
  });
}

function entryToFile(entry: FileSystemFileEntry): Promise<File | null> {
  return new Promise((resolve) => {
    entry.file(
      (file) => resolve(file),
      () => resolve(null),
    );
  });
}

async function collectEntries(
  entries: FileSystemEntry[],
  parent: string,
  depth = 0,
): Promise<IncomingFile[]> {
  const files: IncomingFile[] = [];
  for (const entry of entries) {
    if (depth > MAX_DROP_DEPTH) continue;
    if (entry.isFile) {
      const file = await entryToFile(entry as FileSystemFileEntry);
      if (file) files.push({ file, dir: parent });
    } else if (entry.isDirectory) {
      const children = await readDirectory(entry as FileSystemDirectoryEntry);
      const dir = parent === '' ? entry.name : `${parent}/${entry.name}`;
      files.push(...(await collectEntries(children, dir, depth + 1)));
    }
  }
  return files;
}

/** Collect files from a drop event, including dropped directories. */
export async function filesFromDataTransfer(dataTransfer: DataTransfer): Promise<IncomingFile[]> {
  const items = Array.from(dataTransfer.items ?? []);
  const entries: FileSystemEntry[] = [];
  for (const item of items) {
    if (item.kind !== 'file') continue;
    const entry = item.webkitGetAsEntry?.();
    if (entry) entries.push(entry);
  }
  if (entries.length > 0) {
    const nested = await collectEntries(entries, '');
    if (nested.length > 0) return nested;
  }
  return Array.from(dataTransfer.files ?? []).map((file) => ({
    file,
    dir: directoryOf(file.webkitRelativePath ?? ''),
  }));
}

/** Sort a drop by the path the user sees, not just the file name. */
export function sortIncoming(files: IncomingFile[]): IncomingFile[] {
  return [...files].sort((a, b) =>
    `${a.dir}/${a.file.name}`.localeCompare(`${b.dir}/${b.file.name}`, undefined, {
      numeric: true,
      sensitivity: 'base',
    }),
  );
}
