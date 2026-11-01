import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { scanFile, stripFile } from '../src/core/pipeline.ts';
import { DEFAULT_STRIP_OPTIONS } from '../src/core/types.ts';

const REAL = fileURLToPath(new URL('./real/', import.meta.url));
const OUTPUT = fileURLToPath(new URL('./output/real/', import.meta.url));

/**
 * Real camera and phone exports. They are personal photos, so `tests/real/` is
 * git-ignored and CI has nothing to run here.
 *
 * Drop files in to get an end-to-end pass over data we did not synthesize:
 * scan, strip, re-scan, and write the output where `tools/verify.py` decodes it
 * with Pillow. The assertions stay deliberately coarse — "still decodes" and
 * "nothing sensitive survives" — because precision here would just re-test our
 * own parser against itself.
 */
const names = existsSync(REAL)
  ? readdirSync(REAL)
      .filter((name) => !name.startsWith('.'))
      .sort()
  : [];

describe.skipIf(names.length === 0)('real-world samples', () => {
  it('has samples to work on', () => {
    expect(names.length).toBeGreaterThan(0);
  });

  for (const name of names) {
    it(`cleans ${name}`, async () => {
      const bytes = new Uint8Array(readFileSync(REAL + name));
      const file = new File([bytes], name);
      const scan = await scanFile(file);

      if (!scan.supported) {
        // A real HEIC, for instance: report it, never pretend to clean it.
        expect(scan.warnings.some((warning) => warning.id === 'warn.unsupported')).toBe(true);
        return;
      }

      const outcome = await stripFile(file, DEFAULT_STRIP_OPTIONS);
      expect(
        outcome.verify.ok,
        `${name} leftovers: ${outcome.verify.leftovers.map((f) => f.id).join(', ')}`,
      ).toBe(true);
      expect(outcome.verify.leftovers).toEqual([]);
      expect(outcome.result.blob.size).toBeLessThanOrEqual(bytes.length);

      mkdirSync(OUTPUT, { recursive: true });
      writeFileSync(OUTPUT + name, new Uint8Array(await outcome.result.blob.arrayBuffer()));
    });
  }
});
