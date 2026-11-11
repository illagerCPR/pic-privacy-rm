/** JUMBF box reader (ISO/IEC 19566-5), the container C2PA manifests live in. */
import { ascii, decodeText, u32be, u64be } from './bytes.ts';

export interface JumbfBox {
  /** Box type, e.g. `jumb` (superbox), `jumd` (description), `json`, `cbor`. */
  type: string;
  /** Type UUID for superboxes, dashed hex form; empty for plain boxes. */
  uuid: string;
  label: string;
  toggles?: number;
  offset: number;
  length: number;
  payload: Uint8Array;
  children?: JumbfBox[];
}

const MAX_DEPTH = 12;
const MAX_BOXES = 2000;

function uuidHex(bytes: Uint8Array): string {
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function parseDescription(payload: Uint8Array): { uuid: string; label: string; toggles: number } {
  if (payload.length < 17) return { uuid: '', label: '', toggles: 0 };
  const uuid = uuidHex(payload.subarray(0, 16));
  const toggles = payload[16] ?? 0;
  const rest = payload.subarray(17);
  const nul = rest.indexOf(0);
  const candidate = decodeText(rest.subarray(0, nul >= 0 ? nul : Math.min(rest.length, 96)));
  const label = /^[\x20-\x7e]+$/.test(candidate) ? candidate : '';
  return { uuid, label, toggles };
}

interface RawBox {
  type: string;
  headerLen: number;
  length: number;
  payload: Uint8Array;
  offset: number;
}

function readBox(data: Uint8Array, pos: number, end: number): RawBox | null {
  if (pos + 8 > end) return null;
  const lbox = u32be(data, pos);
  const type = ascii(data, pos + 4, 4);
  let length = lbox;
  let headerLen = 8;
  if (lbox === 1) {
    if (pos + 16 > end) return null;
    length = u64be(data, pos + 8);
    headerLen = 16;
  } else if (lbox === 0) {
    length = end - pos;
  }
  if (length < headerLen || pos + length > end || length <= 0) {
    return null;
  }
  return {
    type,
    headerLen,
    length,
    payload: data.subarray(pos + headerLen, pos + length),
    offset: pos,
  };
}

export function parseJumbf(data: Uint8Array): JumbfBox[] {
  let count = 0;

  const parseLevel = (start: number, end: number, depth: number): JumbfBox[] => {
    const boxes: JumbfBox[] = [];
    let pos = start;
    while (pos + 8 <= end && count < MAX_BOXES) {
      const raw = readBox(data, pos, end);
      if (!raw) break;
      count += 1;
      const box: JumbfBox = {
        type: raw.type,
        uuid: '',
        label: '',
        offset: raw.offset,
        length: raw.length,
        payload: raw.payload,
      };
      if (raw.type === 'jumb' && depth < MAX_DEPTH) {
        const children = parseLevel(pos + raw.headerLen, pos + raw.length, depth + 1);
        box.children = children;
        const desc = children.find((c) => c.type === 'jumd');
        if (desc && desc.payload.length >= 17) {
          const parsed = parseDescription(desc.payload);
          box.uuid = parsed.uuid;
          box.label = parsed.label;
          box.toggles = parsed.toggles;
        }
      } else if (raw.type === 'jumd') {
        const parsed2 = parseDescription(raw.payload);
        box.uuid = parsed2.uuid;
        box.label = parsed2.label;
        box.toggles = parsed2.toggles;
      }
      boxes.push(box);
      pos += raw.length;
    }
    return boxes;
  };

  return parseLevel(0, data.length, 0);
}

/** Flatten a box tree into a list of superboxes carrying a label. */
export function walkJumbf(boxes: readonly JumbfBox[]): JumbfBox[] {
  const out: JumbfBox[] = [];
  const visit = (list: readonly JumbfBox[]) => {
    for (const box of list) {
      out.push(box);
      if (box.children) visit(box.children);
    }
  };
  visit(boxes);
  return out;
}

export function findBox(
  boxes: readonly JumbfBox[],
  predicate: (box: JumbfBox) => boolean,
): JumbfBox | undefined {
  for (const box of boxes) {
    if (predicate(box)) return box;
    if (box.children) {
      const hit = findBox(box.children, predicate);
      if (hit) return hit;
    }
  }
  return undefined;
}
