/**
 * Store-only ZIP writer that never copies the images.
 *
 * A batch can be gigabytes wide, so the archive is laid out as Blob parts: a
 * short local header per member, the member's own Blob (referenced, not read
 * into a buffer), and one central directory at the end. Building the Blob then
 * costs a few kilobytes regardless of the batch size — whereas handing every
 * byte to a compressor means holding one full copy of the archive in memory on
 * top of the images we already keep.
 *
 * Storage is deliberately `method = 0` (store): every format we accept is
 * already compressed, so deflating again buys nothing and would mean reading
 * each image a second time. The one pass we do make over the bytes is the
 * CRC-32 the format requires.
 */

export interface ZipEntry {
  /** Member path inside the archive. */
  name: string;
  blob: Blob;
  /** Timestamp recorded in the entry; defaults to now. */
  modified?: Date;
}

export interface ZipProgress {
  /** Members written so far. */
  done: number;
  total: number;
  /** Bytes read for CRC-32 so far, and in total. */
  bytes: number;
  totalBytes: number;
}

export type ZipErrorCode =
  | 'too-many-entries'
  | 'entry-too-large'
  | 'archive-too-large'
  | 'bad-name';

export class ZipError extends Error {
  readonly code: ZipErrorCode;

  constructor(code: ZipErrorCode, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'ZipError';
    this.code = code;
  }
}

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_END = 0x06054b50;
/** Bit 11: the name is UTF-8. Without it tools guess a legacy code page. */
const FLAG_UTF8 = 0x0800;
const VERSION = 20;
const METHOD_STORE = 0;
const LOCAL_HEADER = 30;
const CENTRAL_HEADER = 46;
const END_RECORD = 22;
const MAX_ENTRIES = 0xffff;
/** Classic archives hold offsets and sizes in 32 bits; Zip64 is not written. */
const MAX_U32 = 0xffffffff;
const READ_CHUNK = 4 * 1024 * 1024;

/**
 * Slicing-by-8 tables: eight bytes per round, roughly 2.5x the byte-at-a-time
 * loop. A 2 GB batch is otherwise seconds of pure arithmetic.
 */
const CRC_TABLES = (() => {
  const base = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    base[index] = value >>> 0;
  }
  const tables = [base];
  for (let slice = 1; slice < 8; slice += 1) {
    const previous = tables[slice - 1]!;
    const next = new Uint32Array(256);
    for (let index = 0; index < 256; index += 1) {
      const value = previous[index]!;
      next[index] = ((value >>> 8) ^ base[value & 0xff]!) >>> 0;
    }
    tables.push(next);
  }
  return tables;
})();

function encodeName(name: string): Uint8Array {
  if (name.length === 0) throw new ZipError('bad-name', 'empty');
  if (name.includes('\0')) throw new ZipError('bad-name', name);
  if (name.startsWith('/') || name.startsWith('\\')) throw new ZipError('bad-name', name);
  if (name.split(/[\\/]/).includes('..')) throw new ZipError('bad-name', name);
  const bytes = new TextEncoder().encode(name);
  if (bytes.length > 0xffff) throw new ZipError('bad-name', name);
  return bytes;
}

function dosStamp(date: Date): { time: number; day: number } {
  const year = Math.min(Math.max(date.getFullYear(), 1980), 2107);
  const month = year === 1980 && date.getFullYear() < 1980 ? 1 : date.getMonth() + 1;
  const day = year === 1980 && date.getFullYear() < 1980 ? 1 : date.getDate();
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    day: ((year - 1980) << 9) | (month << 5) | day,
  };
}

function zipHeader(size: number): { bytes: Uint8Array<ArrayBuffer>; view: DataView } {
  const bytes = new Uint8Array(size);
  return { bytes, view: new DataView(bytes.buffer) };
}

