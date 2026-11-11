/**
 * JPEG container analyser / stripper.
 *
 * JPEG is a chain of marker segments. The strip policy is an allow-list:
 * segments a decoder needs (SOF/DHT/DQT/SOS/APP0 JFIF/APP2 ICC/APP14 Adobe
 * transform) are kept byte-for-byte; everything else is dropped. Unknown APPn
 * segments are dropped too, so metadata we do not recognise cannot survive.
 */
import { decodeText, startsWithBytes, u16be } from './bytes.ts';
import { summarizeExifBlock } from './exif.ts';
import { buildExifFindings, buildIptcFindings, buildJumbfFindings, buildXmpFindings } from './findings.ts';
import { parsePhotoshopApp13 } from './iptc.ts';
import { readAt, type Source } from './source.ts';
import type { BlockInfo, ContainerAnalysis, Finding, Part, StripOptions, Warning } from './types.ts';
import { parseXmp } from './xmp.ts';

const SCAN_CHUNK = 1 << 20;

const MARKER_NAMES: Record<number, string> = {
  0xc0: 'SOF0',
  0xc1: 'SOF1',
  0xc2: 'SOF2',
  0xc3: 'SOF3',
  0xc4: 'DHT',
  0xc5: 'SOF5',
  0xc6: 'SOF6',
  0xc7: 'SOF7',
  0xc8: 'JPG',
  0xc9: 'SOF9',
  0xca: 'SOF10',
  0xcb: 'SOF11',
  0xcc: 'DAC',
  0xcd: 'SOF13',
  0xce: 'SOF14',
  0xcf: 'SOF15',
  0xd8: 'SOI',
  0xd9: 'EOI',
  0xda: 'SOS',
  0xdb: 'DQT',
  0xdc: 'DNL',
  0xdd: 'DRI',
  0xde: 'DHP',
  0xdf: 'EXP',
  0xfe: 'COM',
};

interface Collected {
  findings: Finding[];
  warnings: Warning[];
  blocks: BlockInfo[];
  orientation: number;
  droppedBytes: number;
}

interface SegmentVerdict {
  keep: boolean;
  name: string;
  note?: string;
  unknownApp?: boolean;
}

function isStandalone(marker: number): boolean {
  return marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7);
}

