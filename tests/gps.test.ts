import { describe, expect, it } from 'vitest';

import { describeGps } from '../src/core/gps.ts';
import type { TiffIfd, TiffTag } from '../src/core/tiff.ts';

function rational(tag: number, nums: number[]): TiffTag {
  return { tag, type: 5, count: nums.length, value: { type: 5, count: nums.length, nums } };
}

function textTag(tag: number, text: string): TiffTag {
  return { tag, type: 2, count: text.length + 1, value: { type: 2, count: text.length + 1, nums: [], text } };
}

function gpsIfd(tags: TiffTag[]): TiffIfd {
  return { kind: 'gps', offset: 0, tags, next: 0 };
}

const ZERO_LAT = [0, 1, 0, 1, 0, 1];
const ZERO_LON = [0, 1, 0, 1, 0, 1];

describe('GPS coordinates', () => {
  it('ignores an all-zero GPS block instead of inventing a location', () => {
    // vivo and several Android skins write this when the camera has no fix.
    const ifd = gpsIfd([
      textTag(0x0001, ''),
      rational(0x0002, ZERO_LAT),
      textTag(0x0003, ''),
      rational(0x0004, ZERO_LON),
      rational(0x0006, [0, 1]),
      rational(0x0007, [0, 1, 0, 1, 0, 1]),
    ]);
    expect(describeGps(ifd)).toBeNull();
  });

  it('still reports a fix that only shares one zero axis', () => {
    const ifd = gpsIfd([
      textTag(0x0001, 'N'),
      rational(0x0002, ZERO_LAT),
      textTag(0x0003, 'E'),
      rational(0x0004, [139, 1, 41, 1, 301, 10]),
    ]);
    expect(describeGps(ifd)?.lonText).toBe('139.691694° E');
  });

  it('formats real coordinates and flags them as sensitive', () => {
    const ifd = gpsIfd([
      textTag(0x0001, 'N'),
      rational(0x0002, [35, 1, 41, 1, 216, 10]),
      textTag(0x0003, 'E'),
      rational(0x0004, [139, 1, 41, 1, 301, 10]),
      rational(0x0006, [44, 1]),
    ]);
    const info = describeGps(ifd);
    expect(info).not.toBeNull();
    expect(info?.latText).toBe('35.689333° N');
    expect(info?.lonText).toBe('139.691694° E');
    expect(info?.mapUrl).toContain('35.689333');
    expect(info?.fields.every((field) => field.sensitive)).toBe(true);
  });
});
