import { describe, expect, it } from 'vitest';
import { downloadableState, type Item, type ItemResult } from '../src/hooks/useWorkspace.ts';

function item(state: Item['state'], result?: ItemResult): Item {
  return {
    id: 'item-1',
    file: new File([], 'photo.jpg', { type: 'image/jpeg' }),
    name: 'photo.jpg',
    size: 0,
    previewUrl: '',
    state,
    result,
  };
}

const result: ItemResult = {
  blob: new Blob(['clean']),
  filename: 'photo-clean.jpg',
  size: 5,
  removed: [],
  removedBytes: 0,
  verify: { ok: true, leftovers: [], warnings: [], fileSize: 5 },
  reencoded: false,
};

describe('downloadable selection', () => {
  it('accepts only verified or already-clean rows', () => {
    expect(downloadableState(item('done', result))).toBe('result');
    expect(downloadableState(item('clean'))).toBe('passthrough');
  });

  it('never offers a failed verification, even though it keeps a result for the report', () => {
    expect(downloadableState(item('failed', result))).toBeNull();
  });

  it('ignores rows that are still being processed', () => {
    expect(downloadableState(item('ready'))).toBeNull();
    expect(downloadableState(item('done'))).toBeNull();
  });
});
