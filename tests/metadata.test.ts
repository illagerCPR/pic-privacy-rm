import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { indexOfBytes } from '../src/core/bytes.ts';
import { summarizeExifBlock } from '../src/core/exif.ts';
import { inspectExifBlock, makeReport } from '../src/core/metadata.ts';

const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));
const EXIF_HEADER = new TextEncoder().encode('Exif\0\0');

function fixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(FIXTURES + name));
}

/** Pull the TIFF payload out of the first APP1/Exif segment. */
function exifBlockOf(name: string): Uint8Array {
  const bytes = fixture(name);
  const at = indexOfBytes(bytes, EXIF_HEADER);
  expect(at).toBeGreaterThan(0);
  return bytes.subarray(at + EXIF_HEADER.length);
}

describe('full metadata listing', () => {
  const block = exifBlockOf('meta.jpg');
  const groups = inspectExifBlock(block);
  if (!groups) throw new Error('meta.jpg should carry a readable EXIF block');

  const group = (id: string) => groups.find((entry) => entry.id === id);
  const item = (id: string, name: string) => group(id)?.items.find((entry) => entry.name === name);

  it('keeps IFD0, Exif and GPS as separate groups, in directory order', () => {
    expect(groups.map((entry) => entry.id)).toEqual(['ifd0', 'exif', 'gps', 'ifd1']);
    expect(group('ifd0')?.titleKey).toBe('meta.group.ifd0');
  });

  it('shows the thumbnail directory instead of dropping it', () => {
    // IFD1 only exists because the fixture embeds a thumbnail.
    expect(group('ifd1')?.items.length).toBe(3);
    expect(item('ifd1', 'JPEGInterchangeFormat')?.value).toMatch(/^at byte \d+$/);
    expect(item('ifd1', 'JPEGInterchangeFormatLength')?.value).toMatch(/^\d+$/);
    expect(item('ifd1', 'Compression')?.value).toBe('6 (JPEG (old-style))');
  });

  it('lists every entry, including the IFD pointers the report hides', () => {
    // 8 written tags + ExifIFDPointer + GPSInfoIFDPointer.
    expect(group('ifd0')?.items.length).toBe(10);
    expect(item('ifd0', 'ExifIFDPointer')).toBeDefined();
    expect(item('ifd0', 'GPSInfoIFDPointer')).toBeDefined();
    expect(group('exif')?.items.length).toBe(11);
    expect(group('gps')?.items.length).toBe(9);
  });

  it('carries the raw id, type and count for each entry', () => {
    const make = item('ifd0', 'Make');
    expect(make).toMatchObject({ id: '0x010f', type: 'ASCII', count: 8, value: 'TestCam' });
    const orientation = item('ifd0', 'Orientation');
    expect(orientation).toMatchObject({ id: '0x0112', type: 'SHORT', count: 1 });
  });

  it('decodes enumerations and units instead of dumping raw numbers', () => {
    expect(item('ifd0', 'Orientation')?.value).toBe('6 (Rotate 90 CW)');
    expect(item('exif', 'ExposureTime')?.value).toBe('1/125 s');
    expect(item('exif', 'FNumber')?.value).toBe('f/2.8');
    expect(item('exif', 'FocalLength')?.value).toBe('50 mm');
    expect(item('exif', 'ISOSpeedRatings')?.value).toBe('100');
  });

  it('renders GPS coordinates in degrees, minutes and seconds', () => {
    expect(item('gps', 'GPSLatitude')?.value).toBe(`35° 41' 21.6"`);
    expect(item('gps', 'GPSLongitude')?.value).toBe(`139° 41' 30.1"`);
    expect(item('gps', 'GPSLatitudeRef')?.value).toBe('N');
    expect(item('gps', 'GPSAltitude')?.value).toBe('44 m');
    expect(item('gps', 'GPSAltitudeRef')?.value).toBe('Above sea level');
    expect(item('gps', 'GPSTimeStamp')?.value).toBe('03:04:05');
  });

  it('decodes vendor blobs and free text without hiding them', () => {
    const makerNote = item('exif', 'MakerNote');
    expect(makerNote?.value).toBe('0102030405060708');
    expect(makerNote?.bytes?.length).toBe(8);
    expect(makerNote?.size).toBe(8);
    expect(item('exif', 'UserComment')?.value).toBe('a private note');
    expect(item('ifd0', 'XPTitle')?.value).toBe('Secret title');
  });

  it('reports more entries than the privacy summary, which filters and dedupes', () => {
    const summary = summarizeExifBlock(block);
    const report = makeReport(groups);
    expect(summary).not.toBeNull();
    expect(report.total).toBeGreaterThan(summary?.fields.length ?? 0);
    expect(report.total).toBe(
      report.groups.reduce((sum, entry) => sum + entry.items.length, 0),
    );
  });

  it('marks every EXIF group as removed, because the whole segment goes', () => {
    expect(groups.every((entry) => entry.removed)).toBe(true);
  });

  it('returns null rather than throwing on data that is not TIFF', () => {
    expect(inspectExifBlock(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toBeNull();
    expect(inspectExifBlock(new Uint8Array(0))).toBeNull();
  });
});

describe('metadata listing edge cases', () => {
  it('does not blow up on a truncated directory', () => {
    const block = exifBlockOf('meta.jpg');
    const truncated = block.subarray(0, 40);
    const groups = inspectExifBlock(truncated);
    // Either it refuses the block or it lists whatever survived — never throws.
    expect(groups === null || Array.isArray(groups)).toBe(true);
  });

  it('survives an absurd directory entry count', () => {
    const block = exifBlockOf('meta.jpg').slice();
    // IFD0 entry count lives at offset 8; claim 0xffff entries.
    block[8] = 0xff;
    block[9] = 0xff;
    expect(() => inspectExifBlock(block)).not.toThrow();
  });
});
