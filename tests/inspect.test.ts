import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { inspectSource } from '../src/core/inspect.ts';
import type { MetadataGroup, MetadataReport } from '../src/core/metadata.ts';
import { sourceFromBytes } from '../src/core/source.ts';

const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));

async function inspect(name: string, keepIcc = true): Promise<MetadataReport> {
  const bytes = new Uint8Array(readFileSync(FIXTURES + name));
  return inspectSource(sourceFromBytes(bytes), { keepIcc });
}

function groupOf(report: MetadataReport, id: MetadataGroup['id']): MetadataGroup | undefined {
  return report.groups.find((entry) => entry.id === id);
}

function itemNamed(report: MetadataReport, id: MetadataGroup['id'], name: string) {
  return groupOf(report, id)?.items.find((entry) => entry.name === name);
}

describe('JPEG full metadata', () => {
  it('walks every carrier in file order', async () => {
    const report = await inspect('meta.jpg');
    expect(report.groups.map((entry) => entry.id)).toEqual([
      'file',
      'ifd0',
      'exif',
      'gps',
      'ifd1',
      'xmp',
      'iptc',
      'c2pa',
      'text',
      'container',
    ]);
  });

  it('lists XMP properties under their qualified names', async () => {
    const report = await inspect('meta.jpg');
    const xmp = groupOf(report, 'xmp');
    expect(xmp?.items.length).toBeGreaterThan(10);
    expect(xmp?.items.some((entry) => entry.name.startsWith('dc:'))).toBe(true);
    expect(xmp?.items.some((entry) => entry.name.startsWith('xmlns:'))).toBe(true);
  });

  it('decodes IPTC-IIM datasets from the Photoshop segment', async () => {
    const report = await inspect('meta.jpg');
    const iptc = groupOf(report, 'iptc');
    expect(iptc?.items).toContainEqual({ name: 'City', id: '2:90', value: 'Berlin' });
    expect(iptc?.items).toContainEqual({ name: 'CountryName', id: '2:101', value: 'Germany' });
    expect(iptc?.items).toContainEqual({ name: 'Byline', id: '2:80', value: 'Jane Doe' });
  });

  it('summarises C2PA manifests, including the signing certificate', async () => {
    const report = await inspect('meta.jpg');
    const c2pa = groupOf(report, 'c2pa');
    expect(c2pa?.items).toContainEqual({
      name: 'c2pa.manifest · signer',
      value: 'PicPrivacy Test Signer',
    });
    expect(c2pa?.items).toContainEqual({ name: 'c2pa.manifest · cert valid from', value: '2024-01-01' });
    expect(c2pa?.items.some((entry) => entry.name === 'JUMBF boxes')).toBe(true);
  });

  it('keeps comments and unknown APPn in their own groups', async () => {
    const report = await inspect('meta.jpg');
    const text = groupOf(report, 'text');
    expect(text?.items.some((entry) => entry.name === 'COM comment')).toBe(true);
    expect(groupOf(report, 'container')?.items.some((entry) => entry.name === 'APP5')).toBe(true);
  });
});

describe('PNG full metadata', () => {
  it('pulls XMP out of an iTXt chunk', async () => {
    const report = await inspect('meta.png');
    const xmp = groupOf(report, 'xmp');
    expect(xmp?.items.length).toBeGreaterThan(10);
    expect(xmp?.items.some((entry) => entry.name.startsWith('dc:'))).toBe(true);
  });

  it('decodes plain, deflated and timestamp text chunks', async () => {
    const report = await inspect('meta.png');
    const text = groupOf(report, 'text');
    expect(text?.items.map((entry) => entry.name)).toEqual([
      'tEXt Author',
      'zTXt Comment',
      'tIME (last modified)',
    ]);
    expect(text?.items[0]?.value).toBe('Jane Doe');
    // Inflated from the deflate stream, so this proves decompression ran.
    expect(text?.items[1]?.value).toBe('a compressed private note');
    expect(text?.items[2]?.value).toBe('2024-05-04 12:00:00 UTC');
  });

  it('reads EXIF from the eXIf chunk and C2PA from caBX', async () => {
    const report = await inspect('meta.png');
    expect(itemNamed(report, 'ifd0', 'Make')?.value).toBe('TestCam');
    expect(groupOf(report, 'c2pa')?.items.length).toBeGreaterThan(5);
  });
});

describe('WebP full metadata', () => {
  it('reads EXIF, XMP and C2PA chunks', async () => {
    const report = await inspect('meta.webp');
    expect(itemNamed(report, 'ifd0', 'Model')?.value).toBe('Model X Pro');
    expect(groupOf(report, 'xmp')?.items.length).toBeGreaterThan(10);
    expect(groupOf(report, 'c2pa')?.items.length).toBeGreaterThan(5);
  });
});

describe('GIF full metadata', () => {
  it('reads the comment extension and the XMP application extension', async () => {
    const report = await inspect('meta.gif');
    expect(itemNamed(report, 'text', 'Comment')?.value).toBe('secret gif comment');
    expect(groupOf(report, 'xmp')?.items.length).toBeGreaterThan(10);
  });

  it('keeps the NETSCAPE looping extension out of the removed set', async () => {
    const report = await inspect('meta.gif');
    const loop = groupOf(report, 'container')?.items.find((entry) => entry.name === 'Application NETSCAPE2.0');
    expect(loop?.removed).toBe(false);
  });
});

describe('strip settings are reflected in the listing', () => {
  it('marks the ICC profile as kept or removed depending on the option', async () => {
    const kept = await inspect('meta.jpg', true);
    const dropped = await inspect('meta.jpg', false);
    expect(itemNamed(kept, 'container', 'ICC profile')?.removed).toBe(false);
    expect(itemNamed(dropped, 'container', 'ICC profile')?.removed).toBe(true);
  });
});

describe('edge cases', () => {
  it('reports only the file group for a format it cannot read', async () => {
    const report = await inspect('fake.heic');
    expect(report.groups.map((entry) => entry.id)).toEqual(['file']);
    expect(report.total).toBe(2);
    expect(report.groups[0]?.removed).toBe(false);
  });

  it('does not throw on a truncated or corrupt file', async () => {
    for (const name of ['broken.jpg', 'note.txt']) {
      await expect(inspect(name)).resolves.toBeDefined();
    }
  });

  it('counts every listed row', async () => {
    const report = await inspect('meta.jpg');
    expect(report.total).toBe(report.groups.reduce((sum, entry) => sum + entry.items.length, 0));
  });
});
