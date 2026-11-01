/** Builders that turn parsed metadata into UI findings. Shared by all containers. */
import { summarizeC2pa, type C2paSummary } from './c2pa.ts';
import type { ExifSummary } from './exif.ts';
import type { IptcSummary } from './iptc.ts';
import { parseJumbf, type JumbfBox } from './jumbf.ts';
import type { XmpSummary } from './xmp.ts';
import type { Finding } from './types.ts';

export function buildExifFindings(exif: ExifSummary, bytes: number): Finding[] {
  const findings: Finding[] = [];
  const otherFields = exif.fields.filter((f) => f.group !== 'gps');

  if (otherFields.length > 0) {
    const params: Record<string, string | number> = { count: exif.tagCount };
    if (exif.make) params['make'] = exif.make;
    if (exif.model) params['model'] = exif.model;
    findings.push({
      id: 'finding.exif',
      category: 'exif',
      severity: 'medium',
      bytes,
      params,
      fields: otherFields,
    });
  }

  if (exif.gps) {
    findings.push({
      id: 'finding.gps',
      category: 'gps',
      severity: 'high',
      fields: exif.gps.fields,
      params: {
        lat: exif.gps.latText,
        lon: exif.gps.lonText,
        mapUrl: exif.gps.mapUrl,
      },
    });
  }

  if (exif.thumbnail) {
    findings.push({
      id: 'finding.exif.thumbnail',
      category: 'thumbnail',
      severity: 'high',
      bytes: exif.thumbnail.bytes,
      preview: { blob: exif.thumbnail.blob, mime: exif.thumbnail.mime },
    });
  }

  return findings;
}

export function buildXmpFindings(xmp: XmpSummary): Finding[] {
  const findings: Finding[] = [];
  if (xmp.properties.length > 0) {
    const params: Record<string, string | number> = { count: xmp.properties.length };
    const prefixes = xmp.namespaces.map((n) => n.prefix).slice(0, 8);
    if (prefixes.length > 0) params['namespaces'] = prefixes.join(', ');
    findings.push({
      id: xmp.extended ? 'finding.xmp.extended' : 'finding.xmp',
      category: 'xmp',
      severity: 'medium',
      bytes: xmp.bytes,
      params,
      fields: xmp.fields,
    });
  }
  if (xmp.thumbnail) {
    findings.push({
      id: 'finding.xmp.thumbnail',
      category: 'thumbnail',
      severity: 'high',
      bytes: xmp.thumbnail.bytes,
      preview: { blob: xmp.thumbnail.blob, mime: xmp.thumbnail.mime },
    });
  }
  return findings;
}

export function buildIptcFindings(iptc: IptcSummary): Finding[] {
  if (iptc.datasets.length > 0) {
    return [
      {
        id: 'finding.iptc',
        category: 'iptc',
        severity: 'medium',
        bytes: iptc.bytes,
        params: { count: iptc.datasets.length },
        fields: iptc.fields,
      },
    ];
  }
  if (iptc.resources.length > 0) {
    return [
      {
        id: 'finding.iptc.resources',
        category: 'iptc',
        severity: 'low',
        bytes: iptc.bytes,
        params: { count: iptc.resources.length },
        fields: iptc.resources.map((r) => ({
          label: `8BIM 0x${r.id.toString(16).padStart(4, '0')}`,
          value: `${r.name} (${r.bytes} bytes)`,
          group: 'other',
        })),
      },
    ];
  }
  return [];
}

/**
 * Turn raw JUMBF payloads into findings.
 *
 * Containers disagree about the wrapper around the superbox (a bare superbox,
 * a two-byte `JP` prefix, or a length offset), so every plausible start is
 * tried before giving up and reporting an unparsed block.
 */
export function buildJumbfFindings(payloads: readonly Uint8Array[], bytes: number): Finding[] {
  const candidates: Uint8Array[] = [];
  for (const payload of payloads) {
    candidates.push(payload);
    if (payload.length > 2 && payload[0] === 0x4a && payload[1] === 0x50) candidates.push(payload.subarray(2));
    if (payload.length > 4) candidates.push(payload.subarray(4));
  }
  const boxes: JumbfBox[] = [];
  for (const candidate of candidates) {
    try {
      const parsed = parseJumbf(candidate);
      if (parsed.length > 0) boxes.push(...parsed);
    } catch {
      /* ignore malformed segment */
    }
  }
  const summary = summarizeC2pa(boxes, bytes);
  if (!summary.present) {
    return [
      {
        id: 'finding.jumbf',
        category: 'c2pa',
        severity: 'high',
        bytes,
        params: { segments: payloads.length },
      },
    ];
  }
  return buildC2paFindings(summary);
}

export function buildC2paFindings(summary: C2paSummary): Finding[] {
  if (!summary.present) return [];
  const findings: Finding[] = [];

  if (summary.manifests.length === 0) {
    findings.push({
      id: 'finding.c2pa.unparsed',
      category: 'c2pa',
      severity: 'high',
      bytes: summary.bytes,
      params: { boxes: summary.boxCount },
    });
    return findings;
  }

  for (const manifest of summary.manifests) {
    const params: Record<string, string | number> = {};
    if (manifest.claimGenerator) params['generator'] = manifest.claimGenerator;
    if (manifest.signer) params['signer'] = manifest.signer;
    if (manifest.actions.length > 0) params['actions'] = manifest.actions.length;
    findings.push({
      id: 'finding.c2pa',
      category: 'c2pa',
      severity: 'high',
      bytes: manifest.bytes,
      params,
      manifest,
    });
  }
  return findings;
}
