/**
 * Lazy full-metadata inspection for the "all metadata" view.
 *
 * Deliberately a separate pass from `scanSource`: scanning stays cheap (a few
 * sensitive findings) so batch work does not slow down, and this runs only when
 * the user opens the metadata tab.
 *
 * Nothing here feeds the strip pass. It is a viewer, and it is allowed to be
 * slow, tolerant and verbose — the opposite of the strip code.
 */
import { ascii, concatBytes, decodeText, startsWithBytes, u16be, u32be, u32le } from './bytes.ts';
import { summarizeC2pa } from './c2pa.ts';
import { stripXmpMagic } from './gif.ts';
import { parsePhotoshopApp13 } from './iptc.ts';
import { parseJumbf } from './jumbf.ts';
import {
  inspectExifBlock,
  makeReport,
  type MetadataGroup,
  type MetadataItem,
  type MetadataReport,
} from './metadata.ts';
import { readAt, type Source } from './source.ts';
import { sniff } from './sniff.ts';
import type { FormatInfo } from './types.ts';
import { parseXmp } from './xmp.ts';

export interface InspectOptions {
  /** Mirrors the strip setting so the listing can say what survives. */
  keepIcc: boolean;
}

const MAX_META = 8 * 1024 * 1024;
const MAX_TEXT = 4000;
const XMP_JPEG_HEADER = 'http://ns.adobe.com/xap/1.0/\0';
const XMP_EXT_HEADER = 'http://ns.adobe.com/xmp/extension/\0';

/* ------------------------------------------------------------------ *
 * Group builders
 * ------------------------------------------------------------------ */

function group(
  id: MetadataGroup['id'],
  items: MetadataItem[],
  removed = true,
): MetadataGroup {
  return { id, titleKey: `meta.group.${id}`, removed, items };
}

/** EXIF payloads carry the `Exif\0\0` prefix in JPEG but not in PNG/WebP. */
function exifGroups(payload: Uint8Array): MetadataGroup[] {
  const block = startsWithBytes(payload, 0, 'Exif\0\0') ? payload.subarray(6) : payload;
  const groups = inspectExifBlock(block);
  if (groups) return groups;
  return [
    group('exif', [
      { name: 'EXIF', value: `(${payload.length} bytes, structure not readable)`, size: payload.length },
    ]),
  ];
}

function xmpGroups(bytes: Uint8Array): MetadataGroup[] {
  const xmp = parseXmp(bytes);
  const items: MetadataItem[] = xmp.properties.map((property) => ({
    name: property.key,
    value: property.value,
  }));
  for (const ns of xmp.namespaces) {
    items.push({ name: `xmlns:${ns.prefix}`, value: ns.uri });
  }
  if (items.length === 0) {
    items.push({ name: 'XMP', value: `(${bytes.length} bytes, no readable properties)` });
  }
  return [group('xmp', items)];
}

function iptcGroups(payload: Uint8Array): MetadataGroup[] {
  const photoshop = parsePhotoshopApp13(payload);
  if (!photoshop) return [];
  const items: MetadataItem[] = photoshop.datasets.map((dataset) => ({
    name: dataset.name,
    id: dataset.key,
    value: dataset.value,
  }));
  if (items.length === 0) {
    items.push({ name: 'IPTC-IIM', value: `(${payload.length} bytes, no datasets)` });
  }
  return [group('iptc', items)];
}

function c2paGroups(payload: Uint8Array): MetadataGroup[] {
  let summary;
  try {
    summary = summarizeC2pa(parseJumbf(payload), payload.length);
  } catch {
    return [];
  }
  if (!summary.present) return [];
  const items: MetadataItem[] = [];
  for (const manifest of summary.manifests) {
    // Nested JUMBF boxes sometimes surface as empty manifests; skip the noise.
    if (!manifest.claimGenerator && manifest.actions.length === 0 && manifest.assertionLabels.length === 0) {
      continue;
    }
    const prefix = manifest.label;
    items.push({ name: `${prefix} · claim generator`, value: manifest.claimGenerator ?? '(unknown)' });
    if (manifest.title) items.push({ name: `${prefix} · title`, value: manifest.title });
    if (manifest.signer) items.push({ name: `${prefix} · signer`, value: manifest.signer });
    if (manifest.issuer) items.push({ name: `${prefix} · issuer`, value: manifest.issuer });
    if (manifest.certValidFrom) items.push({ name: `${prefix} · cert valid from`, value: manifest.certValidFrom });
    if (manifest.certValidTo) items.push({ name: `${prefix} · cert valid to`, value: manifest.certValidTo });
    if (manifest.algorithm) items.push({ name: `${prefix} · signing algorithm`, value: manifest.algorithm });
    items.push({
      name: `${prefix} · assertions`,
      value: manifest.assertionLabels.join(', ') || '(none)',
    });
    items.push({ name: `${prefix} · ingredients`, value: String(manifest.ingredientCount) });
    if (manifest.hasThumbnail) items.push({ name: `${prefix} · thumbnail`, value: 'embedded' });
    for (const action of manifest.actions) {
      items.push({
        name: `${prefix} · action`,
        value: [action.action, action.when, action.softwareAgent].filter(Boolean).join(' · '),
      });
    }
    items.push({ name: `${prefix} · bytes`, value: String(manifest.bytes) });
  }
  items.push({ name: 'JUMBF boxes', value: String(summary.boxCount) });
  return [group('c2pa', items)];
}

