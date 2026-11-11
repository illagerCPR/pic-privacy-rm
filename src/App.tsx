import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DetailsDrawer } from './components/DetailsDrawer.tsx';
import { Dropzone } from './components/Dropzone.tsx';
import { FileList } from './components/FileList.tsx';
import { Footer } from './components/Footer.tsx';
import { Header } from './components/Header.tsx';
import { LockIcon, ShieldIcon, SparkIcon } from './components/Icons.tsx';
import { PrivacyModal } from './components/PrivacyModal.tsx';
import { Toasts, type ToastItem } from './components/Toasts.tsx';
import { Toolbar, type Stats } from './components/Toolbar.tsx';
import { useWorkspace } from './hooks/useWorkspace.ts';
import { useI18n } from './i18n/index.tsx';
import type { MessageKey } from './i18n/zh.ts';
import { filesFromDataTransfer } from './lib/files.ts';
import { createPipelineClient } from './lib/pipeline-client.ts';

function Hero() {
  const { t } = useI18n();
  return (
    <section className="hero">
      <h1>{t('hero.title')}</h1>
      <p className="hero-subtitle">{t('hero.subtitle')}</p>
      <div className="chips">
        <span className="chip">
          <LockIcon size={15} />
          {t('hero.chip.local')}
        </span>
        <span className="chip">
          <SparkIcon size={15} />
          {t('hero.chip.lossless')}
        </span>
        <span className="chip">
          <ShieldIcon size={15} />
          {t('hero.chip.formats')}
        </span>
      </div>
    </section>
  );
}

function Steps() {
  const { t } = useI18n();
  const steps = [
    ['steps.drop.title', 'steps.drop.body'],
    ['steps.inspect.title', 'steps.inspect.body'],
    ['steps.download.title', 'steps.download.body'],
  ] as const;

  return (
    <section className="steps" aria-label={t('modal.title')}>
      {steps.map(([title, body], index) => (
        <article className="step" key={title}>
          <span className="step-number">{index + 1}</span>
          <h3>{t(title)}</h3>
          <p>{t(body)}</p>
        </article>
      ))}
    </section>
  );
}

