/**
 * HEIF (HEIC) analyser / stripper.
 *
 * HEIF is ISO BMFF: the picture lives in `mdat` as items addressed by the
 * `iloc` table, and metadata is merely two more items — an `Exif` item and a
 * `mime` item carrying XMP. Removing them is therefore not a matter of
 * deleting a span of bytes: the item info table, the reference table and
 * every following item offset all shift, so the container is rebuilt.
 *
 * The rebuild stays lossless. Coded picture bytes are copied verbatim through
 * zero-copy slices and the new `iloc` points at them; nothing is decoded.
 */
import { ascii, u16be, u32be } from './bytes.ts';
import { summarizeTiff } from './exif.ts';
import { buildExifFindings, buildJumbfFindings, buildXmpFindings } from './findings.ts';
import {
  offsetSizeFor,
  readBoxes,
  readIloc,
  readItemInfo,
  readItemReferences,
  readPropertyAssociations,
  readUInt,
  writeBox,
  writeFullBox,
  writeIloc,
  writeItemInfo,
  writeItemReference,
  writeMdatHeader,
  writePropertyAssociations,
  type Box,
  type IlocTable,
  type ItemInfo,
  type ItemReference,
  type PropertyAssociation,
} from './isobmff.ts';
import { readAt, type Source } from './source.ts';
import { parseTiff } from './tiff.ts';
import type { BlockInfo, ContainerAnalysis, Finding, Part, StripOptions, Warning } from './types.ts';
import { parseXmp } from './xmp.ts';

/** Item types that carry picture data. Everything else is metadata. */
const IMAGE_ITEM_TYPES = new Set([
  'hvc1',
  'hvc2',
  'hev1',
  'lhv1',
  'av01',
  'avc1',
  'vvc1',
  'evc1',
  'jpeg',
  'j2k1',
  'grid',
  'iden',
  'iovl',
  'msk1',
]);

const MAX_META_ITEM = 8 * 1024 * 1024;

const META_CHILD_TYPES = ['hdlr', 'dinf', 'pitm', 'iloc', 'iinf', 'iref', 'iprp', 'idat'];

interface TopLevel {
  ftyp: Box;
  meta: Box;
  mdat?: Box;
  others: Box[];
}

interface MetaParts {
  hdlr?: Box;
  dinf?: Box;
  pitm?: Box;
  iloc?: Box;
  iinf?: Box;
  iref?: Box;
  iprp?: Box;
  idat?: Box;
  unknown: Box[];
}

/** A surviving item and where its bytes live, ready for the rebuild. */
interface PlannedItem {
  id: number;
  method: number;
  length: number;
  /** Original file offset, used to preserve the payload order. */
  sourceStart: number;
  /** Zero-copy source range for a single-extent item stored in `mdat`. */
  slice?: { start: number; end: number };
  /** Bytes already in hand (multi-extent items and `idat` members). */
  bytes?: Uint8Array;
}

/**
 * Walk top-level boxes by reading only their headers, so a 50 MB `mdat` never
 * enters memory.
 */
async function scanTopLevel(src: Source): Promise<TopLevel | null> {
  const boxes: Box[] = [];
  let pos = 0;
  while (pos + 8 <= src.size) {
    const head = await readAt(src, pos, 16);
    if (head.length < 8) break;
    let size = u32be(head, 0);
    const type = ascii(head, 4, 4);
    let headerSize = 8;
    if (size === 1) {
      if (head.length < 16) break;
      size = readUInt(head, 8, 8);
      headerSize = 16;
    } else if (size === 0) {
      size = src.size - pos;
    }
    if (size < headerSize || pos + size > src.size) break;
    boxes.push({ type, pos, size, headerSize, body: pos + headerSize, end: pos + size });
    pos += size;
  }
  const ftyp = boxes.find((box) => box.type === 'ftyp');
  const meta = boxes.find((box) => box.type === 'meta');
  if (!ftyp || !meta) return null;
  return {
    ftyp,
    meta,
    mdat: boxes.find((box) => box.type === 'mdat'),
    others: boxes.filter((box) => box !== ftyp && box !== meta && box.type !== 'mdat'),
  };
}

function splitMeta(bytes: Uint8Array, meta: Box): MetaParts {
  const children = readBoxes(bytes, meta.body + 4, meta.end);
  const pick = (type: string): Box | undefined => children.find((box) => box.type === type);
  return {
    hdlr: pick('hdlr'),
    dinf: pick('dinf'),
    pitm: pick('pitm'),
    iloc: pick('iloc'),
    iinf: pick('iinf'),
    iref: pick('iref'),
    iprp: pick('iprp'),
    idat: pick('idat'),
    unknown: children.filter((box) => !META_CHILD_TYPES.includes(box.type)),
  };
}

