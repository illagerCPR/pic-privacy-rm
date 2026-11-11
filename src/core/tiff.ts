/**
 * Minimal TIFF/EXIF reader.
 *
 * Parses the tag structure only — values are decoded for display. Nothing here
 * is required for the strip pass; it exists so the UI can tell users exactly
 * which metadata is about to disappear.
 */
import { decodeText, decodeUtf16le, trimNul, u16be, u16le, u32be, u32le } from './bytes.ts';

export type TiffKind = 'ifd0' | 'exif' | 'gps' | 'interop' | 'ifd1';

export interface TiffValue {
  type: number;
  count: number;
  /** Numeric values; rationals are flattened into numerator/denominator pairs. */
  nums: number[];
  text?: string;
  bytes?: Uint8Array;
}

export interface TiffTag {
  tag: number;
  type: number;
  count: number;
  value: TiffValue;
}

export interface TiffIfd {
  kind: TiffKind;
  offset: number;
  tags: TiffTag[];
  next: number;
}

export interface TiffThumbnail {
  bytes: Uint8Array;
  mime: string;
}

export interface TiffResult {
  order: 'II' | 'MM';
  ifds: TiffIfd[];
  thumbnail?: TiffThumbnail;
}

export const TIFF_TYPE_SIZE: Record<number, number> = {
  1: 1, // BYTE
  2: 1, // ASCII
  3: 2, // SHORT
  4: 4, // LONG
  5: 8, // RATIONAL
  6: 1, // SBYTE
  7: 1, // UNDEFINED
  8: 2, // SSHORT
  9: 4, // SLONG
  10: 8, // SRATIONAL
  11: 4, // FLOAT
  12: 8, // DOUBLE
  13: 4, // IFD
};

const MAX_IFDS = 12;
const MAX_ENTRIES = 1024;

function readU16(b: Uint8Array, o: number, little: boolean): number {
  return little ? u16le(b, o) : u16be(b, o);
}

function readU32(b: Uint8Array, o: number, little: boolean): number {
  return little ? u32le(b, o) : u32be(b, o);
}

function readS32(b: Uint8Array, o: number, little: boolean): number {
  const v = readU32(b, o, little);
  return v > 0x7fffffff ? v - 0x100000000 : v;
}

export function decodeTiffValue(
  type: number,
  count: number,
  view: Uint8Array,
  little: boolean,
): TiffValue {
  const value: TiffValue = { type, count, nums: [] };
  switch (type) {
    case 2: {
      value.text = trimNul(decodeText(view));
      return value;
    }
    case 5:
    case 10: {
      const pairs = Math.min(count, Math.floor(view.length / 8));
      for (let i = 0; i < pairs; i += 1) {
        const o = i * 8;
        const num = type === 10 ? readS32(view, o, little) : readU32(view, o, little);
        const den = type === 10 ? readS32(view, o + 4, little) : readU32(view, o + 4, little);
        value.nums.push(num, den);
      }
      return value;
    }
    case 3:
    case 8: {
      const n = Math.min(count, Math.floor(view.length / 2));
      for (let i = 0; i < n; i += 1) {
        const raw = readU16(view, i * 2, little);
        value.nums.push(type === 8 && raw > 0x7fff ? raw - 0x10000 : raw);
      }
      return value;
    }
    case 4:
    case 9:
    case 13: {
      const n = Math.min(count, Math.floor(view.length / 4));
      for (let i = 0; i < n; i += 1) {
        value.nums.push(type === 9 ? readS32(view, i * 4, little) : readU32(view, i * 4, little));
      }
      return value;
    }
    case 11: {
      const n = Math.min(count, Math.floor(view.length / 4));
      for (let i = 0; i < n; i += 1) {
        const raw = readU32(view, i * 4, little);
        const buf = new DataView(new ArrayBuffer(4));
        buf.setUint32(0, raw, false);
        value.nums.push(Number(buf.getFloat32(0, false).toPrecision(7)));
      }
      return value;
    }
    case 12: {
      const n = Math.min(count, Math.floor(view.length / 8));
      for (let i = 0; i < n; i += 1) {
        const hi = readU32(view, i * 8, little);
        const lo = readU32(view, i * 8 + 4, little);
        const buf = new DataView(new ArrayBuffer(8));
        buf.setUint32(0, hi, false);
        buf.setUint32(4, lo, false);
        value.nums.push(Number(buf.getFloat64(0, false).toPrecision(10)));
      }
      return value;
    }
    default: {
      value.bytes = view;
      return value;
    }
  }
  // Keep TypeScript satisfied about the unused `data` parameter contract.
}

