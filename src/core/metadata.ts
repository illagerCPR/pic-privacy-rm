/**
 * Complete metadata listing.
 *
 * `exif.ts` reduces a block to the handful of fields the privacy report needs.
 * This module does the opposite: every entry is expanded, nothing is filtered,
 * deduplicated or hidden. It powers the "all metadata" table, so the user can
 * see by themselves exactly what the strip pass is about to throw away — which
 * is also the most honest possible proof that nothing was left behind.
 *
 * Parsing here is purely cosmetic. The strip pass never consults it.
 */
import { decodeText, decodeUtf16le, isMostlyPrintable, trimNul } from './bytes.ts';
import { tagName } from './tag-names.ts';
import { parseTiff, type TiffKind, type TiffResult, type TiffTag, type TiffValue } from './tiff.ts';

export type MetadataGroupId =
  | 'file'
  | 'ifd0'
  | 'exif'
  | 'gps'
  | 'interop'
  | 'ifd1'
  | 'xmp'
  | 'iptc'
  | 'text'
  | 'c2pa'
  | 'container';

export interface MetadataItem {
  /** Display name: a tag name, or `Tag0x1234` for ids we do not know. */
  name: string;
  /** Raw tag id, e.g. `0x010f`. */
  id?: string;
  /** TIFF type name, e.g. `ASCII` or `RATIONAL`. */
  type?: string;
  /** Number of values declared by the directory entry. */
  count?: number;
  /** Human readable value, already formatted. */
  value: string;
  /** True when the value list was shortened for display. */
  truncated?: boolean;
  /** Raw payload, kept only for binary entries worth inspecting. */
  bytes?: Uint8Array;
  /** Byte length of the raw payload. */
  size?: number;
  /** Overrides the group's removal flag when the group is mixed. */
  removed?: boolean;
}

export interface MetadataGroup {
  id: MetadataGroupId;
  /** i18n key for the group heading. */
  titleKey: string;
  /** True when the strip pass removes this group wholesale. */
  removed: boolean;
  items: MetadataItem[];
}

export interface MetadataReport {
  groups: MetadataGroup[];
  /** Total number of listed entries, for the tab badge. */
  total: number;
}

/** Payloads larger than this are described by size only. */
const MAX_BYTES_KEPT = 64 * 1024;

const TYPE_NAMES: Record<number, string> = {
  1: 'BYTE',
  2: 'ASCII',
  3: 'SHORT',
  4: 'LONG',
  5: 'RATIONAL',
  6: 'SBYTE',
  7: 'UNDEFINED',
  8: 'SSHORT',
  9: 'SLONG',
  10: 'SRATIONAL',
  11: 'FLOAT',
  12: 'DOUBLE',
  13: 'IFD',
};

const EMPTY = new Uint8Array(0);

/* ------------------------------------------------------------------ *
 * Enumerations
 * ------------------------------------------------------------------ */

const ORIENTATION: Record<number, string> = {
  1: 'Horizontal (normal)',
  2: 'Mirror horizontal',
  3: 'Rotate 180',
  4: 'Mirror vertical',
  5: 'Mirror horizontal, rotate 270 CW',
  6: 'Rotate 90 CW',
  7: 'Mirror horizontal, rotate 90 CW',
  8: 'Rotate 270 CW',
};

const EXPOSURE_PROGRAM: Record<number, string> = {
  0: 'Not defined',
  1: 'Manual',
  2: 'Program AE',
  3: 'Aperture-priority AE',
  4: 'Shutter speed priority AE',
  5: 'Creative (slow speed)',
  6: 'Action (high speed)',
  7: 'Portrait',
  8: 'Landscape',
  9: 'Bulb',
};

const METERING_MODE: Record<number, string> = {
  0: 'Unknown',
  1: 'Average',
  2: 'Center-weighted average',
  3: 'Spot',
  4: 'Multi-spot',
  5: 'Multi-segment',
  6: 'Partial',
  255: 'Other',
};

