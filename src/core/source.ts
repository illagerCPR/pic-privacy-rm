/**
 * A random-access view over image bytes.
 *
 * The source keeps the original File/Blob, so a strip pass can rebuild the
 * output from zero-copy slices instead of holding the whole file in memory.
 */
export interface Source {
  blob: Blob;
  size: number;
}

export function sourceFromBlob(blob: Blob): Source {
  return { blob, size: blob.size };
}

export function sourceFromBytes(bytes: Uint8Array): Source {
  const copy = bytes.slice();
  return { blob: new Blob([copy]), size: copy.byteLength };
}

export async function readAt(src: Source, offset: number, length: number): Promise<Uint8Array> {
  const start = Math.max(0, Math.min(offset, src.size));
  const end = Math.min(src.size, start + Math.max(0, length));
  if (end <= start) return new Uint8Array(0);
  const buf = await src.blob.slice(start, end).arrayBuffer();
  return new Uint8Array(buf);
}

/** Read at most `max` bytes from `offset` (for bounded metadata payloads). */
export async function readCapped(
  src: Source,
  offset: number,
  length: number,
  max: number,
): Promise<Uint8Array> {
  return readAt(src, offset, Math.min(length, max));
}
