import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32 } from 'node:zlib';
import { afterAll, describe, expect, it } from 'vitest';

import { buildZip, checkZipEntries, ZipError, zipParts, type ZipEntry } from '../src/lib/zip.ts';

const scratch = mkdtempSync(join(tmpdir(), 'picprivacy-zip-'));

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function blobOf(bytes: Uint8Array<ArrayBuffer> | string): Blob {
  return new Blob([typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes]);
}

/** A deliberately small reader: the archive is a flat list of store entries. */
function readArchive(bytes: Uint8Array): {
  name: string;
  crc: number;
  size: number;
  method: number;
  utf8: boolean;
  data: Uint8Array;
}[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = bytes.length - 22;
  expect(view.getUint32(end, true), 'end of central directory').toBe(0x06054b50);
  const count = view.getUint16(end + 10, true);
  let cursor = view.getUint32(end + 16, true);
  const out: {
    name: string;
    crc: number;
    size: number;
    method: number;
    utf8: boolean;
    data: Uint8Array;
  }[] = [];
  for (let index = 0; index < count; index += 1) {
    expect(view.getUint32(cursor, true), 'central header').toBe(0x02014b50);
    const flags = view.getUint16(cursor + 8, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const name = new TextDecoder().decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength));
    const localOffset = view.getUint32(cursor + 42, true);
    expect(view.getUint32(localOffset, true), 'local header').toBe(0x04034b50);
    const localName = view.getUint16(localOffset + 26, true);
    const localExtra = view.getUint16(localOffset + 28, true);
    const start = localOffset + 30 + localName + localExtra;
    const size = view.getUint32(cursor + 24, true);
    out.push({
      name,
      crc: view.getUint32(cursor + 16, true),
      size,
      method: view.getUint16(cursor + 10, true),
      utf8: (flags & 0x0800) !== 0,
      data: bytes.subarray(start, start + size),
    });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return out;
}

