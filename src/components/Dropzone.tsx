import { useRef, useState } from 'react';
import { useI18n } from '../i18n/index.tsx';
import { directoryOf, type IncomingFile } from '../lib/files.ts';
import { ClipboardIcon, FolderIcon, ImagePlusIcon } from './Icons.tsx';

interface Props {
  onFiles: (files: IncomingFile[]) => void;
  compact: boolean;
  dragging: boolean;
}

export function Dropzone({ onFiles, compact, dragging }: Props) {
  const { t } = useI18n();
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const [pasting, setPasting] = useState(false);

  const pickFiles = () => fileInput.current?.click();
  const pickFolder = () => folderInput.current?.click();

  const pasteFromClipboard = async () => {
    if (!navigator.clipboard?.read) return;
    setPasting(true);
    try {
      const items = await navigator.clipboard.read();
      const files: IncomingFile[] = [];
      for (const item of items) {
        for (const type of item.types) {
          if (!type.startsWith('image/')) continue;
          const blob = await item.getType(type);
          const ext = type === 'image/jpeg' ? 'jpg' : (type.split('/')[1] ?? 'png');
          files.push({
            file: new File([blob], `clipboard-${Date.now()}.${ext}`, { type }),
            dir: '',
          });
        }
      }
      if (files.length > 0) onFiles(files);
    } catch {
      /* clipboard permission denied — the global paste handler still works */
    } finally {
      setPasting(false);
    }
  };

  return (
    <section
      className={['dropzone', compact ? 'dropzone--compact' : '', dragging ? 'is-dragging' : '']
        .filter(Boolean)
        .join(' ')}
      aria-label={t('a11y.dropzone')}
    >
      <div className="dropzone-inner">
        <span className="dropzone-icon">
          <ImagePlusIcon size={compact ? 22 : 30} />
        </span>
        {!compact && (
          <>
            <h2 className="dropzone-title">{dragging ? t('drop.dragging') : t('drop.title')}</h2>
            <p className="dropzone-subtitle">{t('drop.subtitle')}</p>
          </>
        )}
        {compact && <span className="dropzone-title">{t('drop.addMore')}</span>}
        <div className="dropzone-actions">
          <button type="button" className="btn btn--primary btn--sm" onClick={pickFiles}>
            {t('drop.pickFiles')}
          </button>
          <button type="button" className="btn btn--ghost btn--sm" onClick={pickFolder}>
            <FolderIcon size={16} />
            {t('drop.pickFolder')}
          </button>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={pasteFromClipboard}
            disabled={pasting}
          >
            <ClipboardIcon size={16} />
            {t('drop.paste')}
          </button>
        </div>
        {!compact && <p className="dropzone-note">{t('drop.formats')}</p>}
      </div>

      <input
        ref={fileInput}
        type="file"
        accept="image/jpeg,image/png,image/webp,image/gif,.jpg,.jpeg,.png,.webp,.gif,.heic,.heif,.avif,.tif,.tiff"
        multiple
        hidden
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []).map((file) => ({ file, dir: '' }));
          if (files.length > 0) onFiles(files);
          event.target.value = '';
        }}
      />
      <input
        ref={folderInput}
        type="file"
        multiple
        hidden
        // Non-standard but supported by Chromium and Safari; harmless elsewhere.
        {...{ webkitdirectory: '', directory: '' }}
        onChange={(event) => {
          // The folder picker reports the tree in webkitRelativePath; the ZIP
          // mirrors it so a shoot comes back out in the same folders.
          const files = Array.from(event.target.files ?? [])
            .filter((file) => file.type !== '')
            .map((file) => ({ file, dir: directoryOf(file.webkitRelativePath ?? '') }));
          if (files.length > 0) onFiles(files);
          event.target.value = '';
        }}
      />
    </section>
  );
}