const LIGHT_SOURCE: Record<number, string> = {
  0: 'Unknown',
  1: 'Daylight',
  2: 'Fluorescent',
  3: 'Tungsten (incandescent)',
  4: 'Flash',
  9: 'Fine weather',
  10: 'Cloudy',
  11: 'Shade',
  12: 'Daylight fluorescent',
  13: 'Day white fluorescent',
  14: 'Cool white fluorescent',
  15: 'White fluorescent',
  17: 'Standard light A',
  18: 'Standard light B',
  19: 'Standard light C',
  20: 'D55',
  21: 'D65',
  22: 'D75',
  23: 'D50',
  24: 'ISO studio tungsten',
  255: 'Other',
};

const FLASH: Record<number, string> = {
  0x00: 'No flash',
  0x01: 'Fired',
  0x05: 'Fired, return not detected',
  0x07: 'Fired, return detected',
  0x08: 'On, did not fire',
  0x09: 'On, fired',
  0x0d: 'On, return not detected',
  0x0f: 'On, return detected',
  0x10: 'Off, did not fire',
  0x14: 'Off, did not fire, return not detected',
  0x18: 'Auto, did not fire',
  0x19: 'Auto, fired',
  0x1d: 'Auto, fired, return not detected',
  0x1f: 'Auto, fired, return detected',
  0x20: 'No flash function',
  0x30: 'Off, no flash function',
  0x41: 'Fired, red-eye reduction',
  0x45: 'Fired, red-eye reduction, return not detected',
  0x47: 'Fired, red-eye reduction, return detected',
  0x49: 'On, red-eye reduction',
  0x4d: 'On, red-eye reduction, return not detected',
  0x4f: 'On, red-eye reduction, return detected',
  0x59: 'Auto, red-eye reduction',
  0x5d: 'Auto, red-eye reduction, return not detected',
  0x5f: 'Auto, red-eye reduction, return detected',
};

const COLOR_SPACE: Record<number, string> = {
  1: 'sRGB',
  2: 'Adobe RGB',
  0xffff: 'Uncalibrated',
};

const WHITE_BALANCE: Record<number, string> = {
  0: 'Auto',
  1: 'Manual',
};

const EXPOSURE_MODE: Record<number, string> = {
  0: 'Auto',
  1: 'Manual',
  2: 'Auto bracket',
};

const SCENE_CAPTURE: Record<number, string> = {
  0: 'Standard',
  1: 'Landscape',
  2: 'Portrait',
  3: 'Night scene',
};

const RESOLUTION_UNIT: Record<number, string> = {
  1: 'None',
  2: 'inches',
  3: 'cm',
};

const COMPRESSION: Record<number, string> = {
  1: 'Uncompressed',
  2: 'CCITT 1D',
  5: 'LZW',
  6: 'JPEG (old-style)',
  7: 'JPEG',
  8: 'Deflate',
  32773: 'PackBits',
  32946: 'Deflate',
  34892: 'Lossy JPEG',
};

const PHOTOMETRIC: Record<number, string> = {
  0: 'WhiteIsZero',
  1: 'BlackIsZero',
  2: 'RGB',
  3: 'Palette',
  5: 'CMYK',
  6: 'YCbCr',
  8: 'CIELab',
};

const YCBCR_POSITIONING: Record<number, string> = {
  1: 'Centered',
  2: 'Co-sited',
};

const SENSING_METHOD: Record<number, string> = {
  1: 'Not defined',
  2: 'One-chip colour area sensor',
  3: 'Two-chip colour area sensor',
  4: 'Three-chip colour area sensor',
  5: 'Colour sequential area sensor',
  7: 'Trilinear sensor',
  8: 'Colour sequential linear sensor',
};

const FILE_SOURCE: Record<number, string> = {
  1: 'Film scanner',
  2: 'Reflection print scanner',
  3: 'Digital still camera',
};

const SCENE_TYPE: Record<number, string> = {
  1: 'Directly photographed',
};