function isSof(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

/** Find the next real marker after entropy-coded data. */
async function findScanEnd(src: Source, start: number): Promise<number | null> {
  let offset = start;
  while (offset < src.size) {
    const chunk = await readAt(src, offset, Math.min(SCAN_CHUNK, src.size - offset));
    if (chunk.length < 2) return null;
    let cursor = 0;
    // Advance to the next 0xff with the native search: entropy data is mostly
    // ordinary bytes, and a byte-at-a-time loop dominated large JPEG scans.
    let resumeAt = chunk.length;
    while (cursor < chunk.length) {
      const at = chunk.indexOf(0xff, cursor);
      if (at === -1) break;
      const next = chunk[at + 1];
      if (next === undefined) {
        // The pair spans the chunk boundary; re-read from the 0xff itself.
        resumeAt = at;
        break;
      }
      if (next === 0x00 || next === 0xff) {
        cursor = at + 1;
        continue;
      }
      if (next >= 0xd0 && next <= 0xd7) {
        cursor = at + 2;
        continue;
      }
      return offset + at;
    }
    offset += resumeAt;
  }
  return null;
}

function failed(warnings: Warning[], fileSize: number): ContainerAnalysis {
  return {
    format: 'jpeg',
    mime: 'image/jpeg',
    ext: 'jpg',
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

export async function analyzeJpeg(src: Source, opts: StripOptions): Promise<ContainerAnalysis> {
  const warnings: Warning[] = [];
  if (src.size < 4) return failed([{ id: 'warn.tooSmall', severity: 'error' }], src.size);
  const head = await readAt(src, 0, 4);
  if (!(head[0] === 0xff && head[1] === 0xd8)) {
    return failed([{ id: 'warn.notJpeg', severity: 'error' }], src.size);
  }

  const collected: Collected = {
    findings: [],
    warnings,
    blocks: [],
    orientation: 1,
    droppedBytes: 0,
  };
  const parts: Part[] = [{ kind: 'slice', start: 0, end: 2 }];
  collected.blocks.push({ name: 'SOI', bytes: 2, kept: true });

  const jumbfParts: Uint8Array[] = [];
  let jumbfBytes = 0;
  let sawSof = false;
  let sawSos = false;
  let sawEoi = false;
  let eoiEnd = -1;
  let pos = 2;
  let unknownApps = 0;
  let unknownBytes = 0;

  while (pos < src.size) {
    const probe = await readAt(src, pos, Math.min(64, src.size - pos));
    if (probe.length < 2) break;
    if (probe[0] !== 0xff) {
      warnings.push({ id: 'warn.jpeg.desync', severity: 'error', params: { offset: pos } });
      break;
    }
    let fill = 0;
    while (fill < probe.length && probe[fill] === 0xff) fill += 1;
    const marker = probe[fill];
    if (marker === undefined) break;
    const markerStart = pos + fill - 1;

    if (marker === 0xd9) {
      sawEoi = true;
      eoiEnd = pos + fill + 1;
      break;
    }

    if (isStandalone(marker)) {
      const end = pos + fill + 1;
      parts.push({ kind: 'slice', start: markerStart, end });
      collected.blocks.push({
        name: marker === 0x01 ? 'TEM' : `RST${marker - 0xd0}`,
        bytes: end - markerStart,
        kept: true,
      });
      pos = end;
      continue;
    }

    const lenPos = pos + fill + 1;
    const lenBuf = await readAt(src, lenPos, 2);
    if (lenBuf.length < 2) {
      warnings.push({ id: 'warn.jpeg.truncated', severity: 'error', params: { offset: pos } });
      break;
    }
    const segLen = u16be(lenBuf, 0);
    if (segLen < 2) {
      warnings.push({ id: 'warn.jpeg.corrupt', severity: 'error', params: { offset: pos } });
      break;
    }
    const payloadStart = lenPos + 2;
    const payloadEnd = lenPos + segLen;
    if (payloadEnd > src.size) {
      warnings.push({ id: 'warn.jpeg.truncated', severity: 'error', params: { offset: pos } });
      break;
    }
    const payloadLength = payloadEnd - payloadStart;

    if (marker === 0xda) {
      sawSos = true;
      const scanEnd = await findScanEnd(src, payloadEnd);
      if (scanEnd === null) {
        warnings.push({ id: 'warn.jpeg.noEoi', severity: 'error' });
        parts.push({ kind: 'slice', start: markerStart, end: src.size });
        pos = src.size;
        break;
      }
      parts.push({ kind: 'slice', start: markerStart, end: scanEnd });
      collected.blocks.push({ name: 'SOS', bytes: scanEnd - markerStart, kept: true, note: 'scan data' });
      pos = scanEnd;
      continue;
    }

    if (isSof(marker)) sawSof = true;

    const verdict = await classifySegment(src, marker, payloadStart, payloadLength, opts, collected, jumbfParts);
    if (verdict.keep) {
      parts.push({ kind: 'slice', start: markerStart, end: payloadEnd });
      collected.blocks.push({ name: verdict.name, bytes: payloadEnd - markerStart, kept: true, note: verdict.note });
    } else {
      collected.droppedBytes += payloadEnd - markerStart;
      collected.blocks.push({ name: verdict.name, bytes: payloadEnd - markerStart, kept: false, note: verdict.note });
      if (verdict.unknownApp) {
        unknownApps += 1;
        unknownBytes += payloadEnd - markerStart;
      }
    }
    if (marker === 0xeb) jumbfBytes += payloadLength;
    pos = payloadEnd;
  }

  if (eoiEnd > 0) {
    parts.push({ kind: 'slice', start: eoiEnd - 2, end: eoiEnd });
    collected.blocks.push({ name: 'EOI', bytes: 2, kept: true });
    const trailer = src.size - eoiEnd;
    if (trailer > 0) {
      collected.findings.push({
        id: 'finding.trailer',
        category: 'trailer',
        severity: 'low',
        bytes: trailer,
        params: { bytes: trailer },
      });
      if (opts.truncateTrailer) {
        collected.droppedBytes += trailer;
      } else {
        parts.push({ kind: 'slice', start: eoiEnd, end: src.size });
      }
    }
  }

  if (!sawSof) warnings.push({ id: 'warn.jpeg.noSof', severity: 'error' });
  if (!sawSos) warnings.push({ id: 'warn.jpeg.noSos', severity: 'error' });
  if (!sawEoi) warnings.push({ id: 'warn.jpeg.noEoi', severity: 'error' });

  if (unknownApps > 0) {
    collected.findings.push({
      id: 'finding.app.unknown',
      category: 'unknown',
      severity: 'low',
      bytes: unknownBytes,
      params: { count: unknownApps },
    });
  }

  if (jumbfParts.length > 0) {
    collected.findings.push(...buildJumbfFindings(jumbfParts, jumbfBytes));
  }

  const ok = sawSof && sawSos && sawEoi && !warnings.some((w) => w.severity === 'error');

  return {
    format: 'jpeg',
    mime: 'image/jpeg',
    ext: 'jpg',
    parts: ok ? parts : [],
    findings: collected.findings,
    warnings: collected.warnings,
    orientation: collected.orientation,
    blocks: collected.blocks,
    droppedBytes: collected.droppedBytes,
    keptBytes: src.size - collected.droppedBytes,
    ok,
  };
}

async function classifySegment(
  src: Source,
  marker: number,
  payloadStart: number,
  payloadLength: number,
  opts: StripOptions,
  collected: Collected,
  jumbfParts: Uint8Array[],
): Promise<SegmentVerdict> {
  const needsPayload = marker >= 0xe0 && marker <= 0xef ? true : marker === 0xfe;
  const payload = needsPayload && payloadLength > 0
    ? await readAt(src, payloadStart, payloadLength)
    : new Uint8Array(0);
  const name = MARKER_NAMES[marker] ?? `0x${marker.toString(16).padStart(2, '0')}`;

  switch (marker) {
    case 0xe0: {
      if (startsWithBytes(payload, 0, 'JFIF')) return { keep: true, name: 'APP0 JFIF' };
      if (startsWithBytes(payload, 0, 'JFXX')) {
        addJfxxThumbnail(collected, payload);
        return { keep: false, name: 'APP0 JFXX', note: 'thumbnail' };
      }
      return { keep: false, name: 'APP0', unknownApp: true };
    }
    case 0xe1: {
      if (startsWithBytes(payload, 0, 'Exif\0\0')) {
        const exif = summarizeExifBlock(payload.subarray(6));
        if (exif) {
          collected.orientation = exif.orientation;
          collected.findings.push(...buildExifFindings(exif, payloadLength));
          if (exif.orientation !== 1) {
            collected.findings.push({
              id: 'finding.orientation',
              category: 'orientation',
              severity: 'low',
              params: { orientation: exif.orientation },
            });
          }
        } else {
          collected.findings.push({
            id: 'finding.exif.unparsed',
            category: 'exif',
            severity: 'medium',
            bytes: payloadLength,
          });
        }
        return { keep: false, name: 'APP1 Exif', note: 'EXIF' };
      }
      if (startsWithBytes(payload, 0, 'http://ns.adobe.com/xap/1.0/\0')) {
        collected.findings.push(...buildXmpFindings(parseXmp(payload.subarray(29))));
        return { keep: false, name: 'APP1 XMP', note: 'XMP' };
      }
      if (startsWithBytes(payload, 0, 'http://ns.adobe.com/xmp/extension/\0')) {
        collected.findings.push(...buildXmpFindings(parseXmp(payload.subarray(35), true)));
        return { keep: false, name: 'APP1 Extended XMP' };
      }
      return { keep: false, name: 'APP1', unknownApp: true };
    }
    case 0xe2: {
      if (startsWithBytes(payload, 0, 'ICC_PROFILE')) {
        if (opts.keepIcc) return { keep: true, name: 'APP2 ICC', note: 'colour profile' };
        return { keep: false, name: 'APP2 ICC', note: 'colour profile (removed on request)' };
      }
      if (startsWithBytes(payload, 0, 'MPF\0')) {
        collected.findings.push({
          id: 'finding.mpf',
          category: 'mpf',
          severity: 'medium',
          bytes: payloadLength,
          params: { bytes: payloadLength },
        });
        return { keep: false, name: 'APP2 MPF', note: 'multi-picture' };
      }
      return { keep: false, name: 'APP2', unknownApp: true };
    }
    case 0xeb: {
      jumbfParts.push(payload);
      return { keep: false, name: 'APP11 JUMBF', note: 'C2PA / JUMBF' };
    }
    case 0xed: {
      if (startsWithBytes(payload, 0, 'Photoshop')) {
        const iptc = parsePhotoshopApp13(payload);
        if (iptc) collected.findings.push(...buildIptcFindings(iptc));
        return { keep: false, name: 'APP13 Photoshop', note: 'IPTC' };
      }
      return { keep: false, name: 'APP13', unknownApp: true };
    }
    case 0xee: {
      if (startsWithBytes(payload, 0, 'Adobe')) return { keep: true, name: 'APP14 Adobe', note: 'colour transform' };
      return { keep: false, name: 'APP14' };
    }
    case 0xfe: {
      const text = decodeText(payload.subarray(0, Math.min(payload.length, 200))).replace(/\u0000/g, '').trim();
      collected.findings.push({
        id: 'finding.comment',
        category: 'comment',
        severity: 'low',
        bytes: payloadLength,
        params: text ? { text } : {},
      });
      return { keep: false, name: 'COM', note: 'comment' };
    }
    default: {
      if (marker >= 0xe3 && marker <= 0xef) return { keep: false, name, unknownApp: true };
      return { keep: true, name };
    }
  }
}

function addJfxxThumbnail(collected: Collected, payload: Uint8Array): void {
  const code = payload[5];
  if (code !== 0x10) return; // 0x10 = JPEG thumbnail
  const jpeg = payload.subarray(6);
  if (jpeg.length < 64) return;
  collected.findings.push({
    id: 'finding.jfxx.thumbnail',
    category: 'thumbnail',
    severity: 'high',
    bytes: jpeg.length,
    preview: { blob: new Blob([jpeg.slice()], { type: 'image/jpeg' }), mime: 'image/jpeg' },
  });
}
