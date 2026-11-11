export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Revoking early aborts a download that is still being written (archives can
  // be gigabytes); the blob data itself is released when the URL goes away.
  window.setTimeout(() => URL.revokeObjectURL(url), 300_000);
}

function stamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(
    date.getHours(),
  )}${pad(date.getMinutes())}`;
}

export function archiveName(date = new Date()): string {
  return `picprivacy-${stamp(date)}.zip`;
}

export function summaryName(date = new Date()): string {
  return `picprivacy-summary-${stamp(date)}.csv`;
}
