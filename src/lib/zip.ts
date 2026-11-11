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
 *
 * ZIP64 is written only when a field would actually overflow: a batch that
 * crosses 4 GiB (or 65,535 members) used to be refused outright, and there is
 * no reason to keep that ceiling once the records are emitted correctly.
 */
import { crc32 } from '../core/crc32.ts';

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

export interface ZipOptions {
  /**
   * Value at which a 32-bit field is treated as full. Real archives use
   * `0xFFFFFFFF`; tests lower it so a handful of bytes exercises ZIP64.
   */
  zip64Threshold?: number;
}

export type ZipErrorCode = 'bad-name';

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
const SIG_ZIP64_END = 0x06064b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;
/** Bit 11: the name is UTF-8. Without it tools guess a legacy code page. */
const FLAG_UTF8 = 0x0800;
const VERSION = 20;
const VERSION_ZIP64 = 45;
const METHOD_STORE = 0;
const LOCAL_HEADER = 30;
const CENTRAL_HEADER = 46;
const END_RECORD = 22;
/** Zip64 replaces both 32-bit sizes/offsets and the 16-bit member count. */
const MAX_U32 = 0xffffffff;
const MAX_U16 = 0xffff;
const READ_CHUNK = 4 * 1024 * 1024;

function encodeName(name: string): Uint8Array {
  if (name.length === 0) throw new ZipError('bad-name', 'empty');
  if (name.includes('\0')) throw new ZipError('bad-name', name);
  if (name.startsWith('/') || name.startsWith('\\')) throw new ZipError('bad-name', name);
  if (name.split(/[\\/]/).includes('..')) throw new ZipError('bad-name', name);
  const bytes = new TextEncoder().encode(name);
  if (bytes.length > 0xffff) throw new ZipError('bad-name', name);
  return bytes;
}

/**
 * Validate every name before the first byte is read. A member that would
 * escape the archive is a caller bug, and failing after checksumming 3 GiB of
 * photos would only make it harder to find.
 */
export function checkZipEntries(entries: readonly ZipEntry[]): void {
  for (const entry of entries) encodeName(entry.name);
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

/**
 * The `0x0001` extra field: 64-bit values in the order the specification
 * defines (uncompressed size, compressed size, local header offset, disk).
 * Only the values whose 32-bit field was filled with `0xFFFFFFFF` are present.
 */
function zip64Extra(values: readonly number[]): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(4 + values.length * 8);
  const view = new DataView(bytes.buffer);
  view.setUint16(0, 0x0001, true);
  view.setUint16(2, values.length * 8, true);
  for (const [index, value] of values.entries()) {
    const offset = 4 + index * 8;
    view.setUint32(offset, value >>> 0, true);
    view.setUint32(offset + 4, Math.floor(value / 0x1_0000_0000), true);
  }
  return bytes;
}

/** CRC-32 of a Blob, read in chunks so peak memory stays at one chunk. */
async function crc32Of(blob: Blob, onBytes: (count: number) => void): Promise<number> {
  let crc = 0;
  for (let offset = 0; offset < blob.size; offset += READ_CHUNK) {
    const end = Math.min(offset + READ_CHUNK, blob.size);
    const chunk = new Uint8Array(await blob.slice(offset, end).arrayBuffer());
    crc = crc32(chunk, crc);
    onBytes(chunk.length);
  }
  return crc;
}

/**
 * Lay the archive out as Blob parts, in order. Exposed separately so tests can
 * prove the image bytes are referenced rather than copied.
 */
