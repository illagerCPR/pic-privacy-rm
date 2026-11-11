import { describe, expect, it } from 'vitest';

import { inspectBlob } from '../src/core/inspect.ts';
import { scanSource, stripSource, verifyBlob } from '../src/core/pipeline.ts';
import { sourceFromBytes } from '../src/core/source.ts';
import { DEFAULT_STRIP_OPTIONS } from '../src/core/types.ts';

/* ------------------------------------------------------------------ *
 * A minimal TIFF writer, so every layout below is explicit.
 * ------------------------------------------------------------------ */

const TYPE_SIZE: Record<number, number> = {
  1: 1,
  2: 1,
  3: 2,
  4: 4,
  5: 8,
  6: 1,
  7: 1,
  8: 2,
  9: 4,
  10: 8,
  11: 4,
  12: 8,
  13: 4,
};

interface Entry {
  tag: number;
  type: number;
  data: Uint8Array;
}

function num(value: number, size: number, little: boolean): Uint8Array {
  const out = new Uint8Array(size);
  for (let i = 0; i < size; i += 1) {
    const shift = little ? i * 8 : (size - 1 - i) * 8;
    out[i] = (value >>> shift) & 0xff;
  }
  return out;
}

const u16 = (value: number, little: boolean): Uint8Array => num(value, 2, little);
const u32 = (value: number, little: boolean): Uint8Array => num(value, 4, little);

function numbers(values: readonly number[], size: 2 | 4, little: boolean): Uint8Array {
  const out = new Uint8Array(values.length * size);
  values.forEach((value, index) => out.set(num(value, size, little), index * size));
  return out;
}

function ascii(text: string): Uint8Array {
  const out = new Uint8Array(text.length + 1);
  for (let i = 0; i < text.length; i += 1) out[i] = text.charCodeAt(i) & 0x7f;
  return out;
}

interface PageSpec {
  /** Page entries; the data offset and byte count entries are added here. */
  entries: Entry[];
  extras?: { pointerTag: number; entries: Entry[] }[];
  strips: Uint8Array[];
  offsetTag?: number;
  countsTag?: number;
  /** Emit the two data-pointer entries at all. */
  withData?: boolean;
  /** Set NewSubfileType, so the page reads as a reduced-resolution copy. */
  subfileType?: number;
  /** Override the recorded data offsets, to build a broken table. */
  offsetOverride?: number[];
}

interface BuildSpec extends Omit<PageSpec, 'entries'> {
  /** The first page; `entries` is the modern name, `ifd0` the original one. */
  entries?: Entry[];
  ifd0?: Entry[];
  little?: boolean;
  magic?: number;
  /** Force the "next IFD" pointer of the last page. */
  nextIfd?: number;
  /** Additional pages, chained after the first one. */
  pages?: PageSpec[];
}

function align2(value: number): number {
  return value + (value % 2);
}

interface PageState {
  dirOffset: number;
  entries: Entry[];
  extras: { pointerTag: number; entries: Entry[]; offset: number }[];
  stripOffsets: number[];
  dataEntries: { offsets: Entry; counts: Entry } | null;
}

