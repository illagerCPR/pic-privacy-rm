import { describe, expect, it } from 'vitest';

import { hexDump } from '../src/lib/hex.ts';

const bytes = (...values: number[]) => new Uint8Array(values);

describe('hex dump', () => {
  it('lays out one row per eight bytes', () => {
    const rows = hexDump(bytes(1, 2, 3, 4, 5, 6, 7, 8));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.offset).toBe('00000000');
    // Padded so the ASCII column of every row lines up.
    expect(rows[0]?.hex).toBe('01 02 03 04 05 06 07 08');
    expect(rows[0]?.ascii).toBe('........');
  });

  it('continues the offset across rows', () => {
    const input = new Uint8Array(20).fill(0x41);
    const rows = hexDump(input);
    expect(rows).toHaveLength(3);
    expect(rows[0]?.ascii).toBe('AAAAAAAA');
    expect(rows[1]?.offset).toBe('00000008');
    expect(rows[1]?.ascii).toBe('AAAAAAAA');
    expect(rows[2]?.offset).toBe('00000010');
    expect(rows[2]?.hex).toBe('41 41 41 41'.padEnd(23, ' '));
    expect(rows[2]?.ascii).toBe('AAAA');
  });

  it('shows printable bytes and dots for the rest', () => {
    // 0x48 'H', 0x69 'i', 0x00, 0xff, 0x7e '~'
    const rows = hexDump(bytes(0x48, 0x69, 0x00, 0xff, 0x7e));
    expect(rows[0]?.ascii).toBe('Hi..~');
    expect(rows[0]?.hex.startsWith('48 69 00 ff 7e')).toBe(true);
  });

  it('honours the byte limit and reports nothing for an empty payload', () => {
    const input = new Uint8Array(64).fill(0x2a);
    expect(hexDump(input, 9)).toHaveLength(2);
    expect(hexDump(input, 0)).toEqual([]);
    expect(hexDump(new Uint8Array(0))).toEqual([]);
  });

  it('defaults to 128 bytes so a large blob cannot flood the drawer', () => {
    expect(hexDump(new Uint8Array(4096))).toHaveLength(16);
  });
});
