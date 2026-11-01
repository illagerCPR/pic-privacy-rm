/**
 * Apply an EXIF orientation to the pixels by re-encoding through a canvas.
 *
 * Only used when the user asks for it: losing the orientation tag can make
 * photos appear sideways, but re-encoding costs quality, so it is opt-in.
 */

const MAX_PIXELS = 120_000_000; // ~120 MP guard against tab crashes

function extensionFor(mime: string): string {
  switch (mime) {
    case 'image/png':
      return 'png';
    case 'image/webp':
      return 'webp';
    case 'image/gif':
      return 'png';
    default:
      return 'jpg';
  }
}

export interface BakedImage {
  blob: Blob;
  mime: string;
  ext: string;
}

export async function bakeOrientation(
  input: Blob,
  orientation: number,
  mime: string,
): Promise<BakedImage> {
  if (orientation < 2 || orientation > 8) {
    return { blob: input, mime, ext: extensionFor(mime) };
  }

  const bitmap = await createImageBitmap(input, { imageOrientation: 'none' });
  try {
    const swap = orientation >= 5 && orientation <= 8;
    const width = swap ? bitmap.height : bitmap.width;
    const height = swap ? bitmap.width : bitmap.height;
    if (width * height > MAX_PIXELS) {
      return { blob: input, mime, ext: extensionFor(mime) };
    }

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) return { blob: input, mime, ext: extensionFor(mime) };

    switch (orientation) {
      case 2:
        context.transform(-1, 0, 0, 1, width, 0);
        break;
      case 3:
        context.transform(-1, 0, 0, -1, width, height);
        break;
      case 4:
        context.transform(1, 0, 0, -1, 0, height);
        break;
      case 5:
        context.transform(0, 1, 1, 0, 0, 0);
        break;
      case 6:
        context.transform(0, 1, -1, 0, height, 0);
        break;
      case 7:
        context.transform(0, -1, -1, 0, width, height);
        break;
      case 8:
        context.transform(0, -1, 1, 0, 0, width);
        break;
      default:
        break;
    }

    context.drawImage(bitmap, 0, 0);

    const outputMime = mime === 'image/jpeg' || mime === 'image/webp' ? mime : 'image/png';
    const quality = outputMime === 'image/png' ? undefined : 0.95;
    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob((result) => resolve(result), outputMime, quality);
    });
    if (!blob) return { blob: input, mime, ext: extensionFor(mime) };
    return { blob, mime: outputMime, ext: extensionFor(outputMime) };
  } finally {
    bitmap.close();
  }
}