/** CRC-32 of a Blob, read in chunks so peak memory stays at one chunk. */
async function crc32Of(blob: Blob, onBytes: (count: number) => void): Promise<number> {
  const [t0, t1, t2, t3, t4, t5, t6, t7] = CRC_TABLES as [
    Uint32Array,
    Uint32Array,
    Uint32Array,
    Uint32Array,
    Uint32Array,
    Uint32Array,
    Uint32Array,
    Uint32Array,
  ];
  let crc = 0xffffffff;
  for (let offset = 0; offset < blob.size; offset += READ_CHUNK) {
    const end = Math.min(offset + READ_CHUNK, blob.size);
    const chunk = new Uint8Array(await blob.slice(offset, end).arrayBuffer());
    const whole = chunk.length - (chunk.length % 8);
    let index = 0;
    for (; index < whole; index += 8) {
      crc ^= chunk[index]! | (chunk[index + 1]! << 8) | (chunk[index + 2]! << 16) | (chunk[index + 3]! << 24);
      crc =
        (t7[crc & 0xff]! ^
          t6[(crc >>> 8) & 0xff]! ^
          t5[(crc >>> 16) & 0xff]! ^
          t4[crc >>> 24]! ^
          t3[chunk[index + 4]!]! ^
          t2[chunk[index + 5]!]! ^
          t1[chunk[index + 6]!]! ^
          t0[chunk[index + 7]!]!) >>>
        0;
    }
    for (; index < chunk.length; index += 1) {
      crc = ((crc >>> 8) ^ t0[(crc ^ chunk[index]!) & 0xff]!) >>> 0;
    }
    onBytes(chunk.length);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Validate what a classic (non-Zip64) archive can express before doing any work.
 * Returns the payload size in bytes.
 */
export function checkZipLimits(entries: readonly ZipEntry[]): number {
  if (entries.length > MAX_ENTRIES) {
    throw new ZipError('too-many-entries', String(entries.length));
  }
  let total = 0;
  for (const entry of entries) {
    if (entry.blob.size > MAX_U32) throw new ZipError('entry-too-large', entry.name);
    total += entry.blob.size;
  }
  // Headers and the central directory share the same 32-bit offset space.
  const overhead = entries.length * (LOCAL_HEADER + CENTRAL_HEADER + 128) + END_RECORD;
  if (total + overhead > MAX_U32) throw new ZipError('archive-too-large', String(total));
  return total;
}

/**
 * Lay the archive out as Blob parts, in order. Exposed separately so tests can
 * prove the image bytes are referenced rather than copied.
 */
export async function zipParts(
  entries: readonly ZipEntry[],
  onProgress?: (progress: ZipProgress) => void,
): Promise<BlobPart[]> {
  const totalBytes = checkZipLimits(entries);
  const parts: BlobPart[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  let done = 0;
  let bytes = 0;
  let lastReport = 0;

  const report = (force: boolean): void => {
    if (!onProgress) return;
    const now = Date.now();
    if (!force && now - lastReport < 120) return;
    lastReport = now;
    onProgress({ done, total: entries.length, bytes, totalBytes });
  };

  report(true);

  for (const entry of entries) {
    const name = encodeName(entry.name);
    const crc = await crc32Of(entry.blob, (count) => {
      bytes += count;
      report(false);
    });
    const stamp = dosStamp(entry.modified ?? new Date());

    const local = zipHeader(LOCAL_HEADER + name.length);
    local.view.setUint32(0, SIG_LOCAL, true);
    local.view.setUint16(4, VERSION, true);
    local.view.setUint16(6, FLAG_UTF8, true);
    local.view.setUint16(8, METHOD_STORE, true);
    local.view.setUint16(10, stamp.time, true);
    local.view.setUint16(12, stamp.day, true);
    local.view.setUint32(14, crc, true);
    local.view.setUint32(18, entry.blob.size, true);
    local.view.setUint32(22, entry.blob.size, true);
    local.view.setUint16(26, name.length, true);
    local.view.setUint16(28, 0, true);
    local.bytes.set(name, LOCAL_HEADER);

    parts.push(local.bytes);
    if (entry.blob.size > 0) parts.push(entry.blob);

    const record = zipHeader(CENTRAL_HEADER + name.length);
    record.view.setUint32(0, SIG_CENTRAL, true);
    record.view.setUint16(4, VERSION, true);
    record.view.setUint16(6, VERSION, true);
    record.view.setUint16(8, FLAG_UTF8, true);
    record.view.setUint16(10, METHOD_STORE, true);
    record.view.setUint16(12, stamp.time, true);
    record.view.setUint16(14, stamp.day, true);
    record.view.setUint32(16, crc, true);
    record.view.setUint32(20, entry.blob.size, true);
    record.view.setUint32(24, entry.blob.size, true);
    record.view.setUint16(28, name.length, true);
    record.view.setUint16(30, 0, true);
    record.view.setUint16(32, 0, true);
    record.view.setUint16(34, 0, true);
    record.view.setUint16(36, 0, true);
    record.view.setUint32(38, 0, true);
    record.view.setUint32(42, offset, true);
    record.bytes.set(name, CENTRAL_HEADER);
    central.push(record.bytes);

    offset += local.bytes.length + entry.blob.size;
    done += 1;
    report(true);
  }

  const directory = new Uint8Array(central.reduce((sum, item) => sum + item.length, 0));
  let cursor = 0;
  for (const item of central) {
    directory.set(item, cursor);
    cursor += item.length;
  }

  const end = zipHeader(END_RECORD);
  end.view.setUint32(0, SIG_END, true);
  end.view.setUint16(4, 0, true);
  end.view.setUint16(6, 0, true);
  end.view.setUint16(8, entries.length, true);
  end.view.setUint16(10, entries.length, true);
  end.view.setUint32(12, directory.length, true);
  end.view.setUint32(16, offset, true);
  end.view.setUint16(20, 0, true);

  parts.push(directory, end.bytes);
  return parts;
}

export async function buildZip(
  entries: readonly ZipEntry[],
  onProgress?: (progress: ZipProgress) => void,
): Promise<Blob> {
  return new Blob(await zipParts(entries, onProgress), { type: 'application/zip' });
}