export async function zipParts(
  entries: readonly ZipEntry[],
  onProgress?: (progress: ZipProgress) => void,
  options: ZipOptions = {},
): Promise<BlobPart[]> {
  checkZipEntries(entries);
  const threshold = options.zip64Threshold ?? MAX_U32;
  const totalBytes = entries.reduce((sum, entry) => sum + entry.blob.size, 0);
  const parts: BlobPart[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  let done = 0;
  let bytes = 0;
  let lastReport = 0;
  let zip64 = false;

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
    const size = entry.blob.size;
    const bigSize = size >= threshold;
    const bigOffset = offset >= threshold;
    if (bigSize || bigOffset) zip64 = true;
    const version = bigSize || bigOffset ? VERSION_ZIP64 : VERSION;

    const localExtra = bigSize ? zip64Extra([size, size]) : null;
    const local = zipHeader(LOCAL_HEADER + name.length + (localExtra?.length ?? 0));
    local.view.setUint32(0, SIG_LOCAL, true);
    local.view.setUint16(4, version, true);
    local.view.setUint16(6, FLAG_UTF8, true);
    local.view.setUint16(8, METHOD_STORE, true);
    local.view.setUint16(10, stamp.time, true);
    local.view.setUint16(12, stamp.day, true);
    local.view.setUint32(14, crc, true);
    local.view.setUint32(18, bigSize ? MAX_U32 : size, true);
    local.view.setUint32(22, bigSize ? MAX_U32 : size, true);
    local.view.setUint16(26, name.length, true);
    local.view.setUint16(28, localExtra?.length ?? 0, true);
    local.bytes.set(name, LOCAL_HEADER);
    if (localExtra) local.bytes.set(localExtra, LOCAL_HEADER + name.length);

    parts.push(local.bytes);
    if (size > 0) parts.push(entry.blob);

    const extraValues: number[] = [];
    if (bigSize) extraValues.push(size, size);
    if (bigOffset) extraValues.push(offset);
    const centralExtra = extraValues.length > 0 ? zip64Extra(extraValues) : null;

    const record = zipHeader(CENTRAL_HEADER + name.length + (centralExtra?.length ?? 0));
    record.view.setUint32(0, SIG_CENTRAL, true);
    record.view.setUint16(4, version, true);
    record.view.setUint16(6, version, true);
    record.view.setUint16(8, FLAG_UTF8, true);
    record.view.setUint16(10, METHOD_STORE, true);
    record.view.setUint16(12, stamp.time, true);
    record.view.setUint16(14, stamp.day, true);
    record.view.setUint32(16, crc, true);
    record.view.setUint32(20, bigSize ? MAX_U32 : size, true);
    record.view.setUint32(24, bigSize ? MAX_U32 : size, true);
    record.view.setUint16(28, name.length, true);
    record.view.setUint16(30, centralExtra?.length ?? 0, true);
    record.view.setUint16(32, 0, true);
    record.view.setUint16(34, 0, true);
    record.view.setUint16(36, 0, true);
    record.view.setUint32(38, 0, true);
    record.view.setUint32(42, bigOffset ? MAX_U32 : offset, true);
    record.bytes.set(name, CENTRAL_HEADER);
    if (centralExtra) record.bytes.set(centralExtra, CENTRAL_HEADER + name.length);
    central.push(record.bytes);

    offset += local.bytes.length + size;
    done += 1;
    report(true);
  }

  const directory = new Uint8Array(central.reduce((sum, item) => sum + item.length, 0));
  let cursor = 0;
  for (const item of central) {
    directory.set(item, cursor);
    cursor += item.length;
  }

  // The member count itself lives in a 16-bit field, so a long batch needs the
  // ZIP64 end record even when every size and offset would have fit.
  if (entries.length >= MAX_U16) zip64 = true;

  if (zip64) {
    const end64 = zipHeader(56);
    end64.view.setUint32(0, SIG_ZIP64_END, true);
    end64.view.setBigUint64(4, 44n, true);
    end64.view.setUint16(12, VERSION_ZIP64, true);
    end64.view.setUint16(14, VERSION_ZIP64, true);
    end64.view.setUint32(16, 0, true);
    end64.view.setUint32(20, 0, true);
    end64.view.setBigUint64(24, BigInt(entries.length), true);
    end64.view.setBigUint64(32, BigInt(entries.length), true);
    end64.view.setBigUint64(40, BigInt(directory.length), true);
    end64.view.setBigUint64(48, BigInt(offset), true);

    const locator = zipHeader(20);
    locator.view.setUint32(0, SIG_ZIP64_LOCATOR, true);
    locator.view.setUint32(4, 0, true);
    // The ZIP64 end record sits immediately after the central directory.
    locator.view.setBigUint64(8, BigInt(offset + directory.length), true);
    locator.view.setUint32(16, 1, true);

    parts.push(directory, end64.bytes, locator.bytes);
  } else {
    parts.push(directory);
  }

  const end = zipHeader(END_RECORD);
  end.view.setUint32(0, SIG_END, true);
  end.view.setUint16(4, 0, true);
  end.view.setUint16(6, 0, true);
  end.view.setUint16(8, zip64 ? MAX_U16 : entries.length, true);
  end.view.setUint16(10, zip64 ? MAX_U16 : entries.length, true);
  end.view.setUint32(12, zip64 ? MAX_U32 : directory.length, true);
  end.view.setUint32(16, zip64 ? MAX_U32 : offset, true);
  end.view.setUint16(20, 0, true);

  parts.push(end.bytes);
  return parts;
}

export async function buildZip(
  entries: readonly ZipEntry[],
  onProgress?: (progress: ZipProgress) => void,
  options: ZipOptions = {},
): Promise<Blob> {
  return new Blob(await zipParts(entries, onProgress, options), { type: 'application/zip' });
}