const COMPONENTS: Record<number, string> = {
  0: '-',
  1: 'Y',
  2: 'Cb',
  3: 'Cr',
  4: 'R',
  5: 'G',
  6: 'B',
};

/* ------------------------------------------------------------------ *
 * Value helpers
 * ------------------------------------------------------------------ */

function rationalAt(nums: number[], index: number): number | undefined {
  const num = nums[index * 2];
  const den = nums[index * 2 + 1];
  if (num === undefined || den === undefined || den === 0) return undefined;
  return num / den;
}

function describe(map: Record<number, string>, value: number | undefined): string | undefined {
  if (value === undefined) return undefined;
  return map[value];
}

function withLabel(value: number | undefined, map: Record<number, string>): string | undefined {
  if (value === undefined) return undefined;
  const label = describe(map, value);
  const numeric = Number.isInteger(value) ? String(value) : String(Number(value.toFixed(4)));
  return label === undefined ? numeric : `${numeric} (${label})`;
}

function hex(b: Uint8Array, max = 32): string {
  const n = Math.min(b.length, max);
  let s = '';
  for (let i = 0; i < n; i += 1) s += (b[i] ?? 0).toString(16).padStart(2, '0');
  return s + (b.length > max ? '…' : '');
}

/** A shutter speed in seconds, rendered the way cameras write it. */
function seconds(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return String(value);
  if (value >= 1) return `${Number(value.toFixed(2))} s`;
  const den = Math.round(1 / value);
  return den > 0 ? `1/${den} s` : `${Number(value.toFixed(4))} s`;
}

/** APEX shutter speed to seconds: t = 2^-v. */
function apexToSeconds(apex: number): number {
  return Math.pow(2, -apex);
}

/** APEX aperture to f-number: N = 2^(v/2). */
function apexToFNumber(apex: number): number {
  return Math.pow(2, apex / 2);
}

function dms(nums: number[]): string | undefined {
  if (nums.length >= 6) {
    const deg = rationalAt(nums, 0);
    const min = rationalAt(nums, 1);
    const sec = rationalAt(nums, 2);
    if (deg === undefined) return undefined;
    return `${deg}° ${min ?? 0}' ${Number((sec ?? 0).toFixed(3))}"`;
  }
  if (nums.length >= 2) {
    const decimal = rationalAt(nums, 0);
    if (decimal === undefined) return undefined;
    return `${Number(decimal.toFixed(6))}°`;
  }
  return undefined;
}

function numberList(nums: number[], limit = 8): { text: string; truncated: boolean } {
  const shown = nums.slice(0, limit).join(', ');
  return { text: nums.length > limit ? `${shown}, …` : shown, truncated: nums.length > limit };
}

/* ------------------------------------------------------------------ *
 * Per-namespace formatting
 * ------------------------------------------------------------------ */

type Formatted = { text: string; truncated?: boolean };

function formatGpsTag(tag: number, value: TiffValue): Formatted | null {
  const nums = value.nums;
  switch (tag) {
    case 0x0000:
      return { text: Array.from(value.bytes ?? EMPTY).join('.') || '(empty)' };
    case 0x0002:
    case 0x0004: {
      const text = dms(nums);
      return text ? { text } : null;
    }
    case 0x0005: {
      const v = nums[0];
      if (v === undefined) return null;
      return { text: v === 1 ? 'Below sea level' : 'Above sea level' };
    }
    case 0x0006: {
      const v = rationalAt(nums, 0);
      return v === undefined ? null : { text: `${Number(v.toFixed(2))} m` };
    }
    case 0x0007: {
      if (nums.length < 6) return null;
      const parts = [0, 1, 2].map((i) => {
        const n = rationalAt(nums, i) ?? 0;
        return String(Math.floor(n)).padStart(2, '0');
      });
      return { text: parts.join(':') };
    }
    case 0x000b: {
      const v = rationalAt(nums, 0);
      return v === undefined ? null : { text: String(Number(v.toFixed(2))) };
    }
    case 0x000d: {
      const v = rationalAt(nums, 0);
      return v === undefined ? null : { text: String(Number(v.toFixed(2))) };
    }
    case 0x000f:
    case 0x0011:
    case 0x0018: {
      const v = rationalAt(nums, 0);
      return v === undefined ? null : { text: `${Number(v.toFixed(2))}°` };
    }
    case 0x001a: {
      const v = rationalAt(nums, 0);
      return v === undefined ? null : { text: String(Number(v.toFixed(2))) };
    }
    case 0x001b:
    case 0x001c:
      return decodeUserText(value);
    default:
      return null;
  }
}

