import { expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractZip } from './zip.ts';

const here = fileURLToPath(new URL('.', import.meta.url));
const fixtures = join(here, '..', 'tests', 'fixtures');
const outDir = join(here, 'downloads');

const FORBIDDEN = [
  'Exif\u0000\u0000',
  'http://ns.adobe.com/xap/1.0/',
  'Photoshop 3.0\u0000',
  'c2pa',
  'caBX',
  'XMP DataXMP',
];

function assertClean(name: string, bytes: Uint8Array) {
  const text = Buffer.from(bytes).toString('latin1');
  for (const marker of FORBIDDEN) {
    expect(text.includes(marker), `${name} still contains ${JSON.stringify(marker)}`).toBe(false);
  }
  const magic = Array.from(bytes.subarray(0, 4));
  const isJpeg = magic[0] === 0xff && magic[1] === 0xd8;
  const isPng = magic[0] === 0x89 && magic[1] === 0x50;
  const isWebp = Buffer.from(bytes.subarray(0, 4)).toString('latin1') === 'RIFF';
  const isGif = Buffer.from(bytes.subarray(0, 3)).toString('latin1') === 'GIF';
  const isTiff = magic[0] === 0x49 && magic[1] === 0x49 && (magic[2] === 0x2a || magic[2] === 0x2b) && magic[3] === 0x00;
  expect(isJpeg || isPng || isWebp || isGif || isTiff, `${name} has an unknown signature`).toBe(true);
}

test.beforeAll(() => {
  mkdirSync(outDir, { recursive: true });
});

test('scans, strips and packages images entirely in the browser', async ({ page }) => {
  const externalRequests: string[] = [];
  page.on('request', (request) => {
    const url = request.url();
    if (!url.startsWith('http://127.0.0.1:5188') && !url.startsWith('data:') && !url.startsWith('blob:')) {
      externalRequests.push(url);
    }
  });

  const consoleErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });

  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('隐私');

  await page.setInputFiles('input[type=file] >> nth=0', [
    join(fixtures, 'meta.jpg'),
    join(fixtures, 'meta.png'),
    join(fixtures, 'meta.webp'),
    join(fixtures, 'meta.gif'),
    join(fixtures, 'plain.jpg'),
  ]);

  // Detection finishes for all five files.
  await expect(page.locator('.file-row')).toHaveCount(5);
  await expect(page.locator('.status', { hasText: '扫描中' })).toHaveCount(0);
  await expect(page.getByText('GPS', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('C2PA', { exact: true }).first()).toBeVisible();

  // "Already clean" is reported honestly.
  await expect(page.locator('.file-row--clean')).toHaveCount(1);

  // Details drawer shows coordinates and the manifest signer.
  await page.locator('.file-row', { hasText: 'meta.jpg' }).locator('button[aria-label^="查看详情"]').click();
  const drawer = page.locator('.drawer');
  await expect(drawer).toBeVisible();
  await expect(drawer).toContainText('35.689333');
  await expect(drawer).toContainText('PicPrivacy Test Signer');
  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();

  // Clean everything.
  await page.getByRole('button', { name: '全部清理' }).click();
  await expect(page.locator('.file-row--done')).toHaveCount(4, { timeout: 30_000 });
  await expect(page.getByText('复检通过').first()).toBeVisible();

  // Download the batch and inspect the archive.
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '下载全部 (.zip)' }).click();
  const download = await downloadPromise;
  const zipPath = join(outDir, 'batch.zip');
  await download.saveAs(zipPath);
  // Python's zipfile is an independent reader: it validates every CRC-32.
  const members = extractZip(zipPath, join(outDir, 'batch'));
  const names = members.map((member) => member.name).sort();
  writeFileSync(join(outDir, 'names.txt'), names.join('\n'));
  expect(names).toHaveLength(5);
  expect(names).toContain('meta-clean.jpg');
  expect(names).toContain('plain-clean.jpg');
  for (const member of members) {
    expect(member.method, `${member.name} is stored, not re-compressed`).toBe(0);
    expect(member.utf8, `${member.name} keeps a UTF-8 name`).toBe(true);
    assertClean(member.name, new Uint8Array(readFileSync(join(outDir, 'batch', member.name))));
  }

  expect(externalRequests, `unexpected external requests: ${externalRequests.join(', ')}`).toEqual([]);
  expect(consoleErrors).toEqual([]);
});

