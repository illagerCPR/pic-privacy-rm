/**
 * CSV summary of a batch.
 *
 * The JSON report is for reproducing a run; this is the one people open in a
 * spreadsheet to see what was found across a hundred photos. RFC 4180 quoting,
 * CRLF line endings and a UTF-8 BOM so Excel reads Chinese file names correctly.
 */
export interface SummaryRow {
  file: string;
  format: string;
  size: number;
  status: string;
  findings: number;
  /** Sensitive categories present, space separated (`gps exif`). */
  categories: string;
  dropped: number;
  output: number | '';
  verify: string;
  reencoded: string;
  error: string;
}

export const SUMMARY_COLUMNS: readonly (keyof SummaryRow)[] = [
  'file',
  'format',
  'size',
  'status',
  'findings',
  'categories',
  'dropped',
  'output',
  'verify',
  'reencoded',
  'error',
];

/**
 * A cell that begins with a formula marker is prefixed with an apostrophe:
 * spreadsheet apps would otherwise evaluate a file name like `=HYPERLINK(…)`
 * when the summary is opened. Numbers we write ourselves never start with one.
 */
function cell(value: string | number): string {
  let text = String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

/**
 * Headers and cells are both generated from SUMMARY_COLUMNS, so a caller
 * cannot label the columns in one order and fill them in another.
 */
export function buildCsv(
  labels: Readonly<Record<keyof SummaryRow, string>>,
  rows: readonly SummaryRow[],
): string {
  const headers = SUMMARY_COLUMNS.map((column) => labels[column]);
  const lines = [headers.map(cell).join(',')];
  for (const row of rows) {
    lines.push(SUMMARY_COLUMNS.map((column) => cell(row[column])).join(','));
  }
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}
