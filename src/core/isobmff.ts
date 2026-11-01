/**
 * ISO base media file format (HEIF / AVIF) box primitives.
 *
 * Only the subset needed to read and rebuild a still-image container lives
 * here. Every structure the spec allows to vary in width — item IDs, offsets,
 * lengths, property indices — is read with its declared size, because
 * real-world files disagree about almost all of them.
 *
 * Nothing in this module decodes image data, so a rebuild stays lossless.
 */
import { ascii, u16be, u32be } from './bytes.ts';

export interface Box {
  type: string;
  /** Offset of the box header within the buffer being scanned. */
  pos: number;
  size: number;
  headerSize: number;
  /** Offset of the payload within the buffer being scanned. */
  body: number;
  end: number;
}

/** Largest unsigned value that fits in `size` bytes, read big-endian. */
export function readUInt(bytes: Uint8Array, offset: number, size: number): number {
  let value = 0;
  for (let i = 0; i < size; i += 1) value = value * 256 + (bytes[offset + i] ?? 0);
  return value;
}

export function readBox(bytes: Uint8Array, pos: number, limit: number): Box | null {
  if (pos + 8 > limit) return null;
  let size = u32be(bytes, pos);
  const type = ascii(bytes, pos + 4, 4);
  let headerSize = 8;
  if (size === 1) {
    if (pos + 16 > limit) return null;
    size = readUInt(bytes, pos + 8, 8);
    headerSize = 16;
  } else if (size === 0) {
    size = limit - pos;
  }
  if (size < headerSize || pos + size > limit) return null;
  return { type, pos, size, headerSize, body: pos + headerSize, end: pos + size };
}

export function readBoxes(bytes: Uint8Array, start: number, end: number): Box[] {
  const out: Box[] = [];
  let pos = start;
  while (pos < end) {
    const box = readBox(bytes, pos, end);
    if (!box) break;
    out.push(box);
    pos = box.end;
  }
  return out;
}

export function findBox(bytes: Uint8Array, start: number, end: number, type: string): Box | undefined {
  return readBoxes(bytes, start, end).find((box) => box.type === type);
}

export interface FullBoxHeader {
  version: number;
  flags: number;
}

export function fullBoxHeader(bytes: Uint8Array, box: Box): FullBoxHeader {
  return {
    version: bytes[box.body] ?? 0,
    flags: ((bytes[box.body + 1] ?? 0) << 16) | ((bytes[box.body + 2] ?? 0) << 8) | (bytes[box.body + 3] ?? 0),
  };
}

// ---------------------------------------------------------------- item table

export interface ItemInfo {
  id: number;
  /** Four-character item type (`hvc1`, `grid`, `Exif`, `mime`…). */
  type: string;
  name: string;
  /** MIME type, only present when `type` is `mime`. */
  contentType: string;
  /** Original bytes, so the entry can be copied back verbatim. */
  raw: Uint8Array;
}

export interface ItemInfoTable {
  version: number;
  items: ItemInfo[];
}

function cString(bytes: Uint8Array, start: number, end: number): { text: string; next: number } {
  let stop = start;
  while (stop < end && bytes[stop] !== 0) stop += 1;
  return { text: ascii(bytes, start, stop - start), next: stop < end ? stop + 1 : end };
}

export function readItemInfo(bytes: Uint8Array, box: Box): ItemInfoTable {
  const { version } = fullBoxHeader(bytes, box);
  const wide = version >= 1;
  const countSize = wide ? 4 : 2;
  let pos = box.body + 4 + countSize;
  const items: ItemInfo[] = [];
  for (const child of readBoxes(bytes, pos, box.end)) {
    if (child.type !== 'infe') continue;
    const entryVersion = bytes[child.body] ?? 0;
    const idSize = entryVersion >= 3 ? 4 : 2;
    let cursor = child.body + 4;
    const id = readUInt(bytes, cursor, idSize);
    cursor += idSize + 2; // item_protection_index
    let type = '';
    let name = '';
    let contentType = '';
    if (entryVersion >= 2) {
      type = ascii(bytes, cursor, 4);
      cursor += 4;
      const parsedName = cString(bytes, cursor, child.end);
      name = parsedName.text;
      cursor = parsedName.next;
      if (type === 'mime') contentType = cString(bytes, cursor, child.end).text;
    } else {
      const parsedName = cString(bytes, cursor, child.end);
      name = parsedName.text;
      cursor = parsedName.next;
      contentType = cString(bytes, cursor, child.end).text;
    }
    items.push({
      id,
      type,
      name,
      contentType,
      raw: bytes.subarray(child.pos, child.end),
    });
    pos = child.end;
  }
  return { version, items };
}

export function writeItemInfo(version: number, entries: readonly Uint8Array[]): Uint8Array {
  const count = new Uint8Array(version >= 1 ? 4 : 2);
  const view = new DataView(count.buffer);
  if (version >= 1) view.setUint32(0, entries.length);
  else view.setUint16(0, entries.length);
  return writeFullBox('iinf', version, 0, [count, ...entries]);
}

