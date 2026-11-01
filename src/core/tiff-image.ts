/**
 * TIFF container analyser / stripper.
 *
 * A TIFF has no metadata "segment": the descriptive tags live in the same
 * image file directory as the tags that describe the pixels. Stripping is
 * therefore a directory rebuild — keep the structural entries, drop everything
 * else, lay the image data out contiguously and point `StripOffsets` at it.
 *
 * The image payload is never decoded. Strips and tiles are copied byte for
 * byte, so LZW, Deflate, PackBits, JPEG-in-TIFF and vendor codecs all pass
 * through untouched, and the output stays bit-identical where it matters.
 *
 * Every page of a multi-page file is rebuilt and re-linked; a reduced-resolution
 * directory (a thumbnail) is dropped, because it is a second copy of a picture
 * we are about to clean. New-style JPEG strips are run through the JPEG engine
 * so no inner APPn survives either.
 *
 * Deliberate refusals (better a clear error than a broken scan):
 *   - BigTIFF (magic 43) — 64-bit offsets are a different layout
 *   - old-style JPEG (compression 6) — the stream hides behind tag 0x0201
 *   - SubIFDs, DNG, CR2 and CFA raws — we cannot relocate those trees safely
 */
import { indexOfBytes, startsWithBytes, u16be, u16le, u32be, u32le } from './bytes.ts';
import { buildIptcFindings, buildXmpFindings } from './findings.ts';
import { describeGps } from './gps.ts';
import { analyzeJpeg } from './jpeg.ts';
import { parsePhotoshopResources, summarizeIim, type IptcSummary } from './iptc.ts';
import { readAt, sourceFromBytes, type Source } from './source.ts';
import { tagName } from './tag-names.ts';
import { decodeTiffValue, TIFF_TYPE_SIZE, type TiffIfd, type TiffTag } from './tiff.ts';
import type {
  BlockInfo,
  ContainerAnalysis,
  Field,
  FieldGroup,
  Finding,
  Part,
  StripOptions,
  Warning,
} from './types.ts';
import { parseXmp } from './xmp.ts';

/* ------------------------------------------------------------------ *
 * Tag policy
 * ------------------------------------------------------------------ */

/** Entries a decoder needs, plus colour data. Everything else is removed. */
const KEEP_TAGS = new Set<number>([
  0x00fe, 0x00ff, // NewSubfileType, SubfileType
  0x0100, 0x0101, 0x0102, 0x0103, 0x0106, 0x0107, 0x0108, 0x0109, 0x010a,
  0x0111, 0x0112, 0x0115, 0x0116, 0x0117, 0x0118, 0x0119, 0x011a, 0x011b, 0x011c,
  0x011e, 0x011f, 0x0122, 0x0123, 0x0124, 0x0125, 0x0128, 0x012d,
  0x013d, 0x013e, 0x013f, 0x0140, 0x0141, 0x0142, 0x0143, 0x0144, 0x0145,
  0x014c, 0x014d, 0x014e, 0x0150, 0x0152, 0x0153, 0x0154, 0x0155, 0x0156,
  0x0157, 0x0158, 0x0159, 0x015a, 0x015b,
  0x0200, 0x0203, 0x0205, 0x0206, 0x0207, 0x0208, 0x0209,
  0x0211, 0x0212, 0x0213, 0x0214,
  0x8773, // ICC profile (subject to the keepIcc setting)
]);

const ICC_TAG = 0x8773;
const STRIP_OFFSETS = 0x0111;
const STRIP_COUNTS = 0x0117;
const TILE_OFFSETS = 0x0144;
const TILE_COUNTS = 0x0145;
const COMPRESSION = 0x0103;
const PHOTOMETRIC = 0x0106;
const SUB_IFDS = 0x014a;
const EXIF_POINTER = 0x8769;
const GPS_POINTER = 0x8825;
const INTEROP_POINTER = 0xa005;
const XMP_TAG = 0x02bc;
const IPTC_TAG = 0x83bb;
const PHOTOSHOP_TAG = 0x8649;
const MAKER_NOTE = 0x927c;
const USER_COMMENT = 0x9286;
const DNG_VERSION = 0xc612;

/** Descriptive tags: they describe the picture, never how to decode it. */
const DESCRIPTIVE_TAGS = new Set<number>([
  0x010d, // DocumentName
  0x010e, // ImageDescription
  0x010f, // Make
  0x0110, // Model
  0x011d, // PageName
  0x0129, // PageNumber
  0x0131, // Software
  0x0132, // DateTime
  0x013b, // Artist
  0x013c, // HostComputer
  0x0151, // TargetPrinter
  0x4746, // Rating
  0x4749, // RatingPercent
  0x8298, // Copyright
  0x9c9b, 0x9c9c, 0x9c9d, 0x9c9e, 0x9c9f, // XPTitle … XPSubject
  // Exif tags that some writers put straight into IFD0 instead of a sub-IFD.
  0x9003, 0x9004, 0x9010, 0x9011, 0x9012, // DateTimeOriginal … OffsetTime
  0xa420, // ImageUniqueID
  0xa430, 0xa431, // CameraOwnerName, BodySerialNumber
  0xa432, 0xa433, 0xa434, 0xa435, // lens identity
  0xa436, 0xa437, // ImageTitle, Photographer
]);