/* ------------------------------------------------------------------ *
 * Shared helpers
 * ------------------------------------------------------------------ */

function splitNul(bytes: Uint8Array): { key: string; rest: Uint8Array } | null {
  const at = bytes.indexOf(0);
  if (at < 0) return null;
  return { key: decodeText(bytes.subarray(0, at)), rest: bytes.subarray(at + 1) };
}

async function inflateText(bytes: Uint8Array): Promise<string> {
  try {
    const stream = new Blob([bytes.slice()]).stream().pipeThrough(new DecompressionStream('deflate'));
    const buffer = await new Response(stream).arrayBuffer();
    return new TextDecoder('utf-8', { fatal: false }).decode(buffer);
  } catch {
    return '';
  }
}

function describeApp1(payload: Uint8Array): string {
  const head = ascii(payload, 0, Math.min(20, payload.length)).replace(/\u0000/g, '').trim();
  return head ? `APP1 ${head}` : 'APP1';
}

function fileGroup(info: FormatInfo, size: number): MetadataGroup {
  return group(
    'file',
    [
      { name: 'Format', value: `${info.format.toUpperCase()} · ${info.mime}` },
      { name: 'File size', value: `${size} bytes` },
    ],
    false,
  );
}

function finish(
  groups: MetadataGroup[],
  text: MetadataItem[],
  container: MetadataItem[],
): MetadataGroup[] {
  const out = [...groups];
  if (text.length > 0) out.push(group('text', text));
  if (container.length > 0) out.push(group('container', container));
  return out;
}

/* ------------------------------------------------------------------ *
 * JPEG
 * ------------------------------------------------------------------ */

async function inspectJpeg(src: Source, opts: InspectOptions): Promise<MetadataGroup[]> {
  const groups: MetadataGroup[] = [];
  const text: MetadataItem[] = [];
  const container: MetadataItem[] = [];

  let pos = 2;
  let guard = 0;
  while (pos + 4 <= src.size && guard < 4096) {
    guard += 1;
    const pair = await readAt(src, pos, 2);
    if (pair[0] !== 0xff) break;
    const marker = pair[1] ?? 0;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      pos += 2;
      continue;
    }
    if (marker === 0xda || marker === 0xd9) break;

    const length = u16be(await readAt(src, pos + 2, 2), 0);
    if (length < 2) break;
    const dataStart = pos + 4;
    const size = Math.min(length - 2, Math.max(0, src.size - dataStart));
    const payload = size > 0 ? await readAt(src, dataStart, size) : new Uint8Array(0);
    pos = dataStart + size;

    if (marker === 0xe1) {
      if (startsWithBytes(payload, 0, 'Exif\0\0')) {
        groups.push(...exifGroups(payload.subarray(6)));
      } else if (startsWithBytes(payload, 0, XMP_JPEG_HEADER)) {
        groups.push(...xmpGroups(payload.subarray(XMP_JPEG_HEADER.length)));
      } else if (startsWithBytes(payload, 0, XMP_EXT_HEADER)) {
        text.push({ name: 'Extended XMP', value: `(${payload.length} bytes, chunked)` });
      } else {
        container.push({ name: describeApp1(payload), value: `(${payload.length} bytes)` });
      }
    } else if (marker === 0xe2) {
      if (startsWithBytes(payload, 0, 'ICC_PROFILE')) {
        container.push({
          name: 'ICC profile',
          value: `${payload.length} bytes${opts.keepIcc ? ' (kept)' : ' (removed)'}`,
          removed: !opts.keepIcc,
        });
      } else if (startsWithBytes(payload, 0, 'MPF\0')) {
        container.push({ name: 'MPF (multi-picture)', value: `(${payload.length} bytes)` });
      } else {
        container.push({ name: 'APP2', value: `(${payload.length} bytes)` });
      }
    } else if (marker === 0xeb) {
      groups.push(...c2paGroups(payload));
    } else if (marker === 0xed) {
      if (startsWithBytes(payload, 0, 'Photoshop')) groups.push(...iptcGroups(payload));
      else container.push({ name: 'APP13', value: `(${payload.length} bytes)` });
    } else if (marker === 0xfe) {
      const comment = decodeText(payload).replace(/\u0000/g, '').trim();
      if (comment) text.push({ name: 'COM comment', value: comment.slice(0, MAX_TEXT) });
    } else if (marker >= 0xe0 && marker <= 0xef) {
      const name =
        marker === 0xe0 ? 'APP0 JFIF' : marker === 0xee ? 'APP14 Adobe' : `APP${marker - 0xe0}`;
      container.push({ name, value: `(${payload.length} bytes)` });
    }
  }

  return finish(groups, text, container);
}