test('cleans a multi-page TIFF and keeps every page', async ({ page }) => {
  await page.goto('/');
  await page.setInputFiles('input[type=file] >> nth=0', [
    join(fixtures, 'meta.tif'),
    join(fixtures, 'multipage.tif'),
  ]);

  const rows = page.locator('.file-row');
  await expect(rows).toHaveCount(2);
  await expect(page.locator('.status', { hasText: '扫描中' })).toHaveCount(0);

  // Browsers cannot decode TIFF, so the thumbnail degrades to an icon — with a
  // hint that cleaning still works.
  const tiffRow = page.locator('.file-row', { hasText: 'meta.tif' });
  await expect(tiffRow.locator('.thumb img')).toHaveCount(0);
  await expect(tiffRow.locator('.thumb')).toHaveAttribute('title', /无法预览 TIFF/);
  await expect(tiffRow.getByText('EXIF', { exact: true })).toBeVisible();

  // The metadata drawer lists the descriptive tags the rebuild will drop.
  await tiffRow.locator('button[aria-label^="查看详情"]').click();
  const drawer = page.locator('.drawer');
  await expect(drawer).toContainText('Alice Example');
  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();

  await page.getByRole('button', { name: '全部清理' }).click();
  await expect(page.locator('.file-row--done')).toHaveCount(2, { timeout: 30_000 });
  await expect(page.getByText('复检通过').first()).toBeVisible();

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '下载全部 (.zip)' }).click();
  const download = await downloadPromise;
  const zipPath = join(outDir, 'tiff.zip');
  await download.saveAs(zipPath);
  const members = extractZip(zipPath, join(outDir, 'tiff'));
  expect(members.map((member) => member.name).sort()).toEqual(['meta-clean.tif', 'multipage-clean.tif']);

  for (const member of members) {
    const bytes = new Uint8Array(readFileSync(join(outDir, 'tiff', member.name)));
    assertClean(member.name, bytes);
    const text = Buffer.from(bytes).toString('latin1');
    for (const marker of ['Alice Example', 'Terrace at dusk', 'x:xmpmeta', 'Barcelona']) {
      expect(text.includes(marker), `${member.name} still contains ${JSON.stringify(marker)}`).toBe(false);
    }
  }
});

test('stops a running batch without leaving the queue stuck', async ({ page }) => {
  await page.goto('/');
  // Enough files that the batch is still running when the cancel lands.
  await page.setInputFiles(
    'input[type=file] >> nth=0',
    Array.from({ length: 20 }, () => join(fixtures, 'multipage.tif')),
  );
  await expect(page.locator('.file-row')).toHaveCount(20);
  await expect(page.locator('.file-row--ready')).toHaveCount(20, { timeout: 30_000 });

  await page.getByRole('button', { name: '全部清理' }).click();
  const cancel = page.getByRole('button', { name: '取消批量清理' });
  await cancel.click();
  await expect(page.locator('.toasts')).toContainText('已停止排队');

  // The batch must drain: no row left claiming to be mid-strip, no progress bar
  // left behind, and the files that never started still say "待清理".
  await expect(page.locator('.file-row--stripping')).toHaveCount(0, { timeout: 30_000 });
  await expect(page.locator('.progress')).toHaveCount(0, { timeout: 30_000 });
  await expect(page.locator('.toasts')).toContainText('批量清理已取消', { timeout: 30_000 });

  const done = await page.locator('.file-row--done').count();
  const ready = await page.locator('.file-row--ready').count();
  expect(done + ready).toBe(20);
  expect(ready, 'cancelling should leave the queued files untouched').toBeGreaterThan(0);

  // A cancelled batch is not a dead end: the rest can be cleaned afterwards.
  await page.getByRole('button', { name: '全部清理' }).click();
  await expect(page.locator('.file-row--done')).toHaveCount(20, { timeout: 60_000 });
  await expect(page.getByText('复检通过').first()).toBeVisible();
});