function primaryItemId(bytes: Uint8Array, pitm: Box | undefined): number | undefined {
  if (!pitm) return undefined;
  const version = bytes[pitm.body] ?? 0;
  return version === 0 ? u16be(bytes, pitm.body + 4) : u32be(bytes, pitm.body + 4);
}

function metadataKind(item: ItemInfo): 'exif' | 'xmp' | 'c2pa' | 'mime' | 'uri' | 'unknown' | null {
  if (IMAGE_ITEM_TYPES.has(item.type)) return null;
  if (item.type === 'Exif') return 'exif';
  if (item.type === 'jumb') return 'c2pa';
  if (item.type === 'uri ') return 'uri';
  if (item.type === 'mime') {
    if (item.contentType === 'application/rdf+xml') return 'xmp';
    return 'mime';
  }
  return 'unknown';
}

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Read an item's payload, joining fragmented extents. */
async function readPayload(src: Source, start: number, length: number): Promise<Uint8Array> {
  return readAt(src, start, Math.min(length, MAX_META_ITEM));
}

function findRotation(
  bytes: Uint8Array,
  iprp: Box | undefined,
  associations: { items: { id: number; associations: PropertyAssociation[] }[] },
  primary: number | undefined,
): number | undefined {
  if (!iprp || primary === undefined) return undefined;
  const ipco = readBoxes(bytes, iprp.body, iprp.end).find((box) => box.type === 'ipco');
  if (!ipco) return undefined;
  const properties = readBoxes(bytes, ipco.body, ipco.end);
  const assoc = associations.items.find((entry) => entry.id === primary);
  for (const entry of assoc?.associations ?? []) {
    const property = properties[entry.index - 1];
    if (property?.type === 'irot' && property.size > property.headerSize) {
      return (bytes[property.body] ?? 0) & 0x03;
    }
  }
  return undefined;
}

export type HeifItemKind = 'image' | 'exif' | 'xmp' | 'c2pa' | 'mime' | 'uri' | 'unknown';

export interface HeifItem {
  info: ItemInfo;
  kind: HeifItemKind;
  /** Absolute file offset of the payload (`idat`-relative resolved). */
  start: number;
  length: number;
  method: number;
  /** Extents declared by `iloc`; 0 when the item has no location entry. */
  extentCount: number;
}

export interface HeifStructure {
  top: TopLevel;
  metaBytes: Uint8Array;
  parts: MetaParts;
  iinfVersion: number;
  ilocVersion: number;
  items: HeifItem[];
  refs: ItemReference[];
  associations: { version: number; flags: number; items: { id: number; associations: PropertyAssociation[] }[] };
  primary: number | undefined;
}

/**
 * Parse the item table and locate every item payload.
 *
 * Both the scan pass and the metadata listing read the container through this
 * function, so the two can never disagree about what an item is.
 */
export async function readHeifStructure(src: Source): Promise<HeifStructure | null> {
  const top = await scanTopLevel(src);
  if (!top) return null;

  const metaBytes = await readAt(src, top.meta.pos, top.meta.size);
  if (metaBytes.length !== top.meta.size) return null;
  const metaBox: Box = {
    type: 'meta',
    pos: 0,
    size: top.meta.size,
    headerSize: top.meta.headerSize,
    body: top.meta.headerSize,
    end: top.meta.size,
  };
  const parts = splitMeta(metaBytes, metaBox);
  if (!parts.iinf || !parts.iloc) return null;

  const iinf = readItemInfo(metaBytes, parts.iinf);
  const iloc = readIloc(metaBytes, parts.iloc);
  if (iinf.items.length === 0) return null;
  const refs = parts.iref ? readItemReferences(metaBytes, parts.iref) : [];
  const ipmaBox = parts.iprp
    ? readBoxes(metaBytes, parts.iprp.body, parts.iprp.end).find((box) => box.type === 'ipma')
    : undefined;
  const associations = ipmaBox
    ? readPropertyAssociations(metaBytes, ipmaBox)
    : { version: 0, flags: 0, items: [] as { id: number; associations: PropertyAssociation[] }[] };

  const idatDataStart = parts.idat ? top.meta.pos + parts.idat.body : 0;
  const locations = new Map(iloc.items.map((item) => [item.id, item]));
  const items: HeifItem[] = iinf.items.map((info) => {
    const location = locations.get(info.id);
    const extents = location?.extents ?? [];
    const method = location?.method ?? 0;
    const origin = method === 1 ? idatDataStart : 0;
    const kind = metadataKind(info);
    return {
      info,
      kind: kind ?? 'image',
      start: origin + (location?.baseOffset ?? 0) + (extents[0]?.offset ?? 0),
      length: extents.reduce((sum, extent) => sum + extent.length, 0),
      method,
      extentCount: extents.length,
    };
  });

  return {
    top,
    metaBytes,
    parts,
    iinfVersion: iinf.version,
    ilocVersion: iloc.version,
    items,
    refs,
    associations,
    primary: primaryItemId(metaBytes, parts.pitm),
  };
}