/** Timestamps that only appear next to DateTime. */
const TIME_EXTRAS = new Set([0x9290, 0x9291, 0x9292, 0x9400, 0x9401, 0x9402]);

/** GeoTIFF georeferencing: a map reference is a location. */
const GEO_TAGS = new Set<number>([
  0x830e, // ModelPixelScale
  0x8480, // ModelTiepoint
  0x8482, // ModelTransformation
  0x87af, // GeoKeyDirectory
  0x87b0, // GeoDoubleParams
  0x87b1, // GeoAsciiParams
  0xa480, // GDAL_METADATA
  0xa481, // GDAL_NODATA
]);

const MAX_ENTRIES = 4096;
const MAX_IFD_BYTES = 1 << 20;
const MAX_VALUE_READ = 8 << 20;
const MAX_TIFF = 0xfffeffff; // classic TIFF offsets are 32-bit

/** How the strip pass treats one IFD0 tag. Exposed for the metadata viewer. */
export function tagPolicy(tag: number, keepIcc = true): 'structural' | 'privacy' | 'unknown' {
  if (KEEP_TAGS.has(tag)) {
    if (tag === ICC_TAG && !keepIcc) return 'privacy';
    return 'structural';
  }
  if (DESCRIPTIVE_TAGS.has(tag) || TIME_EXTRAS.has(tag)) return 'privacy';
  if (tag === USER_COMMENT || tag === MAKER_NOTE) return 'privacy';
  if (tag === EXIF_POINTER || tag === GPS_POINTER || tag === INTEROP_POINTER) return 'privacy';
  if (tag === XMP_TAG || tag === IPTC_TAG || tag === PHOTOSHOP_TAG) return 'privacy';
  if (GEO_TAGS.has(tag)) return 'privacy';
  return 'unknown';
}

/* ------------------------------------------------------------------ *
 * Raw directory reader
 * ------------------------------------------------------------------ */

interface RawEntry {
  tag: number;
  type: number;
  count: number;
  /** Byte length of the value (0 when the type is unknown). */
  size: number;
  /** The four bytes stored inside the directory entry itself. */
  field: Uint8Array;
  /** Absolute offset of the value when it does not fit inline, else 0. */
  valueOffset: number;
}

interface RawIfd {
  entries: RawEntry[];
  next: number;
  /** Byte length of the directory table, including the next-IFD pointer. */
  bytes: number;
}

async function readIfd(src: Source, offset: number, little: boolean): Promise<RawIfd | null> {
  if (offset < 8 || offset + 2 > src.size) return null;
  const head = await readAt(src, offset, 2);
  if (head.length < 2) return null;
  const count = little ? u16le(head, 0) : u16be(head, 0);
  if (count === 0 || count > MAX_ENTRIES) return null;

  const bytes = 2 + count * 12 + 4;
  if (bytes > MAX_IFD_BYTES || offset + bytes > src.size) return null;
  const table = await readAt(src, offset, bytes);
  if (table.length < bytes) return null;

  const entries: RawEntry[] = [];
  for (let i = 0; i < count; i += 1) {
    const at = 2 + i * 12;
    const tag = little ? u16le(table, at) : u16be(table, at);
    const type = little ? u16le(table, at + 2) : u16be(table, at + 2);
    const items = little ? u32le(table, at + 4) : u32be(table, at + 4);
    const size = (TIFF_TYPE_SIZE[type] ?? 0) * items;
    entries.push({
      tag,
      type,
      count: items,
      size,
      field: table.subarray(at + 8, at + 12),
      valueOffset: size <= 4 ? 0 : little ? u32le(table, at + 8) : u32be(table, at + 8),
    });
  }
  const nextAt = 2 + count * 12;
  return { entries, next: little ? u32le(table, nextAt) : u32be(table, nextAt), bytes };
}

/** Pull a value into memory. Returns null when it is out of range or huge. */
async function readValue(src: Source, entry: RawEntry, cap = MAX_VALUE_READ): Promise<Uint8Array | null> {
  if (entry.size === 0) return new Uint8Array(0);
  if (entry.size <= 4) return entry.field.subarray(0, entry.size);
  if (entry.size > cap || entry.valueOffset + entry.size > src.size) return null;
  const bytes = await readAt(src, entry.valueOffset, entry.size);
  return bytes.length === entry.size ? bytes : null;
}

