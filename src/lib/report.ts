/**
 * Machine-readable diagnostic report.
 *
 * The point is reproducibility: a user who thinks the tool lied can hand over
 * exactly what it saw — findings, block layout, settings, verification result —
 * without uploading the photo itself. Binaries are described by size, never
 * embedded.
 */
import type { Finding, ScanResult, StripOptions, VerifyResult } from '../core/types.ts';
import { baseNameOf } from './files.ts';

declare const __APP_VERSION__: string;

// Vite replaces the identifier at build time; plain Node (debug scripts, the
// real-sample runner) leaves it undefined instead of crashing.
const APP_VERSION = typeof __APP_VERSION__ === 'undefined' ? 'dev' : __APP_VERSION__;

export const REPORT_SCHEMA = 'picprivacy.report/1';
/** A batch document: the same report/1 bodies, one per file, in one download. */
export const BATCH_SCHEMA = 'picprivacy.batch/1';

export interface ReportResultInput {
  size: number;
  filename: string;
  removed: { id: string; count: number; bytes: number }[];
  removedBytes: number;
  reencoded: boolean;
  verify: VerifyResult;
}

export interface ReportInput {
  file: File;
  scan: ScanResult;
  options: StripOptions;
  bake: boolean;
  /** Absent until the file has actually been cleaned. */
  result?: ReportResultInput;
}

/** Blobs cannot survive JSON, so every payload becomes a measurement. */
function plainFinding(finding: Finding): Record<string, unknown> {
  const { preview, manifest, ...rest } = finding;
  return {
    ...rest,
    ...(preview ? { preview: { mime: preview.mime, bytes: preview.blob.size } } : {}),
    ...(manifest
      ? {
          manifest: {
            ...manifest,
            thumbnail: manifest.thumbnail ? { bytes: manifest.thumbnail.size } : undefined,
          },
        }
      : {}),
  };
}

async function sha256(file: File): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function reportFileName(original: string): string {
  return `report-${baseNameOf(original)}.json`;
}

function stamp(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(
    date.getMinutes(),
  )}`;
}

export function batchReportName(date = new Date()): string {
  return `picprivacy-reports-${stamp(date)}.json`;
}

/** One report body; `buildReport` and the batch document share it verbatim. */
async function reportBody(input: ReportInput): Promise<Record<string, unknown>> {
  const { file, scan, options, bake, result } = input;
  return {
    schema: REPORT_SCHEMA,
    app: { name: 'PicPrivacy', version: APP_VERSION },
    generatedAt: new Date().toISOString(),
    file: {
      name: file.name,
      size: file.size,
      declaredType: file.type || null,
      sha256: await sha256(file),
      format: scan.format,
      supported: scan.supported,
    },
    settings: {
      truncateTrailer: options.truncateTrailer,
      keepIcc: options.keepIcc,
      bake,
    },
    scan: {
      orientation: scan.orientation,
      droppedBytes: scan.droppedBytes,
      keptBytes: scan.keptBytes,
      hasC2pa: scan.hasC2pa,
      findings: scan.findings.map(plainFinding),
      warnings: scan.warnings,
      blocks: scan.blocks,
    },
    ...(result
      ? {
          result: {
            ...result,
            verify: { ...result.verify, leftovers: result.verify.leftovers.map(plainFinding) },
          },
        }
      : {}),
  };
}

export async function buildReport(input: ReportInput): Promise<string> {
  return `${JSON.stringify(await reportBody(input), null, 2)}\n`;
}

/**
 * Every file in one document. Each entry is a complete `report/1`, so a single
 * object can be lifted out and read with the same tooling.
 */
export async function buildBatchReport(
  inputs: readonly ReportInput[],
  onProgress?: (done: number, total: number) => void,
): Promise<string> {
  const files: Record<string, unknown>[] = [];
  for (const input of inputs) {
    files.push(await reportBody(input));
    onProgress?.(files.length, inputs.length);
  }
  return `${JSON.stringify(
    {
      schema: BATCH_SCHEMA,
      app: { name: 'PicPrivacy', version: APP_VERSION },
      generatedAt: new Date().toISOString(),
      count: files.length,
      files,
    },
    null,
    2,
  )}\n`;
}
