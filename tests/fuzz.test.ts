import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isPipelineError } from '../src/core/errors.ts';
import { scanSource, stripSource, verifyBlob } from '../src/core/pipeline.ts';
import { sourceFromBytes } from '../src/core/source.ts';
import { DEFAULT_STRIP_OPTIONS } from '../src/core/types.ts';

/**
 * Structural fuzzing.
 *
 * Every parser in this repository reads bytes that came from someone else's
 * camera, so a malformed container must never take the page down: it has to
 * end up as a typed `PipelineError` (which the UI turns into "cannot read this
 * file") or as a clean removal. The mutations below are deterministic — a
 * failure is reproducible from the seed alone.
 */

const here = fileURLToPath(new URL('.', import.meta.url));
const fixtures = join(here, 'fixtures');
const SAMPLES = ['meta.jpg', 'meta.png', 'meta.webp', 'meta.gif', 'meta.tif', 'meta.avif'];

/** Small, fast PRNG: deterministic across machines and Node versions. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function mutate(source: Uint8Array, random: () => number, kind: number): Uint8Array {
  const bytes = source.slice();
  const pick = () => Math.floor(random() * bytes.length);
  switch (kind % 4) {
    case 0: {
      // A handful of flipped bits, like a file that went through a bad copy.
      for (let index = 0; index < 5; index += 1) {
        const at = pick();
        bytes[at] = (bytes[at] ?? 0) ^ (1 << Math.floor(random() * 8));
      }
      return bytes;
    }
    case 1: {
      // Cut the file short: every chunk walker has to notice.
      return bytes.slice(0, Math.max(1, pick()));
    }
    case 2: {
      // Oversized length at an arbitrary place: the classic allocation trap.
      const at = pick();
      for (let index = 0; index < 4 && at + index < bytes.length; index += 1) {
        bytes[at + index] = (0x7fffffff >>> (8 * (3 - index))) & 0xff;
      }
      return bytes;
    }
    default: {
      // Remove a slice, which shifts every offset after it.
      const from = pick();
      const to = Math.min(bytes.length, from + 1 + Math.floor(random() * 256));
      const out = new Uint8Array(bytes.length - (to - from));
      out.set(bytes.subarray(0, from), 0);
      out.set(bytes.subarray(to), from);
      return out;
    }
  }
}

async function exercise(bytes: Uint8Array): Promise<void> {
  const source = sourceFromBytes(bytes);
  let scan;
  try {
    scan = await scanSource(source);
  } catch (error) {
    // The only acceptable failure is a typed one the UI knows how to explain.
    expect(isPipelineError(error), `scan threw ${String(error)}`).toBe(true);
    return;
  }

  // Whatever the scan decided, a strip is either refused the same way or
  // produces bytes; it may never throw a raw exception.
  let stripped;
  try {
    stripped = await stripSource(source, DEFAULT_STRIP_OPTIONS);
  } catch (error) {
    expect(isPipelineError(error), `strip threw ${String(error)}`).toBe(true);
    return;
  }
  expect(stripped.blob.size).toBeGreaterThan(0);

  // The product promise has to survive arbitrary input: a result that claims to
  // be clean must pass the independent re-scan too. A result that does not is a
  // blocked download, which is the documented behaviour for unreadable input.
  const verify = await verifyBlob(stripped.blob, scan.format, DEFAULT_STRIP_OPTIONS);
  if (verify.ok) {
    expect(verify.leftovers).toEqual([]);
  }
}

describe('fuzzing the container parsers', () => {
  const seeds = [0x5eed, 0xc0ffee, 0x1234567];

  it('turns malformed containers into typed errors, never crashes', async () => {
    const random = mulberry32(seeds[0]!);
    let cases = 0;
    for (const name of SAMPLES) {
      const source = new Uint8Array(readFileSync(join(fixtures, name)));
      for (let kind = 0; kind < 24; kind += 1) {
        await exercise(mutate(source, random, kind));
        cases += 1;
      }
    }
    expect(cases).toBe(SAMPLES.length * 24);
  }, 120_000);

  it('handles random garbage without hanging or leaking exceptions', async () => {
    const random = mulberry32(seeds[1]!);
    for (let index = 0; index < 30; index += 1) {
      const length = 4 + Math.floor(random() * 4096);
      const bytes = new Uint8Array(length);
      for (let at = 0; at < length; at += 1) bytes[at] = Math.floor(random() * 256);
      // Give it a fighting chance of looking like a known container.
      if (index % 3 === 0) bytes.set([0xff, 0xd8, 0xff], 0);
      if (index % 3 === 1) bytes.set([0x89, 0x50, 0x4e, 0x47], 0);
      await exercise(bytes);
    }
  }, 60_000);

  it('truncates every sample at every power-of-two boundary', async () => {
    for (const name of SAMPLES) {
      const source = new Uint8Array(readFileSync(join(fixtures, name)));
      for (let length = 1; length < source.length; length *= 2) {
        await exercise(source.subarray(0, length));
      }
      await exercise(source.subarray(0, source.length - 1));
    }
  }, 120_000);
});