/** Parse an EXIF/TIFF block. Returns null for data that is not TIFF at all. */
export function parseTiff(data: Uint8Array): TiffResult | null {
  if (data.length < 8) return null;
  const orderByte = decodeText(data.subarray(0, 2));
  if (orderByte !== 'II' && orderByte !== 'MM') return null;
  const little = orderByte === 'II';
  const magic = readU16(data, 2, little);
  if (magic !== 42) return null;

  const ifds: TiffIfd[] = [];
  const visited = new Set<number>();
  let thumbnail: TiffThumbnail | undefined;

  const parseIfd = (offset: number, kind: TiffKind): number => {
    if (offset < 8 || offset + 2 > data.length || visited.has(offset) || ifds.length >= MAX_IFDS) {
      return 0;
    }
    visited.add(offset);
    const rawCount = readU16(data, offset, little);
    const count = Math.min(rawCount, MAX_ENTRIES);
    const tags: TiffTag[] = [];
    for (let i = 0; i < count; i += 1) {
      const entry = offset + 2 + i * 12;
      if (entry + 12 > data.length) break;
      const tag = readU16(data, entry, little);
      const type = readU16(data, entry + 2, little);
      const items = readU32(data, entry + 4, little);
      const size = (TIFF_TYPE_SIZE[type] ?? 0) * items;
      let view: Uint8Array;
      if (size <= 4) {
        view = data.subarray(entry + 8, entry + 8 + Math.max(0, size));
      } else {
        const valueOffset = readU32(data, entry + 8, little);
        if (valueOffset >= data.length) continue;
        view = data.subarray(valueOffset, Math.min(data.length, valueOffset + size));
      }
      if (view.length === 0) continue;
      tags.push({ tag, type, count: items, value: decodeTiffValue(type, items, view, little) });
    }
    const nextOffset =
      offset + 2 + count * 12 + 4 <= data.length
        ? readU32(data, offset + 2 + count * 12, little)
        : 0;
    ifds.push({ kind, offset, tags, next: nextOffset });
    return nextOffset;
  };

  const next = parseIfd(readU32(data, 4, little), 'ifd0');

  const findTag = (ifd: TiffIfd, tag: number) => ifd.tags.find((t) => t.tag === tag);
  const ifd0 = ifds.find((i) => i.kind === 'ifd0');
  if (ifd0) {
    const exifPtr = findTag(ifd0, 0x8769);
    const exifOffset = exifPtr?.value.nums[0];
    if (exifOffset) parseIfd(exifOffset, 'exif');
    const gpsPtr = findTag(ifd0, 0x8825);
    const gpsOffset = gpsPtr?.value.nums[0];
    if (gpsOffset) parseIfd(gpsOffset, 'gps');
    const interopPtr = findTag(ifd0, 0xa005);
    const interopOffset = interopPtr?.value.nums[0];
    if (interopOffset) parseIfd(interopOffset, 'interop');
  }
  const exifIfd = ifds.find((i) => i.kind === 'exif');
  if (exifIfd) {
    const interopPtr = findTag(exifIfd, 0xa005);
    const interopOffset = interopPtr?.value.nums[0];
    if (interopOffset) parseIfd(interopOffset, 'interop');
  }

  if (next) {
    parseIfd(next, 'ifd1');
    const ifd1 = ifds.find((i) => i.kind === 'ifd1');
    if (ifd1) {
      const off = findTag(ifd1, 0x0201)?.value.nums[0] ?? 0;
      const len = findTag(ifd1, 0x0202)?.value.nums[0] ?? 0;
      if (off > 0 && len > 0 && off + len <= data.length) {
        thumbnail = { bytes: data.subarray(off, off + len), mime: 'image/jpeg' };
      }
    }
  }

  return { order: orderByte as 'II' | 'MM', ifds, thumbnail };
}

export function getIfd(result: TiffResult, kind: TiffKind): TiffIfd | undefined {
  return result.ifds.find((i) => i.kind === kind);
}

export function getTagValue(
  result: TiffResult,
  kind: TiffKind,
  tag: number,
): TiffValue | undefined {
  const ifd = getIfd(result, kind);
  return ifd?.tags.find((t) => t.tag === tag)?.value;
}

/** Decode an XP* tag (UTF-16LE bytes stored as BYTE array). */
export function xpString(value: TiffValue | undefined): string | undefined {
  if (!value?.bytes) return undefined;
  const text = decodeUtf16le(value.bytes)
    .replace(/\u0000+$/g, '')
    .trim();
  return text.length > 0 ? text : undefined;
}
