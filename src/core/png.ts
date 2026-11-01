/**
 * PNG analyser / stripper.
 *
 * PNG chunks are self-contained, so stripping is a pure filter: keep the chunks
 * a decoder needs plus colour-management chunks, drop every text/EXIF/XMP/C2PA
 * chunk and every unknown ancillary chunk. Unknown *critical* chunks are not
 * safe to drop, so such files are reported as unsupported instead of damaged.
 */
import { ascii, u32be } from './bytes.ts';
import { crc32 } from './crc32.ts';
import { summarizeC2pa } from './c2pa.ts';
import { summarizeExifBlock } from './exif.ts';
import { buildC2paFindings, buildExifFindings, buildXmpFindings } from './findings.ts';
import { parseJumbf } from './jumbf.ts';
import { readAt, type Source } from './source.ts';
import type { BlockInfo, ContainerAnalysis, Finding, Part, StripOptions, Warning } from './types.ts';
import { parseXmp } from './xmp.ts';

const KEEP_CHUNKS = new Set([
  'IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS',
  'gAMA', 'cHRM', 'sRGB', 'iCCP', 'sBIT', 'bKGD', 'pHYs', 'hIST', 'sPLT',
  'acTL', 'fcTL', 'fdAT',
  'cICP', 'mDCv', 'cLLi', 'sTER',
]);

const KNOWN_METADATA_CHUNKS = new Set([
  'tEXt', 'zTXt', 'iTXt', 'eXIf', 'tIME', 'caBX', 'iDOT', 'vpAg', 'dSIG',
  'prVW', 'mkBF', 'mkTS', 'oFFs', 'pCAL', 'sCAL', 'gIFg', 'gIFx', 'gIFt',
]);

const CHUNK_NAMES: Record<string, string> = {
  IHDR: 'IHDR header',
  PLTE: 'PLTE palette',
  IDAT: 'IDAT pixels',
  IEND: 'IEND',
  tRNS: 'tRNS transparency',
  iCCP: 'iCCP colour profile',
  gAMA: 'gAMA gamma',
  sRGB: 'sRGB colour space',
  cHRM: 'cHRM chromaticity',
  bKGD: 'bKGD background',
  pHYs: 'pHYs pixel size',
  tEXt: 'tEXt text',
  zTXt: 'zTXt compressed text',
  iTXt: 'iTXt international text',
  eXIf: 'eXIf (EXIF)',
  tIME: 'tIME timestamp',
  caBX: 'caBX (C2PA)',
  acTL: 'acTL animation',
  fcTL: 'fcTL frame control',
  fdAT: 'fdAT frame data',
  iDOT: 'iDOT (Apple)',
};

const MAX_CHUNK_READ = 4 * 1024 * 1024;

function isCritical(type: string): boolean {
  const first = type.charCodeAt(0);
  return first >= 65 && first <= 90;
}