/* ------------------------------------------------------------------ *
 * PNG
 * ------------------------------------------------------------------ */

async function inspectPng(src: Source, opts: InspectOptions): Promise<MetadataGroup[]> {
  const groups: MetadataGroup[] = [];
  const text: MetadataItem[] = [];
  const container: MetadataItem[] = [];

  let pos = 8;
  let guard = 0;
  while (pos + 8 <= src.size && guard < 20000) {
    guard += 1;
    const header = await readAt(src, pos, 8);
    const length = u32be(header, 0);
    const type = ascii(header, 4, 4);
    if (type === 'IEND' || length > MAX_META) break;
    const dataStart = pos + 8;
    const payload = length > 0 ? await readAt(src, dataStart, length) : new Uint8Array(0);
    pos = dataStart + length + 4;

    if (type === 'eXIf') {
      groups.push(...exifGroups(payload));
    } else if (type === 'caBX') {
      groups.push(...c2paGroups(payload));
    } else if (type === 'tEXt') {
      const split = splitNul(payload);
      if (split) text.push({ name: `tEXt ${split.key}`, value: decodeText(split.rest).slice(0, MAX_TEXT) });
    } else if (type === 'zTXt') {
      const split = splitNul(payload);
      if (split) {
        const body = await inflateText(split.rest.subarray(1));
        text.push({ name: `zTXt ${split.key}`, value: body.slice(0, MAX_TEXT) });
      }
    } else if (type === 'iTXt') {
      const first = splitNul(payload);
      if (first) {
        const flag = first.rest[0] ?? 0;
        const lang = splitNul(first.rest.subarray(2));
        const translated = lang ? splitNul(lang.rest) : null;
        if (translated) {
          const body =
            flag === 1 ? new TextEncoder().encode(await inflateText(translated.rest)) : translated.rest;
          if (first.key.toLowerCase().includes('xmp')) {
            // PNG keeps XMP in a tEXt-family chunk, usually iTXt.
            groups.push(...xmpGroups(body));
          } else {
            const label = translated.key || lang?.key || '';
            text.push({
              name: `iTXt ${first.key}${label ? ` [${label}]` : ''}`,
              value: decodeText(body).slice(0, MAX_TEXT),
            });
          }
        }
      }
    } else if (type === 'iCCP') {
      const split = splitNul(payload);
      const name = split?.key || 'ICC profile';
      container.push({
        name: `iCCP ${name}`,
        value: `${length} bytes${opts.keepIcc ? ' (kept)' : ' (removed)'}`,
        removed: !opts.keepIcc,
      });
    } else if (type === 'tIME') {
      if (payload.length >= 7) {
        const year = u16be(payload, 0);
        const pad = (n: number) => String(n).padStart(2, '0');
        text.push({
          name: 'tIME (last modified)',
          value: `${year}-${pad(payload[2] ?? 0)}-${pad(payload[3] ?? 0)} ${pad(payload[4] ?? 0)}:${pad(
            payload[5] ?? 0,
          )}:${pad(payload[6] ?? 0)} UTC`,
        });
      }
    }
  }

  return finish(groups, text, container);
}

/* ------------------------------------------------------------------ *
 * WebP
 * ------------------------------------------------------------------ */

