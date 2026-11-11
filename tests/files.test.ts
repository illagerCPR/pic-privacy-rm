import { describe, expect, it } from 'vitest';
import { directoryOf, safeArchivePath, uniqueName } from '../src/lib/files.ts';

describe('folder structure', () => {
  it('reads the directory out of a relative path', () => {
    expect(directoryOf('')).toBe('');
    expect(directoryOf('photo.jpg')).toBe('');
    expect(directoryOf('shoot/photo.jpg')).toBe('shoot');
    expect(directoryOf('shoot/day1/photo.jpg')).toBe('shoot/day1');
    expect(directoryOf('shoot\\day1\\photo.jpg')).toBe('shoot/day1');
  });

  it('mirrors the tree inside the archive', () => {
    expect(safeArchivePath('', 'photo-clean.jpg')).toBe('photo-clean.jpg');
    expect(safeArchivePath('shoot/day1', 'photo-clean.jpg')).toBe('shoot/day1/photo-clean.jpg');
    expect(safeArchivePath('shoot\\day1', 'photo-clean.jpg')).toBe('shoot/day1/photo-clean.jpg');
  });

  it('never produces a path that escapes the archive', () => {
    expect(safeArchivePath('../../etc', 'passwd')).toBe('etc/passwd');
    expect(safeArchivePath('/absolute/dir', 'a.jpg')).toBe('absolute/dir/a.jpg');
    expect(safeArchivePath('a/./b', 'a.jpg')).toBe('a/b/a.jpg');
    expect(safeArchivePath('', '..')).toBe('image');
    expect(safeArchivePath('', '')).toBe('image');
  });

  it('replaces characters some systems cannot store', () => {
    expect(safeArchivePath('', 'a\u0000b.jpg')).toBe('a_b.jpg');
    expect(safeArchivePath('', 'a:b?.jpg')).toBe('a_b_.jpg');
  });

  it('keeps the file name when the tree is deeper than the limit', () => {
    expect(safeArchivePath('1/2/3/4/5', 'x.jpg')).toBe('2/3/4/5/x.jpg');
  });
});

describe('duplicate member names', () => {
  it('numbers the second copy without touching either folder', () => {
    const taken = new Set<string>();
    expect(uniqueName(safeArchivePath('', 'p-clean.jpg'), taken)).toBe('p-clean.jpg');
    expect(uniqueName(safeArchivePath('', 'p-clean.jpg'), taken)).toBe('p-clean (2).jpg');
    expect(uniqueName(safeArchivePath('2024.05', 'p-clean.jpg'), taken)).toBe(
      '2024.05/p-clean.jpg',
    );
    expect(uniqueName(safeArchivePath('2024.05', 'p-clean.jpg'), taken)).toBe(
      '2024.05/p-clean (2).jpg',
    );
  });
});
