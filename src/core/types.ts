/** Public data model shared by the scanning engine and the UI. */

export type Format =
  | 'jpeg'
  | 'png'
  | 'webp'
  | 'gif'
  | 'avif'
  | 'heic'
  | 'tiff'
  | 'bmp'
  | 'jxl'
  | 'svg'
  | 'pdf'
  | 'video'
  | 'unknown';

export interface FormatInfo {
  format: Format;
  mime: string;
  ext: string;
  supported: boolean;
}

export type Severity = 'high' | 'medium' | 'low' | 'info';

export type Category =
  | 'gps'
  | 'exif'
  | 'xmp'
  | 'iptc'
  | 'c2pa'
  | 'thumbnail'
  | 'comment'
  | 'trailer'
  | 'mpf'
  | 'orientation'
  | 'icc'
  | 'structure'
  | 'unknown';

export type FieldGroup = 'device' | 'time' | 'author' | 'gps' | 'capture' | 'software' | 'other';

/** A single labelled value shown in the details panel. */
export interface Field {
  /** Technical tag name, kept language-neutral (Make, Model, GPSLatitude…). */
  label: string;
  value: string;
  group?: FieldGroup;
  sensitive?: boolean;
}

export interface C2paAction {
  action: string;
  when?: string;
  softwareAgent?: string;
  digitalSourceType?: string;
  reason?: string;
}

export interface C2paManifest {
  label: string;
  bytes: number;
  claimGenerator?: string;
  title?: string;
  signer?: string;
  issuer?: string;
  certValidFrom?: string;
  certValidTo?: string;
  algorithm?: string;
  actions: C2paAction[];
  assertionLabels: string[];
  ingredientCount: number;
  hasThumbnail: boolean;
  thumbnail?: Blob;
}

export interface FindingPreview {
  blob: Blob;
  mime: string;
}

export interface Finding {
  /** i18n key describing the finding, e.g. `finding.gps`. */
  id: string;
  category: Category;
  severity: Severity;
  /** Bytes that this finding accounts for in the source file. */
  bytes?: number;
  params?: Record<string, string | number>;
  fields?: Field[];
  preview?: FindingPreview;
  manifest?: C2paManifest;
}

export interface Warning {
  id: string;
  severity: 'warn' | 'error';
  params?: Record<string, string | number>;
}

export interface BlockInfo {
  /** Human readable block name, e.g. `APP1 Exif`, `tEXt`, `C2PA`. */
  name: string;
  bytes: number;
  kept: boolean;
  note?: string;
}

export interface ScanResult {
  format: Format;
  fileSize: number;
  supported: boolean;
  findings: Finding[];
  warnings: Warning[];
  /** EXIF orientation (1–8), 1 when absent or unknown. */
  orientation: number;
  blocks: BlockInfo[];
  /** Bytes that a strip pass will remove. */
  droppedBytes: number;
  keptBytes: number;
  hasC2pa: boolean;
}

export interface StripOptions {
  /** Drop everything after the JPEG EOI marker (trailing junk, appended data). */
  truncateTrailer: boolean;
  /** Keep the ICC colour profile (recommended: without it colours can shift). */
  keepIcc: boolean;
}

export const DEFAULT_STRIP_OPTIONS: StripOptions = {
  truncateTrailer: true,
  keepIcc: true,
};

export interface RemovalEntry {
  id: string;
  count: number;
  bytes: number;
}

export interface StripResult {
  blob: Blob;
  format: Format;
  mime: string;
  ext: string;
  removed: RemovalEntry[];
  removedBytes: number;
  warnings: Warning[];
  reencoded: boolean;
}

export interface VerifyResult {
  ok: boolean;
  leftovers: Finding[];
  warnings: Warning[];
  fileSize: number;
}

/** A slice of the source (copied as-is) or freshly minted bytes. */
export type Part =
  { kind: 'slice'; start: number; end: number } | { kind: 'bytes'; bytes: Uint8Array };

/** Result of one container analysis pass; `parts` only exists for stripping. */
export interface ContainerAnalysis {
  format: Format;
  mime: string;
  ext: string;
  parts: Part[];
  findings: Finding[];
  warnings: Warning[];
  orientation: number;
  blocks: BlockInfo[];
  droppedBytes: number;
  keptBytes: number;
  /** False when the container is structurally unusable or unsupported. */
  ok: boolean;
}
