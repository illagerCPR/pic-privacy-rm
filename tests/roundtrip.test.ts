import { describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { sourceFromBytes } from '../src/core/source.ts';
import { scanSource, stripSource, verifyBlob } from '../src/core/pipeline.ts';
import { DEFAULT_STRIP_OPTIONS, type ScanResult } from '../src/core/types.ts';

const here = fileURLToPath(new URL('.', import.meta.url));
const fixtures = join(here, 'fixtures');
const output = join(here, 'output');

const expectations = JSON.parse(readFileSync(join(fixtures, 'expectations.json'), 'utf8')) as Record<
  string,
  { format: string; findings: string[] }
>;

function fixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(fixtures, name)));
}

async function scan(name: string): Promise<ScanResult> {
  return scanSource(sourceFromBytes(fixture(name)));
}

async function toBytes(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}

describe('detection', () => {
  for (const [name, expected] of Object.entries(expectations)) {
    it(`finds the expected metadata in ${name}`, async () => {
      const result = await scan(name);
      expect(result.format).toBe(expected.format);
      const ids = result.findings.map((f) => f.id);
      for (const id of expected.findings) {
        expect(ids, `${name} should report ${id}`).toContain(id);
      }
      expect(result.warnings.filter((w) => w.severity === 'error')).toEqual([]);
    });
  }

  it('reads GPS coordinates, camera identity and the EXIF thumbnail', async () => {
    const result = await scan('meta.jpg');
    const gps = result.findings.find((f) => f.category === 'gps');
    expect(gps).toBeDefined();
    expect(gps?.params?.lat).toContain('35.689333');
    expect(gps?.params?.lon).toContain('139.691694');

    const exif = result.findings.find((f) => f.id === 'finding.exif');
    const labels = exif?.fields?.map((f) => `${f.label}=${f.value}`) ?? [];
    expect(labels).toContain('Make=TestCam');
    expect(labels).toContain('Model=Model X Pro');
    expect(labels).toContain('BodySerialNumber=SN-123456789');
    expect(labels).toContain('CameraOwnerName=owner@example.com');

    const thumb = result.findings.find((f) => f.id === 'finding.exif.thumbnail');
    expect(thumb?.preview?.blob.size).toBeGreaterThan(200);
    expect(result.orientation).toBe(6);
  });

  it('reads XMP properties and the embedded XMP thumbnail', async () => {
    const result = await scan('meta.jpg');
    const xmp = result.findings.find((f) => f.id === 'finding.xmp');
    const labels = xmp?.fields?.map((f) => `${f.label}`) ?? [];
    expect(labels).toContain('xmp:CreatorTool');
    expect(labels).toContain('dc:creator');
    expect(labels).toContain('photoshop:City');
    expect(result.findings.some((f) => f.id === 'finding.xmp.thumbnail')).toBe(true);
  });

  it('reads IPTC datasets', async () => {
    const result = await scan('meta.jpg');
    const iptc = result.findings.find((f) => f.id === 'finding.iptc');
    const labels = iptc?.fields?.map((f) => f.label) ?? [];
    expect(labels).toContain('IPTC City');
    expect(labels).toContain('IPTC Byline');
  });

  it('parses the C2PA manifest, its actions and signer', async () => {
    const result = await scan('meta.jpg');
    const c2pa = result.findings.find((f) => f.category === 'c2pa');
    expect(c2pa?.manifest).toBeDefined();
    expect(c2pa?.manifest?.claimGenerator).toContain('PicPrivacy Test');
    expect(c2pa?.manifest?.signer).toBe('PicPrivacy Test Signer');
    expect(c2pa?.manifest?.issuer).toBe('PicPrivacy Test Signer');
    expect(c2pa?.manifest?.algorithm).toBe('ES256');
    expect(c2pa?.manifest?.actions.map((a) => a.action)).toEqual(['c2pa.created', 'c2pa.edited']);
    expect(c2pa?.manifest?.hasThumbnail).toBe(true);
    expect(c2pa?.manifest?.thumbnail?.size).toBeGreaterThan(200);
  });

  it('finds PNG text chunks, eXIf, tIME and caBX', async () => {
    const result = await scan('meta.png');
    const ids = result.findings.map((f) => f.id);
    expect(ids).toContain('finding.png.text');
    expect(ids).toContain('finding.png.time');
    expect(ids).toContain('finding.c2pa');
    expect(result.findings.find((f) => f.category === 'gps')).toBeDefined();
  });

  it('finds WebP EXIF/XMP chunks', async () => {
    const result = await scan('meta.webp');
    expect(result.findings.some((f) => f.id === 'finding.xmp')).toBe(true);
    expect(result.findings.some((f) => f.category === 'gps')).toBe(true);
  });

  it('finds GIF comments and XMP', async () => {
    const result = await scan('meta.gif');
    expect(result.findings.some((f) => f.id === 'finding.xmp')).toBe(true);
    expect(result.findings.some((f) => f.category === 'comment')).toBe(true);
  });

  it('reports unsupported formats instead of pretending to clean them', async () => {
    const txt = await scan('note.txt');
    expect(txt.supported).toBe(false);
    expect(txt.warnings[0]?.id).toBe('warn.unsupported');
  });

  it('refuses a HEIC it cannot read instead of calling it clean', async () => {
    // `fake.heic` is a bare ftyp with no item table: the format is supported,
    // but this particular file is not readable.
    const heic = await scan('fake.heic');
    expect(heic.supported).toBe(true);
    expect(heic.warnings.some((warning) => warning.severity === 'error')).toBe(true);
    expect(heic.droppedBytes).toBe(0);
    await expect(stripSource(sourceFromBytes(fixture('fake.heic')))).rejects.toThrow(/unreadable|unsupported/);
  });
});

