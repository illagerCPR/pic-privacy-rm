import { describe, expect, it } from 'vitest';

import { readHeifStructure } from '../src/core/heif.ts';
import { inspectSource } from '../src/core/inspect.ts';
import { readBoxes } from '../src/core/isobmff.ts';
import { scanSource, stripSource, verifyBlob } from '../src/core/pipeline.ts';
import { sourceFromBytes } from '../src/core/source.ts';

/* ------------------------------------------------------------------ *
 * Synthetic HEIF builder
 *
 * Real HEIC files cannot be generated here (no encoder, and they would be
 * personal photos anyway), so the container is assembled by hand. The picture
 * payload is arbitrary bytes: these tests exercise the item table, never the
 * codec.
 * ------------------------------------------------------------------ */

const IMAGE_BYTES = new Uint8Array(Array.from({ length: 64 }, (_, i) => i % 251));
const XMP_TEXT =
  '<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:creator>tester</dc:creator></rdf:Description></rdf:RDF></x:xmpmeta>';

function u16(value: number): Uint8Array {
  const out = new Uint8Array(2);
  new DataView(out.buffer).setUint16(0, value);
  return out;
}

function u32(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value);
  return out;
}

function ascii(text: string): Uint8Array {
  return new Uint8Array([...text].map((char) => char.charCodeAt(0) & 0xff));
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function box(type: string, ...parts: Uint8Array[]): Uint8Array {
  const body = concat(parts);
  return concat([u32(body.length + 8), ascii(type), body]);
}

function fullBox(type: string, version: number, flags: number, ...parts: Uint8Array[]): Uint8Array {
  return box(type, new Uint8Array([version, 0, (flags >> 8) & 0xff, flags & 0xff]), ...parts);
}

/** A minimal big-endian TIFF with one ASCII tag (Make = "TestCam"). */
function tiffBlock(): Uint8Array {
  const value = ascii('TestCam\0');
  const ifdOffset = 8;
  const entryCount = 1;
  const valueOffset = ifdOffset + 2 + entryCount * 12 + 4;
  return concat([
    ascii('MM'),
    u16(42),
    u32(ifdOffset),
    u16(entryCount),
    u16(0x010f), // Make
    u16(2), // ASCII
    u32(value.length),
    u32(valueOffset),
    u32(0), // next IFD
    value,
  ]);
}

/** HEIF wraps the TIFF block in `[4-byte offset][TIFF]`. */
function exifItemPayload(): Uint8Array {
  return concat([u32(0), tiffBlock()]);
}

function infe(id: number, type: string, name: string, contentType?: string): Uint8Array {
  const parts = [u16(id), u16(0), ascii(type), ascii(`${name}\0`)];
  if (contentType) parts.push(ascii(`${contentType}\0`));
  return fullBox('infe', 2, 0, ...parts);
}

interface Layout {
  /**
   * Container brand to write. `heic` is the default; `avif` uses the AVIF item
   * type, and `mif1-avif` is an AVIF that only declares itself in the
   * compatibility list.
   */
  brand?: 'heic' | 'avif' | 'mif1-avif';
  ilocVersion?: number;
  baseOffsetSize?: number;
  /** Extra top-level boxes inserted between `ftyp` and `meta`. */
  extraTop?: Uint8Array[];
  /** Item ids that live in `idat` via construction_method 1. */
  idatItems?: Set<number>;
  extraItems?: { info: Uint8Array; id: number; payload: Uint8Array }[];
}

interface Built {
  bytes: Uint8Array;
  imagePayload: Uint8Array;
  exifPayload: Uint8Array;
  xmpPayload: Uint8Array;
}

/**
 * Assemble a HEIF file: ftyp + meta + (idat) + mdat.
 *
 * Items are laid out in `mdat` in declaration order, so the caller can reason
 * about offsets exactly as a real encoder would.
 */
function buildHeif(layout: Layout = {}): Built {
  const image = IMAGE_BYTES;
  const exif = exifItemPayload();
  const xmp = ascii(XMP_TEXT);

  const brand = layout.brand ?? 'heic';
  const isAvif = brand === 'avif' || brand === 'mif1-avif';
  const imageType = isAvif ? 'av01' : 'hvc1';
  const items: { id: number; info: Uint8Array; payload: Uint8Array; inIdat: boolean }[] = [
    {
      id: 1,
      info: infe(1, imageType, ''),
      payload: image,
      inIdat: layout.idatItems?.has(1) ?? false,
    },
    { id: 2, info: infe(2, 'Exif', ''), payload: exif, inIdat: layout.idatItems?.has(2) ?? false },
    {
      id: 3,
      info: infe(3, 'mime', 'xmp', 'application/rdf+xml'),
      payload: xmp,
      inIdat: layout.idatItems?.has(3) ?? false,
    },
    ...(layout.extraItems ?? []).map((extra) => ({
      id: extra.id,
      info: extra.info,
      payload: extra.payload,
      inIdat: false,
    })),
  ];

  const ilocVersion = layout.ilocVersion ?? 1;
  const baseOffsetSize = layout.baseOffsetSize ?? 0;

  const ilocPayload = (
    entries: {
      id: number;
      method: number;
      base: number;
      extents: { offset: number; length: number }[];
    }[],
  ): Uint8Array => {
    const sizes = new Uint8Array([(4 << 4) | 4, (baseOffsetSize << 4) | 0]);
    const count = ilocVersion < 2 ? u16(entries.length) : u32(entries.length);
    const rows = entries.map((entry) => {
      const head = ilocVersion < 2 ? u16(entry.id) : u32(entry.id);
      const method = ilocVersion === 1 || ilocVersion === 2 ? u16(entry.method) : new Uint8Array(0);
      const base = new Uint8Array(baseOffsetSize);
      if (baseOffsetSize > 0) new DataView(base.buffer).setUint32(0, entry.base);
      const parts = [head, method, u16(0), base, u16(entry.extents.length)];
      for (const extent of entry.extents) parts.push(u32(extent.offset), u32(extent.length));
      return concat(parts);
    });
    return fullBox('iloc', ilocVersion, 0, sizes, count, ...rows);
  };

  const buildMeta = (
    offsets: Map<number, number>,
    idatOffsets: Map<number, number>,
    idatPayload: Uint8Array | null,
  ): Uint8Array => {
    const hdlr = fullBox('hdlr', 0, 0, u32(0), ascii('pict'), new Uint8Array(12), ascii('\0'));
    const pitm = fullBox('pitm', 0, 0, u16(1));
    const iinf = fullBox('iinf', 0, 0, u16(items.length), ...items.map((item) => item.info));
    const iloc = ilocPayload(
      items.map((item) => ({
        id: item.id,
        method: item.inIdat ? 1 : 0,
        base: 0,
        extents: [
          item.inIdat
            ? { offset: idatOffsets.get(item.id) ?? 0, length: item.payload.length }
            : { offset: offsets.get(item.id) ?? 0, length: item.payload.length },
        ],
      })),
    );
    const ispe = fullBox('ispe', 0, 0, u32(4), u32(4));
    const ipco = box('ipco', ispe);
    const ipma = fullBox('ipma', 0, 0, u32(1), u16(1), new Uint8Array([1, 0x81]));
    const iprp = box('iprp', ipco, ipma);
    const idat = idatPayload ? box('idat', idatPayload) : null;
    const children = [hdlr, pitm, iinf, iloc, iprp];
    if (idat) children.push(idat);
    return fullBox('meta', 0, 0, ...children);
  };

  const ftyp =
    brand === 'avif'
      ? box('ftyp', ascii('avif'), u32(0), ascii('mif1'), ascii('miaf'), ascii('MA1B'))
      : brand === 'mif1-avif'
        ? box('ftyp', ascii('mif1'), u32(0), ascii('mif1'), ascii('miaf'), ascii('avif'))
        : box('ftyp', ascii('heic'), u32(0), ascii('mif1'), ascii('heic'));
  const idatPayload =
    items.filter((item) => item.inIdat).length > 0
      ? concat(items.filter((item) => item.inIdat).map((item) => item.payload))
      : null;
  const idatOffsets = new Map<number, number>();
  {
    let cursor = 0;
    for (const item of items.filter((entry) => entry.inIdat)) {
      idatOffsets.set(item.id, cursor);
      cursor += item.payload.length;
    }
  }

  const extraTop = layout.extraTop ?? [];
  const extraTopSize = extraTop.reduce((sum, part) => sum + part.length, 0);
  const probe = buildMeta(new Map(), idatOffsets, idatPayload);
  const offsets = new Map<number, number>();
  // ftyp + extra top boxes + meta + the 8-byte mdat header, then the payload.
  let cursor = ftyp.length + extraTopSize + probe.length + 8;
  for (const item of items.filter((entry) => !entry.inIdat)) {
    offsets.set(item.id, cursor);
    cursor += item.payload.length;
  }
  const meta = buildMeta(offsets, idatOffsets, idatPayload);
  // The probe and the real table must be the same width, otherwise the offsets
  // written above are stale.
  expect(meta.length).toBe(probe.length);

  const mdatPayload = items.filter((item) => !item.inIdat).map((item) => item.payload);

  return {
    bytes: concat([ftyp, ...extraTop, meta, box('mdat', ...mdatPayload)]),
    imagePayload: image,
    exifPayload: exif,
    xmpPayload: xmp,
  };
}

function scan(bytes: Uint8Array) {
  return scanSource(sourceFromBytes(bytes));
}

describe('heif detection', () => {
  it('recognises a HEIC container', async () => {
    const { bytes } = buildHeif();
    const result = await scan(bytes);
    expect(result.format).toBe('heic');
    expect(result.supported).toBe(true);
  });

  it('reports EXIF and XMP as findings', async () => {
    const { bytes } = buildHeif();
    const result = await scan(bytes);
    const ids = result.findings.map((finding) => finding.id);
    expect(ids).toContain('finding.exif');
    expect(ids).toContain('finding.xmp');
    expect(result.findings.find((f) => f.id === 'finding.exif')?.fields?.[0]?.value).toContain(
      'TestCam',
    );
  });

  it('counts the metadata payload as dropped', async () => {
    const { bytes, exifPayload, xmpPayload } = buildHeif();
    const result = await scan(bytes);
    expect(result.droppedBytes).toBeGreaterThanOrEqual(exifPayload.length + xmpPayload.length);
  });
});

describe('heif stripping', () => {
  it('removes both metadata items and re-verifies clean', async () => {
    const { bytes } = buildHeif();
    const stripped = await stripSource(sourceFromBytes(bytes));
    const verify = await verifyBlob(stripped.blob, 'heic');
    expect(verify.ok).toBe(true);
    expect(verify.leftovers).toEqual([]);
  });

  it('keeps the picture payload byte-for-byte', async () => {
    const { bytes, imagePayload } = buildHeif();
    const stripped = await stripSource(sourceFromBytes(bytes));
    const out = new Uint8Array(await stripped.blob.arrayBuffer());
    const structure = await readHeifStructure(sourceFromBytes(out));
    expect(structure).not.toBeNull();
    const imageItem = structure!.items.find((item) => item.info.id === 1)!;
    expect(out.subarray(imageItem.start, imageItem.start + imageItem.length)).toEqual(imagePayload);
  });

  it('drops the metadata items from the item table', async () => {
    const { bytes } = buildHeif();
    const stripped = await stripSource(sourceFromBytes(bytes));
    const out = new Uint8Array(await stripped.blob.arrayBuffer());
    const structure = await readHeifStructure(sourceFromBytes(out));
    expect(structure!.items.map((item) => item.info.id)).toEqual([1]);
  });

  it('is idempotent', async () => {
    const { bytes } = buildHeif();
    const once = await stripSource(sourceFromBytes(bytes));
    const onceBytes = new Uint8Array(await once.blob.arrayBuffer());
    const twice = await stripSource(sourceFromBytes(onceBytes));
    const twiceBytes = new Uint8Array(await twice.blob.arrayBuffer());
    expect(twiceBytes.length).toBe(onceBytes.length);
    expect(twice.removedBytes).toBe(0);
  });

  it('handles an iloc version 0 table', async () => {
    const { bytes } = buildHeif({ ilocVersion: 0 });
    const stripped = await stripSource(sourceFromBytes(bytes));
    const verify = await verifyBlob(stripped.blob, 'heic');
    expect(verify.ok).toBe(true);
  });

  it('handles a base_offset_size other than zero', async () => {
    const { bytes } = buildHeif({ baseOffsetSize: 4 });
    const stripped = await stripSource(sourceFromBytes(bytes));
    const verify = await verifyBlob(stripped.blob, 'heic');
    expect(verify.ok).toBe(true);
  });

  it('handles items stored in idat', async () => {
    const { bytes } = buildHeif({ idatItems: new Set([1]) });
    const stripped = await stripSource(sourceFromBytes(bytes));
    const out = new Uint8Array(await stripped.blob.arrayBuffer());
    const structure = await readHeifStructure(sourceFromBytes(out));
    const imageItem = structure!.items.find((item) => item.info.id === 1)!;
    expect(imageItem.method).toBe(1);
    expect(out.subarray(imageItem.start, imageItem.start + imageItem.length)).toEqual(IMAGE_BYTES);
  });

  it('drops an unknown item type instead of trusting it', async () => {
    const { bytes } = buildHeif({
      extraItems: [{ id: 4, info: infe(4, 'zzzz', 'mystery'), payload: new Uint8Array(16) }],
    });
    const stripped = await stripSource(sourceFromBytes(bytes));
    const out = new Uint8Array(await stripped.blob.arrayBuffer());
    const structure = await readHeifStructure(sourceFromBytes(out));
    expect(structure!.items.map((item) => item.info.id)).toEqual([1]);
    expect(structure!.items.some((item) => item.info.type === 'zzzz')).toBe(false);
  });

  it('refuses an image sequence instead of half-cleaning it', async () => {
    // A `moov` box means the file is an animation; dropping it would leave
    // something that no longer plays, so such files are rejected outright.
    const { bytes } = buildHeif({ extraTop: [box('moov', new Uint8Array(16))] });
    const result = await scan(bytes);
    expect(result.supported).toBe(true);
    expect(result.warnings.some((warning) => warning.id === 'warn.heif.sequence')).toBe(true);
    await expect(stripSource(sourceFromBytes(bytes))).rejects.toThrow();
  });

  it('leaves a container without metadata intact', async () => {
    const { bytes } = buildHeif();
    const stripped = await stripSource(sourceFromBytes(bytes));
    const out = new Uint8Array(await stripped.blob.arrayBuffer());
    const top = readBoxes(out, 0, out.length);
    expect(top.map((entry) => entry.type)).toEqual(['ftyp', 'meta', 'mdat']);
  });
});

describe('avif', () => {
  it('reports the AVIF container, not HEIC', async () => {
    const { bytes } = buildHeif({ brand: 'avif' });
    const result = await scan(bytes);
    expect(result.format).toBe('avif');
    expect(result.supported).toBe(true);
  });

  it('strips AVIF metadata and keeps the container AVIF', async () => {
    const { bytes, imagePayload } = buildHeif({ brand: 'avif' });
    const stripped = await stripSource(sourceFromBytes(bytes));
    expect(stripped.format).toBe('avif');
    expect(stripped.mime).toBe('image/avif');
    expect(stripped.ext).toBe('avif');
    const out = new Uint8Array(await stripped.blob.arrayBuffer());
    const structure = await readHeifStructure(sourceFromBytes(out));
    expect(structure!.format.format).toBe('avif');
    const imageItem = structure!.items.find((item) => item.info.id === 1)!;
    expect(out.subarray(imageItem.start, imageItem.start + imageItem.length)).toEqual(imagePayload);
    const verify = await verifyBlob(stripped.blob, 'avif');
    expect(verify.ok).toBe(true);
  });

  it('recognises the generic mif1 brand holding AVIF', async () => {
    // Files whose major brand is the generic HEIF one rely on the compat list.
    const { bytes } = buildHeif({ brand: 'mif1-avif' });
    const result = await scan(bytes);
    expect(result.format).toBe('avif');
  });
});

describe('heif inspection', () => {
  it('lists the item table with removal flags', async () => {
    const { bytes } = buildHeif();
    const report = await inspectSource(sourceFromBytes(bytes), { keepIcc: true });
    const container = report.groups.find((group) => group.id === 'container');
    expect(container).toBeDefined();
    const names = container!.items.map((item) => item.name);
    expect(names.some((name) => name.includes('hvc1'))).toBe(true);
    expect(names.some((name) => name.includes('Exif'))).toBe(true);
    const exifItem = container!.items.find((item) => item.name.includes('Exif'))!;
    expect(exifItem.removed).toBe(true);
    const imageItem = container!.items.find((item) => item.name.includes('hvc1'))!;
    expect(imageItem.removed).toBe(false);
  });

  it('expands the Exif item into tag groups', async () => {
    const { bytes } = buildHeif();
    const report = await inspectSource(sourceFromBytes(bytes), { keepIcc: true });
    const ifd0 = report.groups.find((group) => group.id === 'ifd0');
    expect(ifd0).toBeDefined();
    expect(ifd0!.items.some((item) => item.value.includes('TestCam'))).toBe(true);
  });
});
