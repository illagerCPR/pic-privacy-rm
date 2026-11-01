/** Identify the container from magic bytes (and a little header parsing). */
import { ascii } from './bytes.ts';
import { readAt, type Source } from './source.ts';
import type { Format, FormatInfo } from './types.ts';

const FORMATS: Record<Format, { mime: string; ext: string; supported: boolean }> = {
  jpeg: { mime: 'image/jpeg', ext: 'jpg', supported: true },
  png: { mime: 'image/png', ext: 'png', supported: true },
  webp: { mime: 'image/webp', ext: 'webp', supported: true },
  gif: { mime: 'image/gif', ext: 'gif', supported: true },
  avif: { mime: 'image/avif', ext: 'avif', supported: true },
  heic: { mime: 'image/heic', ext: 'heic', supported: true },
  tiff: { mime: 'image/tiff', ext: 'tif', supported: false },
  bmp: { mime: 'image/bmp', ext: 'bmp', supported: false },
  jxl: { mime: 'image/jxl', ext: 'jxl', supported: false },
  svg: { mime: 'image/svg+xml', ext: 'svg', supported: false },
  pdf: { mime: 'application/pdf', ext: 'pdf', supported: false },
  video: { mime: 'video/mp4', ext: 'mp4', supported: false },
  unknown: { mime: 'application/octet-stream', ext: 'bin', supported: false },
};

export function formatInfoOf(format: Format): FormatInfo {
  const meta = FORMATS[format];
  return { format, mime: meta.mime, ext: meta.ext, supported: meta.supported };
}

export async function sniff(src: Source): Promise<FormatInfo> {
  const head = await readAt(src, 0, Math.min(src.size, 512));
  if (head.length < 4) return formatInfoOf('unknown');

  const b = head;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return formatInfoOf('jpeg');
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return formatInfoOf('png');
  const magic6 = ascii(b, 0, 6);
  if (magic6 === 'GIF87a' || magic6 === 'GIF89a') return formatInfoOf('gif');
  if (ascii(b, 0, 4) === 'RIFF') {
    const riffType = ascii(b, 8, 4);
    if (riffType === 'WEBP') return formatInfoOf('webp');
    if (riffType === 'WAVE') return { format: 'unknown', mime: 'audio/wav', ext: 'wav', supported: false };
    if (riffType === 'AVI ') return formatInfoOf('video');
    return formatInfoOf('unknown');
  }
  if (ascii(b, 4, 4) === 'ftyp') {
    const brand = ascii(b, 8, 4);
    // `mif1` is the generic HEIF brand and can hold either codec, so the
    // compatibility list decides before the major brand does.
    const compatible = ascii(b, 16, Math.min(48, b.length - 16));
    if (['avif', 'avis'].includes(brand) || compatible.includes('avif') || compatible.includes('avis')) {
      return formatInfoOf('avif');
    }
    if (['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'mif1', 'msf1'].includes(brand)) return formatInfoOf('heic');
    return formatInfoOf('video');
  }
  if ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a && b[3] === 0x00) || (b[0] === 0x4d && b[1] === 0x4d && b[2] === 0x00 && b[3] === 0x2a)) {
    return formatInfoOf('tiff');
  }
  if (b[0] === 0x42 && b[1] === 0x4d) return formatInfoOf('bmp');
  if (b[0] === 0x00 && b[1] === 0x00 && b[2] === 0x00 && b[3] === 0x0c && ascii(b, 4, 4) === 'JXL ') {
    return formatInfoOf('jxl');
  }
  if (b[0] === 0xff && b[1] === 0x0a) return formatInfoOf('jxl');
  if (ascii(b, 0, 4) === '%PDF') return formatInfoOf('pdf');
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return formatInfoOf('video');
  if (b[0] === 0x42 && b[1] === 0x4d) return formatInfoOf('bmp');

  const text = ascii(b, 0, Math.min(b.length, 256)).trimStart();
  if (text.startsWith('<svg') || (text.startsWith('<?xml') && text.includes('<svg'))) return formatInfoOf('svg');
  if (text.startsWith('<') && text.includes('</svg>')) return formatInfoOf('svg');

  return formatInfoOf('unknown');
}