function toTag(entry: RawEntry, bytes: Uint8Array, little: boolean): TiffTag {
  return { tag: entry.tag, type: entry.type, count: entry.count, value: decodeTiffValue(entry.type, entry.count, bytes, little) };
}

function firstNumber(entry: RawEntry | undefined, bytes: Uint8Array | null, little: boolean): number | undefined {
  if (!entry || !bytes) return undefined;
  return decodeTiffValue(entry.type, entry.count, bytes, little).nums[0];
}

function numbersOf(entry: RawEntry, bytes: Uint8Array, little: boolean): number[] {
  return decodeTiffValue(entry.type, entry.count, bytes, little).nums;
}

/* ------------------------------------------------------------------ *
 * Output helpers
 * ------------------------------------------------------------------ */

function putU16(bytes: Uint8Array, at: number, value: number, little: boolean): void {
  if (little) {
    bytes[at] = value & 0xff;
    bytes[at + 1] = (value >>> 8) & 0xff;
  } else {
    bytes[at] = (value >>> 8) & 0xff;
    bytes[at + 1] = value & 0xff;
  }
}

function putU32(bytes: Uint8Array, at: number, value: number, little: boolean): void {
  if (little) {
    bytes[at] = value & 0xff;
    bytes[at + 1] = (value >>> 8) & 0xff;
    bytes[at + 2] = (value >>> 16) & 0xff;
    bytes[at + 3] = (value >>> 24) & 0xff;
  } else {
    bytes[at] = (value >>> 24) & 0xff;
    bytes[at + 1] = (value >>> 16) & 0xff;
    bytes[at + 2] = (value >>> 8) & 0xff;
    bytes[at + 3] = value & 0xff;
  }
}

function failed(warnings: Warning[], fileSize: number): ContainerAnalysis {
  return {
    format: 'tiff',
    mime: 'image/tiff',
    ext: 'tif',
    parts: [],
    findings: [],
    warnings,
    orientation: 1,
    blocks: [],
    droppedBytes: 0,
    keptBytes: fileSize,
    ok: false,
  };
}

/* ------------------------------------------------------------------ *
 * Field extraction (display only — the strip pass never depends on it)
 * ------------------------------------------------------------------ */

function groupForTag(tag: number): FieldGroup {
  if (tag === 0x010f || tag === 0x0110) return 'device';
  if (tag === 0x013b || tag === 0x8298 || (tag >= 0x9c9b && tag <= 0x9c9f)) return 'author';
  if (tag === 0x010e || tag === 0x010d || tag === 0x011d) return 'author';
  if (tag === 0x0132 || TIME_EXTRAS.has(tag)) return 'time';
  if (tag === 0x0131) return 'software';
  return 'other';
}

function describeEntry(
  entry: RawEntry,
  bytes: Uint8Array,
  little: boolean,
  kind: 'tiff' | 'exif',
): Field | null {
  const value = decodeTiffValue(entry.type, entry.count, bytes, little);
  let text = value.text ?? '';
  if (!text && value.nums.length > 0) {
    text = value.nums.length > 8 ? `${value.nums.slice(0, 8).join(', ')}, …` : value.nums.join(', ');
  }
  if (!text && value.bytes) text = `(${value.bytes.length} bytes)`;
  if (entry.tag === MAKER_NOTE) text = `(${entry.size} bytes, vendor private)`;
  if (!text) return null;
  let label = tagName(kind, entry.tag);
  // Tags that normally live in the Exif sub-IFD but sometimes show up in IFD0.
  if (label.startsWith('Tag0x') && kind === 'tiff') label = tagName('exif', entry.tag);
  return { label, value: text, group: groupForTag(entry.tag), sensitive: true };
}

async function ifdFields(
  src: Source,
  ifd: RawIfd,
  little: boolean,
  kind: 'tiff' | 'exif',
): Promise<{ fields: Field[]; weight: number }> {
  const fields: Field[] = [];
  let weight = 0;
  for (const entry of ifd.entries) {
    weight += entry.size;
    const bytes = await readValue(src, entry, 64 * 1024);
    if (!bytes) continue;
    const field = describeEntry(entry, bytes, little, kind);
    if (field) fields.push(field);
  }
  return { fields, weight: weight + ifd.bytes };
}

/* ------------------------------------------------------------------ *
 * Analyser
 * ------------------------------------------------------------------ */

type Payload =
  | { kind: 'slice'; start: number; end: number }
  | { kind: 'bytes'; bytes: Uint8Array };

interface Segment {
  /** Source range of the segment. */
  start: number;
  count: number;
  /** What actually gets written: the source slice, or a cleaned stream. */
  output: Payload;
  /** Assigned during layout. */
  at: number;
}

interface Prepared {
  dir: RawIfd;
  index: number;
  kept: RawEntry[];
  dropped: RawEntry[];
  offsetsTag: number;
  countsTag: number;
  segments: Segment[];
  /** Assigned during layout. */
  dirOffset: number;
}

