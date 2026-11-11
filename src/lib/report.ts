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
import { sha256Blob } from './sha256.ts';

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
  bakeFailed?: boolean;
  verify: VerifyResult;
}

export interface ReportInput {
  file: File;
  scan: ScanResult;
  options: StripOptions;
  bake: boolean;
  /**
   * Replace sensitive values with `[redacted]`. On by default: the report is
   * meant to be attached to a bug report, and it describes the very GPS
   * coordinates and serial numbers the user came here to remove.
   */
  redact?: boolean;
  /** Absent until the file has actually been cleaned. */
  result?: ReportResultInput;
}

const REDACTED = '[redacted]';
/**
 * Params that describe structure rather than a person. Everything else with a
 * string value is replaced when redaction is on: `lat`, `lon`, `mapUrl`, `text`,
 * `make`, `model`, `keywords` and any future field are covered by default.
 */
const SAFE_PARAM_KEYS = new Set([
  'format',
  'type',
  'types',
  'block',
  'chunk',
  'item',
  'codec',
  'id',
  'kind',
  'warning',
  'namespaces',
]);

function redactParams(
  params: Record<string, string | number> | undefined,
): Record<string, string | number> | undefined {
  if (!params) return params;
  const out: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(params)) {
    out[key] = typeof value === 'number' || SAFE_PARAM_KEYS.has(key) ? value : REDACTED;
  }
  return out;
}

function redactManifest(manifest: NonNullable<Finding['manifest']>): Record<string, unknown> {
  return {
    ...manifest,
    title: manifest.title ? REDACTED : undefined,
    signer: manifest.signer ? REDACTED : undefined,
    issuer: manifest.issuer ? REDACTED : undefined,
    thumbnail: manifest.thumbnail ? { bytes: manifest.thumbnail.size } : undefined,
  };
}

/** Blobs cannot survive JSON, so every payload becomes a measurement. */
function plainFinding(finding: Finding, redact: boolean): Record<string, unknown> {
  const { preview, manifest, fields, params, ...rest } = finding;
  return {
    ...rest,
    ...(params ? { params: redact ? redactParams(params) : params } : {}),
    ...(fields
      ? {
          fields: redact
            ? fields.map((field) => (field.sensitive ? { ...field, value: REDACTED } : field))
            : fields,
        }
      : {}),
    ...(preview ? { preview: { mime: preview.mime, bytes: preview.blob.size } } : {}),
    ...(manifest
      ? {
          manifest: redact
            ? redactManifest(manifest)
            : {
                ...manifest,
                thumbnail: manifest.thumbnail ? { bytes: manifest.thumbnail.size } : undefined,
              },
        }
      : {}),
  };
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
  const redact = input.redact ?? true;
  return {
    schema: REPORT_SCHEMA,
    app: { name: 'PicPrivacy', version: APP_VERSION },
    generatedAt: new Date().toISOString(),
    redaction: { applied: redact },
    file: {
      name: file.name,
      size: file.size,
      declaredType: file.type || null,
      sha256: await sha256Blob(file),
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
      findings: scan.findings.map((finding) => plainFinding(finding, redact)),
      warnings: scan.warnings,
      blocks: scan.blocks,
    },
    ...(result
      ? {
          result: {
            ...result,
            verify: {
              ...result.verify,
              leftovers: result.verify.leftovers.map((finding) => plainFinding(finding, redact)),
            },
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
