import { expect, test } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync } from 'fflate';

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
  expect(isJpeg || isPng || isWebp || isGif, `${name} has an unknown signature`).toBe(true);
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
  const archive = unzipSync(new Uint8Array(readFileSync(zipPath)));
  const names = Object.keys(archive).sort();
  writeFileSync(join(outDir, 'names.txt'), names.join('\n'));
  expect(names).toHaveLength(5);
  expect(names).toContain('meta-clean.jpg');
  expect(names).toContain('plain-clean.jpg');
  for (const [name, bytes] of Object.entries(archive)) {
    assertClean(name, bytes);
    writeFileSync(join(outDir, name), bytes);
  }

  expect(externalRequests, `unexpected external requests: ${externalRequests.join(', ')}`).toEqual([]);
  expect(consoleErrors).toEqual([]);
});

test('switches language and keeps the layout intact', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'EN' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Strip the privacy');
  await page.getByRole('button', { name: '中' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('移除照片');
});

test('refuses unsupported files without pretending to clean them', async ({ page }) => {
  await page.goto('/');
  await page.setInputFiles('input[type=file] >> nth=0', [join(fixtures, 'fake.heic')]);
  const row = page.locator('.file-row').first();
  await expect(row).toHaveClass(/file-row--unsupported/, { timeout: 15_000 });
  await expect(row).toContainText('不支持');
  // No download action may be offered.
  await expect(row.getByRole('button', { name: /下载/ })).toHaveCount(0);
});