function buildTiff(spec: BuildSpec): Uint8Array {
  const little = spec.little ?? true;
  const pages: PageSpec[] = [
    {
      entries: spec.entries ?? spec.ifd0 ?? [],
      extras: spec.extras,
      strips: spec.strips,
      offsetTag: spec.offsetTag,
      countsTag: spec.countsTag,
      withData: spec.withData,
      subfileType: spec.subfileType,
      offsetOverride: spec.offsetOverride,
    },
    ...(spec.pages ?? []),
  ];

  /* First pass: decide every offset. */
  let cursor = 8;
  const valueAt = new Map<Entry, number>();
  const states: PageState[] = [];

  for (const page of pages) {
    const dataEntries =
      page.withData === false
        ? null
        : {
            offsets: {
              tag: page.offsetTag ?? 0x0111,
              type: 4,
              data: new Uint8Array(page.strips.length * 4),
            },
            counts: {
              tag: page.countsTag ?? 0x0117,
              type: 4,
              data: new Uint8Array(page.strips.length * 4),
            },
          };
    const pointers: Entry[] = (page.extras ?? []).map((extra) => ({
      tag: extra.pointerTag,
      type: 4,
      data: new Uint8Array(4),
    }));
    const subfile: Entry[] =
      page.subfileType === undefined
        ? []
        : [{ tag: 0x00fe, type: 4, data: u32(page.subfileType, little) }];
    const data: Entry[] = dataEntries ? [dataEntries.offsets, dataEntries.counts] : [];

    const entries = [...page.entries, ...subfile, ...pointers, ...data].sort(
      (a, b) => a.tag - b.tag,
    );
    const state: PageState = {
      dirOffset: cursor,
      entries,
      extras: [],
      stripOffsets: [],
      dataEntries,
    };
    states.push(state);

    cursor += 2 + entries.length * 12 + 4;
    for (const entry of entries) {
      if (entry.data.length <= 4) continue;
      cursor = align2(cursor);
      valueAt.set(entry, cursor);
      cursor += entry.data.length;
    }
    for (const extra of page.extras ?? []) {
      const sorted = [...extra.entries].sort((a, b) => a.tag - b.tag);
      cursor = align2(cursor);
      state.extras.push({ pointerTag: extra.pointerTag, entries: sorted, offset: cursor });
      cursor += 2 + sorted.length * 12 + 4;
      for (const entry of sorted) {
        if (entry.data.length <= 4) continue;
        cursor = align2(cursor);
        valueAt.set(entry, cursor);
        cursor += entry.data.length;
      }
    }
    for (const strip of page.strips) {
      cursor = align2(cursor);
      state.stripOffsets.push(cursor);
      cursor += strip.length;
    }
  }

  /* Second pass: resolve the values that depend on the layout. */
  pages.forEach((page, index) => {
    const state = states[index]!;
    if (state.dataEntries) {
      state.dataEntries.offsets.data = numbers(
        page.offsetOverride ?? state.stripOffsets,
        4,
        little,
      );
      state.dataEntries.counts.data = numbers(
        page.strips.map((strip) => strip.length),
        4,
        little,
      );
    }
    for (const extra of state.extras) {
      const pointer = state.entries.find((entry) => entry.tag === extra.pointerTag);
      if (pointer) pointer.data = u32(extra.offset, little);
    }
  });

  /* Third pass: write. */
  const bytes = new Uint8Array(cursor);
  const write = (at: number, data: Uint8Array): void => void bytes.set(data, at);
  const u16At = (at: number, value: number): void => void bytes.set(u16(value, little), at);
  const u32At = (at: number, value: number): void => void bytes.set(u32(value, little), at);

  bytes[0] = little ? 0x49 : 0x4d;
  bytes[1] = little ? 0x49 : 0x4d;
  write(2, u16(spec.magic ?? 42, little));
  write(4, u32(8, little));

  const writeIfd = (offset: number, entries: Entry[], next: number): void => {
    u16At(offset, entries.length);
    entries.forEach((entry, index) => {
      const at = offset + 2 + index * 12;
      u16At(at, entry.tag);
      u16At(at + 2, entry.type);
      u32At(at + 4, entry.data.length / (TYPE_SIZE[entry.type] ?? 1));
      if (entry.data.length <= 4) write(at + 8, entry.data);
      else u32At(at + 8, valueAt.get(entry) ?? 0);
    });
    u32At(offset + 2 + entries.length * 12, next);
  };

  states.forEach((state, index) => {
    const next = index + 1 < states.length ? states[index + 1]!.dirOffset : (spec.nextIfd ?? 0);
    writeIfd(state.dirOffset, state.entries, next);
    for (const entry of state.entries)
      if (entry.data.length > 4) write(valueAt.get(entry) ?? 0, entry.data);
    for (const extra of state.extras) writeIfd(extra.offset, extra.entries, 0);
    for (const extra of state.extras) {
      for (const entry of extra.entries)
        if (entry.data.length > 4) write(valueAt.get(entry) ?? 0, entry.data);
    }
    pages[index]!.strips.forEach((strip, at) => write(state.stripOffsets[at] ?? 0, strip));
  });

  return bytes;
}