interface Thumbnail {
  dir: RawIfd;
  index: number;
  bytes: number;
  /** A JPEG preview can be shown; a reduced-resolution page cannot. */
  preview?: { start: number; count: number };
}

const JPEG_PREVIEW = 0x0201;
const JPEG_PREVIEW_LENGTH = 0x0202;
const JPEG_TABLES = 0x015b;
const SUBFILE_TYPE = 0x00fe;

const MAX_PAGES = 1024; // safety net only: scanned documents can be long
const MAX_INNER_JPEG = 64 << 20;

/** Layout bookkeeping for one page: where its directory and values go. */
interface PageLayout {
  dirOffset: number;
  valueAt: Map<number, number>;
  pads: Map<number, number>;
  /** Padding between the value area and the image data. */
  dataPad: number;
}

function isComputed(page: Prepared, entry: RawEntry): boolean {
  return entry.tag === page.offsetsTag || entry.tag === page.countsTag;
}

function outLength(page: Prepared, entry: RawEntry): number {
  return isComputed(page, entry) ? page.segments.length * 4 : entry.size;
}

function inlineOut(page: Prepared, entry: RawEntry): boolean {
  return outLength(page, entry) <= 4;
}

function assembleParts(parts: Part[], source: Uint8Array): Uint8Array {
  const total = parts.reduce(
    (sum, part) => sum + (part.kind === 'slice' ? part.end - part.start : part.bytes.length),
    0,
  );
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    if (part.kind === 'slice') {
      out.set(source.subarray(part.start, part.end), at);
      at += part.end - part.start;
    } else {
      out.set(part.bytes, at);
      at += part.bytes.length;
    }
  }
  return out;
}

function containsMarker(bytes: Uint8Array, text: string): boolean {
  const needle = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) needle[i] = text.charCodeAt(i) & 0xff;
  return indexOfBytes(bytes, needle) >= 0;
}

