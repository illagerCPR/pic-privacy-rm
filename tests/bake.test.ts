import { describe, expect, it } from 'vitest';
import { bakeIfNeeded } from '../src/lib/bake.ts';

const blob = new Blob(['pixels']);

describe('orientation baking', () => {
  it('does nothing when disabled or when the orientation is upright', async () => {
    expect(await bakeIfNeeded(blob, 'image/jpeg', 'jpg', 6, false)).toMatchObject({
      blob,
      reencoded: false,
      failed: false,
    });
    expect(await bakeIfNeeded(blob, 'image/jpeg', 'jpg', 1, true)).toMatchObject({
      reencoded: false,
      failed: false,
    });
  });

  it('keeps the stripped bytes when the browser cannot decode the image', async () => {
    const outcome = await bakeIfNeeded(blob, 'image/jpeg', 'jpg', 6, true, async () => {
      throw new Error('cannot decode');
    });
    expect(outcome.blob).toBe(blob);
    expect(outcome.mime).toBe('image/jpeg');
    expect(outcome.ext).toBe('jpg');
    expect(outcome.reencoded).toBe(false);
    expect(outcome.failed).toBe(true);
  });

  it('reports a real re-encode and its new type', async () => {
    const baked = new Blob(['rotated']);
    const outcome = await bakeIfNeeded(blob, 'image/jpeg', 'jpg', 6, true, async () => ({
      blob: baked,
      mime: 'image/png',
      ext: 'png',
    }));
    expect(outcome).toMatchObject({ blob: baked, mime: 'image/png', ext: 'png', reencoded: true, failed: false });
  });
});
