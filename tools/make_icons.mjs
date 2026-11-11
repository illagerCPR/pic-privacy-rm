/**
 * Rasterise the favicon into the PNG set a PWA needs.
 *
 * The icons are committed, so this only runs when the mark changes:
 *
 *   node tools/make_icons.mjs
 *
 * It uses the same Chrome the e2e suite drives, which keeps the rounded corners
 * and the stroke widths identical to the SVG instead of redrawing the mark by
 * hand in an image library.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const root = new URL('..', import.meta.url);
const svg = readFileSync(new URL('public/favicon.svg', root), 'utf8');
const outDir = new URL('public/icons/', root);
mkdirSync(outDir, { recursive: true });

const targets = [
  // `any`: the mark keeps its transparent, rounded corners.
  { name: 'icon-192.png', size: 192, inset: 0 },
  { name: 'icon-512.png', size: 512, inset: 0 },
  // `maskable` and iOS: a full-bleed square with the mark inside the safe zone.
  { name: 'icon-maskable-512.png', size: 512, inset: 0.11 },
  { name: 'apple-touch-icon.png', size: 180, inset: 0.11 },
];

const browser = await chromium.launch({ channel: 'chrome' });
for (const target of targets) {
  const transparent = target.inset === 0;
  const inset = `${target.inset * 100}%`;
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    html, body { margin: 0; height: 100%; }
    body { display: grid; place-items: center; background: ${transparent ? 'transparent' : '#0f766e'}; }
    .art { width: calc(100% - ${inset} * 2); height: calc(100% - ${inset} * 2); }
    svg { display: block; width: 100%; height: 100%; }
  </style></head><body><div class="art">${svg}</div></body></html>`;

  const page = await browser.newPage({
    viewport: { width: target.size, height: target.size },
    deviceScaleFactor: 1,
  });
  await page.setContent(html, { waitUntil: 'load' });
  const png = await page.screenshot({ omitBackground: transparent });
  await page.close();
  writeFileSync(new URL(target.name, outDir), png);
  console.log(`${target.name}: ${target.size}x${target.size}, ${png.length} bytes`);
}
await browser.close();