test('switches language and keeps the layout intact', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'EN' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Strip the privacy');
  await page.getByRole('button', { name: '中' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('移除照片');
});

test('refuses a container it cannot read instead of calling it clean', async ({ page }) => {
  await page.goto('/');
  await page.setInputFiles('input[type=file] >> nth=0', [join(fixtures, 'fake.heic')]);
  const row = page.locator('.file-row').first();
  await expect(row).toHaveClass(/file-row--failed/, { timeout: 15_000 });
  await expect(row).toContainText('不是有效的 HEIF');
  // No download action may be offered for a file we never read.
  await expect(row.getByRole('button', { name: /下载/ })).toHaveCount(0);
});

test('refuses unsupported formats without pretending to clean them', async ({ page }) => {
  // BMP is still in the "reported, never half-cleaned" bucket.
  const bmp = new Uint8Array(64);
  bmp.set([0x42, 0x4d], 0);
  mkdirSync(outDir, { recursive: true });
  const path = join(outDir, 'fake.bmp');
  writeFileSync(path, bmp);

  await page.goto('/');
  await page.setInputFiles('input[type=file] >> nth=0', [path]);
  const row = page.locator('.file-row').first();
  await expect(row).toHaveClass(/file-row--unsupported/, { timeout: 15_000 });
  await expect(row).toContainText('不支持');
  await expect(row.getByRole('button', { name: /下载/ })).toHaveCount(0);
});

function jpegSize(bytes: Uint8Array): { width: number; height: number } {
  let i = 2;
  while (i < bytes.length - 9) {
    if (bytes[i] !== 0xff) {
      i += 1;
      continue;
    }
    const marker = bytes[i + 1] ?? 0;
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const height = ((bytes[i + 5] ?? 0) << 8) | (bytes[i + 6] ?? 0);
      const width = ((bytes[i + 7] ?? 0) << 8) | (bytes[i + 8] ?? 0);
      return { width, height };
    }
    const length = ((bytes[i + 2] ?? 0) << 8) | (bytes[i + 3] ?? 0);
    i += 2 + length;
  }
  throw new Error('no SOF marker');
}

test('bakes EXIF orientation into pixels when asked', async ({ page }) => {
  await page.goto('/');
  await page.setInputFiles('input[type=file] >> nth=0', [join(fixtures, 'progressive.jpg')]);
  await expect(page.locator('.status', { hasText: '扫描中' })).toHaveCount(0);

  // progressive.jpg is 80x60 with orientation 6 (rotate 90° clockwise).
  // The real checkbox is visually hidden; the label is the click target.
  await page.locator('.setting', { hasText: '把方向写入像素' }).locator('.setting-label').click();
  await expect(
    page.locator('.setting', { hasText: '把方向写入像素' }).locator('input'),
  ).toBeChecked();
  await page.getByRole('button', { name: '全部清理' }).click();
  await expect(page.locator('.file-row--done')).toHaveCount(1, { timeout: 30_000 });

  const downloadPromise = page.waitForEvent('download');
  await page.locator('.file-row').getByRole('button', { name: '下载' }).click();
  const download = await downloadPromise;
  const path = join(outDir, 'baked.jpg');
  await download.saveAs(path);
  const bytes = new Uint8Array(readFileSync(path));

  const size = jpegSize(bytes);
  expect(size).toEqual({ width: 60, height: 80 });
  assertClean('baked.jpg', bytes);
});

test('keeps working offline after the first visit', async ({ page, context }) => {
  await page.goto('http://127.0.0.1:5190/');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('隐私');
  await expect(page.locator('meta[http-equiv="Content-Security-Policy"]')).toHaveCount(1);

  await page.waitForFunction(() => navigator.serviceWorker?.controller != null, undefined, {
    timeout: 20_000,
  });
  await page.reload(); // second load goes through the worker and warms the cache

  await context.setOffline(true);
  try {
    await page.reload();
    await expect(page.getByRole('heading', { level: 1 })).toContainText('隐私');
    await expect(page.getByRole('button', { name: '选择文件', exact: true })).toBeVisible();
  } finally {
    await context.setOffline(false);
  }
});

