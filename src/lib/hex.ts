/** Fixed-width hex + ASCII dump rows for binary metadata previews. */
export interface HexRow {
  /** Byte offset of the first byte in the row, 8 hex digits. */
  offset: string;
  /** Bytes as space separated hex, padded so the ASCII column lines up. */
  hex: string;
  /** Printable bytes, everything else rendered as `.`. */
  ascii: string;
}

// Eight bytes per row: the drawer is narrow, and sixteen would push the ASCII
// column outside the visible area.
const BYTES_PER_ROW = 8;
const HEX_WIDTH = BYTES_PER_ROW * 3 - 1;

function toAscii(byte: number): string {
  return byte >= 0x20 && byte <= 0x7e ? String.fromCharCode(byte) : '.';
}

/**
 * Render at most `limit` bytes. Vendor blobs can be large, and a hex dump of a
 * 64 KB MakerNote is neither readable nor cheap to lay out, so the caller pages
 * through the payload instead.
 */
export function hexDump(bytes: Uint8Array, limit = 128): HexRow[] {
  const end = Math.min(bytes.length, Math.max(0, limit));
  const rows: HexRow[] = [];
  for (let at = 0; at < end; at += BYTES_PER_ROW) {
    const slice = bytes.subarray(at, Math.min(at + BYTES_PER_ROW, end));
    const hex = Array.from(slice, (byte) => byte.toString(16).padStart(2, '0')).join(' ');
    rows.push({
      offset: at.toString(16).padStart(8, '0'),
      hex: hex.padEnd(HEX_WIDTH, ' '),
      ascii: Array.from(slice, toAscii).join(''),
    });
  }
  return rows;
}
