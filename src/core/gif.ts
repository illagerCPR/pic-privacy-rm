/**
 * GIF analyser / stripper.
 *
 * GIF has no EXIF, but it does carry comment extensions and — surprisingly
 * often — an XMP application extension. Both are dropped; every structural
 * block (colour tables, image descriptors, frame control, looping) is kept.
 */
import { ascii, decodeText, u16le } from './bytes.ts';
import { buildXmpFindings } from './findings.ts';
import { readAt, type Source } from './source.ts';
import type { BlockInfo, ContainerAnalysis, Finding, Part, StripOptions, Warning } from './types.ts';
import { parseXmp } from './xmp.ts';

const MAX_META = 4 * 1024 * 1024;

interface Scan {
  pos: number;
  end: number;
  data?: Uint8Array;
}

function toBlobPart(buf: Uint8Array): Uint8Array {
  return buf;
}

export async function analyzeGif(src: Source, opts: StripOptions): Promise<ContainerAnalysis> {
  const warnings: Warning[] = [];
  const findings: Finding[] = [];
  const blocks: BlockInfo[] = [];
  const parts: Part[] = [];

  if (src.size < 14) return failed([{ id: 'warn.tooSmall', severity: 'error' }], src.size);
  const head = await readAt(src, 0, 13);
  const signature = ascii(head, 0, 6);
  if (signature !== 'GIF87a' && signature !== 'GIF89a') {
    return failed([{ id: 'warn.notGif', severity: 'error' }], src.size);
  }
  const packed = head[10] ?? 0;
  const hasGct = (packed & 0x80) !== 0;
  const gctSize = hasGct ? 3 * (1 << ((packed & 0x07) + 1)) : 0;
  const headerEnd = 13 + gctSize;
  if (headerEnd > src.size) return failed([{ id: 'warn.gif.truncated', severity: 'error' }], src.size);

  parts.push({ kind: 'slice', start: 0, end: headerEnd });
  blocks.push({ name: `Header ${signature}`, bytes: 13, kept: true });
  if (hasGct) blocks.push({ name: 'Global colour table', bytes: gctSize, kept: true });

  let droppedBytes = 0;
  let frames = 0;
  let comments = 0;
  let sawTrailer = false;
  let pos = headerEnd;

  const readSubBlocks = async (start: number): Promise<Scan> => {
    let cursor = start;
    const pieces: Uint8Array[] = [];
    let total = 0;
    while (cursor < src.size) {
      const sizeBuf = await readAt(src, cursor, 1);
      if (sizeBuf.length === 0) break;
      const size = sizeBuf[0] ?? 0;
      cursor += 1;
      if (size === 0) break;
      if (total < MAX_META) {
        const piece = await readAt(src, cursor, Math.min(size, MAX_META - total));
        pieces.push(piece);
        total += piece.length;
      }
      cursor += size;
    }
    let data: Uint8Array | undefined;
    if (pieces.length > 0) {
      data = new Uint8Array(total);
      let at = 0;
      for (const piece of pieces) {
        data.set(piece, at);
        at += piece.length;
      }
    }
    return { pos: cursor, end: cursor, data };
  };

  while (pos < src.size) {
    const byte = await readAt(src, pos, 1);
    const blockType = byte[0];
    if (blockType === undefined) break;

    if (blockType === 0x3b) {
      sawTrailer = true;
      parts.push({ kind: 'slice', start: pos, end: pos + 1 });
      blocks.push({ name: 'Trailer', bytes: 1, kept: true });
      pos += 1;
      break;
    }

    if (blockType === 0x00) {
      pos += 1;
      continue;
    }

    if (blockType === 0x2c) {
      const desc = await readAt(src, pos, 10);
      if (desc.length < 10) {
        warnings.push({ id: 'warn.gif.truncated', severity: 'error' });
        break;
      }
      const localPacked = desc[9] ?? 0;
      const lctSize = (localPacked & 0x80) !== 0 ? 3 * (1 << ((localPacked & 0x07) + 1)) : 0;
      const minCodeSizePos = pos + 10 + lctSize;
      const minCode = await readAt(src, minCodeSizePos, 1);
      if (minCode.length === 0) {
        warnings.push({ id: 'warn.gif.truncated', severity: 'error' });
        break;
      }
      const scanned = await readSubBlocks(minCodeSizePos + 1);
      parts.push({ kind: 'slice', start: pos, end: scanned.pos });
      blocks.push({ name: 'Image descriptor', bytes: scanned.pos - pos, kept: true });
      frames += 1;
      pos = scanned.pos;
      continue;
    }

    if (blockType === 0x21) {
      const ext = await readAt(src, pos, 3);
      const label = ext[1] ?? 0;
      const blockStart = pos;
      let data: Uint8Array | undefined;
      let end = pos + 2;

      if (label === 0xff) {
        const appHeader = await readAt(src, pos + 3, 11);
        const identifier = ascii(appHeader, 0, 11);
        const scanned = await readSubBlocks(pos + 3 + 11);
        data = scanned.data;
        end = scanned.pos;
        const isXmp = identifier.startsWith('XMP Data');
        if (isXmp) {
          const payload = stripXmpMagic(data);
          findings.push(...buildXmpFindings(parseXmp(payload)));
          droppedBytes += end - blockStart;
          blocks.push({ name: 'Application extension (XMP)', bytes: end - blockStart, kept: false, note: 'XMP' });
          pos = end;
          continue;
        }
        blocks.push({ name: `Application extension ${identifier.trim() || '(unnamed)'}`, bytes: end - blockStart, kept: true });
        parts.push({ kind: 'slice', start: blockStart, end });
        pos = end;
        continue;
      }

      if (label === 0xfe) {
        const scanned = await readSubBlocks(pos + 2);
        data = scanned.data;
        end = scanned.pos;
        comments += 1;
        const text = data ? decodeText(data).replace(/\u0000/g, '').trim() : '';
        if (text) {
          findings.push({
            id: 'finding.comment.gif',
            category: 'comment',
            severity: 'low',
            bytes: end - blockStart,
            params: { text: text.slice(0, 200) },
            fields: [{ label: 'GIF comment', value: text.slice(0, 400), group: 'other' }],
          });
        }
        droppedBytes += end - blockStart;
        blocks.push({ name: 'Comment extension', bytes: end - blockStart, kept: false, note: 'comment' });
        pos = end;
        continue;
      }

      // Graphic control (0xF9), plain text (0x01) and anything else: keep verbatim.
      const fixed = label === 0xf9 ? 4 : label === 0x01 ? 12 : 0;
      const scanned = await readSubBlocks(pos + 2 + (fixed > 0 ? 1 + fixed : 0));
      end = scanned.pos;
      parts.push({ kind: 'slice', start: blockStart, end });
      blocks.push({ name: label === 0xf9 ? 'Graphic control' : label === 0x01 ? 'Plain text' : `Extension 0x${label.toString(16)}`, bytes: end - blockStart, kept: true });
      pos = end;
      continue;
    }

    warnings.push({ id: 'warn.gif.unknownBlock', severity: 'warn', params: { block: blockType } });
    pos += 1;
  }

  if (pos < src.size && sawTrailer) {
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

  if (!sawTrailer) warnings.push({ id: 'warn.gif.noTrailer', severity: 'error' });
  if (frames === 0) warnings.push({ id: 'warn.gif.noFrames', severity: 'error' });
  if (comments > 0) {
    findings.push({ id: 'finding.comment.summary', category: 'comment', severity: 'low', params: { count: comments } });
  }
  if (frames > 1) {
    findings.push({
      id: 'finding.gif.animation',
      category: 'structure',
      severity: 'info',
      params: { frames },
    });
  }

  const ok = sawTrailer && frames > 0 && !warnings.some((w) => w.severity === 'error');
  return {
    format: 'gif',
    mime: 'image/gif',
    ext: 'gif',
    parts: ok ? parts : [],
    findings,
    warnings,
    orientation: 1,
    blocks,
    droppedBytes,
    keptBytes: src.size - droppedBytes,
    ok,
  };
}

/** GIF XMP sub-blocks end with a 0x01 0x00… magic trailer; strip it. */
export function stripXmpMagic(data: Uint8Array | undefined): Uint8Array {
  if (!data) return new Uint8Array(0);
  const magic = data.indexOf(0x01);
  const end = magic > 0 ? magic : data.length;
  return toBlobPart(data.subarray(0, end));
}

function failed(warnings: Warning[], fileSize: number): ContainerAnalysis {
  return {
    format: 'gif', mime: 'image/gif', ext: 'gif', parts: [], findings: [],
    warnings, orientation: 0, blocks: [], droppedBytes: 0, keptBytes: fileSize, ok: false,
  };
}

export { u16le };
