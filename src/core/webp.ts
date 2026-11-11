/**
 * WebP (RIFF) analyser / stripper.
 *
 * Chunks are a flat list; we keep the ones a decoder needs plus the ICC profile,
 * rebuild the RIFF header size, and clear the EXIF/XMP presence flags in VP8X.
 */
import { ascii, u32le } from './bytes.ts';
import { summarizeC2pa } from './c2pa.ts';
import { summarizeExifBlock } from './exif.ts';
import { buildC2paFindings, buildExifFindings, buildXmpFindings } from './findings.ts';
import { parseJumbf } from './jumbf.ts';
import { readAt, type Source } from './source.ts';
import type {
  BlockInfo,
  ContainerAnalysis,
  Finding,
  Part,
  StripOptions,
  Warning,
} from './types.ts';
import { parseXmp } from './xmp.ts';

const KEEP_CHUNKS = new Set(['VP8 ', 'VP8L', 'VP8X', 'ALPH', 'ANIM', 'ANMF', 'ICCP']);

const CHUNK_NAMES: Record<string, string> = {
  'VP8 ': 'VP8 lossy image',
  VP8L: 'VP8L lossless image',
  VP8X: 'VP8X header',
  ALPH: 'ALPH transparency',
  ANIM: 'ANIM animation',
  ANMF: 'ANMF frame',
  ICCP: 'ICCP colour profile',
  EXIF: 'EXIF',
  'XMP ': 'XMP',
  C2PA: 'C2PA manifest',
  JUMBF: 'JUMBF',
};

// VP8X flag byte: bit 5 ICC, bit 4 alpha, bit 3 EXIF, bit 2 XMP, bit 1 animation.
const FLAG_ICC = 0x20;
const FLAG_ALPHA = 0x10;
const FLAG_EXIF = 0x08;
const FLAG_XMP = 0x04;
const FLAG_ANIM = 0x02;

const MAX_META = 4 * 1024 * 1024;

interface Chunk {
  fourcc: string;
  start: number;
  dataStart: number;
  size: number;
  end: number;
  keep: boolean;
  payload?: Uint8Array;
}

