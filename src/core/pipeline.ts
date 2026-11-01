/** Orchestration: sniff → analyse → (strip) → (verify). */
import { analyzeGif } from './gif.ts';
import { analyzeJpeg } from './jpeg.ts';
import { analyzePng } from './png.ts';
import { analyzeWebp } from './webp.ts';
import { sniff } from './sniff.ts';
import { sourceFromBlob, type Source } from './source.ts';
import {
  DEFAULT_STRIP_OPTIONS,
  type ContainerAnalysis,
  type Finding,
  type Format,
  type ScanResult,
  type StripOptions,
  type StripResult,
  type VerifyResult,
} from './types.ts';

const ANALYSERS: Record<string, (src: Source, opts: StripOptions) => Promise<ContainerAnalysis>> = {
  jpeg: analyzeJpeg,
  png: analyzePng,
  webp: analyzeWebp,
  gif: analyzeGif,
};

const UNSUPPORTED_FORMAT_NAMES: Partial<Record<Format, string>> = {
  avif: 'AVIF',
  heic: 'HEIC',
  tiff: 'TIFF',
  bmp: 'BMP',
  jxl: 'JPEG XL',
  svg: 'SVG',
  pdf: 'PDF',
  video: 'video',
};

export function unsupportedFormatName(format: Format): string | undefined {
  return UNSUPPORTED_FORMAT_NAMES[format];
}

async function analyse(src: Source, opts: StripOptions): Promise<ContainerAnalysis | null> {
  const info = await sniff(src);
  const analyser = ANALYSERS[info.format];
  if (!analyser) return null;
  return analyser(src, opts);
}

export async function scanSource(
  src: Source,
  opts: StripOptions = DEFAULT_STRIP_OPTIONS,
): Promise<ScanResult> {
  const info = await sniff(src);
  const analysis = await analyse(src, opts);
  if (!analysis) {
    return {
      format: info.format,
      fileSize: src.size,
      supported: false,
      findings: [],
      warnings: [{ id: 'warn.unsupported', severity: 'error', params: { format: info.format } }],
      orientation: 1,
      blocks: [],
      droppedBytes: 0,
      keptBytes: src.size,
      hasC2pa: false,
    };
  }
  return {
    format: analysis.format,
    fileSize: src.size,
    supported: true,
    findings: analysis.findings,
    warnings: analysis.warnings,
    orientation: analysis.orientation || 1,
    blocks: analysis.blocks,
    droppedBytes: analysis.droppedBytes,
    keptBytes: analysis.keptBytes,
    hasC2pa: analysis.findings.some((f) => f.category === 'c2pa'),
  };
}

const KEEP_CATEGORIES = new Set(['icc']);

export async function stripSource(
  src: Source,
  opts: StripOptions = DEFAULT_STRIP_OPTIONS,
): Promise<StripResult> {
  const info = await sniff(src);
  if (!info.supported) {
    throw new Error(`unsupported-format:${info.format}`);
  }
  const analysis = await analyse(src, opts);
  if (!analysis) throw new Error(`unsupported-format:${info.format}`);
  if (!analysis.ok) {
    throw new Error(`unreadable:${analysis.warnings.find((w) => w.severity === 'error')?.id ?? 'unknown'}`);
  }

  const blobParts: BlobPart[] = analysis.parts.map((part) =>
    part.kind === 'slice' ? src.blob.slice(part.start, part.end) : (part.bytes as unknown as BlobPart),
  );
  const blob = new Blob(blobParts, { type: analysis.mime });

  const removed = summariseRemoved(analysis.findings);
  return {
    blob,
    format: analysis.format,
    mime: analysis.mime,
    ext: analysis.ext,
    removed,
    removedBytes: analysis.droppedBytes,
    warnings: analysis.warnings,
    reencoded: false,
  };
}

function summariseRemoved(findings: Finding[]): { id: string; count: number; bytes: number }[] {
  const map = new Map<string, { id: string; count: number; bytes: number }>();
  for (const finding of findings) {
    if (KEEP_CATEGORIES.has(finding.category)) continue;
    const entry = map.get(finding.id) ?? { id: finding.id, count: 0, bytes: 0 };
    entry.count += 1;
    entry.bytes += finding.bytes ?? 0;
    map.set(finding.id, entry);
  }
  return [...map.values()];
}

const SENSITIVE_CATEGORIES = new Set([
  'gps',
  'exif',
  'xmp',
  'iptc',
  'c2pa',
  'thumbnail',
  'comment',
  'trailer',
  'mpf',
  'unknown',
  'orientation',
]);

/** Re-scan the stripped output: nothing sensitive may survive. */
export async function verifyBlob(blob: Blob, expectFormat?: Format): Promise<VerifyResult> {
  const src = sourceFromBlob(blob);
  const scan = await scanSource(src);
  const leftovers = scan.findings.filter((f) => SENSITIVE_CATEGORIES.has(f.category));
  const formatMismatch = expectFormat !== undefined && scan.format !== expectFormat;
  return {
    ok: scan.supported && !formatMismatch && leftovers.length === 0 && !scan.warnings.some((w) => w.severity === 'error'),
    leftovers,
    warnings: scan.warnings,
    fileSize: blob.size,
  };
}

export async function scanFile(file: File, opts?: StripOptions): Promise<ScanResult> {
  return scanSource(sourceFromBlob(file), opts);
}

export interface StripOutcome {
  result: StripResult;
  verify: VerifyResult;
}

/**
 * Strip a File and re-scan the output.
 *
 * A failed verification is reported, not thrown: the caller decides how to
 * present it, and the UI refuses to offer a download in that case.
 */
export async function stripFile(file: File, opts?: StripOptions): Promise<StripOutcome> {
  const src = sourceFromBlob(file);
  const result = await stripSource(src, opts);
  const verify = await verifyBlob(result.blob, result.format);
  return { result, verify };
}