test('lists every metadata entry and filters the table', async ({ page }) => {
  await page.goto('/');
  await page.setInputFiles('input[type=file] >> nth=0', [join(fixtures, 'meta.jpg')]);
  await expect(page.locator('.status', { hasText: '扫描中' })).toHaveCount(0);

  await page.locator('.file-row', { hasText: 'meta.jpg' }).locator('button[aria-label^="查看详情"]').click();
  const drawer = page.locator('.drawer');
  await drawer.getByRole('tab', { name: '全部元数据' }).click();

  // The listing is produced by the worker on demand, so it arrives async.
  await expect(drawer.locator('.meta-row').first()).toBeVisible({ timeout: 15_000 });
  expect(await drawer.locator('.meta-row').count()).toBeGreaterThan(70);

  // Spot-check values that come from different containers.
  await expect(drawer).toContainText('TestCam');
  await expect(drawer).toContainText(`35° 41' 21.6"`);
  await expect(drawer).toContainText('0102030405060708');
  await expect(drawer).toContainText('PicPrivacy Test Signer');

  // Searching narrows the listing to matching rows only.
  await drawer.getByRole('searchbox').fill('SN-123456789');
  await expect(drawer.locator('.meta-row')).toHaveCount(1);
  await expect(drawer.locator('.meta-tally')).toContainText('匹配 1');

  await drawer.getByRole('searchbox').fill('no-such-tag');
  await expect(drawer.locator('.meta-row')).toHaveCount(0);
  await expect(drawer).toContainText('没有匹配项');
});

test('previews vendor blobs as a hex dump', async ({ page }) => {
  await page.goto('/');
  await page.setInputFiles('input[type=file] >> nth=0', [join(fixtures, 'meta.jpg')]);
  await expect(page.locator('.status', { hasText: '扫描中' })).toHaveCount(0);

  await page.locator('.file-row', { hasText: 'meta.jpg' }).locator('button[aria-label^="查看详情"]').click();
  const drawer = page.locator('.drawer');
  await drawer.getByRole('tab', { name: '全部元数据' }).click();
  await expect(drawer.locator('.meta-row').first()).toBeVisible({ timeout: 15_000 });

  // The fixture's MakerNote is eight bytes we deliberately do not interpret.
  const makerNote = drawer.locator('.meta-row', { hasText: 'MakerNote' });
  await expect(makerNote).toContainText('0102030405060708');
  await makerNote.getByRole('button', { name: '查看字节' }).click();

  const hex = makerNote.locator('.meta-hex');
  await expect(hex).toBeVisible();
  await expect(hex).toContainText('00000000');
  await expect(hex).toContainText('01 02 03 04 05 06 07 08');
  await expect(hex).toContainText('8 / 8 字节');

  await makerNote.getByRole('button', { name: '收起字节' }).click();
  await expect(hex).toBeHidden();
});

test('compares the metadata before and after stripping', async ({ page }) => {
  await page.goto('/');
  await page.setInputFiles('input[type=file] >> nth=0', [join(fixtures, 'meta.jpg')]);
  await expect(page.locator('.status', { hasText: '扫描中' })).toHaveCount(0);

  await page.getByRole('button', { name: '全部清理' }).click();
  await expect(page.locator('.file-row--done')).toHaveCount(1, { timeout: 30_000 });

  await page.locator('.file-row', { hasText: 'meta.jpg' }).locator('button[aria-label^="查看详情"]').click();
  const drawer = page.locator('.drawer');
  await drawer.getByRole('tab', { name: '全部元数据' }).click();
  await expect(drawer.locator('.meta-row').first()).toBeVisible({ timeout: 15_000 });

  // The comparison only exists once an output blob does.
  await drawer.getByRole('button', { name: '对比清理前后' }).click();
  const panes = drawer.locator('.meta-pane');
  await expect(panes).toHaveCount(2);
  await expect(panes.nth(0).locator('.meta-pane-head')).toContainText('清理前');
  await expect(panes.nth(1).locator('.meta-pane-head')).toContainText('清理后');

  // Before: everything the file carried.
  expect(await panes.nth(0).locator('.meta-row').count()).toBeGreaterThan(70);
  await expect(panes.nth(0)).toContainText('TestCam');

  // After: the file entry, the ICC profile colour needs and the JFIF header a
  // decoder needs. Nothing else survives the strip.
  await expect(panes.nth(1).locator('.meta-row')).toHaveCount(4, { timeout: 15_000 });
  await expect(panes.nth(1)).not.toContainText('TestCam');
  await expect(panes.nth(1)).not.toContainText(`35° 41' 21.6"`);
  await expect(panes.nth(1)).toContainText('ICC profile');
  await expect(panes.nth(1)).toContainText('APP0 JFIF');
  await expect(panes.nth(1).locator('.badge').first()).toHaveText('保留');
  await expect(panes.nth(1)).toContainText('已经没有可移除的元数据');
});