async function inspectWebp(src: Source, opts: InspectOptions): Promise<MetadataGroup[]> {
  const groups: MetadataGroup[] = [];
  const container: MetadataItem[] = [];

  let pos = 12;
  let guard = 0;
  while (pos + 8 <= src.size && guard < 4096) {
    guard += 1;
    const header = await readAt(src, pos, 8);
    const fourcc = ascii(header, 0, 4);
    const size = u32le(header, 4);
    const dataStart = pos + 8;
    const end = Math.min(src.size, dataStart + size);
    const payload =
      end > dataStart ? await readAt(src, dataStart, Math.min(end - dataStart, MAX_META)) : new Uint8Array(0);
    pos = dataStart + size + (size % 2);

    if (fourcc === 'EXIF') {
      groups.push(...exifGroups(payload));
    } else if (fourcc === 'XMP ') {
      groups.push(...xmpGroups(payload));
    } else if (fourcc === 'ICCP') {
      container.push({
        name: 'ICCP colour profile',
        value: `${size} bytes${opts.keepIcc ? ' (kept)' : ' (removed)'}`,
        removed: !opts.keepIcc,
      });
    } else if (fourcc === 'C2PA' || fourcc === 'JUMBF') {
      groups.push(...c2paGroups(payload));
    }
  }

  return finish(groups, [], container);
}

/* ------------------------------------------------------------------ *
 * GIF
 * ------------------------------------------------------------------ */

async function readSubBlocks(src: Source, start: number): Promise<{ data: Uint8Array; pos: number }> {
  const pieces: Uint8Array[] = [];
  let pos = start;
  let guard = 0;
  while (pos < src.size && guard < 4096) {
    guard += 1;
    const size = (await readAt(src, pos, 1))[0] ?? 0;
    pos += 1;
    if (size === 0) break;
    pieces.push(await readAt(src, pos, size));
    pos += size;
  }
  return { data: concatBytes(pieces), pos };
}

async function inspectGif(src: Source): Promise<MetadataGroup[]> {
  const groups: MetadataGroup[] = [];
  const text: MetadataItem[] = [];
  const container: MetadataItem[] = [];
  if (src.size < 14) return [];
  const head = await readAt(src, 0, 13);
  const packed = head[10] ?? 0;
  let pos = 13;
  if ((packed & 0x80) !== 0) pos += 3 * (1 << ((packed & 0x07) + 1));

  let guard = 0;
  while (pos < src.size && guard < 20000) {
    guard += 1;
    const kind = (await readAt(src, pos, 1))[0] ?? 0;
    if (kind === 0x3b) break;

    if (kind === 0x21) {
      const label = (await readAt(src, pos + 1, 1))[0] ?? 0;
      const start = pos + 2;
      if (label === 0xff) {
        // 0x21 0xFF <block size 11> <11-byte identifier> <sub-blocks…>
        const identifier = ascii(await readAt(src, pos + 3, 11), 0, 11);
        const scanned = await readSubBlocks(src, pos + 3 + 11);
        if (identifier.startsWith('XMP Data')) {
          groups.push(...xmpGroups(stripXmpMagic(scanned.data)));
        } else {
          container.push({
            name: `Application ${identifier.trim() || '(unnamed)'}`,
            value: `(${scanned.data.length} bytes)`,
            removed: false,
          });
        }
        pos = scanned.pos;
        continue;
      }
      if (label === 0xfe) {
        const scanned = await readSubBlocks(src, start);
        const comment = decodeText(scanned.data).replace(/\u0000/g, '').trim();
        if (comment) text.push({ name: 'Comment', value: comment.slice(0, MAX_TEXT) });
        pos = scanned.pos;
        continue;
      }
      const fixed = label === 0xf9 ? 4 : label === 0x01 ? 12 : 0;
      pos = (await readSubBlocks(src, start + (fixed > 0 ? 1 + fixed : 0))).pos;
      continue;
    }

    if (kind === 0x2c) {
      const descriptor = await readAt(src, pos + 1, 9);
      const flags = descriptor[8] ?? 0;
      let cursor = pos + 10;
      if ((flags & 0x80) !== 0) cursor += 3 * (1 << ((flags & 0x07) + 1));
      cursor += 1; // LZW minimum code size
      pos = (await readSubBlocks(src, cursor)).pos;
      continue;
    }

    break;
  }

  return finish(groups, text, container);
}

/* ------------------------------------------------------------------ *
 * Entry point
 * ------------------------------------------------------------------ */

export async function inspectSource(src: Source, opts: InspectOptions): Promise<MetadataReport> {
  const info = await sniff(src);
  let groups: MetadataGroup[];
  switch (info.format) {
    case 'jpeg':
      groups = await inspectJpeg(src, opts);
      break;
    case 'png':
      groups = await inspectPng(src, opts);
      break;
    case 'webp':
      groups = await inspectWebp(src, opts);
      break;
    case 'gif':
      groups = await inspectGif(src);
      break;
    default:
      groups = [];
  }
  return makeReport([fileGroup(info, src.size), ...groups]);
}

export async function inspectFile(file: File, opts: InspectOptions): Promise<MetadataReport> {
  return inspectSource({ blob: file, size: file.size }, opts);
}