export default function App() {
  const { t } = useI18n();
  const [pipeline] = useState(() => createPipelineClient());
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const toastId = useRef(0);
  const [dragging, setDragging] = useState(false);
  const [privacyOpen, setPrivacyOpen] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);

  const notify = useCallback(
    (key: string, params?: Record<string, string | number>) => {
      const text = t(key as MessageKey, params);
      toastId.current += 1;
      const id = toastId.current;
      const tone: ToastItem['tone'] = key.startsWith('error.')
        ? 'bad'
        : key === 'toast.done' || key === 'toast.zipDone'
          ? 'ok'
          : 'info';
      setToasts((prev) => [...prev.slice(-2), { id, text, tone }]);
      window.setTimeout(() => {
        setToasts((prev) => prev.filter((toast) => toast.id !== id));
      }, 4200);
    },
    [t],
  );

  const workspace = useWorkspace(pipeline, notify);
  const { items, addFiles, stripItem, downloadItem, removeItem } = workspace;

  // Stable callbacks keep memoized rows from re-rendering when another file in
  // the list changes state.
  const openDetails = useCallback((id: string) => setDetailId(id), []);
  const stripOne = useCallback((id: string) => void stripItem(id), [stripItem]);
  const downloadOne = useCallback((id: string) => void downloadItem(id), [downloadItem]);
  const removeOne = useCallback(
    (id: string) => {
      removeItem(id);
      setDetailId((current) => (current === id ? null : current));
    },
    [removeItem],
  );

  const stats: Stats = useMemo(() => {
    let sensitive = 0;
    let reclaimable = 0;
    let clean = 0;
    let done = 0;
    let failed = 0;
    for (const item of items) {
      if (item.scan && item.scan.droppedBytes > 0) sensitive += 1;
      if (item.state === 'ready' && item.scan) reclaimable += item.scan.droppedBytes;
      if (item.state === 'clean') clean += 1;
      if (item.state === 'done') done += 1;
      if (item.state === 'failed' || item.state === 'error') failed += 1;
    }
    return { total: items.length, sensitive, clean, done, failed, reclaimable };
  }, [items]);

  const orientationCount = useMemo(
    () => items.filter((item) => (item.scan?.orientation ?? 1) > 1).length,
    [items],
  );

  const canStripAll = items.some(
    (item) => item.state === 'ready' || (item.state === 'failed' && item.scan?.supported),
  );
  const canDownloadAll = items.some((item) => item.state === 'done' || item.state === 'clean');
  const detailItem = items.find((item) => item.id === detailId) ?? null;

  useEffect(() => {
    const onDragOver = (event: DragEvent) => {
      if (!event.dataTransfer?.types?.includes('Files')) return;
      event.preventDefault();
      setDragging(true);
    };
    const onDragLeave = (event: DragEvent) => {
      if (event.relatedTarget === null) setDragging(false);
    };
    const onDrop = (event: DragEvent) => {
      event.preventDefault();
      setDragging(false);
      if (!event.dataTransfer) return;
      void filesFromDataTransfer(event.dataTransfer).then((files) => {
        if (files.length > 0) addFiles(files);
      });
    };
    const onPaste = (event: ClipboardEvent) => {
      const files = Array.from(event.clipboardData?.files ?? []);
      if (files.length === 0) return;
      event.preventDefault();
      addFiles(files);
    };

    window.addEventListener('dragover', onDragOver);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('drop', onDrop);
    window.addEventListener('paste', onPaste);
    return () => {
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('drop', onDrop);
      window.removeEventListener('paste', onPaste);
    };
  }, [addFiles]);

  return (
    <>
      <Header onOpenPrivacy={() => setPrivacyOpen(true)} />

      <main className="wrap">
        {items.length === 0 && <Hero />}

        <Dropzone onFiles={addFiles} compact={items.length > 0} dragging={dragging} />

        {items.length > 0 && (
          <>
            <Toolbar
              stats={stats}
              options={workspace.options}
              setOptions={workspace.setOptions}
              bake={workspace.bake}
              setBake={workspace.setBake}
              redactReports={workspace.redactReports}
              setRedactReports={workspace.setRedactReports}
              orientationCount={orientationCount}
              onStripAll={() => void workspace.stripAll()}
              onDownloadAll={() => void workspace.downloadAll()}
              onExportBatchReport={() => void workspace.exportBatchReport()}
              canExportBatch={items.some((item) => Boolean(item.scan))}
              onClear={workspace.clear}
              onCancelBatch={workspace.cancelBatch}
              cancelling={workspace.cancelling}
              busy={workspace.busy}
              progress={workspace.progress}
              scanProgress={workspace.scanProgress}
              job={workspace.job}
              canStripAll={canStripAll}
              canDownloadAll={canDownloadAll}
            />
            <FileList
              items={items}
              onDetails={openDetails}
              onStrip={stripOne}
              onDownload={downloadOne}
              onRemove={removeOne}
            />
          </>
        )}

        {items.length === 0 && <Steps />}
      </main>

      <Footer />

      <DetailsDrawer
        item={detailItem}
        onClose={() => setDetailId(null)}
        onStrip={() => {
          if (detailItem) {
            void workspace.stripItem(detailItem.id);
            setDetailId(null);
          }
        }}
        onDownload={() => {
          if (detailItem) void workspace.downloadItem(detailItem.id);
        }}
        onLoadMetadata={workspace.inspectItem}
        onLoadResultMetadata={workspace.inspectResult}
        onExportReport={workspace.exportReport}
      />

      <PrivacyModal open={privacyOpen} onClose={() => setPrivacyOpen(false)} />

      <Toasts toasts={toasts} onDismiss={(id) => setToasts((prev) => prev.filter((toast) => toast.id !== id))} />
    </>
  );
}
