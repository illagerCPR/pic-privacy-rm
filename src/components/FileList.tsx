import type { Item } from '../hooks/useWorkspace.ts';
import { FileRow } from './FileRow.tsx';

interface Props {
  items: Item[];
  /** True while a scan or batch strip owns the pipeline. */
  busy: boolean;
  onDetails: (id: string) => void;
  onStrip: (id: string) => void;
  onDownload: (id: string) => void;
  onRemove: (id: string) => void;
}

export function FileList({ items, busy, onDetails, onStrip, onDownload, onRemove }: Props) {
  return (
    <ul className="file-list">
      {items.map((item) => (
        <FileRow
          key={item.id}
          item={item}
          busy={busy}
          onDetails={onDetails}
          onStrip={onStrip}
          onDownload={onDownload}
          onRemove={onRemove}
        />
      ))}
    </ul>
  );
}
