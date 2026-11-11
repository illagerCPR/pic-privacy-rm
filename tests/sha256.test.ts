import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Sha256, sha256Blob } from '../src/lib/sha256.ts';

const hex = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

describe('incremental SHA-256', () => {
  it('matches the standard vectors', () => {
    expect(new Sha256().digest()).toBe(hex(new Uint8Array()));
    const abc = new TextEncoder().encode('abc');
    expect(new Sha256().update(abc).digest()).toBe(hex(abc));
    const long = new TextEncoder().encode(
      'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq',
    );
    expect(new Sha256().update(long).digest()).toBe(hex(long));
  });

  it('matches Node across every chunk boundary', () => {
    const bytes = new Uint8Array(100_003);
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = (index * 31 + 7) & 0xff;
    for (const size of [1, 63, 64, 65, 1000, 4096]) {
      const hash = new Sha256();
      for (let offset = 0; offset < bytes.length; offset += size) {
        hash.update(bytes.subarray(offset, offset + size));
      }
      expect(hash.digest(), `chunk size ${size}`).toBe(hex(bytes));
    }
  });

  it('streams a Blob without changing the answer', async () => {
    const bytes = new Uint8Array(50_000).fill(0x5a);
    expect(await sha256Blob(new Blob([bytes]), 4096)).toBe(hex(bytes));
  });
});