/* ------------------------------------------------------------------ *
 * An independent reader, so assertions do not just re-run the parser
 * under test.
 * ------------------------------------------------------------------ */

interface ReadBack {
  little: boolean;
  dirs: Map<number, { type: number; count: number; data: Uint8Array }>;
  next: number;
}

function readTiff(bytes: Uint8Array, ifdOffset = 8): ReadBack {
  const little = bytes[0] === 0x49;
  const rd16 = (at: number): number =>
    little ? bytes[at]! | (bytes[at + 1]! << 8) : (bytes[at]! << 8) | bytes[at + 1]!;
  const rd32 = (at: number): number => {
    const b = [bytes[at]!, bytes[at + 1]!, bytes[at + 2]!, bytes[at + 3]!];
    return (
      (little
        ? b[0]! | (b[1]! << 8) | (b[2]! << 16) | (b[3]! << 24)
        : (b[0]! << 24) | (b[1]! << 16) | (b[2]! << 8) | b[3]!) >>> 0
    );
  };
  const count = rd16(ifdOffset);
  const dirs = new Map<number, { type: number; count: number; data: Uint8Array }>();
  for (let i = 0; i < count; i += 1) {
    const at = ifdOffset + 2 + i * 12;
    const tag = rd16(at);
    const type = rd16(at + 2);
    const items = rd32(at + 4);
    const size = (TYPE_SIZE[type] ?? 1) * items;
    const data =
      size <= 4
        ? bytes.slice(at + 8, at + 8 + size)
        : (() => {
            const offset = rd32(at + 8);
            return bytes.slice(offset, offset + size);
          })();
    dirs.set(tag, { type, count: items, data });
  }
  return { little, dirs, next: rd32(ifdOffset + 2 + count * 12) };
}