function formatTiffTag(tag: number, value: TiffValue): Formatted | null {
  const nums = value.nums;
  switch (tag) {
    case 0x0112: {
      const v = nums[0];
      const label = describe(ORIENTATION, v);
      return label ? { text: `${v} (${label})` } : null;
    }
    case 0x0103: {
      const v = nums[0];
      const label = describe(COMPRESSION, v);
      return label ? { text: `${v} (${label})` } : null;
    }
    case 0x0106: {
      const v = nums[0];
      const label = describe(PHOTOMETRIC, v);
      return label ? { text: `${v} (${label})` } : null;
    }
    case 0x011a:
    case 0x011b: {
      const v = rationalAt(nums, 0);
      return v === undefined ? null : { text: `${Number(v.toFixed(3))} dpi` };
    }
    case 0x0128: {
      const v = nums[0];
      const label = describe(RESOLUTION_UNIT, v);
      return label ? { text: `${v} (${label})` } : null;
    }
    case 0x0213: {
      const v = nums[0];
      const label = describe(YCBCR_POSITIONING, v);
      return label ? { text: `${v} (${label})` } : null;
    }
    case 0x0201:
      return nums[0] === undefined ? null : { text: `at byte ${nums[0]}` };
    case 0x0111: {
      // StripOffsets: a list of pointers into the file.
      return nums.length === 0 ? null : numberList(nums, 4);
    }
    case 0x9c9b:
    case 0x9c9c:
    case 0x9c9d:
    case 0x9c9e:
    case 0x9c9f: {
      // XP* tags store UTF-16LE bytes in a BYTE entry.
      const raw = value.bytes ?? EMPTY;
      const text = decodeUtf16le(raw)
        .replace(/\u0000+$/g, '')
        .trim();
      return { text: text.length > 0 ? text : '(empty)' };
    }
    default:
      return null;
  }
}

