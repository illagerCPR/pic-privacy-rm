#!/usr/bin/env node
/**
 * Guard the promise on the tin: the production build must not reference any
 * external resource, and it must ship the "no network" Content-Security-Policy.
 *
 * Fails the build when a CDN, font service or analytics snippet sneaks in.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const dist = new URL('../dist/', import.meta.url).pathname;
const problems = [];

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path);
    else if (/\.(html|css|js|mjs|json|webmanifest)$/.test(entry)) inspect(path);
  }
}

function inspect(path) {
  const html = readFileSync(path, 'utf8');
  const name = path.slice(dist.length);

  if (name.endsWith('.html')) {
    if (!/<meta[^>]+http-equiv="Content-Security-Policy"/i.test(html)) {
      problems.push(`${name}: missing Content-Security-Policy meta tag`);
    } else if (!/connect-src\s+'none'/i.test(html)) {
      problems.push(`${name}: CSP does not forbid network connections`);
    }

    for (const match of html.matchAll(
      /<(script|link|img|iframe)[^>]*(?:src|href)="(https?:)?\/\/[^"]*"/gi,
    )) {
      problems.push(`${name}: external subresource ${match[0].slice(0, 120)}`);
    }
  }

  // Bundled code may mention user-facing links (GitHub, OpenStreetMap); those are
  // anchors a human clicks, not resources the page loads. Anything else is noise.
  const allowedHosts = [
    // Links a human may click: the repository and the coordinate preview.
    'github.com',
    'illagercpr.github.io',
    'www.openstreetmap.org',
    // String constants, never fetched: SVG namespace, XMP namespace, React error docs.
    'www.w3.org',
    'ns.adobe.com',
    'react.dev',
  ];
  for (const match of html.matchAll(/https?:\/\/[a-z0-9.-]+/gi)) {
    const host = match[0].replace(/^https?:\/\//i, '').toLowerCase();
    if (!allowedHosts.some((allowed) => host === allowed || host.endsWith(`.${allowed}`))) {
      problems.push(`${name}: unexpected external URL ${match[0]}`);
    }
  }
}

walk(dist);

if (problems.length > 0) {
  console.error('Offline check failed:');
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log('Offline check passed: no external subresources, CSP present.');