// --------------------------------------------------------------- item layout

export interface Extent {
  offset: number;
  length: number;
}

export interface IlocItem {
  id: number;
  /** 0 = absolute file offsets, 1 = offsets into the `idat` box. */
  method: number;
  baseOffset: number;
  extents: Extent[];
}

export interface IlocTable {
  version: number;
  offsetSize: number;
  lengthSize: number;
  baseOffsetSize: number;
  indexSize: number;
  items: IlocItem[];
}

export function readIloc(bytes: Uint8Array, box: Box): IlocTable {
  const { version } = fullBoxHeader(bytes, box);
  const first = bytes[box.body + 4] ?? 0;
  const second = bytes[box.body + 5] ?? 0;
  const offsetSize = first >> 4;
  const lengthSize = first & 0x0f;
  const baseOffsetSize = second >> 4;
  const indexSize = second & 0x0f;
  const idSize = version < 2 ? 2 : 4;
  let pos = box.body + 6;
  const count = version < 2 ? u16be(bytes, pos) : u32be(bytes, pos);
  pos += idSize;
  const items: IlocItem[] = [];
  for (let i = 0; i < count && pos + idSize + 2 <= box.end; i += 1) {
    const id = readUInt(bytes, pos, idSize);
    pos += idSize;
    let method = 0;
    if (version === 1 || version === 2) {
      method = u16be(bytes, pos) & 0x0f;
      pos += 2;
    }
    pos += 2; // data_reference_index
    const baseOffset = readUInt(bytes, pos, baseOffsetSize);
    pos += baseOffsetSize;
    const extentCount = u16be(bytes, pos);
    pos += 2;
    const extents: Extent[] = [];
    for (let e = 0; e < extentCount; e += 1) {
      pos += indexSize;
      const offset = readUInt(bytes, pos, offsetSize);
      pos += offsetSize;
      const length = readUInt(bytes, pos, lengthSize);
      pos += lengthSize;
      extents.push({ offset, length });
    }
    if (pos > box.end) break;
    items.push({ id, method, baseOffset, extents });
  }
  return { version, offsetSize, lengthSize, baseOffsetSize, indexSize, items };
}

function writeUInt(out: Uint8Array, pos: number, size: number, value: number): void {
  for (let i = size - 1; i >= 0; i -= 1) {
    out[pos + i] = value % 256;
    value = Math.floor(value / 256);
  }
}

/** Total byte width an offset needs, capped at 8. */
export function offsetSizeFor(maxOffset: number): number {
  if (maxOffset < 0x10000) return 2;
  if (maxOffset < 0x100000000) return 4;
  return 8;
}

export function writeIloc(table: IlocTable, items: readonly IlocItem[]): Uint8Array {
  const idSize = table.version < 2 ? 2 : 4;
  const head = new Uint8Array(6);
  head[0] = table.version;
  head[4] = (table.offsetSize << 4) | table.lengthSize;
  head[5] = (table.baseOffsetSize << 4) | table.indexSize;
  const count = new Uint8Array(idSize);
  if (idSize === 2) new DataView(count.buffer).setUint16(0, items.length);
  else new DataView(count.buffer).setUint32(0, items.length);

  const rows: Uint8Array[] = [];
  for (const item of items) {
    const extents = item.extents.length > 0 ? item.extents : [{ offset: 0, length: 0 }];
    const rowSize =
      idSize +
      (table.version === 1 || table.version === 2 ? 2 : 0) +
      2 +
      table.baseOffsetSize +
      2 +
      extents.length * (table.indexSize + table.offsetSize + table.lengthSize);
    const row = new Uint8Array(rowSize);
    let pos = 0;
    writeUInt(row, pos, idSize, item.id);
    pos += idSize;
    if (table.version === 1 || table.version === 2) {
      writeUInt(row, pos, 2, item.method & 0x0f);
      pos += 2;
    }
    pos += 2; // data_reference_index stays 0
    writeUInt(row, pos, table.baseOffsetSize, 0);
    pos += table.baseOffsetSize;
    writeUInt(row, pos, 2, extents.length);
    pos += 2;
    for (const extent of extents) {
      pos += table.indexSize;
      writeUInt(row, pos, table.offsetSize, extent.offset);
      pos += table.offsetSize;
      writeUInt(row, pos, table.lengthSize, extent.length);
      pos += table.lengthSize;
    }
    rows.push(row);
  }
  return writeFullBox('iloc', table.version, 0, [head.subarray(4), count, ...rows]);
}

// ----------------------------------------------------------------- item refs

export interface ItemReference {
  type: string;
  from: number;
  to: number[];
}

