import { crc32 as zlibCrc32 } from 'node:zlib';
import { describe, expect, it } from 'vitest';

import { crc32 } from '../src/core/crc32.ts';

function sample(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let index = 0; index < length; index += 1) bytes[index] = (index * 31 + 7) & 0xff;
  return bytes;
}

describe('crc32', () => {
  it('matches zlib for every alignment', () => {
    for (const length of [0, 1, 2, 7, 8, 9, 15, 16, 17, 4096, 100_003]) {
      const bytes = sample(length);
      expect(crc32(bytes), `length ${length}`).toBe(zlibCrc32(Buffer.from(bytes)));
    }
  });

  it('checksums subarrays without touching the surrounding bytes', () => {
    const bytes = sample(1024);
    const slice = bytes.subarray(100, 300);
    expect(crc32(slice)).toBe(zlibCrc32(Buffer.from(slice)));
  });

  it('chains across chunks, the way the ZIP writer feeds it', () => {
    const left = sample(1_000);
    const right = sample(3_000);
    const joined = new Uint8Array(4_000);
    joined.set(left, 0);
    joined.set(right, left.length);
    expect(crc32(right, crc32(left))).toBe(crc32(joined));
  });
});
