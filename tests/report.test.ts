import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { scanFile, stripFile } from '../src/core/pipeline.ts';
import { DEFAULT_STRIP_OPTIONS } from '../src/core/types.ts';
import {
  BATCH_SCHEMA,
  batchReportName,
  buildBatchReport,
  buildReport,
  REPORT_SCHEMA,
  reportFileName,
} from '../src/lib/report.ts';

const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));
const bytes = new Uint8Array(readFileSync(FIXTURES + 'meta.jpg'));
const file = new File([bytes], 'meta.jpg', { type: 'image/jpeg' });

async function parsed(options: Parameters<typeof buildReport>[0]) {
  return JSON.parse(await buildReport(options)) as Record<string, any>;
}

describe('diagnostic report', () => {
  it('records what the scan saw and hashes the exact input', async () => {
    const scan = await scanFile(file);
    const report = await parsed({ file, scan, options: DEFAULT_STRIP_OPTIONS, bake: false });

    expect(report.schema).toBe(REPORT_SCHEMA);
    expect(report.app.name).toBe('PicPrivacy');
    expect(report.file).toMatchObject({ name: 'meta.jpg', size: bytes.length, format: 'jpeg', supported: true });
    expect(report.file.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(report.settings).toEqual({ truncateTrailer: true, keepIcc: true, bake: false });
  });

  it('keeps findings readable but turns every payload into a size', async () => {
    const scan = await scanFile(file);
    const json = await buildReport({ file, scan, options: DEFAULT_STRIP_OPTIONS, bake: false });
    const report = JSON.parse(json) as any;

    expect(report.scan.findings.length).toBe(scan.findings.length);
    const gps = report.scan.findings.find((finding: any) => finding.category === 'gps');
    expect(gps.params.lat).toMatch(/^35\.689/);

    const withPreview = report.scan.findings.find((finding: any) => finding.preview);
    expect(withPreview.preview.bytes).toBeGreaterThan(0);
    expect(withPreview.preview.mime).toMatch(/^image\//);

    // No binary ever reaches the JSON, and a Blob must not stringify into `{}`.
    expect(json).not.toContain('data:image');
    expect(json).not.toContain('[object Blob]');
    for (const finding of report.scan.findings) {
      if (finding.manifest) expect(finding.manifest.thumbnail?.bytes ?? 0).toBeLessThan(1e7);
    }
  });

  it('adds the verification block only for a cleaned file', async () => {
    const scan = await scanFile(file);
    const outcome = await stripFile(file, DEFAULT_STRIP_OPTIONS);
    const report = await parsed({
      file,
      scan,
      options: DEFAULT_STRIP_OPTIONS,
      bake: false,
      result: {
        size: outcome.result.blob.size,
        filename: 'meta-clean.jpg',
        removed: outcome.result.removed,
        removedBytes: outcome.result.removedBytes,
        reencoded: false,
        verify: outcome.verify,
      },
    });

    expect(report.result.size).toBe(outcome.result.blob.size);
    expect(report.result.removedBytes).toBeGreaterThan(0);
    expect(report.result.verify.ok).toBe(true);
    expect(report.result.verify.leftovers).toEqual([]);
  });

  it('packs every file into one batch document', async () => {
    const scan = await scanFile(file);
    const progress: number[] = [];
    const json = await buildBatchReport(
      [
        { file, scan, options: DEFAULT_STRIP_OPTIONS, bake: false },
        { file, scan, options: DEFAULT_STRIP_OPTIONS, bake: false },
      ],
      (done) => progress.push(done),
    );
    const doc = JSON.parse(json) as any;

    expect(doc.schema).toBe(BATCH_SCHEMA);
    expect(doc.count).toBe(2);
    expect(doc.files).toHaveLength(2);
    // Each entry stands alone: the same body a single export would produce.
    expect(doc.files[0].schema).toBe(REPORT_SCHEMA);
    expect(doc.files[1].file.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(progress).toEqual([1, 2]);
  });

  it('names the batch document after the moment it was built', () => {
    expect(batchReportName(new Date(2026, 10, 1, 9, 5))).toBe('picprivacy-reports-20261101-0905.json');
  });

  it('names the file after the original', () => {
    expect(reportFileName('IMG_0042.HEIC')).toBe('report-IMG_0042.json');
    expect(reportFileName('no-extension')).toBe('report-no-extension.json');
  });
});
