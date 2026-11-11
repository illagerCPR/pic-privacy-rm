/** Small, bounds-safe helpers for reading binary data. */

export function u8(b: Uint8Array, o: number): number {
  const v = b[o];
  return v === undefined ? 0 : v;
}

export function u16be(b: Uint8Array, o: number): number {
  return (u8(b, o) << 8) | u8(b, o + 1);
}

export function u16le(b: Uint8Array, o: number): number {
  return u8(b, o) | (u8(b, o + 1) << 8);
}

export function u32be(b: Uint8Array, o: number): number {
  return u8(b, o) * 0x1000000 + ((u8(b, o + 1) << 16) | (u8(b, o + 2) << 8) | u8(b, o + 3));
}

export function u32le(b: Uint8Array, o: number): number {
  return (u8(b, o) | (u8(b, o + 1) << 8) | (u8(b, o + 2) << 16)) + u8(b, o + 3) * 0x1000000;
}

/** 64-bit big-endian read; values above Number.MAX_SAFE_INTEGER are clamped. */
export function u64be(b: Uint8Array, o: number): number {
  const hi = u32be(b, o);
  const lo = u32be(b, o + 4);
  const v = hi * 0x100000000 + lo;
  return v > Number.MAX_SAFE_INTEGER ? Number.MAX_SAFE_INTEGER : v;
}

export function ascii(b: Uint8Array, o: number, len: number): string {
  let s = '';
  const end = Math.min(b.length, o + len);
  for (let i = Math.max(0, o); i < end; i += 1) s += String.fromCharCode(b[i] ?? 0);
  return s;
}

export function startsWithBytes(b: Uint8Array, o: number, prefix: string): boolean {
  if (o < 0 || o + prefix.length > b.length) return false;
  for (let i = 0; i < prefix.length; i += 1) {
    if (b[o + i] !== prefix.charCodeAt(i)) return false;
  }
  return true;
}

export function indexOfBytes(haystack: Uint8Array, needle: Uint8Array, from = 0): number {
  if (needle.length === 0) return from;
  const last = haystack.length - needle.length;
  outer: for (let i = Math.max(0, from); i <= last; i += 1) {
    for (let j = 0; j < needle.length; j += 1) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

export function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** True when every byte is printable ASCII / common whitespace. */
export function isMostlyPrintable(b: Uint8Array, ratio = 0.9): boolean {
  if (b.length === 0) return false;
  let good = 0;
  for (const c of b) {
    if ((c >= 0x20 && c <= 0x7e) || c === 0x09 || c === 0x0a || c === 0x0d) good += 1;
  }
  return good / b.length >= ratio;
}

export function trimNul(s: string): string {
  const at = s.indexOf('\u0000');
  return (at === -1 ? s : s.slice(0, at)).trim();
}

/** Decode bytes as UTF-8, falling back to Latin-1 on invalid sequences. */
export function decodeText(b: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(b);
  } catch {
    let s = '';
    for (const c of b) s += String.fromCharCode(c);
    return s;
  }
}

export function decodeUtf16le(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i + 1 < b.length; i += 2) {
    s += String.fromCharCode((b[i] ?? 0) | ((b[i + 1] ?? 0) << 8));
  }
  return s;
}
