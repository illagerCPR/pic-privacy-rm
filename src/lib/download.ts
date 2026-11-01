import { Zip, ZipPassThrough } from 'fflate';

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

const ZIP_LIMIT = 4 * 1024 * 1024 * 1024;

/** Stream images into a store-only zip so memory stays flat for big batches. */
export function buildZip(entries: { name: string; blob: Blob }[]): Promise<Blob> {
  const total = entries.reduce((sum, entry) => sum + entry.blob.size, 0);
  if (total > ZIP_LIMIT) {
    return Promise.reject(new Error('archive-too-large'));
  }

  return new Promise<Blob>((resolve, reject) => {
    const chunks: BlobPart[] = [];
    const zip = new Zip((error, chunk, final) => {
      if (error) {
        reject(error);
        return;
      }
      if (chunk.length > 0) chunks.push(chunk as unknown as BlobPart);
      if (final) resolve(new Blob(chunks, { type: 'application/zip' }));
    });

    void (async () => {
      for (const entry of entries) {
        const file = new ZipPassThrough(entry.name);
        zip.add(file);
        const reader = entry.blob.stream().getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) file.push(value, false);
        }
        file.push(new Uint8Array(0), true);
      }
      zip.end();
    })().catch(reject);
  });
}

export function archiveName(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `picprivacy-${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(
    date.getHours(),
  )}${pad(date.getMinutes())}.zip`;
}