function formatExifTag(tag: number, value: TiffValue): Formatted | null {
  const nums = value.nums;
  switch (tag) {
    case 0x829a: {
      const v = rationalAt(nums, 0);
      return v === undefined ? null : { text: seconds(v) };
    }
    case 0x829d: {
      const v = rationalAt(nums, 0);
      return v === undefined ? null : { text: `f/${Number(v.toFixed(2))}` };
    }
    case 0x9201: {
      const v = rationalAt(nums, 0);
      return v === undefined ? null : { text: seconds(apexToSeconds(v)) };
    }
    case 0x9202:
    case 0x9205: {
      const v = rationalAt(nums, 0);
      return v === undefined ? null : { text: `f/${Number(apexToFNumber(v).toFixed(2))}` };
    }
    case 0x9204: {
      const v = rationalAt(nums, 0);
      if (v === undefined) return null;
      return { text: `${v > 0 ? '+' : ''}${Number(v.toFixed(2))} EV` };
    }
    case 0x920a:
    case 0xa405: {
      const v = rationalAt(nums, 0);
      return v === undefined ? null : { text: `${Number(v.toFixed(1))} mm` };
    }
    case 0x9206: {
      const v = rationalAt(nums, 0);
      return v === undefined ? null : { text: `${Number(v.toFixed(2))} m` };
    }
    case 0x9209: {
      const v = nums[0];
      const label = describe(FLASH, v);
      return label ? { text: `0x${(v ?? 0).toString(16).padStart(2, '0')} (${label})` } : null;
    }
    case 0x8822: {
      const v = nums[0];
      return withLabel(v, EXPOSURE_PROGRAM)
        ? { text: withLabel(v, EXPOSURE_PROGRAM) as string }
        : null;
    }
    case 0x9207: {
      const v = nums[0];
      const label = describe(METERING_MODE, v);
      return label ? { text: `${v} (${label})` } : null;
    }
    case 0x9208: {
      const v = nums[0];
      const label = describe(LIGHT_SOURCE, v);
      return label ? { text: `${v} (${label})` } : null;
    }
    case 0xa001: {
      const v = nums[0];
      const label = describe(COLOR_SPACE, v);
      return label ? { text: `${v} (${label})` } : null;
    }
    case 0xa403: {
      const v = nums[0];
      const label = describe(WHITE_BALANCE, v);
      return label ? { text: `${v} (${label})` } : null;
    }
    case 0xa402: {
      const v = nums[0];
      const label = describe(EXPOSURE_MODE, v);
      return label ? { text: `${v} (${label})` } : null;
    }
    case 0xa406: {
      const v = nums[0];
      const label = describe(SCENE_CAPTURE, v);
      return label ? { text: `${v} (${label})` } : null;
    }
    case 0xa217: {
      const v = nums[0];
      const label = describe(SENSING_METHOD, v);
      return label ? { text: `${v} (${label})` } : null;
    }
    case 0x9101: {
      const bytes = value.bytes ?? EMPTY;
      if (bytes.length === 0) return null;
      const parts = Array.from(bytes, (b) => COMPONENTS[b] ?? String(b));
      return { text: parts.join(', ') };
    }
    case 0xa300: {
      const v = nums[0] ?? (value.bytes ? value.bytes[0] : undefined);
      const label = describe(FILE_SOURCE, v);
      return v === undefined ? null : { text: label ? `${v} (${label})` : String(v) };
    }
    case 0xa301: {
      const v = nums[0] ?? (value.bytes ? value.bytes[0] : undefined);
      const label = describe(SCENE_TYPE, v);
      return v === undefined ? null : { text: label ? `${v} (${label})` : String(v) };
    }
    case 0x9286:
      return decodeUserText(value);
    case 0x9000:
    case 0xa000:
      return decodeUndefinedText(value);
    default:
      return null;
  }
}

function decodeUserText(value: TiffValue): Formatted | null {
  const raw = value.bytes;
  if (!raw || raw.length === 0) return null;
  const prefix = decodeText(raw.subarray(0, 8));
  const body = raw.subarray(8);
  if (prefix.startsWith('ASCII')) {
    const text = trimNul(decodeText(body));
    return text ? { text } : null;
  }
  if (prefix.startsWith('UNICODE')) {
    let s = '';
    for (let i = 0; i + 1 < body.length; i += 2) {
      s += String.fromCharCode((body[i] ?? 0) | ((body[i + 1] ?? 0) << 8));
    }
    const text = s.replace(/\u0000/g, '').trim();
    return text ? { text } : null;
  }
  const fallback = trimNul(decodeText(raw));
  return fallback ? { text: fallback } : null;
}

function decodeUndefinedText(value: TiffValue): Formatted | null {
  const raw = value.bytes;
  if (!raw || raw.length === 0) return null;
  if (isMostlyPrintable(raw, 0.95)) {
    const text = trimNul(decodeText(raw));
    return text ? { text } : null;
  }
  return null;
}

function formatGeneric(tag: TiffTag): Formatted {
  const { value } = tag;
  if (value.nums.length > 0) return numberList(value.nums);
  const raw = value.bytes;
  if (raw && raw.length > 0) {
    if (isMostlyPrintable(raw, 0.95)) {
      const text = trimNul(decodeText(raw));
      if (text.length > 0) return { text };
    }
    if (raw.length <= 16) return { text: hex(raw) };
    return { text: `(${raw.length} bytes)` };
  }
  return { text: '(empty)' };
}

