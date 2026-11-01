/** Tiny CBOR decoder — just enough to read C2PA claims and COSE headers. */

export type CborValue =
  | number
  | string
  | boolean
  | null
  | Uint8Array
  | CborValue[]
  | CborMap;

export interface CborMap {
  [key: string]: CborValue;
}

class Reader {
  readonly bytes: Uint8Array;
  pos = 0;
  depth = 0;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }

  byte(): number {
    const v = this.bytes[this.pos];
    if (v === undefined) throw new Error('cbor: unexpected end');
    this.pos += 1;
    return v;
  }

  take(len: number): Uint8Array {
    if (this.pos + len > this.bytes.length) throw new Error('cbor: truncated');
    const out = this.bytes.subarray(this.pos, this.pos + len);
    this.pos += len;
    return out;
  }

  /** Read a head: major type + argument. */
  head(): { major: number; info: number; value: number } {
    const first = this.byte();
    const major = first >> 5;
    const info = first & 0x1f;
    let value = info;
    if (info >= 24 && info <= 27) {
      const len = 1 << (info - 24);
      value = 0;
      for (let i = 0; i < len; i += 1) value = value * 256 + this.byte();
    }
    return { major, info, value };
  }

  decode(): CborValue {
    if (this.depth > 32) throw new Error('cbor: nesting too deep');
    this.depth += 1;
    try {
      const { major, info, value } = this.head();
      switch (major) {
        case 0:
          return value;
        case 1:
          return -1 - value;
        case 2: {
          if (info === 31) return this.chunkedBytes();
          return this.take(value).slice();
        }
        case 3: {
          if (info === 31) return this.chunkedText();
          return new TextDecoder('utf-8', { fatal: false }).decode(this.take(value));
        }
        case 4: {
          const out: CborValue[] = [];
          if (info === 31) {
            while (this.bytes[this.pos] !== 0xff) out.push(this.decode());
            this.pos += 1;
            return out;
          }
          for (let i = 0; i < value; i += 1) out.push(this.decode());
          return out;
        }
        case 5: {
          const out: CborMap = {};
          const readPair = () => {
            const k = this.decode();
            const v = this.decode();
            const key = typeof k === 'string' ? k : typeof k === 'number' ? String(k) : JSON.stringify(k);
            out[key] = v;
          };
          if (info === 31) {
            while (this.bytes[this.pos] !== 0xff) readPair();
            this.pos += 1;
            return out;
          }
          for (let i = 0; i < value; i += 1) readPair();
          return out;
        }
        case 6:
          return this.decode();
        case 7: {
          if (info === 20) return false;
          if (info === 21) return true;
          if (info === 22) return null;
          if (info === 25) {
            const b = this.take(2);
            const half = ((b[0] ?? 0) << 8) | (b[1] ?? 0);
            const sign = half & 0x8000 ? -1 : 1;
            const exp = (half >> 10) & 0x1f;
            const frac = half & 0x3ff;
            if (exp === 0) return sign * frac * 2 ** -24;
            if (exp === 31) return sign * Infinity;
            return sign * (1 + frac / 1024) * 2 ** (exp - 15);
          }
          if (info === 26) {
            const b = this.take(4);
            const dv = new DataView(new Uint8Array(b).buffer);
            return dv.getFloat32(0, false);
          }
          if (info === 27) {
            const b = this.take(8);
            const dv = new DataView(new Uint8Array(b).buffer);
            return dv.getFloat64(0, false);
          }
          return null;
        }
        default:
          return null;
      }
    } finally {
      this.depth -= 1;
    }
  }

  chunkedBytes(): Uint8Array {
    const parts: Uint8Array[] = [];
    let total = 0;
    while (this.bytes[this.pos] !== 0xff) {
      const piece = this.take(this.head().value);
      parts.push(piece);
      total += piece.length;
    }
    this.pos += 1;
    const out = new Uint8Array(total);
    let at = 0;
    for (const p of parts) {
      out.set(p, at);
      at += p.length;
    }
    return out;
  }

  chunkedText(): string {
    let s = '';
    while (this.bytes[this.pos] !== 0xff) {
      s += new TextDecoder('utf-8', { fatal: false }).decode(this.take(this.head().value));
    }
    this.pos += 1;
    return s;
  }
}

export function decodeCbor(bytes: Uint8Array): CborValue {
  return new Reader(bytes).decode();
}

export function asMap(value: CborValue): CborMap | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Uint8Array)
    ? (value as CborMap)
    : null;
}

export function asString(value: CborValue | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