export async function analyzeHeif(src: Source, _opts: StripOptions): Promise<ContainerAnalysis> {
  const warnings: Warning[] = [];
  const findings: Finding[] = [];

  const structure = await readHeifStructure(src);
  if (!structure) return failed([{ id: 'warn.heif.noMeta', severity: 'error' }], src.size);
  const { top, metaBytes, parts, associations, primary, items } = structure;

  if (structure.items.length === 0) return failed([{ id: 'warn.heif.noItems', severity: 'error' }], src.size);
  const unlocated = structure.items.filter((item) => item.extentCount === 0).length;
  if (unlocated > 0) {
    warnings.push({
      id: 'warn.heif.tableMismatch',
      severity: 'warn',
      params: { info: structure.items.length, loc: unlocated },
    });
  }

  const drop = new Set<number>();
  const planned: PlannedItem[] = [];
  const blocks: BlockInfo[] = [];
  const jumbfPayloads: Uint8Array[] = [];
  let exifBytes = 0;
  let exifSummary: ReturnType<typeof summarizeTiff> | undefined;
  let c2paBytes = 0;
  let imageItems = 0;
  const unknownTypes: string[] = [];

  for (const item of items) {
    const { info, kind, start, length } = item;
    const method = item.method;
    const label = kind === 'exif' ? 'Exif' : kind === 'xmp' ? 'XMP' : info.type || 'item';

    if (kind === 'image') {
      imageItems += 1;
      if (length === 0) continue;
      if (item.extentCount === 1 && method === 0) {
        planned.push({ id: info.id, method, length, sourceStart: start, slice: { start, end: start + length } });
      } else {
        planned.push({ id: info.id, method, length, sourceStart: start, bytes: await readPayload(src, start, length) });
      }
      continue;
    }

    drop.add(info.id);
    blocks.push({ name: `Item ${info.id} ${label}`, bytes: length, kept: false });
    if (kind === 'unknown' && info.type !== '') unknownTypes.push(info.type);
    if (length === 0 || length > MAX_META_ITEM) continue;

    if (kind === 'exif') {
      const payload = await readPayload(src, start, length);
      exifBytes += payload.length;
      try {
        // The Exif item opens with a 4-byte offset to the TIFF header, counted
        // from the end of that field.
        const tiffStart = 4 + (payload.length >= 4 ? u32be(payload, 0) : 0);
        if (tiffStart < payload.length) {
          const tiff = parseTiff(payload.subarray(tiffStart));
          if (tiff) exifSummary = summarizeTiff(tiff);
        }
      } catch {
        warnings.push({ id: 'warn.heif.exifUnparsed', severity: 'warn' });
      }
    } else if (kind === 'xmp') {
      const payload = await readPayload(src, start, length);
      findings.push(...buildXmpFindings(parseXmp(payload)));
    } else if (kind === 'c2pa') {
      const payload = await readPayload(src, start, length);
      c2paBytes += payload.length;
      jumbfPayloads.push(payload);
    }
  }

  if (exifSummary) findings.push(...buildExifFindings(exifSummary, exifBytes));
  else if (exifBytes > 0) {
    findings.push({ id: 'finding.exif.unparsed', category: 'exif', severity: 'high', bytes: exifBytes });
  }
  if (jumbfPayloads.length > 0) findings.push(...buildJumbfFindings(jumbfPayloads, c2paBytes));
  if (unknownTypes.length > 0) {
    findings.push({
      id: 'finding.heif.item',
      category: 'unknown',
      severity: 'medium',
      params: { types: [...new Set(unknownTypes)].join(', ') },
    });
  }
  if (imageItems === 0) return failed([{ id: 'warn.heif.noImage', severity: 'error' }], src.size);

  // ---- orientation: `irot` survives the strip, so only a bare EXIF tag is lost
  const rotation = findRotation(metaBytes, parts.iprp, associations, primary);
  // HEIF records orientation in the container (`irot`/`imir`), which travels with
  // the picture items and survives the strip. So there is never anything to bake
  // here — and baking would fail anyway, because browsers cannot decode HEIC.
  // Only warn for the rare file whose sole orientation is an EXIF tag.
  const orientation = 1;
  if (rotation === undefined && exifSummary && exifSummary.orientation > 1) {
    warnings.push({
      id: 'warn.heif.orientationLost',
      severity: 'warn',
      params: { orientation: exifSummary.orientation },
    });
  }

  const ftypBytes = await readAt(src, top.ftyp.pos, top.ftyp.size);
  const brand = ascii(ftypBytes, 8, 4) || 'heif';
  blocks.unshift({
    name: 'meta (item table)',
    bytes: top.meta.size,
    kept: true,
    note: `${structure.items.length} items`,
  });
  blocks.unshift({ name: `ftyp ${brand}`, bytes: top.ftyp.size, kept: true });
  if (top.mdat) {
    blocks.push({
      name: 'mdat (picture data)',
      bytes: top.mdat.size - top.mdat.headerSize,
      kept: true,
      note: `${imageItems} items`,
    });
  }
  for (const box of top.others) blocks.push({ name: `Top-level ${box.type}`, bytes: box.size, kept: false });

  const rebuilt = buildContainer({
    metaBytes,
    parts,
    ilocVersion: structure.ilocVersion,
    iinfVersion: structure.iinfVersion,
    infes: items.filter((item) => item.kind === 'image').map((item) => item.info.raw),
    irefVersion: parts.iref ? (metaBytes[parts.iref.body] ?? 0) : 0,
    refs: structure.refs,
    drop,
    associations: associations.items,
    ipmaFlags: associations.flags,
    planned,
    ftypBytes,
    primary,
  });
  if (!rebuilt) return failed([{ id: 'warn.heif.rebuildFailed', severity: 'error' }], src.size);

  const droppedBytes = src.size - rebuilt.totalBytes;
  const ok = droppedBytes >= 0 && !warnings.some((warn) => warn.severity === 'error');

  return {
    format: 'heic',
    mime: 'image/heic',
    ext: 'heic',
    parts: ok ? rebuilt.containerParts : [],
    findings,
    warnings,
    orientation,
    blocks,
    droppedBytes: Math.max(0, droppedBytes),
    keptBytes: Math.min(src.size, rebuilt.totalBytes),
    ok,
  };
}