test('warns before cleaning a photo whose orientation would be lost', async ({ page }) => {
  await page.goto('/');
  await page.setInputFiles('input[type=file] >> nth=0', [join(fixtures, 'rotated.jpg')]);
  await expect(page.locator('.status', { hasText: '扫描中' })).toHaveCount(0);

  const callout = page.locator('.settings-callout');
  await expect(callout).toBeVisible();
  await expect(callout).toContainText('清理后会按未旋转的方向显示');

  // One click turns the fix on; the warning has done its job and goes away.
  await callout.getByRole('button', { name: '把方向写入像素' }).click();
  await expect(
    page.locator('.setting', { hasText: '把方向写入像素' }).locator('input'),
  ).toBeChecked();
  await expect(callout).toBeHidden();
});

test('reports the lost orientation tag after cleaning', async ({ page }) => {
  await page.goto('/');
  await page.setInputFiles('input[type=file] >> nth=0', [join(fixtures, 'rotated.jpg')]);
  await expect(page.locator('.status', { hasText: '扫描中' })).toHaveCount(0);
  await expect(page.locator('.settings-callout')).toBeVisible();

  await page.getByRole('button', { name: '全部清理' }).click();
  await expect(page.locator('.file-row--done')).toHaveCount(1, { timeout: 30_000 });
  await expect(page.getByText('方向标签已删除').first()).toBeVisible();
});

test('exports a reproducible diagnostic report', async ({ page }) => {
  await page.goto('/');
  await page.setInputFiles('input[type=file] >> nth=0', [join(fixtures, 'meta.jpg')]);
  await expect(page.locator('.status', { hasText: '扫描中' })).toHaveCount(0);

  await page.locator('.file-row', { hasText: 'meta.jpg' }).locator('button[aria-label^="查看详情"]').click();
  const drawer = page.locator('.drawer');

  const downloadPromise = page.waitForEvent('download');
  await drawer.getByRole('button', { name: '导出报告' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('report-meta.json');

  const path = join(outDir, 'report-meta.json');
  await download.saveAs(path);
  const report = JSON.parse(readFileSync(path, 'utf8'));

  expect(report.schema).toBe('picprivacy.report/1');
  expect(report.file).toMatchObject({ name: 'meta.jpg', format: 'jpeg', supported: true });
  const expected = createHash('sha256').update(readFileSync(join(fixtures, 'meta.jpg'))).digest('hex');
  expect(report.file.sha256).toBe(expected);
  expect(report.scan.findings.length).toBeGreaterThan(0);
  expect(report.scan.hasC2pa).toBe(true);
  expect(report.scan.blocks.length).toBeGreaterThan(0);
  // Sensitive values are redacted by default; the report is meant to be shared.
  expect(report.redaction).toEqual({ applied: true });
  const gps = report.scan.findings.find((finding: any) => finding.category === 'gps');
  expect(gps.params.lat).toBe('[redacted]');
  expect(readFileSync(path, 'utf8')).not.toContain('35.689');
  // Nothing was cleaned yet, so there is no verification block to report.
  expect(report.result).toBeUndefined();
});

test('reports the exact values only when redaction is turned off', async ({ page }) => {
  await page.goto('/');
  await page.setInputFiles('input[type=file] >> nth=0', [join(fixtures, 'meta.jpg')]);
  await expect(page.locator('.status', { hasText: '扫描中' })).toHaveCount(0);

  const toggle = page.locator('.setting', { hasText: '报告默认脱敏' });
  await expect(toggle.locator('input')).toBeChecked();
  await toggle.locator('.setting-label').click();
  await expect(toggle.locator('input')).not.toBeChecked();

  await page.locator('.file-row', { hasText: 'meta.jpg' }).locator('button[aria-label^="查看详情"]').click();
  const downloadPromise = page.waitForEvent('download');
  await page.locator('.drawer').getByRole('button', { name: '导出报告' }).click();
  const download = await downloadPromise;
  const path = join(outDir, 'report-meta-full.json');
  await download.saveAs(path);
  const report = JSON.parse(readFileSync(path, 'utf8'));

  expect(report.redaction).toEqual({ applied: false });
  const gps = report.scan.findings.find((finding: any) => finding.category === 'gps');
  expect(gps.params.lat).toMatch(/^35\.689/);
});

test('packages a long batch and every member matches the single-file download', async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });

  await page.goto('/');
  // 40 copies: enough that the zip has to be assembled from many members
  // without ever holding a second copy of their bytes.
  await page.setInputFiles(
    'input[type=file] >> nth=0',
    Array.from({ length: 40 }, () => join(fixtures, 'meta.jpg')),
  );
  await expect(page.locator('.file-row')).toHaveCount(40);
  await expect(page.locator('.status', { hasText: '扫描中' })).toHaveCount(0, { timeout: 30_000 });

  await page.getByRole('button', { name: '全部清理' }).click();
  await expect(page.locator('.file-row--done')).toHaveCount(40, { timeout: 120_000 });

  // One file on its own, so the archive can be compared byte for byte.
  const singlePromise = page.waitForEvent('download');
  await page.locator('.file-row--done button[aria-label^="下载清理后的文件"]').first().click();
  const singlePath = join(outDir, 'single.jpg');
  await (await singlePromise).saveAs(singlePath);
  const singleSha = createHash('sha256').update(readFileSync(singlePath)).digest('hex');

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '下载全部 (.zip)' }).click();
  const download = await downloadPromise;
  const zipPath = join(outDir, 'large.zip');
  await download.saveAs(zipPath);

  const members = extractZip(zipPath, join(outDir, 'large'));
  expect(members).toHaveLength(40);
  expect(new Set(members.map((member) => member.name)).size, 'member names stay unique').toBe(40);
  for (const member of members) {
    expect(member.sha256, `${member.name} differs from the single download`).toBe(singleSha);
    assertClean(member.name, new Uint8Array(readFileSync(join(outDir, 'large', member.name))));
  }
  expect(consoleErrors).toEqual([]);
});