export async function analyzeWebp(src: Source, opts: StripOptions): Promise<ContainerAnalysis> {
  const warnings: Warning[] = [];
  const findings: Finding[] = [];
  const blocks: BlockInfo[] = [];

  if (src.size < 12) {
    return failed([{ id: 'warn.tooSmall', severity: 'error' }], src.size);
  }
  const header = await readAt(src, 0, 12);
  if (ascii(header, 0, 4) !== 'RIFF' || ascii(header, 8, 4) !== 'WEBP') {
    return failed([{ id: 'warn.notWebp', severity: 'error' }], src.size);
  }
  const declared = u32le(header, 4) + 8;
  if (declared > src.size) {
    warnings.push({ id: 'warn.webp.truncated', severity: 'warn' });
  }

  const chunks: Chunk[] = [];
  let pos = 12;
  while (pos + 8 <= src.size) {
    const head = await readAt(src, pos, 8);
    const fourcc = ascii(head, 0, 4);
    const size = u32le(head, 4);
    const dataStart = pos + 8;
    const dataEnd = dataStart + size;
    const end = dataEnd + (size & 1);
    if (dataEnd > src.size) {
      warnings.push({ id: 'warn.webp.truncated', severity: 'error', params: { chunk: fourcc } });
      break;
    }
    const keep = KEEP_CHUNKS.has(fourcc) && (fourcc !== 'ICCP' || opts.keepIcc);
    chunks.push({ fourcc, start: pos, dataStart, size, end: Math.min(end, src.size), keep });
    pos = Math.min(end, src.size);
  }

  let sawImage = false;
  let orientation = 1;
  let droppedBytes = 0;

  for (const chunk of chunks) {
    const name = CHUNK_NAMES[chunk.fourcc] ?? chunk.fourcc;
    blocks.push({ name, bytes: chunk.end - chunk.start, kept: chunk.keep });

    if (chunk.fourcc === 'VP8 ' || chunk.fourcc === 'VP8L' || chunk.fourcc === 'ANMF')
      sawImage = true;

    if (chunk.keep) continue;

    droppedBytes += chunk.end - chunk.start;
    const wanted =
      chunk.fourcc === 'EXIF' ||
      chunk.fourcc === 'XMP ' ||
      chunk.fourcc === 'C2PA' ||
      chunk.fourcc === 'JUMBF';
    if (!wanted || chunk.size === 0) continue;
    const payload = await readAt(src, chunk.dataStart, Math.min(chunk.size, MAX_META));
    chunk.payload = payload;

    if (chunk.fourcc === 'EXIF') {
      const exif = summarizeExifBlock(payload);
      if (exif) {
        orientation = exif.orientation;
        findings.push(...buildExifFindings(exif, chunk.size));
        if (exif.orientation !== 1) {
          findings.push({
            id: 'finding.orientation',
            category: 'orientation',
            severity: 'low',
            params: { orientation: exif.orientation },
          });
        }
      } else {
        findings.push({
          id: 'finding.exif.unparsed',
          category: 'exif',
          severity: 'medium',
          bytes: chunk.size,
        });
      }
    } else if (chunk.fourcc === 'XMP ') {
      findings.push(...buildXmpFindings(parseXmp(payload)));
    } else {
      try {
        findings.push(...buildC2paFindings(summarizeC2pa(parseJumbf(payload), chunk.size)));
      } catch {
        findings.push({
          id: 'finding.jumbf',
          category: 'c2pa',
          severity: 'high',
          bytes: chunk.size,
        });
      }
    }
  }

  const trailer = src.size - pos;
  if (trailer > 0) {
    findings.push({
      id: 'finding.trailer',
      category: 'trailer',
      severity: 'low',
      bytes: trailer,
      params: { bytes: trailer },
    });
    if (!opts.truncateTrailer)
      chunks.push({
        fourcc: '',
        start: pos,
        dataStart: pos,
        size: trailer,
        end: src.size,
        keep: true,
      });
    else droppedBytes += trailer;
  }

  const kept = chunks.filter((c) => c.keep);
  const keptAnimated = kept.some((c) => c.fourcc === 'ANIM' || c.fourcc === 'ANMF');
  const keptAlpha = kept.some((c) => c.fourcc === 'ALPH');
  const chunkBytes = kept.reduce((sum, c) => sum + (c.end - c.start), 0);
  const riffSize = 4 + chunkBytes;

  const parts: Part[] = [];
  const fileHeader = new Uint8Array(12);
  fileHeader.set([0x52, 0x49, 0x46, 0x46], 0); // RIFF
  fileHeader.set(
    [riffSize & 0xff, (riffSize >>> 8) & 0xff, (riffSize >>> 16) & 0xff, (riffSize >>> 24) & 0xff],
    4,
  );
  fileHeader.set([0x57, 0x45, 0x42, 0x50], 8); // WEBP
  parts.push({ kind: 'bytes', bytes: fileHeader });

  for (const chunk of kept) {
    if (chunk.fourcc === 'VP8X' && chunk.end - chunk.start >= 9) {
      const payload = await readAt(src, chunk.dataStart, Math.min(chunk.size, 10));
      const patched = payload.slice();
      const flags = patched[0] ?? 0;
      let next = flags & ~FLAG_EXIF & ~FLAG_XMP;
      if (!opts.keepIcc) next &= ~FLAG_ICC;
      if (!keptAnimated) next &= ~FLAG_ANIM;
      if (!keptAlpha) next &= ~FLAG_ALPHA;
      patched[0] = next;
      const chunkHeader = new Uint8Array(8);
      chunkHeader.set([0x56, 0x50, 0x38, 0x58], 0); // VP8X
      chunkHeader.set([patched.length & 0xff, (patched.length >>> 8) & 0xff, 0, 0], 4);
      const padded =
        patched.length % 2 === 1
          ? new Uint8Array([...chunkHeader, ...patched, 0])
          : new Uint8Array([...chunkHeader, ...patched]);
      parts.push({ kind: 'bytes', bytes: padded });
    } else {
      parts.push({ kind: 'slice', start: chunk.start, end: chunk.end });
    }
  }

  if (!sawImage) warnings.push({ id: 'warn.webp.noImage', severity: 'error' });
  if (declared !== 0 && Math.abs(declared - src.size) > 16) {
    warnings.push({ id: 'warn.webp.sizeMismatch', severity: 'warn' });
  }

  const ok = sawImage && !warnings.some((w) => w.severity === 'error');
  return {
    format: 'webp',
    mime: 'image/webp',
    ext: 'webp',
    parts: ok ? parts : [],
    findings,
    warnings,
    orientation,
    blocks,
    droppedBytes,
    keptBytes: src.size - droppedBytes,
    ok,
  };
}

function failed(warnings: Warning[], fileSize: number): ContainerAnalysis {
  return {
    format: 'webp',
    mime: 'image/webp',
    ext: 'webp',
    parts: [],
    findings: [],
    warnings,
    orientation: 0,
    blocks: [],
    droppedBytes: 0,
    keptBytes: fileSize,
    ok: false,
  };
}