export async function analyzePng(src: Source, opts: StripOptions): Promise<ContainerAnalysis> {
  const warnings: Warning[] = [];
  const findings: Finding[] = [];
  const blocks: BlockInfo[] = [];
  const parts: Part[] = [{ kind: 'slice', start: 0, end: 8 }];
  let droppedBytes = 0;

  const signature = await readAt(src, 0, 8);
  const expected = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (src.size < 8 || signature.some((b, i) => b !== expected[i])) {
    return {
      format: 'png', mime: 'image/png', ext: 'png', parts: [], findings: [],
      warnings: [{ id: 'warn.notPng', severity: 'error' }], orientation: 0,
      blocks: [], droppedBytes: 0, keptBytes: src.size, ok: false,
    };
  }

  let pos = 8;
  let sawIhdr = false;
  let sawIdat = false;
  let sawIend = false;
  let sawCgbi = false;
  let orientation = 1;
  let textCount = 0;
  const textKeywords: string[] = [];

  while (pos + 8 <= src.size) {
    const header = await readAt(src, pos, 8);
    const length = u32be(header, 0);
    const type = ascii(header, 4, 4);
    const dataStart = pos + 8;
    const dataEnd = dataStart + length;
    const chunkEnd = dataEnd + 4;
    if (chunkEnd > src.size || length > src.size) {
      warnings.push({ id: 'warn.png.truncated', severity: 'error', params: { offset: pos } });
      break;
    }

    if (type === 'CgBI') sawCgbi = true;
    if (type === 'IHDR') sawIhdr = true;
    if (type === 'IDAT') sawIdat = true;
    if (type === 'IEND') sawIend = true;

    let keep = KEEP_CHUNKS.has(type);
    if (type === 'iCCP' && !opts.keepIcc) keep = false;

    if (!keep) {
      if (KNOWN_METADATA_CHUNKS.has(type) || !isCritical(type)) {
        droppedBytes += chunkEnd - pos;
      } else {
        warnings.push({ id: 'warn.png.criticalChunk', severity: 'error', params: { type } });
      }
    }

    if (keep) {
      // Validate the CRC of the chunks we keep so a corrupted source is visible.
      if (length <= 1024 * 1024) {
        const body = await readAt(src, pos + 4, 4 + length);
        const stored = u32be(await readAt(src, dataEnd, 4), 0);
        if (crc32(body) !== stored) {
          warnings.push({ id: 'warn.png.badCrc', severity: 'warn', params: { type } });
        }
      }
      parts.push({ kind: 'slice', start: pos, end: chunkEnd });
    } else if (type === 'tEXt' || type === 'zTXt' || type === 'iTXt' || type === 'eXIf' || type === 'caBX' || type === 'tIME') {
      await readMetadataChunk(src, type, dataStart, length, { findings, textKeywords: (k) => { textCount += 1; textKeywords.push(k); } }, (o) => { orientation = o; });
    }

    blocks.push({
      name: CHUNK_NAMES[type] ?? type,
      bytes: chunkEnd - pos,
      kept: keep,
      note: keep ? undefined : KNOWN_METADATA_CHUNKS.has(type) ? 'metadata' : 'unknown',
    });

    pos = chunkEnd;
    if (type === 'IEND') break;
  }

  if (pos < src.size && sawIend) {
    const trailer = src.size - pos;
    findings.push({
      id: 'finding.trailer',
      category: 'trailer',
      severity: 'low',
      bytes: trailer,
      params: { bytes: trailer },
    });
    if (!opts.truncateTrailer) parts.push({ kind: 'slice', start: pos, end: src.size });
    else droppedBytes += trailer;
  }

  if (textCount > 0) {
    findings.push({
      id: 'finding.png.text',
      category: 'comment',
      severity: 'low',
      params: { count: textCount, keywords: textKeywords.slice(0, 6).join(', ') },
    });
  }

  if (sawCgbi) warnings.push({ id: 'warn.png.cgbi', severity: 'error' });
  if (!sawIhdr) warnings.push({ id: 'warn.png.noHeader', severity: 'error' });
  if (!sawIdat) warnings.push({ id: 'warn.png.noData', severity: 'error' });
  if (!sawIend) warnings.push({ id: 'warn.png.noEnd', severity: 'error' });

  const ok = sawIhdr && sawIdat && sawIend && !sawCgbi && !warnings.some((w) => w.severity === 'error');
  return {
    format: 'png',
    mime: 'image/png',
    ext: 'png',
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

interface TextSink {
  findings: Finding[];
  textKeywords: (keyword: string) => void;
}

async function readMetadataChunk(
  src: Source,
  type: string,
  dataStart: number,
  length: number,
  sink: TextSink,
  setOrientation: (value: number) => void,
): Promise<void> {
  if (length === 0 || length > MAX_CHUNK_READ) return;
  const data = await readAt(src, dataStart, length);

  if (type === 'eXIf') {
    const exif = summarizeExifBlock(data);
    if (exif) {
      setOrientation(exif.orientation);
      sink.findings.push(...buildExifFindings(exif, length));
      if (exif.orientation !== 1) {
        sink.findings.push({
          id: 'finding.orientation',
          category: 'orientation',
          severity: 'low',
          params: { orientation: exif.orientation },
        });
      }
    } else {
      sink.findings.push({ id: 'finding.exif.unparsed', category: 'exif', severity: 'medium', bytes: length });
    }
    return;
  }

  if (type === 'caBX') {
    try {
      const boxes = parseJumbf(data);
      sink.findings.push(...buildC2paFindings(summarizeC2pa(boxes, length)));
    } catch {
      sink.findings.push({ id: 'finding.jumbf', category: 'c2pa', severity: 'high', bytes: length });
    }
    return;
  }

  if (type === 'tIME') {
    const year = (data[0] ?? 0) * 256 + (data[1] ?? 0);
    const month = data[2] ?? 0;
    const day = data[3] ?? 0;
    const hour = data[4] ?? 0;
    const minute = data[5] ?? 0;
    const second = data[6] ?? 0;
    const pad = (n: number) => String(n).padStart(2, '0');
    sink.findings.push({
      id: 'finding.png.time',
      category: 'comment',
      severity: 'low',
      params: { date: `${year}-${pad(month)}-${pad(day)} ${pad(hour)}:${pad(minute)}:${pad(second)}` },
      bytes: length,
    });
    return;
  }

  if (type === 'tEXt') {
    const nul = data.indexOf(0);
    const keyword = ascii(data, 0, nul >= 0 ? nul : data.length);
    const value = new TextDecoder('utf-8', { fatal: false }).decode(data.subarray(nul + 1)).slice(0, 300);
    if (keyword) sink.textKeywords(keyword);
    if (keyword === 'XML:com.adobe.xmp') {
      sink.findings.push(...buildXmpFindings(parseXmp(value ? data.subarray(nul + 1) : data)));
    } else if (value.trim()) {
      sink.findings.push({
        id: 'finding.png.text',
        category: 'comment',
        severity: 'low',
        bytes: length,
        params: { keywords: keyword },
        fields: [{ label: `tEXt ${keyword}`, value: value.trim(), group: 'other' }],
      });
    }
    return;
  }

  if (type === 'zTXt' || type === 'iTXt') {
    const nul = data.indexOf(0);
    const keyword = ascii(data, 0, nul >= 0 ? nul : data.length);
    let text = '';
    let compressed = false;
    if (type === 'zTXt' && nul + 2 <= data.length) {
      compressed = true;
      text = await inflate(data.subarray(nul + 2));
    } else if (type === 'iTXt' && nul + 3 <= data.length) {
      compressed = (data[nul + 1] ?? 0) === 1;
      let cursor = nul + 3;
      for (let i = 0; i < 2; i += 1) {
        const end = data.indexOf(0, cursor);
        cursor = end >= 0 ? end + 1 : data.length;
      }
      const body = data.subarray(cursor);
      text = compressed ? await inflate(body) : new TextDecoder('utf-8', { fatal: false }).decode(body);
    }
    if (keyword) sink.textKeywords(keyword);
    if (keyword === 'XML:com.adobe.xmp') {
      sink.findings.push(...buildXmpFindings(parseXmp(new TextEncoder().encode(text))));
    } else if (text.trim()) {
      sink.findings.push({
        id: 'finding.png.text',
        category: 'comment',
        severity: 'low',
        bytes: length,
        params: { keywords: keyword },
        fields: [{ label: `${type} ${keyword}`, value: text.trim().slice(0, 300), group: 'other' }],
      });
    }
    return;
  }

  // Unknown metadata chunk we chose to drop.
  sink.findings.push({
    id: 'finding.unknown.chunk',
    category: 'unknown',
    severity: 'low',
    bytes: length,
    params: { type },
  });
}

async function inflate(bytes: Uint8Array): Promise<string> {
  try {
    const stream = new Blob([bytes.slice()]).stream().pipeThrough(new DecompressionStream('deflate'));
    const buffer = await new Response(stream).arrayBuffer();
    return new TextDecoder('utf-8', { fatal: false }).decode(buffer).slice(0, 20000);
  } catch {
    return '';
  }
}