test('traps keyboard focus inside the drawer and gives it back', async ({ page }) => {
  await page.goto('/');
  await page.setInputFiles('input[type=file] >> nth=0', [join(fixtures, 'meta.jpg')]);
  await expect(page.locator('.status', { hasText: '扫描中' })).toHaveCount(0);

  const trigger = page
    .locator('.file-row', { hasText: 'meta.jpg' })
    .locator('button[aria-label^="查看详情"]');
  await trigger.focus();
  await trigger.click();

  const drawer = page.locator('.drawer');
  await expect(drawer).toBeVisible();
  await expect(drawer).toBeFocused();

  // Every Tab stays inside the panel, including the wrap past the last control.
  for (let step = 1; step <= 25; step += 1) {
    await page.keyboard.press('Tab');
    const inside = await page.evaluate(() => Boolean(document.activeElement?.closest('.drawer')));
    expect(inside, `focus escaped after ${step} tab(s)`).toBe(true);
  }
  for (let step = 1; step <= 5; step += 1) {
    await page.keyboard.press('Shift+Tab');
    const inside = await page.evaluate(() => Boolean(document.activeElement?.closest('.drawer')));
    expect(inside, `focus escaped after ${step} shift+tab(s)`).toBe(true);
  }

  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();
  await expect(trigger).toBeFocused();
});

test('exports one report per file in a single document', async ({ page }) => {
  await page.goto('/');
  await page.setInputFiles('input[type=file] >> nth=0', [
    join(fixtures, 'meta.jpg'),
    join(fixtures, 'plain.jpg'),
  ]);
  await expect(page.locator('.status', { hasText: '扫描中' })).toHaveCount(0);

  await page.getByRole('button', { name: '全部清理' }).click();
  await expect(page.locator('.file-row--done, .file-row--clean')).toHaveCount(2, { timeout: 30_000 });

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出批量报告' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^picprivacy-reports-\d{8}-\d{4}\.json$/);

  const path = join(outDir, 'batch-report.json');
  await download.saveAs(path);
  const doc = JSON.parse(readFileSync(path, 'utf8'));

  expect(doc.schema).toBe('picprivacy.batch/1');
  expect(doc.count).toBe(2);
  expect(doc.files.map((entry: any) => entry.file.name)).toEqual(['meta.jpg', 'plain.jpg']);
  // Each entry is a complete report, and only the cleaned one has a result.
  expect(doc.files[0].schema).toBe('picprivacy.report/1');
  expect(doc.files[0].result.verify.ok).toBe(true);
  expect(doc.files[1].result).toBeUndefined();
  expect(doc.files[1].file.sha256).toBe(
    createHash('sha256').update(readFileSync(join(fixtures, 'plain.jpg'))).digest('hex'),
  );
});