/** Pull the image payload out of a stripped file, using only raw byte maths. */
function payload(
  bytes: Uint8Array,
  offsetTag = 0x0111,
  countsTag = 0x0117,
  ifdOffset = 8,
): Uint8Array[] {
  const ifd = readTiff(bytes, ifdOffset);
  const reader = (data: Uint8Array, index: number): number => {
    const at = index * 4;
    const b = [data[at]!, data[at + 1]!, data[at + 2]!, data[at + 3]!];
    return (
      (ifd.little
        ? b[0]! | (b[1]! << 8) | (b[2]! << 16) | (b[3]! << 24)
        : (b[0]! << 24) | (b[1]! << 16) | (b[2]! << 8) | b[3]!) >>> 0
    );
  };
  const offsets = ifd.dirs.get(offsetTag)!;
  const counts = ifd.dirs.get(countsTag)!;
  const out: Uint8Array[] = [];
  for (let i = 0; i < offsets.count; i += 1) {
    const start = reader(offsets.data, i);
    out.push(bytes.slice(start, start + reader(counts.data, i)));
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * A hand-built JPEG, for the new-style JPEG (compression 7) path.
 * ------------------------------------------------------------------ */

function jpegSegment(marker: number, body: readonly number[]): number[] {
  const length = body.length + 2;
  return [0xff, marker, (length >> 8) & 0xff, length & 0xff, ...body];
}

/** Minimal but structurally valid JPEG; `withExif` adds an APP1 Exif segment. */
function tinyJpeg(withExif: boolean): Uint8Array {
  const out: number[] = [0xff, 0xd8];
  if (withExif) {
    const tiff = [
      0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    ];
    out.push(
      ...jpegSegment(0xe1, [...'Exif\u0000\u0000'].map((char) => char.charCodeAt(0)).concat(tiff)),
    );
  }
  out.push(...jpegSegment(0xc0, [8, 0, 2, 0, 2, 1, 1, 0x11, 0])); // SOF0, 2x2, 1 component
  out.push(...jpegSegment(0xda, [1, 1, 0x00, 0, 63, 0])); // SOS
  out.push(0x12, 0x34, 0xff, 0xd9); // scan data + EOI
  return new Uint8Array(out);
}

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

const WHITE_STRIP = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
const GREY_STRIP = new Uint8Array([11, 12, 13, 14, 15, 16, 17, 18]);

function baseEntries(little: boolean): Entry[] {
  return [
    { tag: 0x0100, type: 4, data: u32(4, little) }, // ImageWidth
    { tag: 0x0101, type: 4, data: u32(2, little) }, // ImageLength
    { tag: 0x0102, type: 3, data: u16(8, little) }, // BitsPerSample
    { tag: 0x0103, type: 3, data: u16(1, little) }, // Compression = none
    { tag: 0x0106, type: 3, data: u16(1, little) }, // Photometric = black is zero
    { tag: 0x0112, type: 3, data: u16(1, little) }, // Orientation
    { tag: 0x0115, type: 3, data: u16(1, little) }, // SamplesPerPixel
    { tag: 0x0116, type: 3, data: u16(2, little) }, // RowsPerStrip
    { tag: 0x011a, type: 5, data: numbers([72, 1], 4, little) }, // XResolution
    { tag: 0x011b, type: 5, data: numbers([72, 1], 4, little) }, // YResolution
    { tag: 0x0128, type: 3, data: u16(2, little) }, // ResolutionUnit
  ];
}

function metaEntries(): Entry[] {
  return [
    { tag: 0x010d, type: 2, data: ascii('scan-0001.tif') },
    { tag: 0x010e, type: 2, data: ascii('Roof terrace at dusk') },
    { tag: 0x010f, type: 2, data: ascii('NIKON') },
    { tag: 0x0110, type: 2, data: ascii('Z 6_2') },
    { tag: 0x0131, type: 2, data: ascii('PhotoMechanic 6') },
    { tag: 0x0132, type: 2, data: ascii('2024:05:06 19:24:10') },
    { tag: 0x013b, type: 2, data: ascii('Alice Example') },
    { tag: 0x8298, type: 2, data: ascii('(c) Alice 2024') },
  ];
}

function exifEntries(little: boolean): Entry[] {
  return [
    { tag: 0x829a, type: 5, data: numbers([1, 250], 4, little) }, // ExposureTime
    { tag: 0x9003, type: 2, data: ascii('2024:05:06 19:24:10') },
    { tag: 0xa431, type: 2, data: ascii('6001234') }, // BodySerialNumber
    { tag: 0x927c, type: 7, data: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) },
  ];
}

function gpsEntries(little: boolean): Entry[] {
  return [
    { tag: 0x0000, type: 1, data: new Uint8Array([2, 3, 0, 0]) }, // GPSVersionID
    { tag: 0x0001, type: 2, data: ascii('N') }, // GPSLatitudeRef
    { tag: 0x0002, type: 5, data: numbers([41, 1, 51, 1, 2, 1], 4, little) }, // GPSLatitude
    { tag: 0x0003, type: 2, data: ascii('E') },
    { tag: 0x0004, type: 5, data: numbers([3, 1, 7, 1, 30, 1], 4, little) },
  ];
}

function metaTiff(little = true, extra: Entry[] = []): Uint8Array {
  return buildTiff({
    little,
    ifd0: [...baseEntries(little), ...metaEntries(), ...extra],
    extras: [
      { pointerTag: 0x8769, entries: exifEntries(little) },
      { pointerTag: 0x8825, entries: gpsEntries(little) },
    ],
    strips: [WHITE_STRIP, GREY_STRIP],
  });
}

/* ------------------------------------------------------------------ *
 * Scanning
 * ------------------------------------------------------------------ */

describe('TIFF scanning', () => {
  it('reports nothing for a file that only carries structural tags', async () => {
    const bytes = buildTiff({ ifd0: baseEntries(true), strips: [WHITE_STRIP] });
    const scan = await scanSource(sourceFromBytes(bytes));
    expect(scan.format).toBe('tiff');
    expect(scan.supported).toBe(true);
    expect(scan.findings).toEqual([]);
    expect(scan.warnings).toEqual([]);
    expect(scan.orientation).toBe(1);
  });

  it('finds descriptive tags, the Exif directory and GPS', async () => {
    const scan = await scanSource(sourceFromBytes(metaTiff()));
    const ids = scan.findings.map((finding) => finding.id);
    expect(ids).toContain('finding.tiff.tags');
    expect(ids).toContain('finding.exif');
    expect(ids).toContain('finding.gps');

    const gps = scan.findings.find((finding) => finding.id === 'finding.gps')!;
    expect(String(gps.params?.['lat'])).toContain('41.85');
    expect(String(gps.params?.['lon'])).toContain('3.125');

    const tags = scan.findings.find((finding) => finding.id === 'finding.tiff.tags')!;
    expect(tags.fields?.some((field) => field.label === 'Artist')).toBe(true);
    expect(tags.params?.['make']).toBe('NIKON');
  });

  it('never lists the structural tags it keeps', async () => {
    const scan = await scanSource(sourceFromBytes(metaTiff()));
    const shown = scan.findings.flatMap((finding) => finding.fields ?? []);
    expect(shown.some((field) => field.label === 'ImageWidth')).toBe(false);
    expect(shown.some((field) => field.label === 'StripOffsets')).toBe(false);
    expect(shown.some((field) => field.label === 'Orientation')).toBe(false);
  });

  it('reports unknown tags instead of silently keeping them', async () => {
    const bytes = buildTiff({
      ifd0: [...baseEntries(true), { tag: 0xc7a1, type: 7, data: new Uint8Array([1, 2, 3, 4, 5]) }],
      strips: [WHITE_STRIP],
    });
    const scan = await scanSource(sourceFromBytes(bytes));
    expect(scan.findings.map((finding) => finding.id)).toContain('finding.tiff.unknown');
  });
});

/* ------------------------------------------------------------------ *
 * Stripping
 * ------------------------------------------------------------------ */

describe('TIFF stripping', () => {
  it('keeps the pixel payload byte for byte and drops the rest', async () => {
    const source = metaTiff();
    const result = await stripSource(sourceFromBytes(source));
    const output = new Uint8Array(await result.blob.arrayBuffer());

    expect(payload(output)).toEqual(payload(source));
    expect(output.length).toBeLessThan(source.length);

    const ifd = readTiff(output);
    expect(ifd.next).toBe(0);
    expect(ifd.dirs.has(0x010f)).toBe(false);
    expect(ifd.dirs.has(0x013b)).toBe(false);
    expect(ifd.dirs.has(0x8298)).toBe(false);
    expect(ifd.dirs.has(0x8769)).toBe(false);
    expect(ifd.dirs.has(0x8825)).toBe(false);
    expect(ifd.dirs.has(0x0100)).toBe(true);
    expect(ifd.dirs.has(0x0112)).toBe(true);
  });

  it('leaves a file that verifies clean', async () => {
    const result = await stripSource(sourceFromBytes(metaTiff()));
    const verify = await verifyBlob(result.blob, 'tiff');
    expect(verify.ok).toBe(true);
    expect(verify.leftovers).toEqual([]);
  });

  it('is idempotent: a second pass finds nothing to remove', async () => {
    const first = await stripSource(sourceFromBytes(metaTiff()));
    const output = new Uint8Array(await first.blob.arrayBuffer());
    const scan = await scanSource(sourceFromBytes(output));
    expect(scan.findings).toEqual([]);
  });

  it('rewrites a big endian file in its own byte order', async () => {
    const source = metaTiff(false);
    const result = await stripSource(sourceFromBytes(source));
    const output = new Uint8Array(await result.blob.arrayBuffer());
    expect(output[0]).toBe(0x4d);
    expect(payload(output)).toEqual(payload(source));
    expect((await scanSource(sourceFromBytes(output))).findings).toEqual([]);
  });

  it('rebuilds tiled files as well as striped ones', async () => {
    const tiles = [new Uint8Array([9, 9, 9, 9]), new Uint8Array([8, 8, 8])];
    const source = buildTiff({
      ifd0: [
        ...baseEntries(true).filter((entry) => entry.tag !== 0x0116),
        { tag: 0x0142, type: 4, data: u32(4, true) }, // TileWidth
        { tag: 0x0143, type: 4, data: u32(4, true) }, // TileLength
        { tag: 0x013b, type: 2, data: ascii('Tiled Author') },
      ],
      strips: tiles,
      offsetTag: 0x0144,
      countsTag: 0x0145,
    });

    const result = await stripSource(sourceFromBytes(source));
    const output = new Uint8Array(await result.blob.arrayBuffer());
    expect(payload(output, 0x0144, 0x0145)).toEqual(tiles);
    expect((await scanSource(sourceFromBytes(output))).findings).toEqual([]);
  });

  it('rebuilds and re-links every page of a multi-page file', async () => {
    const source = buildTiff({
      ifd0: [...baseEntries(true), ...metaEntries()],
      strips: [WHITE_STRIP],
      pages: [
        {
          entries: [...baseEntries(true), ...metaEntries()],
          strips: [GREY_STRIP],
        },
      ],
    });
    const result = await stripSource(sourceFromBytes(source));
    const output = new Uint8Array(await result.blob.arrayBuffer());

    const chain = readTiff(output);
    expect(chain.next).not.toBe(0);
    expect(chain.dirs.has(0x010f)).toBe(false);
    expect(payload(output)).toEqual([WHITE_STRIP]);
    expect(payload(output, 0x0111, 0x0117, chain.next)).toEqual([GREY_STRIP]);

    const second = readTiff(output, chain.next);
    expect(second.next).toBe(0);
    expect(second.dirs.has(0x013b)).toBe(false);
    expect((await verifyBlob(result.blob, 'tiff')).ok).toBe(true);
  });

  it('drops a reduced-resolution directory and reports it as a thumbnail', async () => {
    const source = buildTiff({
      ifd0: [...baseEntries(true), ...metaEntries()],
      strips: [WHITE_STRIP],
      pages: [
        {
          entries: [...baseEntries(true), ...metaEntries()],
          strips: [GREY_STRIP],
          subfileType: 1,
        },
      ],
    });

    const scan = await scanSource(sourceFromBytes(source));
    expect(scan.findings.some((finding) => finding.id === 'finding.exif.thumbnail')).toBe(true);

    const result = await stripSource(sourceFromBytes(source));
    const output = new Uint8Array(await result.blob.arrayBuffer());
    expect(readTiff(output).next).toBe(0);
    expect(payload(output)).toEqual([WHITE_STRIP]);
    expect((await verifyBlob(result.blob, 'tiff')).ok).toBe(true);
  });

  it('cleans metadata inside new-style JPEG strips', async () => {
    const clean = tinyJpeg(false);
    const dirty = tinyJpeg(true);
    expect(Buffer.from(dirty).includes('Exif\u0000\u0000')).toBe(true);

    const entries = (): Entry[] =>
      baseEntries(true).map((entry) =>
        entry.tag === 0x0103 ? { ...entry, data: u16(7, true) } : entry,
      );
    const source = buildTiff({ ifd0: entries(), strips: [dirty, clean] });

    const scan = await scanSource(sourceFromBytes(source));
    expect(scan.findings.some((finding) => finding.id === 'finding.tiff.jpegInner')).toBe(true);

    const result = await stripSource(sourceFromBytes(source));
    const output = new Uint8Array(await result.blob.arrayBuffer());
    const [first, second] = payload(output);
    expect(Buffer.from(first!).includes('Exif\u0000\u0000')).toBe(false);
    expect(first!.length).toBe(dirty.length - 24);
    expect(second).toEqual(clean);
    expect((await verifyBlob(result.blob, 'tiff')).ok).toBe(true);
  });

  it('drops the ICC profile only when asked', async () => {
    const source = buildTiff({
      ifd0: [...baseEntries(true), { tag: 0x8773, type: 7, data: new Uint8Array(64).fill(7) }],
      strips: [WHITE_STRIP],
    });

    const kept = await stripSource(sourceFromBytes(source), DEFAULT_STRIP_OPTIONS);
    expect(readTiff(new Uint8Array(await kept.blob.arrayBuffer())).dirs.has(0x8773)).toBe(true);

    const dropped = await stripSource(sourceFromBytes(source), {
      ...DEFAULT_STRIP_OPTIONS,
      keepIcc: false,
    });
    expect(readTiff(new Uint8Array(await dropped.blob.arrayBuffer())).dirs.has(0x8773)).toBe(false);
  });

  it('survives a strip pass on a file with nothing to remove', async () => {
    const source = buildTiff({ ifd0: baseEntries(true), strips: [WHITE_STRIP] });
    const result = await stripSource(sourceFromBytes(source));
    const output = new Uint8Array(await result.blob.arrayBuffer());
    expect(payload(output)).toEqual([WHITE_STRIP]);
    expect(result.removedBytes).toBe(0);
  });
});

/* ------------------------------------------------------------------ *
 * Metadata listing
 * ------------------------------------------------------------------ */

describe('TIFF metadata listing', () => {
  it('separates the rows that survive from the rows that go', async () => {
    const report = await inspectBlob(sourceFromBytes(metaTiff()).blob, { keepIcc: true });
    expect(report.groups.map((group) => group.id)).toContain('ifd0');
    expect(report.groups.map((group) => group.id)).toContain('gps');

    const ifd0 = report.groups.find((group) => group.id === 'ifd0')!;
    expect(ifd0.removed).toBe(false);
    expect(ifd0.items.find((item) => item.name === 'ImageWidth')?.removed).toBe(false);
    expect(ifd0.items.find((item) => item.name === 'Orientation')?.removed).toBe(false);
    expect(ifd0.items.find((item) => item.name === 'Make')?.removed).toBe(true);
    expect(ifd0.items.find((item) => item.name === 'Artist')?.removed).toBe(true);

    const gps = report.groups.find((group) => group.id === 'gps')!;
    expect(gps.removed).toBe(true);
    expect(gps.items.every((item) => item.removed !== false)).toBe(true);
  });

  it('shows the ICC profile as kept or removed with the setting', async () => {
    const bytes = buildTiff({
      ifd0: [...baseEntries(true), { tag: 0x8773, type: 7, data: new Uint8Array(64).fill(7) }],
      strips: [WHITE_STRIP],
    });
    const kept = await inspectBlob(sourceFromBytes(bytes).blob, { keepIcc: true });
    const icc = kept.groups
      .find((group) => group.id === 'ifd0')!
      .items.find((item) => item.id === '0x8773');
    expect(icc?.removed).toBe(false);
    const dropped = await inspectBlob(sourceFromBytes(bytes).blob, { keepIcc: false });
    const iccDropped = dropped.groups
      .find((group) => group.id === 'ifd0')!
      .items.find((item) => item.id === '0x8773');
    expect(iccDropped?.removed).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * Refusals
 * ------------------------------------------------------------------ */

describe('TIFF refusals', () => {
  async function refusal(bytes: Uint8Array): Promise<string> {
    const scan = await scanSource(sourceFromBytes(bytes));
    const error = scan.warnings.find((warning) => warning.severity === 'error');
    expect(error, 'expected an error-level warning').toBeDefined();
    await expect(stripSource(sourceFromBytes(bytes))).rejects.toMatchObject({ code: 'unreadable' });
    return error!.id;
  }

  it('refuses BigTIFF, but still recognises it as a TIFF', async () => {
    const bytes = buildTiff({ ifd0: baseEntries(true), strips: [WHITE_STRIP], magic: 43 });
    const scan = await scanSource(sourceFromBytes(bytes));
    expect(scan.format).toBe('tiff');
    expect(scan.supported).toBe(true);
    expect(await refusal(bytes)).toBe('warn.tiff.bigTiff');
  });

  it('refuses a directory chain that points past the end of the file', async () => {
    const bytes = buildTiff({
      ifd0: [...baseEntries(true), ...metaEntries()],
      strips: [WHITE_STRIP],
      nextIfd: 4000,
    });
    expect(await refusal(bytes)).toBe('warn.tiff.chainBroken');
  });

  it('refuses a directory chain that loops', async () => {
    const bytes = buildTiff({ ifd0: baseEntries(true), strips: [WHITE_STRIP], nextIfd: 8 });
    expect(await refusal(bytes)).toBe('warn.tiff.cycle');
  });

  it('refuses old-style JPEG, whose stream hides in tag 0x0201', async () => {
    const entries = baseEntries(true).map((entry) =>
      entry.tag === 0x0103 ? { ...entry, data: u16(6, true) } : entry,
    );
    const bytes = buildTiff({ ifd0: entries, strips: [WHITE_STRIP] });
    expect(await refusal(bytes)).toBe('warn.tiff.jpegOldStyle');
  });

  it('refuses SubIFDs', async () => {
    const bytes = buildTiff({
      ifd0: [...baseEntries(true), { tag: 0x014a, type: 4, data: u32(8, true) }],
      strips: [WHITE_STRIP],
    });
    expect(await refusal(bytes)).toBe('warn.tiff.subIfds');
  });

  it('refuses DNG and CR2 raws', async () => {
    const dng = buildTiff({
      ifd0: [...baseEntries(true), { tag: 0xc612, type: 1, data: new Uint8Array([1, 4, 0, 0]) }],
      strips: [WHITE_STRIP],
    });
    expect(await refusal(dng)).toBe('warn.tiff.raw');

    const cr2 = buildTiff({ ifd0: baseEntries(true), strips: [WHITE_STRIP] });
    cr2.set([0x43, 0x52, 0x02, 0x00], 8);
    expect(await refusal(cr2)).toBe('warn.tiff.raw');
  });

  it('refuses CFA photometric data', async () => {
    const entries = baseEntries(true).map((entry) =>
      entry.tag === 0x0106 ? { ...entry, data: u16(32803, true) } : entry,
    );
    const bytes = buildTiff({ ifd0: entries, strips: [WHITE_STRIP] });
    expect(await refusal(bytes)).toBe('warn.tiff.raw');
  });

  it('refuses JPEG-compressed TIFF rather than leaving the inner streams alone', async () => {
    const entries = baseEntries(true).map((entry) =>
      entry.tag === 0x0103 ? { ...entry, data: u16(7, true) } : entry,
    );
    const bytes = buildTiff({ ifd0: entries, strips: [WHITE_STRIP] });
    expect(await refusal(bytes)).toBe('warn.tiff.jpegInner');
  });

  it('refuses a directory with no image data table', async () => {
    const bytes = buildTiff({
      ifd0: [...baseEntries(true), ...metaEntries()],
      strips: [WHITE_STRIP],
      withData: false,
    });
    expect(await refusal(bytes)).toBe('warn.tiff.noData');
  });

  it('refuses a data table whose ranges fall outside the file', async () => {
    const bytes = buildTiff({
      ifd0: baseEntries(true),
      strips: [WHITE_STRIP],
      offsetOverride: [0x7fffffff],
    });
    expect(await refusal(bytes)).toBe('warn.tiff.stripTable');
  });

  it('refuses a file that carries both a strip and a tile table', async () => {
    const entries = [
      ...baseEntries(true),
      { tag: 0x0142, type: 4, data: u32(4, true) },
      { tag: 0x0143, type: 4, data: u32(4, true) },
      { tag: 0x0144, type: 4, data: u32(0, true) },
      { tag: 0x0145, type: 4, data: u32(0, true) },
    ];
    const bytes = buildTiff({ ifd0: entries, strips: [WHITE_STRIP] });
    expect(await refusal(bytes)).toBe('warn.tiff.stripTable');
  });

  it('refuses a file whose image data is cut short', async () => {
    const source = buildTiff({ ifd0: baseEntries(true), strips: [WHITE_STRIP, GREY_STRIP] });
    const bytes = source.slice(0, source.length - 4);
    expect(await refusal(bytes)).toBe('warn.tiff.stripTable');
  });
});
