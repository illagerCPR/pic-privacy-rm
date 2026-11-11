import { useEffect, useState } from 'react';

/**
 * Renders a Blob as an <img>, owning the object URL for exactly as long as the
 * element exists. Thumbnails, C2PA manifests and the before/after preview all
 * need the same three lines, and forgetting the revoke leaks the whole image.
 */
export function BlobImage({
  blob,
  alt,
  className,
}: {
  blob: Blob;
  alt: string;
  className?: string;
}) {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    const objectUrl = URL.createObjectURL(blob);
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [blob]);

  return url ? (
    <img className={className} src={url} alt={alt} loading="lazy" decoding="async" />
  ) : null;
}