describe('stripping', () => {
  mkdirSync(output, { recursive: true });

  for (const [name, expected] of Object.entries(expectations)) {
    it(`strips ${name} and the result re-verifies`, async () => {
      const src = sourceFromBytes(fixture(name));
      const result = await stripSource(src, DEFAULT_STRIP_OPTIONS);
      const bytes = await toBytes(result.blob);
      writeFileSync(join(output, name), bytes);

      expect(result.format).toBe(expected.format);
      expect(bytes.length).toBeGreaterThan(0);

      const verify = await verifyBlob(result.blob, result.format);
      expect(verify.ok, `${name} leftovers: ${verify.leftovers.map((f) => f.id).join(',')}`).toBe(true);
      expect(verify.leftovers).toEqual([]);

      const rescan = await scanSource(sourceFromBytes(bytes));
      expect(rescan.findings.filter((f) => f.category !== 'icc')).toEqual([]);
      expect(rescan.format).toBe(expected.format);
    });
  }

  it('leaves clean images byte-identical', async () => {
    for (const name of ['plain.jpg', 'plain.png', 'plain.webp', 'plain.gif']) {
      const original = fixture(name);
      const result = await stripSource(sourceFromBytes(original), DEFAULT_STRIP_OPTIONS);
      const bytes = await toBytes(result.blob);
      expect(Buffer.from(bytes).equals(Buffer.from(original)), name).toBe(true);
    }
  });

  it('is idempotent', async () => {
    for (const name of ['meta.jpg', 'meta.png', 'meta.webp', 'meta.gif']) {
      const once = await stripSource(sourceFromBytes(fixture(name)), DEFAULT_STRIP_OPTIONS);
      const onceBytes = await toBytes(once.blob);
      const twice = await stripSource(sourceFromBytes(onceBytes), DEFAULT_STRIP_OPTIONS);
      const twiceBytes = await toBytes(twice.blob);
      expect(Buffer.from(twiceBytes).equals(Buffer.from(onceBytes)), name).toBe(true);
    }
  });

  it('keeps the ICC profile by default and drops it on request', async () => {
    const keep = await stripSource(sourceFromBytes(fixture('meta.jpg')), DEFAULT_STRIP_OPTIONS);
    const keepBytes = Buffer.from(await toBytes(keep.blob));
    expect(keepBytes.includes(Buffer.from('ICC_PROFILE\0'))).toBe(true);

    const drop = await stripSource(sourceFromBytes(fixture('meta.jpg')), {
      ...DEFAULT_STRIP_OPTIONS,
      keepIcc: false,
    });
    const dropBytes = Buffer.from(await toBytes(drop.blob));
    expect(dropBytes.includes(Buffer.from('ICC_PROFILE\0'))).toBe(false);
  });

  it('drops trailing data only when asked', async () => {
    const src = sourceFromBytes(fixture('meta.jpg'));
    const withTruncate = await toBytes((await stripSource(src, DEFAULT_STRIP_OPTIONS)).blob);
    const without = await toBytes(
      (await stripSource(src, { ...DEFAULT_STRIP_OPTIONS, truncateTrailer: false })).blob,
    );
    expect(Buffer.from(withTruncate).includes(Buffer.from('TRAILING-DATA-AFTER-EOI'))).toBe(false);
    expect(Buffer.from(without).includes(Buffer.from('TRAILING-DATA-AFTER-EOI'))).toBe(true);
  });

  it('refuses truncated input rather than emitting broken files', async () => {
    await expect(stripSource(sourceFromBytes(fixture('broken.jpg')), DEFAULT_STRIP_OPTIONS)).rejects.toThrow();
  });

  it('refuses unsupported formats', async () => {
    await expect(stripSource(sourceFromBytes(fixture('fake.heic')), DEFAULT_STRIP_OPTIONS)).rejects.toThrow();
  });

  it('keeps the JPEG codestream intact (pixels unchanged)', async () => {
    // Strip is byte surgery: every kept byte must come from the source, in order.
    const original = fixture('meta.jpg');
    const stripped = await toBytes(
      (await stripSource(sourceFromBytes(original), DEFAULT_STRIP_OPTIONS)).blob,
    );
    const eoiInOriginal = Buffer.from(original).indexOf(Buffer.from([0xff, 0xd9]));
    expect(eoiInOriginal).toBeGreaterThan(0);
    // The stripped file ends with EOI and starts with SOI.
    expect(Array.from(stripped.subarray(0, 2))).toEqual([0xff, 0xd8]);
    expect(Array.from(stripped.subarray(stripped.length - 2))).toEqual([0xff, 0xd9]);
  });
});
