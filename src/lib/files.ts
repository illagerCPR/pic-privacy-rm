const SUPPORTED_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif']);
// Recognised as images so we can tell the user they are unsupported, rather than silently skipping them.
const KNOWN_IMAGE_EXTENSIONS = new Set([
  ...SUPPORTED_EXTENSIONS,
  'heic', 'heif', 'avif', 'tif', 'tiff', 'bmp', 'jxl', 'svg', 'ico',
]);
const SPREADSHEET_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

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
  const dot = name.lastIndexOf('.');
  const base = dot === -1 ? name : name.slice(0, dot);
  const ext = dot === -1 ? '' : name.slice(dot);
  let index = 2;
  while (taken.has(`${base} (${index})${ext}`)) index += 1;
  const next = `${base} (${index})${ext}`;
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

async function collectEntries(entries: FileSystemEntry[], depth = 0): Promise<File[]> {
  const files: File[] = [];
  for (const entry of entries) {
    if (entry.isFile && depth <= 4) {
      const file = await entryToFile(entry as FileSystemFileEntry);
      if (file) files.push(file);
    } else if (entry.isDirectory && depth <= 4) {
      const children = await readDirectory(entry as FileSystemDirectoryEntry);
      files.push(...(await collectEntries(children, depth + 1)));
    }
  }
  return files;
}

/** Collect files from a drop event, including dropped directories. */
export async function filesFromDataTransfer(dataTransfer: DataTransfer): Promise<File[]> {
  const items = Array.from(dataTransfer.items ?? []);
  const entries: FileSystemEntry[] = [];
  for (const item of items) {
    if (item.kind !== 'file') continue;
    const entry = item.webkitGetAsEntry?.();
    if (entry) entries.push(entry);
  }
  if (entries.length > 0) {
    const nested = await collectEntries(entries);
    if (nested.length > 0) return nested;
  }
  return Array.from(dataTransfer.files ?? []);
}

export function sortFilesByName(files: File[]): File[] {
  return [...files].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }),
  );
}