function formatValue(kind: TiffKind, tag: TiffTag): Formatted {
  const { value } = tag;
  const type = value.type;

  if (type === 2) {
    const text = trimNul(value.text ?? '');
    return { text: text.length > 0 ? text : '(empty)' };
  }

  // BYTE / SBYTE never reach `nums`, so widen them here.
  if (type === 1 || type === 6) {
    const raw = value.bytes ?? EMPTY;
    const nums = Array.from(raw, (b) => (type === 6 && b > 0x7f ? b - 0x100 : b));
    if (nums.length === 0) return { text: '(empty)' };
    const special =
      kind === 'gps'
        ? formatGpsTag(tag.tag, { ...value, nums })
        : kind === 'exif'
          ? formatExifTag(tag.tag, { ...value, nums })
          : formatTiffTag(tag.tag, { ...value, nums });
    return special ?? numberList(nums);
  }

  const special =
    kind === 'gps'
      ? formatGpsTag(tag.tag, value)
      : kind === 'exif'
        ? formatExifTag(tag.tag, value)
        : formatTiffTag(tag.tag, value);
  if (special) return special;

  return formatGeneric(tag);
}

/* ------------------------------------------------------------------ *
 * Assembly
 * ------------------------------------------------------------------ */

function kindOf(kind: TiffKind): 'tiff' | 'exif' | 'gps' | 'interop' {
  if (kind === 'gps') return 'gps';
  if (kind === 'interop') return 'interop';
  if (kind === 'exif') return 'exif';
  return 'tiff';
}

function keepBytes(kind: TiffKind, tag: number, value: TiffValue): boolean {
  const raw = value.bytes;
  if (!raw || raw.length === 0 || raw.length > MAX_BYTES_KEPT) return false;
  // Vendor blobs and free-text blobs are the two users actually want to peek at.
  if (tag === 0x927c || tag === 0x9286) return true;
  // Unknown ids: keep the payload so the hex preview stays useful.
  return tagName(kindOf(kind), tag).startsWith('Tag0x');
}

function buildItem(kind: TiffKind, tag: TiffTag): MetadataItem {
  const formatted = formatValue(kind, tag);
  const item: MetadataItem = {
    name: tagName(kindOf(kind), tag.tag),
    id: `0x${tag.tag.toString(16).padStart(4, '0')}`,
    type: TYPE_NAMES[tag.type] ?? `TYPE${tag.type}`,
    count: tag.count,
    value: formatted.text,
  };
  if (formatted.truncated) item.truncated = true;
  if (tag.value.bytes && tag.value.bytes.length > 0) {
    item.size = tag.value.bytes.length;
    if (keepBytes(kind, tag.tag, tag.value)) item.bytes = tag.value.bytes.slice();
  }
  return item;
}

/** Expand a parsed TIFF block into one group per IFD. */
export function inspectTiff(tiff: TiffResult, removed = true): MetadataGroup[] {
  const order: TiffKind[] = ['ifd0', 'exif', 'gps', 'interop', 'ifd1'];
  const groups: MetadataGroup[] = [];
  for (const kind of order) {
    const ifds = tiff.ifds.filter((ifd) => ifd.kind === kind);
    if (ifds.length === 0) continue;
    const items: MetadataItem[] = [];
    for (const ifd of ifds) {
      for (const tag of ifd.tags) items.push(buildItem(kind, tag));
    }
    if (items.length === 0) continue;
    groups.push({ id: kind, titleKey: `meta.group.${kind}`, removed, items });
  }
  return groups;
}

/** Parse a raw EXIF block (`Exif\0\0` already removed) and expand it. */
export function inspectExifBlock(data: Uint8Array, removed = true): MetadataGroup[] | null {
  const tiff = parseTiff(data);
  if (!tiff) return null;
  return inspectTiff(tiff, removed);
}

/** Wrap groups into the report shape the UI consumes. */
export function makeReport(groups: MetadataGroup[]): MetadataReport {
  return { groups, total: groups.reduce((sum, group) => sum + group.items.length, 0) };
}