export function readItemReferences(bytes: Uint8Array, box: Box): ItemReference[] {
  const { version } = fullBoxHeader(bytes, box);
  const idSize = version >= 1 ? 4 : 2;
  const out: ItemReference[] = [];
  for (const child of readBoxes(bytes, box.body + 4, box.end)) {
    let pos = child.body;
    if (pos + idSize > child.end) continue;
    const from = readUInt(bytes, pos, idSize);
    pos += idSize;
    const to: number[] = [];
    while (pos + idSize <= child.end) {
      to.push(readUInt(bytes, pos, idSize));
      pos += idSize;
    }
    out.push({ type: child.type, from, to });
  }
  return out;
}

export function writeItemReference(version: number, refs: readonly ItemReference[]): Uint8Array {
  const idSize = version >= 1 ? 4 : 2;
  const children = refs.map((ref) => {
    const body = new Uint8Array(idSize * (1 + ref.to.length));
    writeUInt(body, 0, idSize, ref.from);
    ref.to.forEach((id, index) => writeUInt(body, idSize * (index + 1), idSize, id));
    return writeBox(ref.type, [body]);
  });
  return writeFullBox('iref', version, 0, children);
}

// -------------------------------------------------------------- item props

export interface PropertyAssociation {
  index: number;
  essential: boolean;
}

export interface IpmaItem {
  id: number;
  associations: PropertyAssociation[];
}

export interface IpmaTable {
  version: number;
  flags: number;
  items: IpmaItem[];
}

export function readPropertyAssociations(bytes: Uint8Array, box: Box): IpmaTable {
  const { version, flags } = fullBoxHeader(bytes, box);
  const wideId = version >= 1;
  const wideIndex = (flags & 1) !== 0;
  let pos = box.body + 4;
  const count = u32be(bytes, pos);
  pos += 4;
  const items: IpmaItem[] = [];
  for (let i = 0; i < count && pos < box.end; i += 1) {
    const id = readUInt(bytes, pos, wideId ? 4 : 2);
    pos += wideId ? 4 : 2;
    const assocCount = bytes[pos] ?? 0;
    pos += 1;
    const associations: PropertyAssociation[] = [];
    for (let a = 0; a < assocCount; a += 1) {
      const size = wideIndex ? 2 : 1;
      const value = readUInt(bytes, pos, size);
      pos += size;
      const essentialBit = wideIndex ? 0x8000 : 0x80;
      associations.push({ index: value & (essentialBit - 1), essential: (value & essentialBit) !== 0 });
    }
    if (pos > box.end) break;
    items.push({ id, associations });
  }
  return { version, flags, items };
}

export function writePropertyAssociations(table: IpmaTable): Uint8Array {
  const wideId = table.version >= 1;
  const wideIndex = (table.flags & 1) !== 0;
  const count = new Uint8Array(4);
  new DataView(count.buffer).setUint32(0, table.items.length);
  const rows = table.items.map((item) => {
    const head = new Uint8Array((wideId ? 4 : 2) + 1);
    writeUInt(head, 0, wideId ? 4 : 2, item.id);
    head[head.length - 1] = item.associations.length;
    const assoc = new Uint8Array(item.associations.length * (wideIndex ? 2 : 1));
    item.associations.forEach((entry, index) => {
      const flag = entry.essential ? essentialBitFor(wideIndex) : 0;
      writeUInt(assoc, index * (wideIndex ? 2 : 1), wideIndex ? 2 : 1, flag | entry.index);
    });
    return concat([head, assoc]);
  });
  return writeFullBox('ipma', table.version, table.flags, [count, ...rows]);
}

function essentialBitFor(wide: boolean): number {
  return wide ? 0x8000 : 0x80;
}

// ------------------------------------------------------------------ writing

export function concat(parts: readonly Uint8Array[]): Uint8Array {
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

export function writeBox(type: string, parts: readonly Uint8Array[]): Uint8Array {
  const body = concat(parts);
  const out = new Uint8Array(8 + body.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, out.length);
  for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i) & 0xff;
  out.set(body, 8);
  return out;
}

export function writeFullBox(
  type: string,
  version: number,
  flags: number,
  parts: readonly Uint8Array[],
): Uint8Array {
  const head = new Uint8Array([version, (flags >> 16) & 0xff, (flags >> 8) & 0xff, flags & 0xff]);
  return writeBox(type, [head, ...parts]);
}

/** `mdat` header; 64-bit sizes only when the payload cannot fit in 32 bits. */
export function writeMdatHeader(payloadSize: number): Uint8Array {
  if (payloadSize + 8 <= 0xffffffff) {
    const head = new Uint8Array(8);
    new DataView(head.buffer).setUint32(0, payloadSize + 8);
    head.set([0x6d, 0x64, 0x61, 0x74], 4);
    return head;
  }
  const head = new Uint8Array(16);
  const view = new DataView(head.buffer);
  view.setUint32(0, 1);
  head.set([0x6d, 0x64, 0x61, 0x74], 4);
  view.setUint32(8, Math.floor((payloadSize + 16) / 0x100000000));
  view.setUint32(12, (payloadSize + 16) >>> 0);
  return head;
}
