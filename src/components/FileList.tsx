import type { Item } from '../hooks/useWorkspace.ts';
import { FileRow } from './FileRow.tsx';

interface Props {
  items: Item[];
  onDetails: (id: string) => void;
  onStrip: (id: string) => void;
  onDownload: (id: string) => void;
  onRemove: (id: string) => void;
}

export function FileList({ items, onDetails, onStrip, onDownload, onRemove }: Props) {
  return (
    <ul className="file-list">
      {items.map((item) => (
        <FileRow
          key={item.id}
          item={item}
          onDetails={() => onDetails(item.id)}
          onStrip={() => onStrip(item.id)}
          onDownload={() => onDownload(item.id)}
          onRemove={() => onRemove(item.id)}
        />
      ))}
    </ul>
  );
}