export async function analyzeTiff(src: Source, opts: StripOptions): Promise<ContainerAnalysis> {
  const fail = (id: string, params?: Record<string, string | number>): ContainerAnalysis =>
    failed([{ id, severity: 'error', params }], src.size);

  if (src.size < 8) return fail('warn.tooSmall');
  if (src.size > MAX_TIFF) return fail('warn.tiff.tooLarge');

  const head = await readAt(src, 0, 16);
  if (head.length < 8) return fail('warn.tooSmall');
  const little = startsWithBytes(head, 0, 'II');
  if (!little && !startsWithBytes(head, 0, 'MM')) return fail('warn.tiff.notTiff');

  const magic = little ? u16le(head, 2) : u16be(head, 2);
  if (magic === 43) return fail('warn.tiff.bigTiff');
  if (magic !== 42) return fail('warn.tiff.notTiff');
  // Canon raw files wear a TIFF header and only differ at offset 8.
  if (startsWithBytes(head, 8, 'CR')) return fail('warn.tiff.raw', { format: 'CR2' });

  /* ---- walk the directory chain ---------------------------------- */
  const dirs: RawIfd[] = [];
  const seen = new Set<number>();
  let next = little ? u32le(head, 4) : u32be(head, 4);
  while (next !== 0) {
    if (seen.has(next)) return fail('warn.tiff.cycle');
    if (dirs.length >= MAX_PAGES) return fail('warn.tiff.tooManyPages', { count: dirs.length });
    seen.add(next);
    const dir = await readIfd(src, next, little);
    if (!dir) {
      return dirs.length === 0
        ? fail('warn.tiff.noIfd')
        : fail('warn.tiff.chainBroken', { offset: next });
    }
    dirs.push(dir);
    next = dir.next;
  }
  if (dirs.length === 0) return fail('warn.tiff.noIfd');

  /* ---- classify every directory ---------------------------------- */
  const pages: Prepared[] = [];
  const thumbnails: Thumbnail[] = [];
  let innerCleaned = 0;

  for (const [index, dir] of dirs.entries()) {
    const byTag = new Map<number, RawEntry>();
    for (const entry of dir.entries) if (!byTag.has(entry.tag)) byTag.set(entry.tag, entry);

    if (byTag.has(SUB_IFDS)) return fail('warn.tiff.subIfds');
    if (byTag.has(DNG_VERSION)) return fail('warn.tiff.raw', { format: 'DNG' });

    const compression = firstNumber(byTag.get(COMPRESSION), await maybeRead(src, byTag.get(COMPRESSION)), little);
    // Old-style JPEG keeps the stream behind tag 0x0201 as a whole; that is a
    // different document layout, so it is refused rather than guessed at.
    if (compression === 6) return fail('warn.tiff.jpegOldStyle');

    const photometric = firstNumber(byTag.get(PHOTOMETRIC), await maybeRead(src, byTag.get(PHOTOMETRIC)), little);
    if (photometric === 32803) return fail('warn.tiff.raw', { format: 'CFA' });

    // A reduced-resolution directory is a thumbnail, not a page: it is a copy
    // of a picture we are about to clean, and it stays behind otherwise.
    const subfile = firstNumber(byTag.get(SUBFILE_TYPE), await maybeRead(src, byTag.get(SUBFILE_TYPE)), little);
    const reduced = subfile !== undefined && (subfile & 1) === 1;
    const preview = byTag.get(JPEG_PREVIEW);
    if (index > 0 && (reduced || preview !== undefined)) {
      const count = firstNumber(byTag.get(JPEG_PREVIEW_LENGTH), await maybeRead(src, byTag.get(JPEG_PREVIEW_LENGTH)), little);
      thumbnails.push({
        dir,
        index,
        bytes: dir.bytes,
        preview:
          preview && count && preview.valueOffset + count <= src.size
            ? { start: preview.valueOffset, count }
            : undefined,
      });
      continue;
    }

    // Both tables at once is ambiguous: we could only relocate one of them.
    if (byTag.has(TILE_OFFSETS) && byTag.has(STRIP_OFFSETS)) return fail('warn.tiff.stripTable');
    const tiled = byTag.has(TILE_OFFSETS) || byTag.has(TILE_COUNTS);
    const offsetsTag = tiled ? TILE_OFFSETS : STRIP_OFFSETS;
    const countsTag = tiled ? TILE_COUNTS : STRIP_COUNTS;
    const offsetsEntry = byTag.get(offsetsTag);
    const countsEntry = byTag.get(countsTag);
    if (!offsetsEntry || !countsEntry) return fail('warn.tiff.noData');

    const offsetsBytes = await readValue(src, offsetsEntry, 32 << 20);
    const countsBytes = await readValue(src, countsEntry, 32 << 20);
    if (!offsetsBytes || !countsBytes) return fail('warn.tiff.truncated');

    const offsets = numbersOf(offsetsEntry, offsetsBytes, little);
    const counts = numbersOf(countsEntry, countsBytes, little);
    if (offsets.length === 0 || offsets.length !== counts.length) return fail('warn.tiff.stripTable');

    const segments: Segment[] = [];
    for (let i = 0; i < offsets.length; i += 1) {
      const start = offsets[i] ?? 0;
      const count = counts[i] ?? 0;
      if (count === 0xffffffff || start + count > src.size) return fail('warn.tiff.stripTable');
      segments.push({ start, count, output: { kind: 'slice', start, end: start + count }, at: 0 });
    }

    if (compression === 7) {
      // New-style JPEG: each strip is its own stream. Clean it with the JPEG
      // engine so no inner APPn survives, and only keep the bytes when the
      // stream actually changed.
      const tables = byTag.get(JPEG_TABLES);
      if (tables) {
        const bytes = await readValue(src, tables, 1 << 20);
        if (bytes && (containsMarker(bytes, 'Exif\u0000\u0000') || containsMarker(bytes, 'x:xmpmeta'))) {
          return fail('warn.tiff.jpegTables');
        }
      }
      for (const segment of segments) {
        if (segment.count === 0) continue;
        if (segment.count > MAX_INNER_JPEG) return fail('warn.tiff.jpegInner', { index: index + 1 });
        const bytes = await readAt(src, segment.start, segment.count);
        if (bytes.length !== segment.count) return fail('warn.tiff.truncated');
        const inner = await analyzeJpeg(sourceFromBytes(bytes), opts);
        if (!inner.ok) return fail('warn.tiff.jpegInner', { index: index + 1 });
        if (inner.droppedBytes > 0) {
          segment.output = { kind: 'bytes', bytes: assembleParts(inner.parts, bytes) };
          innerCleaned += 1;
        }
      }
    }

    const kept: RawEntry[] = [];
    const dropped: RawEntry[] = [];
    for (const entry of [...dir.entries].sort((a, b) => a.tag - b.tag)) {
      if (byTag.get(entry.tag) !== entry) continue; // duplicate tag: first one wins
      const keep = KEEP_TAGS.has(entry.tag) && !(entry.tag === ICC_TAG && !opts.keepIcc);
      if (!keep) {
        dropped.push(entry);
        continue;
      }
      if ((TIFF_TYPE_SIZE[entry.type] ?? 0) === 0) {
        return fail('warn.tiff.badType', { tag: entry.tag.toString(16) });
      }
      if (entry.size > 4 && entry.valueOffset + entry.size > src.size) {
        return fail('warn.tiff.valueRange', { tag: entry.tag.toString(16) });
      }
      kept.push(entry);
    }
    if (kept.length === 0) return fail('warn.tiff.noEntries');

    pages.push({ dir, index, kept, dropped, offsetsTag, countsTag, segments, dirOffset: 0 });
  }
  if (pages.length === 0) return fail('warn.tiff.noImagePage');

  /* ---- layout: header, then each page's directory, values and data -- */
  const layouts: PageLayout[] = [];
  let cursor = 8;
  for (const page of pages) {
    const layout: PageLayout = { dirOffset: cursor, valueAt: new Map(), pads: new Map(), dataPad: 0 };
    layouts.push(layout);
    page.dirOffset = cursor;
    cursor += 2 + page.kept.length * 12 + 4;
    for (const entry of page.kept) {
      if (inlineOut(page, entry)) continue;
      const pad = cursor % 2;
      cursor += pad;
      layout.pads.set(entry.tag, pad);
      layout.valueAt.set(entry.tag, cursor);
      cursor += outLength(page, entry);
    }
    layout.dataPad = cursor % 2;
    cursor += layout.dataPad;
    for (const segment of page.segments) {
      segment.at = cursor;
      cursor += segment.output.kind === 'slice' ? segment.output.end - segment.output.start : segment.output.bytes.length;
    }
  }
  const totalSize = cursor;
  if (totalSize > MAX_TIFF) return fail('warn.tiff.tooLarge');

  /* ---- emit ------------------------------------------------------ */
  const parts: Part[] = [];
  const zero = new Uint8Array(1);
  for (const [pageIndex, page] of pages.entries()) {
    const layout = layouts[pageIndex]!;
    const dirBytes = 2 + page.kept.length * 12 + 4;
    const ifd = new Uint8Array(dirBytes);
    const nextPage = pages[pageIndex + 1];
    putU16(ifd, 0, page.kept.length, little);

    const offsetTable = new Uint8Array(page.segments.length * 4);
    page.segments.forEach((segment, at) => putU32(offsetTable, at * 4, segment.at, little));
    const countTable = new Uint8Array(page.segments.length * 4);
    page.segments.forEach((segment, at) => {
      const length = segment.output.kind === 'slice'
        ? segment.output.end - segment.output.start
        : segment.output.bytes.length;
      putU32(countTable, at * 4, length, little);
    });

    page.kept.forEach((entry, index) => {
      const at = 2 + index * 12;
      putU16(ifd, at, entry.tag, little);
      putU16(ifd, at + 2, isComputed(page, entry) ? 4 : entry.type, little);
      putU32(ifd, at + 4, isComputed(page, entry) ? page.segments.length : entry.count, little);
      if (inlineOut(page, entry)) {
        const body = entry.tag === page.offsetsTag
          ? offsetTable
          : entry.tag === page.countsTag
            ? countTable
            : entry.field.subarray(0, 4);
        ifd.set(body.subarray(0, 4), at + 8);
      } else {
        putU32(ifd, at + 8, layout.valueAt.get(entry.tag) ?? 0, little);
      }
    });
    putU32(ifd, 2 + page.kept.length * 12, nextPage ? nextPage.dirOffset : 0, little);

    if (pageIndex === 0) {
      const withHeader = new Uint8Array(8 + dirBytes);
      withHeader[0] = little ? 0x49 : 0x4d;
      withHeader[1] = little ? 0x49 : 0x4d;
      putU16(withHeader, 2, 42, little);
      putU32(withHeader, 4, 8, little);
      withHeader.set(ifd, 8);
      parts.push({ kind: 'bytes', bytes: withHeader });
    } else {
      parts.push({ kind: 'bytes', bytes: ifd });
    }

    for (const entry of page.kept) {
      if (inlineOut(page, entry)) continue;
      for (let i = 0; i < (layout.pads.get(entry.tag) ?? 0); i += 1) parts.push({ kind: 'bytes', bytes: zero });
      if (entry.tag === page.offsetsTag) parts.push({ kind: 'bytes', bytes: offsetTable });
      else if (entry.tag === page.countsTag) parts.push({ kind: 'bytes', bytes: countTable });
      else parts.push({ kind: 'slice', start: entry.valueOffset, end: entry.valueOffset + entry.size });
    }

    for (let i = 0; i < layout.dataPad; i += 1) parts.push({ kind: 'bytes', bytes: zero });
    for (const segment of page.segments) {
      if (segment.output.kind === 'bytes') {
        parts.push({ kind: 'bytes', bytes: segment.output.bytes });
      } else if (segment.output.end > segment.output.start) {
        parts.push({ kind: 'slice', start: segment.output.start, end: segment.output.end });
      }
    }
  }

  /* ---- findings --------------------------------------------------- */
  const findings: Finding[] = [];
  const blocks: BlockInfo[] = [
    { name: 'TIFF header', bytes: 8, kept: true },
  ];

  const iptcSeen = new Set<string>();
  const addIptc = (summary: IptcSummary | null): void => {
    if (!summary) return;
    const signature = summary.datasets.map((dataset) => `${dataset.key}=${dataset.value}`).join('\u0000');
    if (signature.length > 0) {
      if (iptcSeen.has(signature)) return;
      iptcSeen.add(signature);
    }
    findings.push(...buildIptcFindings(summary));
  };

  const descriptive: Field[] = [];
  const descriptiveSeen = new Set<string>();
  let descriptiveBytes = 0;
  const exifFields: Field[] = [];
  const exifSeen = new Set<string>();
  let exifCount = 0;
  let exifBytes = 0;
  let gps: { fields: Field[]; params: Record<string, string | number>; bytes: number } | undefined;
  let unknownTags = 0;
  let unknownBytes = 0;
  let geoCount = 0;
  let geoBytes = 0;
  let dataBytes = 0;

  for (const page of pages) {
    blocks.push({
      name: `IFD${page.index} (${page.dir.entries.length} tags)`,
      bytes: page.dir.bytes,
      kept: true,
      note: `${page.kept.length} kept`,
    });
    for (const segment of page.segments) {
      dataBytes += segment.output.kind === 'slice'
        ? segment.output.end - segment.output.start
        : segment.output.bytes.length;
    }
  }

  for (const page of pages) {
    for (const entry of page.dropped) {
      if (DESCRIPTIVE_TAGS.has(entry.tag) || TIME_EXTRAS.has(entry.tag) || entry.tag === USER_COMMENT) {
        descriptiveBytes += entry.size;
        const bytes = await readValue(src, entry, 64 * 1024);
        if (!bytes) continue;
        const field = describeEntry(entry, bytes, little, 'tiff');
        if (!field) continue;
        const key = `${field.label}\u0000${field.value}`;
        if (descriptiveSeen.has(key)) continue;
        descriptiveSeen.add(key);
        descriptive.push(field);
        continue;
      }
      if (GEO_TAGS.has(entry.tag)) {
        geoCount += 1;
        geoBytes += entry.size;
        continue;
      }
      if (entry.tag === XMP_TAG) {
        blocks.push({ name: 'XMP', bytes: entry.size, kept: false });
        const bytes = await readValue(src, entry);
        if (bytes) findings.push(...buildXmpFindings(parseXmp(bytes)));
        continue;
      }
      if (entry.tag === IPTC_TAG) {
        blocks.push({ name: 'IPTC', bytes: entry.size, kept: false });
        const bytes = await readValue(src, entry);
        if (bytes) addIptc(summarizeIim(bytes));
        continue;
      }
      if (entry.tag === PHOTOSHOP_TAG) {
        blocks.push({ name: 'Photoshop IRB', bytes: entry.size, kept: false });
        const bytes = await readValue(src, entry);
        addIptc(bytes ? parsePhotoshopResources(bytes) : null);
        continue;
      }
      if (entry.tag === MAKER_NOTE) {
        descriptiveBytes += entry.size;
        descriptive.push({
          label: tagName('exif', MAKER_NOTE),
          value: `(${entry.size} bytes, vendor private)`,
          group: 'device',
          sensitive: true,
        });
        continue;
      }
      if (entry.tag === EXIF_POINTER || entry.tag === GPS_POINTER || entry.tag === INTEROP_POINTER) continue;
      if (entry.tag === JPEG_PREVIEW || entry.tag === JPEG_PREVIEW_LENGTH || entry.tag === JPEG_TABLES) continue;
      unknownTags += 1;
      unknownBytes += entry.size;
    }

    const byTag = new Map<number, RawEntry>();
    for (const entry of page.dir.entries) if (!byTag.has(entry.tag)) byTag.set(entry.tag, entry);

    const exifPointer = byTag.get(EXIF_POINTER);
    const exifOffset = firstNumber(exifPointer, await maybeRead(src, exifPointer), little);
    if (exifOffset) {
      const exifIfd = await readIfd(src, exifOffset, little);
      if (exifIfd) {
        const loaded = await ifdFields(src, exifIfd, little, 'exif');
        for (const field of loaded.fields) {
          const key = `${field.label}\u0000${field.value}`;
          if (exifSeen.has(key)) continue;
          exifSeen.add(key);
          exifFields.push(field);
        }
        exifCount += exifIfd.entries.length;
        exifBytes += loaded.weight;
        blocks.push({ name: `Exif IFD (IFD${page.index})`, bytes: loaded.weight, kept: false });
        const makerNote = exifIfd.entries.find((entry) => entry.tag === MAKER_NOTE);
        if (makerNote) blocks.push({ name: 'MakerNote', bytes: makerNote.size, kept: false });
      } else {
        findings.push({ id: 'finding.exif.unparsed', category: 'exif', severity: 'medium', bytes: exifPointer?.size ?? 0 });
      }
    }

    if (!gps) {
      const gpsPointer = byTag.get(GPS_POINTER);
      const gpsOffset = firstNumber(gpsPointer, await maybeRead(src, gpsPointer), little);
      if (gpsOffset) {
        const gpsIfd = await readIfd(src, gpsOffset, little);
        if (gpsIfd) {
          const tags: TiffTag[] = [];
          let weight = gpsIfd.bytes;
          for (const entry of gpsIfd.entries) {
            weight += entry.size;
            const bytes = await readValue(src, entry, 64 * 1024);
            if (bytes) tags.push(toTag(entry, bytes, little));
          }
          const ifd: TiffIfd = { kind: 'gps', offset: gpsOffset, tags, next: 0 };
          const info = describeGps(ifd);
          gps = {
            fields: info?.fields ?? [],
            params: info
              ? { lat: info.latText, lon: info.lonText, mapUrl: info.mapUrl }
              : { entries: gpsIfd.entries.length },
            bytes: weight,
          };
          blocks.push({ name: 'GPS IFD', bytes: weight, kept: false });
        }
      }
    }
  }

  if (descriptive.length > 0 || descriptiveBytes > 0) {
    const params: Record<string, string | number> = { count: descriptive.length };
    const make = descriptive.find((field) => field.label === 'Make')?.value;
    const model = descriptive.find((field) => field.label === 'Model')?.value;
    if (make) params['make'] = make;
    if (model) params['model'] = model;
    findings.push({
      id: 'finding.tiff.tags',
      category: 'exif',
      severity: 'medium',
      bytes: descriptiveBytes,
      params,
      fields: descriptive,
    });
  }

  if (exifCount > 0) {
    const params: Record<string, string | number> = { count: exifCount };
    const make = exifFields.find((field) => field.label === 'Make')?.value;
    const model = exifFields.find((field) => field.label === 'Model')?.value;
    if (make) params['make'] = make;
    if (model) params['model'] = model;
    findings.push({
      id: 'finding.exif',
      category: 'exif',
      severity: 'medium',
      bytes: exifBytes,
      params,
      fields: exifFields,
    });
  }

  if (gps) {
    findings.push({
      id: 'finding.gps',
      category: 'gps',
      severity: 'high',
      bytes: gps.bytes,
      params: gps.params,
      fields: gps.fields,
    });
  }

  if (geoCount > 0) {
    findings.push({
      id: 'finding.tiff.geo',
      category: 'gps',
      severity: 'high',
      bytes: geoBytes,
      params: { count: geoCount },
    });
    blocks.push({ name: 'GeoTIFF tags', bytes: geoBytes, kept: false });
  }

  if (unknownTags > 0) {
    findings.push({
      id: 'finding.tiff.unknown',
      category: 'unknown',
      severity: 'low',
      bytes: unknownBytes,
      params: { count: unknownTags },
    });
    blocks.push({ name: 'Unknown tags', bytes: unknownBytes, kept: false });
  }

  if (innerCleaned > 0) {
    findings.push({
      id: 'finding.tiff.jpegInner',
      category: 'exif',
      severity: 'medium',
      params: { count: innerCleaned },
    });
  }

  for (const thumbnail of thumbnails) {
    let preview: { blob: Blob; mime: string } | undefined;
    if (thumbnail.preview) {
      const bytes = await readAt(src, thumbnail.preview.start, thumbnail.preview.count);
      if (bytes.length > 0) preview = { blob: new Blob([bytes.slice()], { type: 'image/jpeg' }), mime: 'image/jpeg' };
    }
    findings.push({
      id: 'finding.exif.thumbnail',
      category: 'thumbnail',
      severity: 'high',
      bytes: thumbnail.bytes + (thumbnail.preview?.count ?? 0),
      preview,
    });
    blocks.push({ name: `IFD${thumbnail.index} thumbnail`, bytes: thumbnail.bytes, kept: false });
  }

  const iccPage = pages.find((page) => page.kept.some((entry) => entry.tag === ICC_TAG));
  const iccEntry = iccPage?.kept.find((entry) => entry.tag === ICC_TAG);
  if (iccEntry) blocks.push({ name: 'ICC profile', bytes: iccEntry.size, kept: opts.keepIcc });

  const unit = pages.some((page) => page.offsetsTag === TILE_OFFSETS) ? 'tile' : 'strip';
  const segmentCount = pages.reduce((sum, page) => sum + page.segments.length, 0);
  blocks.push({
    name: `Image data (${segmentCount} ${unit}${segmentCount === 1 ? '' : 's'}${pages.length > 1 ? `, ${pages.length} pages` : ''})`,
    bytes: dataBytes,
    kept: true,
  });

  const droppedBytes = Math.max(0, src.size - totalSize);
  return {
    format: 'tiff',
    mime: 'image/tiff',
    ext: 'tif',
    parts,
    findings,
    warnings: [],
    orientation: 1,
    blocks,
    droppedBytes,
    keptBytes: totalSize,
    ok: true,
  };
}

async function maybeRead(src: Source, entry: RawEntry | undefined): Promise<Uint8Array | null> {
  return entry ? readValue(src, entry, 64 * 1024) : null;
}
