import type { Category, Finding } from '../core/types.ts';
import type { MessageKey } from '../i18n/zh.ts';

export interface BadgeSpec {
  key: MessageKey;
  tone: 'high' | 'medium' | 'low';
  order: number;
}

const BADGES: Partial<Record<Category, BadgeSpec>> = {
  gps: { key: 'badge.gps', tone: 'high', order: 0 },
  c2pa: { key: 'badge.c2pa', tone: 'high', order: 1 },
  thumbnail: { key: 'badge.thumbnail', tone: 'high', order: 2 },
  exif: { key: 'badge.exif', tone: 'medium', order: 3 },
  xmp: { key: 'badge.xmp', tone: 'medium', order: 4 },
  iptc: { key: 'badge.iptc', tone: 'medium', order: 5 },
  orientation: { key: 'badge.orientation', tone: 'low', order: 6 },
  mpf: { key: 'badge.mpf', tone: 'low', order: 7 },
  comment: { key: 'badge.comment', tone: 'low', order: 8 },
  trailer: { key: 'badge.trailer', tone: 'low', order: 9 },
  unknown: { key: 'badge.unknown', tone: 'low', order: 10 },
};

export function badgesFor(findings: Finding[]): BadgeSpec[] {
  const seen = new Set<Category>();
  const out: BadgeSpec[] = [];
  for (const finding of findings) {
    if (seen.has(finding.category)) continue;
    const badge = BADGES[finding.category];
    if (!badge) continue;
    seen.add(finding.category);
    out.push(badge);
  }
  return out.sort((a, b) => a.order - b.order);
}

export type FindingIcon =
  | 'gps'
  | 'camera'
  | 'image'
  | 'clock'
  | 'user'
  | 'shield'
  | 'layers'
  | 'alert'
  | 'info'
  | 'file';

export function iconForFinding(finding: Finding): FindingIcon {
  if (finding.category === 'gps') return 'gps';
  if (finding.category === 'exif') return 'camera';
  if (finding.category === 'thumbnail') return 'image';
  if (finding.category === 'c2pa') return 'shield';
  if (finding.category === 'xmp' || finding.category === 'iptc') return 'layers';
  if (finding.category === 'orientation') return 'info';
  if (finding.category === 'trailer' || finding.category === 'mpf') return 'file';
  if (finding.severity === 'high') return 'alert';
  return 'info';
}

/** Format a JS date range for certificate validity display. */
export function validityText(from?: string, to?: string): string {
  if (!from && !to) return '';
  if (from && to) return `${from} → ${to}`;
  return from ?? to ?? '';
}
