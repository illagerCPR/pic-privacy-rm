/** Turn a parsed TIFF/EXIF block into display fields and findings data. */
import { describeGps, findGpsIfd, type GpsInfo } from './gps.ts';
import { tagName } from './tag-names.ts';
import {
  getIfd,
  getTagValue,
  parseTiff,
  xpString,
  type TiffKind,
  type TiffResult,
} from './tiff.ts';
import type { Field, FieldGroup } from './types.ts';
import { trimNul } from './bytes.ts';

export interface ExifSummary {
  fields: Field[];
  orientation: number;
  gps?: GpsInfo;
  thumbnail?: { blob: Blob; mime: string; bytes: number };
  tagCount: number;
  hasMakerNote: boolean;
  make?: string;
  model?: string;
  serials: string[];
  times: string[];
}

const DEVICE_TAGS = new Set([
  0x010f, // Make
  0x0110, // Model
  0xa431, // BodySerialNumber
  0xa435, // LensSerialNumber
  0xa433, // LensMake
  0xa434, // LensModel
  0xc62f, // InternalSerialNumber
  0xa430, // CameraOwnerName
  0xa420, // ImageUniqueID
  0x927c, // MakerNote
  0x0112, // Orientation (structural, not identity)
]);

const AUTHOR_TAGS = new Set([0x013b, 0x8298, 0x9c9b, 0x9c9c, 0x9c9d, 0x9c9e, 0x9c9f]);

const TIME_TAGS = new Set([
  0x0132, 0x9003, 0x9004, 0x9010, 0x9011, 0x9012, 0x9290, 0x9291, 0x9292, 0x9400,
]);

const SOFTWARE_TAGS = new Set([0x0131]);

/** Internal TIFF pointers/offsets — meaningless to a human and never shown. */
const HIDDEN_TAGS = new Set([0x8769, 0x8825, 0xa005, 0x0201, 0x0202, 0x0111, 0x0117]);

const SENSITIVE_TAGS = new Set([
  ...DEVICE_TAGS,
  ...AUTHOR_TAGS,
  0x0131,
  0x0132,
  0x9003,
  0x9004,
  0xa420,
  0x9286,
]);

function groupFor(tag: number): FieldGroup {
  if (DEVICE_TAGS.has(tag)) return 'device';
  if (AUTHOR_TAGS.has(tag)) return 'author';
  if (TIME_TAGS.has(tag)) return 'time';
  if (SOFTWARE_TAGS.has(tag)) return 'software';
  return 'capture';
}

function formatRational(nums: number[], index: number): string {
  const num = nums[index * 2];
  const den = nums[index * 2 + 1];
  if (num === undefined || den === undefined) return '?';
  if (den === 0) return `${num}/0`;
  const value = num / den;
  const rounded = Number(value.toFixed(4));
  return den === 1 ? String(num) : `${num}/${den} (${rounded})`;
}

function formatTagValue(
  tag: number,
  type: number,
  count: number,
  nums: number[],
  text?: string,
  bytes?: Uint8Array,
): string {
  if (type === 2) return trimNul(text ?? '');
  if (type === 5 || type === 10) {
    const n = Math.min(count, 4);
    const parts: string[] = [];
    for (let i = 0; i < n; i += 1) parts.push(formatRational(nums, i));
    return parts.join(', ');
  }
  if (tag === 0x927c) return `(${bytes?.length ?? 0} bytes, vendor private)`;
  if (tag === 0x9286 && bytes) {
    const prefix = new TextDecoder('ascii').decode(bytes.subarray(0, 8));
    const body = bytes.subarray(8);
    const bodyText = prefix.startsWith('UNICODE')
      ? Array.from({ length: Math.floor(body.length / 2) }, (_, i) =>
          String.fromCharCode((body[i * 2] ?? 0) | ((body[i * 2 + 1] ?? 0) << 8)),
        ).join('')
      : new TextDecoder('utf-8', { fatal: false }).decode(body);
    return bodyText.replace(/\u0000/g, '').trim();
  }
  if (tag >= 0x9c9b && tag <= 0x9c9f) {
    return xpString({ type, count, nums, bytes }) ?? '';
  }
  if (nums.length > 0) {
    if (nums.length > 8) return `${nums.slice(0, 8).join(', ')}, …`;
    return nums.join(', ');
  }
  if (bytes)
    return bytes.length <= 8
      ? `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`
      : `(${bytes.length} bytes)`;
  return '';
}

/** Parse a raw EXIF block (`Exif\0\0` already removed) and describe it. */
export function summarizeExifBlock(data: Uint8Array): ExifSummary | null {
  const tiff = parseTiff(data);
  if (!tiff) return null;
  return summarizeTiff(tiff);
}

export function summarizeTiff(tiff: TiffResult): ExifSummary {
  const fields: Field[] = [];
  const serials: string[] = [];
  const times: string[] = [];
  let tagCount = 0;
  let hasMakerNote = false;
  let make: string | undefined;
  let model: string | undefined;
  let orientation = 1;
  let thumbnail: ExifSummary['thumbnail'];

  const pushIfd = (kind: TiffKind) => {
    const ifd = getIfd(tiff, kind);
    if (!ifd) return;
    for (const tag of ifd.tags) {
      tagCount += 1;
      if (tag.tag === 0x0112) {
        const v = tag.value.nums[0];
        if (v && v >= 1 && v <= 8) orientation = v;
      }
      if (kind === 'exif' && tag.tag === 0x927c) hasMakerNote = true;
      if (HIDDEN_TAGS.has(tag.tag)) continue;
      const name = tagName(kind === 'ifd0' || kind === 'ifd1' ? 'tiff' : 'exif', tag.tag);
      const value = formatTagValue(
        tag.tag,
        tag.type,
        tag.count,
        tag.value.nums,
        tag.value.text,
        tag.value.bytes,
      );
      if (!value) continue;
      const field: Field = {
        label: name,
        value,
        group: groupFor(tag.tag),
        sensitive: SENSITIVE_TAGS.has(tag.tag),
      };
      fields.push(field);
      if (tag.tag === 0x010f) make = value;
      if (tag.tag === 0x0110) model = value;
      if (tag.tag === 0xa431 || tag.tag === 0xa435 || tag.tag === 0xc62f) serials.push(value);
      if (tag.tag === 0x9003 || tag.tag === 0x0132) times.push(value);
    }
  };

  pushIfd('ifd0');
  pushIfd('exif');
  // IFD1 only carries the embedded thumbnail pointers.
  const ifd1 = getIfd(tiff, 'ifd1');
  if (ifd1) tagCount += ifd1.tags.length;

  const gpsIfd = findGpsIfd(tiff);
  const gps = gpsIfd ? (describeGps(gpsIfd) ?? undefined) : undefined;

  if (tiff.thumbnail) {
    const bytes = tiff.thumbnail.bytes;
    thumbnail = {
      blob: new Blob([bytes.slice()], { type: tiff.thumbnail.mime }),
      mime: tiff.thumbnail.mime,
      bytes: bytes.length,
    };
  }

  // Deduplicate consecutive identical labels coming from multiple IFDs.
  const seen = new Set<string>();
  const uniqueFields = fields.filter((f) => {
    const key = `${f.label}\u0000${f.value}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return {
    fields: uniqueFields,
    orientation,
    gps,
    thumbnail,
    tagCount,
    hasMakerNote,
    make,
    model,
    serials,
    times,
  };
}

export { getTagValue };
