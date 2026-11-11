import { describe, expect, it } from 'vitest';
import { buildCsv, SUMMARY_COLUMNS, type SummaryRow } from '../src/lib/csv.ts';

function row(overrides: Partial<SummaryRow> = {}): SummaryRow {
  return {
    file: 'photo.jpg',
    format: 'JPEG',
    size: 78400,
    status: '已清理',
    findings: 3,
    categories: 'gps exif',
    dropped: 1200,
    output: 1635,
    verify: '通过',
    reencoded: '否',
    error: '',
    ...overrides,
  };
}

const LABELS = Object.fromEntries(SUMMARY_COLUMNS.map((column) => [column, column])) as Record<
  keyof SummaryRow,
  string
>;

describe('CSV summary', () => {
  it('starts with a BOM and uses CRLF so Excel opens it correctly', () => {
    const csv = buildCsv(LABELS, [row()]);
    expect(csv.startsWith('\uFEFF')).toBe(true);
    expect(csv).toContain('\r\n');
    expect(csv.split('\r\n')[0]).toBe(`\uFEFF${SUMMARY_COLUMNS.join(',')}`);
    expect(csv.endsWith('\r\n')).toBe(true);
  });

  it('writes one line per file in column order', () => {
    const labels = { ...LABELS, file: '文件', status: '状态', size: '大小' };
    const csv = buildCsv(labels, [row(), row({ file: 'b.png', status: '无需清理' })]);
    const lines = csv
      .replace(/^\uFEFF/, '')
      .trimEnd()
      .split('\r\n');
    expect(lines[0]?.split(',')).toEqual(SUMMARY_COLUMNS.map((column) => labels[column]));
    expect(lines[0]).toContain('文件,format,大小');
    expect(lines[1]?.startsWith('photo.jpg,JPEG,78400,已清理,')).toBe(true);
    expect(lines[2]?.startsWith('b.png,JPEG,78400,无需清理,')).toBe(true);
  });

  it('quotes commas, quotes and line breaks', () => {
    const csv = buildCsv(LABELS, [row({ file: 'a,b "c".jpg' }), row({ file: 'line\nbreak.jpg' })]);
    expect(csv).toContain('"a,b ""c"".jpg"');
    expect(csv).toContain('"line\nbreak.jpg"');
  });

  it('defuses a file name a spreadsheet would run as a formula', () => {
    const csv = buildCsv(LABELS, [row({ file: '=HYPERLINK("http://x")' })]);
    expect(csv).toContain(`"'=HYPERLINK(""http://x"")"`);
    expect(csv).not.toContain(',=HYPERLINK');
  });

  it('leaves an unknown output size empty rather than writing "undefined"', () => {
    const csv = buildCsv(LABELS, [row({ output: '' })]);
    const cells = csv.split('\r\n')[1]?.split(',') ?? [];
    expect(cells[SUMMARY_COLUMNS.indexOf('output')]).toBe('');
  });
});
