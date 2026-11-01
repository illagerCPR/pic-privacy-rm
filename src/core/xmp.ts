/** Lightweight XMP (RDF/XML) scanner.
 *
 * We intentionally do not ship a full XML parser: XMP packets are frequently
 * large and occasionally malformed, and we only need to *show* what is inside
 * before deleting the whole packet anyway. A tolerant scanner is more useful
 * here than a strict parser that gives up on real-world files.
 */
import { decodeText } from './bytes.ts';
import type { Field, FieldGroup } from './types.ts';

export interface XmpProperty {
  key: string;
  prefix: string;
  value: string;
  group: FieldGroup;
  sensitive: boolean;
}

export interface XmpSummary {
  bytes: number;
  namespaces: { prefix: string; uri: string }[];
  properties: XmpProperty[];
  fields: Field[];
  extended: boolean;
  thumbnail?: { blob: Blob; mime: string; bytes: number };
  hasGps: boolean;
  hasCreator: boolean;
  hasHistory: boolean;
}

const WRAPPER_ELEMENTS = new Set([
  'xmpmeta',
  'RDF',
  'Description',
  'Seq',
  'Bag',
  'Alt',
  'li',
  'history',
]);

const SENSITIVE_PREFIXES = new Set([
  'dc',
  'xmp',
  'xmpMM',
  'photoshop',
  'Iptc4xmpCore',
  'Iptc4xmpExt',
  'crs',
  'tiff',
  'exif',
  'aux',
  'gpano',
  'stEvt',
  'pdf',
  'xmpGImg',
  'xmpNote',
  'MicrosoftPhoto',
  'lr',
]);

const GPS_PREFIXES = new Set(['gpano']);
const AUTHOR_PREFIXES = new Set(['dc', 'photoshop', 'Iptc4xmpCore', 'Iptc4xmpExt']);

function groupFor(prefix: string, name: string): FieldGroup {
  if (GPS_PREFIXES.has(prefix) || /^(GPS|GPano)/.test(name)) return 'gps';
  if (AUTHOR_PREFIXES.has(prefix)) return 'author';
  if (prefix === 'xmp' || prefix === 'xmpMM' || prefix === 'crs' || prefix === 'stEvt' || prefix === 'lr') {
    return 'software';
  }
  if (prefix === 'tiff' || prefix === 'aux' || prefix === 'exif') return 'device';
  return 'other';
}

function stripTags(input: string): string {
  return input.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function decodeBase64(value: string): Uint8Array | null {
  const clean = value.replace(/\s+/g, '');
  if (clean.length < 16) return null;
  try {
    const binary = atob(clean);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

export function parseXmp(bytes: Uint8Array, extended = false): XmpSummary {
  const text = decodeText(bytes);
  const namespaces: { prefix: string; uri: string }[] = [];
  const seenNs = new Set<string>();
  for (const m of text.matchAll(/xmlns:([A-Za-z0-9_.-]+)\s*=\s*["']([^"']+)["']/g)) {
    const prefix = m[1] ?? '';
    const uri = m[2] ?? '';
    if (!prefix || seenNs.has(prefix)) continue;
    seenNs.add(prefix);
    namespaces.push({ prefix, uri });
  }

  const properties: XmpProperty[] = [];
  const seenKeys = new Set<string>();

  const add = (prefix: string, name: string, rawValue: string) => {
    if (properties.length >= 300) return;
    if (WRAPPER_ELEMENTS.has(name)) return;
    const value = stripTags(rawValue).slice(0, 400);
    if (!value) return;
    const key = `${prefix}:${name}`;
    const dedupe = `${key}\u0000${value}`;
    if (seenKeys.has(dedupe)) return;
    seenKeys.add(dedupe);
    properties.push({
      key,
      prefix,
      value,
      group: groupFor(prefix, name),
      sensitive: SENSITIVE_PREFIXES.has(prefix) || /^(GPS|GPano)/.test(name),
    });
  };

  // Element form, walked open-tag by open-tag so nesting never hides siblings.
  for (const m of text.matchAll(/<([A-Za-z0-9_.-]+):([A-Za-z0-9_.-]+)(?:\s[^>]*)?>/g)) {
    const prefix = m[1] ?? '';
    const name = m[2] ?? '';
    if (WRAPPER_ELEMENTS.has(name)) continue;
    const openEnd = (m.index ?? 0) + m[0].length;
    const closeAt = text.indexOf(`</${prefix}:${name}>`, openEnd);
    if (closeAt === -1) continue;
    const inner = text.slice(openEnd, closeAt);
    if (/<rdf:li[\s>]/.test(inner)) {
      for (const li of inner.matchAll(/<rdf:li(?:\s[^>]*)?>([\s\S]*?)<\/rdf:li>/g)) {
        add(prefix, name, li[1] ?? '');
      }
    } else if (!inner.includes('<')) {
      add(prefix, name, inner);
    } else {
      add(prefix, name, stripTags(inner));
    }
  }

  // Attribute form: <rdf:Description ns:Name="value" …>
  for (const m of text.matchAll(/<rdf:Description\b([^>]*)>/g)) {
    const attrs = m[1] ?? '';
    for (const a of attrs.matchAll(/([A-Za-z0-9_.-]+):([A-Za-z0-9_.-]+)\s*=\s*"([^"]*)"/g)) {
      const prefix = a[1] ?? '';
      const name = a[2] ?? '';
      if (prefix === 'xmlns') continue;
      add(prefix, name, a[3] ?? '');
    }
  }

  const hasGps = properties.some((p) => p.group === 'gps' || /^(GPSLatitude|GPSLongitude|GPSAltitude)$/.test(p.key.split(':')[1] ?? ''));
  const hasCreator = properties.some((p) => /^(dc:(creator|rights)|photoshop:(Credit|Byline|AuthorsPosition))$/.test(p.key));
  const hasHistory = properties.some((p) => /^(xmpMM:History|stEvt:|photoshop:History)$/.test(p.key) || p.prefix === 'stEvt');

  let thumbnail: XmpSummary['thumbnail'];
  const thumbProp = properties.find((p) => p.key === 'xmpGImg:image');
  if (thumbProp) {
    const raw = decodeBase64(thumbProp.value);
    if (raw && raw.length > 100) {
      thumbnail = { blob: new Blob([raw.slice()], { type: 'image/jpeg' }), mime: 'image/jpeg', bytes: raw.length };
    }
  }

  // The base64 preview is surfaced as a thumbnail, not as a wall of text.
  const isBinaryBlob = (value: string) => value.length > 200 && /^[A-Za-z0-9+/=\s]+$/.test(value);
  const fields: Field[] = properties
    .filter((p) => p.key !== 'xmpGImg:image')
    .map((p) => ({
      label: p.key,
      value: isBinaryBlob(p.value) ? `(${p.value.length} chars of base64 data)` : p.value,
      group: p.group,
      sensitive: p.sensitive,
    }));

  return {
    bytes: bytes.length,
    namespaces,
    properties,
    fields,
    extended,
    thumbnail,
    hasGps,
    hasCreator,
    hasHistory,
  };
}