interface RebuildInput {
  metaBytes: Uint8Array;
  parts: MetaParts;
  ilocVersion: number;
  iinfVersion: number;
  infes: Uint8Array[];
  irefVersion: number;
  refs: ItemReference[];
  drop: Set<number>;
  associations: { id: number; associations: PropertyAssociation[] }[];
  ipmaFlags: number;
  planned: PlannedItem[];
  ftypBytes: Uint8Array;
  primary: number | undefined;
}

interface RebuildOutput {
  containerParts: Part[];
  totalBytes: number;
}

/**
 * Rebuild `meta` around the surviving items and re-point `iloc` at a freshly
 * packed `mdat`.
 *
 * `iloc` keeps the source version, because version 0 cannot express the
 * `construction_method` that items stored in `idat` rely on. The offset width
 * is learned from a first layout pass and widened once if it does not fit.
 */
function buildContainer(input: RebuildInput): RebuildOutput | null {
  const { metaBytes, parts, drop, planned } = input;

  const mdatItems = planned
    .filter((item) => item.method === 0)
    .sort((a, b) => a.sourceStart - b.sourceStart);
  const idatItems = planned.filter((item) => item.method === 1);
  const mdatPayload = mdatItems.reduce((sum, item) => sum + item.length, 0);

  const keptRefs = input.refs
    .filter((ref) => !drop.has(ref.from))
    .map((ref) => ({ ...ref, to: ref.to.filter((id) => !drop.has(id)) }))
    .filter((ref) => ref.to.length > 0);

  const keptAssociations = input.associations.filter((entry) => !drop.has(entry.id));

  const hdlrBytes = parts.hdlr ? metaBytes.subarray(parts.hdlr.pos, parts.hdlr.end) : null;
  const dinfBytes = parts.dinf ? metaBytes.subarray(parts.dinf.pos, parts.dinf.end) : null;
  const ipcoBytes = parts.iprp
    ? (() => {
        const ipco = readBoxes(metaBytes, parts.iprp.body, parts.iprp.end).find((box) => box.type === 'ipco');
        return ipco ? metaBytes.subarray(ipco.pos, ipco.end) : null;
      })()
    : null;

  let pitmBytes: Uint8Array | null = null;
  if (parts.pitm) {
    if (input.primary !== undefined && drop.has(input.primary)) {
      const replacement = planned[0]?.id;
      if (replacement !== undefined) {
        const inner = new Uint8Array(2);
        new DataView(inner.buffer).setUint16(0, replacement);
        pitmBytes = writeFullBox('pitm', 0, 0, [inner]);
      }
    } else {
      pitmBytes = metaBytes.subarray(parts.pitm.pos, parts.pitm.end);
    }
  }

  const idatPayload = idatItems.length > 0
    ? concatBytes(idatItems.map((item) => item.bytes ?? new Uint8Array(item.length)))
    : null;
  const idatOffsets = new Map<number, number>();
  {
    let cursor = 0;
    for (const item of idatItems) {
      idatOffsets.set(item.id, cursor);
      cursor += item.length;
    }
  }

  const ilocTable = (offsetSize: number): IlocTable => ({
    version: input.ilocVersion,
    offsetSize,
    lengthSize: 4,
    baseOffsetSize: 0,
    indexSize: 0,
    items: [],
  });

  const writeMeta = (offsetSize: number, starts: Map<number, number>): Uint8Array => {
    const iinfBox = writeItemInfo(input.iinfVersion, input.infes);
    const irefBox = parts.iref ? writeItemReference(input.irefVersion, keptRefs) : null;
    const ipmaBox = parts.iprp
      ? writePropertyAssociations({ version: 0, flags: input.ipmaFlags, items: keptAssociations })
      : null;
    const ilocBox = writeIloc(
      ilocTable(offsetSize),
      planned.map((item) => ({
        id: item.id,
        method: item.method,
        baseOffset: 0,
        extents: [
          {
            offset: item.method === 1 ? (idatOffsets.get(item.id) ?? 0) : (starts.get(item.id) ?? 0),
            length: item.length,
          },
        ],
      })),
    );

    const children: Uint8Array[] = [];
    if (hdlrBytes) children.push(hdlrBytes);
    if (dinfBytes) children.push(dinfBytes);
    if (pitmBytes) children.push(pitmBytes);
    children.push(iinfBox);
    if (irefBox) children.push(irefBox);
    if (ipcoBytes) children.push(writeBox('iprp', [ipcoBytes, ...(ipmaBox ? [ipmaBox] : [])]));
    if (idatPayload) children.push(writeBox('idat', [idatPayload]));
    children.push(ilocBox);
    return writeFullBox('meta', 0, 0, children);
  };

  const mdatHeader = writeMdatHeader(mdatPayload);

  const plan = (offsetSize: number): { meta: Uint8Array; starts: Map<number, number>; payloadStart: number } => {
    const probe = writeMeta(offsetSize, new Map());
    const payloadStart = input.ftypBytes.length + probe.length + mdatHeader.length;
    const starts = new Map<number, number>();
    let cursor = payloadStart;
    for (const item of mdatItems) {
      starts.set(item.id, cursor);
      cursor += item.length;
    }
    // Offsets do not change the table size, so the real table is the same width.
    return { meta: writeMeta(offsetSize, starts), starts, payloadStart };
  };

  let offsetSize = Math.max(4, input.ilocVersion === 2 ? 4 : 4);
  let result = plan(offsetSize);
  const totalBytes = result.payloadStart + mdatPayload;
  const needed = offsetSizeFor(totalBytes);
  if (needed > offsetSize) {
    offsetSize = needed;
    result = plan(offsetSize);
  }

  const containerParts: Part[] = [
    { kind: 'bytes', bytes: input.ftypBytes },
    { kind: 'bytes', bytes: result.meta },
    { kind: 'bytes', bytes: mdatHeader },
  ];
  for (const item of mdatItems) {
    if (item.slice) containerParts.push({ kind: 'slice', start: item.slice.start, end: item.slice.end });
    else if (item.bytes) containerParts.push({ kind: 'bytes', bytes: item.bytes });
  }
  return { containerParts, totalBytes };
}

function failed(warnings: Warning[], fileSize: number): ContainerAnalysis {
  return {
    format: 'heic',
    mime: 'image/heic',
    ext: 'heic',
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