function havePython(): boolean {
  try {
    execFileSync('python3', ['-c', 'import zipfile'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const python = havePython();

describe('store-only archive', () => {
  const entries: ZipEntry[] = [
    {
      name: 'plain.jpg',
      blob: blobOf(`jpeg-ish ${'x'.repeat(200)}`),
      modified: new Date(2026, 10, 1, 12, 34, 56),
    },
    { name: '空 格.png', blob: blobOf(new Uint8Array([1, 2, 3, 4, 5])) },
    { name: 'frames/动画 🐱.webp', blob: blobOf(new Uint8Array(70_000).fill(9)) },
    { name: 'empty.tif', blob: blobOf(new Uint8Array(0)) },
  ];

  it('writes local headers, CRC-32 and sizes that match zlib', async () => {
    const archive = new Uint8Array(await (await buildZip(entries)).arrayBuffer());
    const members = readArchive(archive);
    expect(members.map((member) => member.name)).toEqual(entries.map((entry) => entry.name));
    for (const [index, member] of members.entries()) {
      const source = new Uint8Array(await entries[index]!.blob.arrayBuffer());
      expect(member.size).toBe(source.length);
      expect(member.data).toEqual(source);
      expect(member.crc).toBe(crc32(Buffer.from(source)));
      expect(member.method, 'store, not deflate').toBe(0);
      expect(member.utf8, 'UTF-8 name flag').toBe(true);
    }
  });

  it('opens in an independent implementation (python zipfile)', async () => {
    if (!python) return;
    const path = join(scratch, 'batch.zip');
    writeFileSync(path, new Uint8Array(await (await buildZip(entries)).arrayBuffer()));
    const script = `
import hashlib, json, sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as handle:
    assert handle.testzip() is None
    print(json.dumps([
        [info.filename, len(handle.read(info.filename)), info.compress_type]
        for info in handle.infolist()
    ]))
`;
    const listed = JSON.parse(
      execFileSync('python3', ['-c', script, path], { encoding: 'utf8' }),
    ) as [string, number, number][];
    expect(listed).toEqual(entries.map((entry) => [entry.name, entry.blob.size, 0]));
  });

  it('hands the image bytes to the Blob instead of copying them', async () => {
    const parts = await zipParts(entries);
    const blobs = parts.filter((part): part is Blob => part instanceof Blob);
    const payloads = entries.filter((entry) => entry.blob.size > 0);
    expect(blobs).toHaveLength(payloads.length);
    for (const [index, entry] of payloads.entries()) {
      expect(blobs[index]).toBe(entry.blob);
    }
    const total = parts.reduce(
      (sum, part) => sum + (part instanceof Blob ? part.size : (part as Uint8Array).length),
      0,
    );
    expect(total).toBe(new Blob(parts).size);
  });

  it('checksums a member that spans several read chunks', async () => {
    const big = new Uint8Array(9 * 1024 * 1024);
    for (let index = 0; index < big.length; index += 1) big[index] = (index * 31) & 0xff;
    const archive = new Uint8Array(
      await (await buildZip([{ name: 'big.bin', blob: blobOf(big) }])).arrayBuffer(),
    );
    const [member] = readArchive(archive);
    expect(member?.size).toBe(big.length);
    expect(member?.crc).toBe(crc32(Buffer.from(big)));
  });

  it('reports progress per member', async () => {
    const seen: number[] = [];
    await buildZip(entries, (progress) => {
      expect(progress.total).toBe(entries.length);
      seen.push(progress.done);
    });
    expect(seen[0]).toBe(0);
    expect(seen.at(-1)).toBe(entries.length);
    expect([...seen].sort((a, b) => a - b)).toEqual(seen);
  });

  it('keeps peak memory flat when the archive is far bigger than RAM headroom', async () => {
    const chunk = blobOf(new Uint8Array(8 * 1024 * 1024).fill(3));
    const big: ZipEntry[] = Array.from({ length: 64 }, (_, index) => ({
      name: `shot-${index}.jpg`,
      blob: chunk,
    }));
    if (global.gc) global.gc();
    const before = process.memoryUsage().rss;
    const archive = await buildZip(big);
    const delta = process.memoryUsage().rss - before;
    expect(archive.size).toBeGreaterThan(512 * 1024 * 1024);
    // 512 MiB of payload: copy-then-compress would add half a gigabyte of RSS.
    expect(delta).toBeLessThan(160 * 1024 * 1024);
  }, 120_000);
});

describe('unsafe member names', () => {
  it('refuses names that would escape the archive, before reading any bytes', async () => {
    for (const name of ['', '../evil.jpg', '/abs.jpg', 'a\\b.jpg'.replace('\\b', '\u0000b')]) {
      expect(() => checkZipEntries([{ name, blob: blobOf('x') }]), name).toThrow(ZipError);
    }
    // The folder mirror may produce a path, but never a traversal.
    await expect(zipParts([{ name: 'a/../../b.jpg', blob: blobOf('x') }])).rejects.toThrow(
      ZipError,
    );
  });
});

/**
 * The 32-bit fields and the 16-bit member count used to cap an archive at 4 GiB
 * / 65,535 members. Chip away at the threshold instead of allocating gigabytes:
 * the records written are the same, only the value that triggers them differs.
 */
describe('ZIP64', () => {
  const pythonReads = (bytes: Uint8Array): { name: string; size: number }[] => {
    const path = join(scratch, `zip64-${Math.random().toString(36).slice(2)}.zip`);
    writeFileSync(path, bytes);
    const script = `
import json, sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as handle:
    assert handle.testzip() is None
    print(json.dumps([[info.filename, len(handle.read(info.filename))] for info in handle.infolist()]))
`;
    const out = JSON.parse(execFileSync('python3', ['-c', script, path], { encoding: 'utf8' })) as [
      string,
      number,
    ][];
    rmSync(path, { force: true });
    return out.map(([name, size]) => ({ name, size }));
  };

  it('spills a member size into the ZIP64 extra field', async () => {
    const entries: ZipEntry[] = [
      { name: 'big.jpg', blob: blobOf(new Uint8Array(300).fill(7)) },
      { name: 'small.jpg', blob: blobOf(new Uint8Array(10).fill(8)) },
    ];
    const bytes = new Uint8Array(
      await (await buildZip(entries, undefined, { zip64Threshold: 250 })).arrayBuffer(),
    );
    const view = new DataView(bytes.buffer);
    // The local header of the big member marks both sizes as "look in the extra".
    expect(view.getUint32(18, true)).toBe(0xffffffff);
    expect(view.getUint32(22, true)).toBe(0xffffffff);
    expect(view.getUint16(28, true)).toBe(20); // 4 byte header + 16 bytes of sizes
    expect(view.getUint16(30 + 7, true)).toBe(0x0001);
    // And a ZIP64 end record with its locator precedes the classic one.
    const end = bytes.length - 22;
    expect(view.getUint16(end + 10, true)).toBe(0xffff);
    const locator = end - 20;
    expect(view.getUint32(locator, true)).toBe(0x07064b50);
    expect(pythonReads(bytes)).toEqual([
      { name: 'big.jpg', size: 300 },
      { name: 'small.jpg', size: 10 },
    ]);
  });

  it('spills a local header offset into the ZIP64 extra field', async () => {
    // Three small members: with the threshold at 250 bytes only the later
    // offsets overflow, so the size fields stay 32-bit.
    const entries: ZipEntry[] = ['a.jpg', 'b.jpg', 'c.jpg'].map((name) => ({
      name,
      blob: blobOf(new Uint8Array(100).fill(name.charCodeAt(0))),
    }));
    const bytes = new Uint8Array(
      await (await buildZip(entries, undefined, { zip64Threshold: 250 })).arrayBuffer(),
    );
    const view = new DataView(bytes.buffer);
    const end = bytes.length - 22;
    const zip64End = end - 20 - 56;
    expect(view.getUint32(zip64End, true)).toBe(0x06064b50);
    const centralOffset = Number(view.getBigUint64(zip64End + 48, true));
    // Walk to the last central record: 46 + name + extra each.
    let cursor = centralOffset;
    let lastOffsetField = 0;
    let lastExtraLength = 0;
    for (let index = 0; index < 3; index += 1) {
      const nameLength = view.getUint16(cursor + 28, true);
      lastExtraLength = view.getUint16(cursor + 30, true);
      lastOffsetField = view.getUint32(cursor + 42, true);
      cursor += 46 + nameLength + lastExtraLength;
    }
    expect(lastOffsetField).toBe(0xffffffff);
    expect(lastExtraLength).toBe(12); // header + 8 bytes of offset
    expect(pythonReads(bytes)).toEqual(entries.map((entry) => ({ name: entry.name, size: 100 })));
  });

  it('writes a plain archive while everything fits in 32 bits', async () => {
    const plain: ZipEntry[] = [{ name: 'a.jpg', blob: blobOf('hello') }];
    const bytes = new Uint8Array(await (await buildZip(plain)).arrayBuffer());
    expect(Buffer.from(bytes).includes(Buffer.from([0x50, 0x4b, 6, 6]))).toBe(false);
    expect(Buffer.from(bytes).includes(Buffer.from([0x50, 0x4b, 6, 7]))).toBe(false);
  });
});

describe('fixture sanity', () => {
  it('round-trips through a real file', async () => {
    const path = join(scratch, 'single.zip');
    writeFileSync(
      path,
      new Uint8Array(
        await (await buildZip([{ name: 'a.txt', blob: blobOf('hello') }])).arrayBuffer(),
      ),
    );
    const bytes = new Uint8Array(readFileSync(path));
    // "PK\5\6" only appears in the end record we write last.
    expect(bytes.subarray(bytes.length - 22, bytes.length - 18)).toEqual(
      new Uint8Array([0x50, 0x4b, 5, 6]),
    );
  });
});
