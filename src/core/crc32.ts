/** CRC-32 (IEEE 802.3): PNG chunk checksums and ZIP member checksums. */

/**
 * Slicing-by-8 tables: eight bytes per round instead of one. A 2 GB archive is
 * otherwise seconds of pure arithmetic, and PNG's IDAT chunks benefit too.
 */
const TABLES = (() => {
  const base = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    base[n] = c >>> 0;
  }
  const tables = [base];
  for (let slice = 1; slice < 8; slice += 1) {
    const previous = tables[slice - 1]!;
    const next = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      const value = previous[n]!;
      next[n] = ((value >>> 8) ^ base[value & 0xff]!) >>> 0;
    }
    tables.push(next);
  }
  return tables;
})();

/**
 * CRC-32 of `bytes`. Pass a previous result as `seed` to checksum a stream:
 * `crc32(b, crc32(a))` equals `crc32(a ++ b)`.
 */
export function crc32(bytes: Uint8Array, seed = 0): number {
  const [t0, t1, t2, t3, t4, t5, t6, t7] = TABLES as [
    Uint32Array,
    Uint32Array,
    Uint32Array,
    Uint32Array,
    Uint32Array,
    Uint32Array,
    Uint32Array,
    Uint32Array,
  ];
  let crc = (seed ^ 0xffffffff) >>> 0;
  const whole = bytes.length - (bytes.length % 8);
  let index = 0;
  for (; index < whole; index += 8) {
    crc ^= bytes[index]! | (bytes[index + 1]! << 8) | (bytes[index + 2]! << 16) | (bytes[index + 3]! << 24);
    crc =
      (t7[crc & 0xff]! ^
        t6[(crc >>> 8) & 0xff]! ^
        t5[(crc >>> 16) & 0xff]! ^
        t4[crc >>> 24]! ^
        t3[bytes[index + 4]!]! ^
        t2[bytes[index + 5]!]! ^
        t1[bytes[index + 6]!]! ^
        t0[bytes[index + 7]!]!) >>>
      0;
  }
  for (; index < bytes.length; index += 1) {
    crc = ((crc >>> 8) ^ t0[(crc ^ bytes[index]!) & 0xff]!) >>> 0;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
