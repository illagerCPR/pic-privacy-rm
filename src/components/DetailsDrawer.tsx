import { useEffect, useMemo, useRef, useState } from 'react';
import type { MetadataReport } from '../core/metadata.ts';
import type { C2paManifest, Field, Finding } from '../core/types.ts';
import { useModal } from '../hooks/useModal.ts';
import type { Item } from '../hooks/useWorkspace.ts';
import { useI18n } from '../i18n/index.tsx';
import type { MessageKey } from '../i18n/zh.ts';
import { validityText } from '../lib/finding-ui.ts';
import { formatBytes } from '../lib/format.ts';
import {
  AlertIcon,
  CameraIcon,
  CheckIcon,
  ClockIcon,
  DownloadIcon,
  FileIcon,
  InfoIcon,
  LayersIcon,
  MapPinIcon,
  ShieldIcon,
  SparkIcon,
  XIcon,
} from './Icons.tsx';
import { BlobImage } from './BlobImage.tsx';
import { MetadataTable } from './MetadataTable.tsx';

type Group = NonNullable<Field['group']>;
const GROUP_ORDER: Group[] = ['gps', 'device', 'author', 'time', 'software', 'capture', 'other'];

function FieldGroup({ fields }: { fields: Field[] }) {
  const { t } = useI18n();
  const grouped = useMemo(() => {
    const map = new Map<Group, Field[]>();
    for (const field of fields) {
      const group: Group = field.group ?? 'other';
      const list = map.get(group) ?? [];
      list.push(field);
      map.set(group, list);
    }
    return map;
  }, [fields]);

  return (
    <>
      {GROUP_ORDER.filter((group) => grouped.has(group)).map((group) => (
        <div className="field-group" key={group}>
          <h4 className="field-group-title">{t(`groups.${group}` as MessageKey)}</h4>
          <dl className="field-table">
            {(grouped.get(group) ?? []).map((field, index) => (
              <div className="field-row" key={`${field.label}-${index}`}>
                <dt data-sensitive={field.sensitive ? 'true' : undefined}>{field.label}</dt>
                <dd title={field.value.length > 120 ? field.value : undefined}>{field.value}</dd>
              </div>
            ))}
          </dl>
        </div>
      ))}
    </>
  );
}

function FindingBody({ finding }: { finding: Finding }) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const fields = finding.fields ?? [];
  const visible = expanded ? fields : fields.slice(0, 10);
  const hasMore = fields.length > visible.length;

  return (
    <>
      {finding.params?.lat && finding.params?.lon && (
        <div className="gps-line">
          <MapPinIcon size={15} />
          <span className="mono">
            {finding.params.lat}, {finding.params.lon}
          </span>
          {typeof finding.params.mapUrl === 'string' && (
            <a
              href={finding.params.mapUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="text-link"
            >
              {t('drawer.map')}
            </a>
          )}
        </div>
      )}

      {visible.length > 0 && <FieldGroup fields={visible} />}
      {hasMore && (
        <button type="button" className="text-button" onClick={() => setExpanded(true)}>
          {t('drawer.fields', { n: fields.length - visible.length })}
        </button>
      )}

      {finding.preview && (
        <figure className="thumb-preview">
          <BlobImage blob={finding.preview.blob} alt={t('drawer.thumbnailAlt')} />
          <figcaption>
            {formatBytes(finding.preview.blob.size)} · {finding.preview.mime}
          </figcaption>
        </figure>
      )}

      {finding.manifest && <C2paCard manifest={finding.manifest} />}
    </>
  );
}

function C2paCard({ manifest }: { manifest: C2paManifest }) {
  const { t } = useI18n();
  const rows: { label: string; value?: string }[] = [
    { label: t('c2pa.generator'), value: manifest.claimGenerator },
    { label: t('c2pa.signer'), value: manifest.signer },
    {
      label: t('c2pa.issuer'),
      value: manifest.issuer === manifest.signer ? undefined : manifest.issuer,
    },
    { label: t('c2pa.algorithm'), value: manifest.algorithm },
    {
      label: t('c2pa.validity'),
      value: validityText(manifest.certValidFrom, manifest.certValidTo),
    },
  ].filter((row) => Boolean(row.value));

  return (
    <div className="c2pa">
      <div className="c2pa-head">
        <ShieldIcon size={16} />
        <strong>{manifest.title || t('c2pa.untitled')}</strong>
      </div>

      {rows.length > 0 && (
        <dl className="field-table field-table--compact">
          {rows.map((row) => (
            <div className="field-row" key={row.label}>
              <dt>{row.label}</dt>
              <dd>{row.value}</dd>
            </div>
          ))}
        </dl>
      )}

      {manifest.actions.length > 0 && (
        <div className="c2pa-actions">
          <h5>{t('c2pa.actions')}</h5>
          <ol>
            {manifest.actions.map((action, index) => (
              <li key={`${action.action}-${index}`}>
                <code>{action.action}</code>
                {action.softwareAgent && <span className="c2pa-agent">{action.softwareAgent}</span>}
                {action.when && <time>{action.when}</time>}
              </li>
            ))}
          </ol>
        </div>
      )}

      {manifest.ingredientCount > 0 && (
        <p className="c2pa-meta">
          {t('c2pa.ingredients')}: {manifest.ingredientCount}
        </p>
      )}

      {manifest.thumbnail && (
        <figure className="thumb-preview thumb-preview--small">
          <BlobImage blob={manifest.thumbnail} alt={t('drawer.c2paThumbnail')} />
          <figcaption>{t('c2pa.thumbnail')}</figcaption>
        </figure>
      )}

      <p className="c2pa-notice">{t('c2pa.notice')}</p>
    </div>
  );
}

function iconFor(finding: Finding) {
  switch (finding.category) {
    case 'gps':
      return <MapPinIcon size={17} />;
    case 'exif':
      return <CameraIcon size={17} />;
    case 'xmp':
    case 'iptc':
      return <LayersIcon size={17} />;
    case 'c2pa':
      return <ShieldIcon size={17} />;
    case 'thumbnail':
      return <FileIcon size={17} />;
    case 'trailer':
    case 'mpf':
      return <FileIcon size={17} />;
    case 'orientation':
      return <InfoIcon size={17} />;
    case 'comment':
      return <ClockIcon size={17} />;
    default:
      return finding.severity === 'high' ? <AlertIcon size={17} /> : <InfoIcon size={17} />;
  }
}

function FindingCard({ finding }: { finding: Finding }) {
  const { t } = useI18n();
  const tr = (key: string, params?: Record<string, string | number>) =>
    t(key as MessageKey, params);
  const desc = tr(`${finding.id}.desc`);

  return (
    <article className="finding" data-tone={finding.severity}>
      <header className="finding-head">
        <span className="finding-icon">{iconFor(finding)}</span>
        <div className="finding-title">
          <h3>{tr(finding.id)}</h3>
          {desc !== `${finding.id}.desc` && <p>{desc}</p>}
        </div>
        {finding.bytes !== undefined && finding.bytes > 0 && (
          <span className="finding-bytes">{formatBytes(finding.bytes)}</span>
        )}
      </header>
      <FindingBody finding={finding} />
    </article>
  );
}

interface Props {
  item: Item | null;
  onClose: () => void;
  onStrip: () => void;
  onDownload: () => void;
  onLoadMetadata: (id: string) => Promise<MetadataReport | null>;
  onLoadResultMetadata: (id: string) => Promise<MetadataReport | null>;
  onExportReport: (id: string) => Promise<void>;
}

type Tab = 'privacy' | 'structure' | 'meta';

const TABS: { id: Tab; key: MessageKey }[] = [
  { id: 'privacy', key: 'drawer.privacy' },
  { id: 'structure', key: 'drawer.structure' },
  { id: 'meta', key: 'drawer.metadata' },
];

export function DetailsDrawer({
  item,
  onClose,
  onStrip,
  onDownload,
  onLoadMetadata,
  onLoadResultMetadata,
  onExportReport,
}: Props) {
  const { t } = useI18n();
  const [tab, setTab] = useState<Tab>('privacy');
  const [meta, setMeta] = useState<{
    loading: boolean;
    report: MetadataReport | null;
    error: string | null;
  }>({ loading: false, report: null, error: null });
  const metaLoadedFor = useRef<string | null>(null);

  // Before/after comparison. The stripped listing is fetched on demand too,
  // even later than the source one: most people never open this view.
  const [compareOn, setCompareOn] = useState(false);
  const [after, setAfter] = useState<{
    loading: boolean;
    report: MetadataReport | null;
    error: string | null;
  }>({ loading: false, report: null, error: null });
  const afterLoadedFor = useRef<Blob | null>(null);
  const itemId = item?.id;
  const resultBlob = item?.result?.blob ?? null;
  // Focus, scroll locking and Escape belong to the shared modal behaviour.
  const modal = useModal(itemId !== undefined, onClose);

  useEffect(() => {
    setTab('privacy');
    setMeta({ loading: false, report: null, error: null });
    metaLoadedFor.current = null;
    setCompareOn(false);
    setAfter({ loading: false, report: null, error: null });
    afterLoadedFor.current = null;
  }, [itemId]);

  // The listing is built on demand: only opening this tab pays for it.
  useEffect(() => {
    if (tab !== 'meta' || !itemId) return undefined;
    if (metaLoadedFor.current === itemId) return undefined;
    metaLoadedFor.current = itemId;
    let cancelled = false;
    setMeta({ loading: true, report: null, error: null });
    onLoadMetadata(itemId)
      .then((report) => {
        if (!cancelled) setMeta({ loading: false, report, error: null });
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setMeta({
            loading: false,
            report: null,
            error: error instanceof Error ? error.message : 'error',
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [tab, itemId, onLoadMetadata]);

  // Re-inspecting after a re-strip: the output Blob identity is the cache key.
  useEffect(() => {
    if (!compareOn || !itemId || !resultBlob) return undefined;
    if (afterLoadedFor.current === resultBlob) return undefined;
    afterLoadedFor.current = resultBlob;
    let cancelled = false;
    setAfter({ loading: true, report: null, error: null });
    onLoadResultMetadata(itemId)
      .then((report) => {
        if (!cancelled) setAfter({ loading: false, report, error: null });
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setAfter({
            loading: false,
            report: null,
            error: error instanceof Error ? error.message : 'error',
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [compareOn, itemId, resultBlob, onLoadResultMetadata]);

  // A tablist is expected to move with the arrow keys, Home and End rather
  // than requiring a Tab stop per tab.
  const onTabKey = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const index = TABS.findIndex((entry) => entry.id === tab);
    const last = TABS.length - 1;
    let next: number;
    switch (event.key) {
      case 'ArrowRight':
        next = index === last ? 0 : index + 1;
        break;
      case 'ArrowLeft':
        next = index === 0 ? last : index - 1;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = last;
        break;
      default:
        return;
    }
    event.preventDefault();
    const entry = TABS[next];
    if (!entry) return;
    setTab(entry.id);
    document.getElementById(`drawer-tab-${entry.id}`)?.focus();
  };

  if (!item) return null;

  const scan = item.scan;
  const findings = (scan?.findings ?? []).filter((finding) => finding.category !== 'icc');
  const kept = (scan?.findings ?? []).filter((finding) => finding.category === 'icc');
  const canDownload = item.state === 'done' || item.state === 'clean';
  // Chrome decodes neither HEIC nor TIFF, so the preview says why it is empty
  // instead of showing two broken images.
  const previewNotice =
    scan?.format === 'heic'
      ? t('notice.heif.preview')
      : scan?.format === 'tiff'
        ? t('notice.tiff.preview')
        : undefined;

  return (
    <div className="drawer-layer">
      <div className="drawer-backdrop" role="presentation" onClick={onClose} />
      <aside
        ref={modal.ref}
        className="drawer"
        role="dialog"
        aria-modal="true"
        aria-label={t('drawer.title')}
        tabIndex={-1}
        onKeyDown={modal.onKeyDown}
        data-wide={tab === 'meta' && compareOn ? 'true' : undefined}
      >
        <header className="drawer-head">
          <div className="drawer-title">
            <h2>{item.name}</h2>
            <p>
              {scan && <span className="pill">{scan.format.toUpperCase()}</span>}
              <span className="mono">{formatBytes(item.size)}</span>
              {item.result && item.result.size !== item.size && (
                <>
                  <span aria-hidden="true">→</span>
                  <span className="mono">{formatBytes(item.result.size)}</span>
                </>
              )}
            </p>
          </div>
          <button
            type="button"
            className="icon-btn"
            onClick={onClose}
            aria-label={t('actions.close')}
          >
            <XIcon size={18} />
          </button>
        </header>

        <div
          className="drawer-tabs"
          role="tablist"
          aria-label={t('drawer.title')}
          onKeyDown={onTabKey}
        >
          {TABS.map((entry) => (
            <button
              key={entry.id}
              id={`drawer-tab-${entry.id}`}
              type="button"
              role="tab"
              aria-selected={tab === entry.id}
              aria-controls={`drawer-panel-${entry.id}`}
              tabIndex={tab === entry.id ? 0 : -1}
              className={tab === entry.id ? 'is-active' : ''}
              onClick={() => setTab(entry.id)}
            >
              {t(entry.key)}
            </button>
          ))}
        </div>

        <div className="drawer-body">
          <div
            role="tabpanel"
            id="drawer-panel-privacy"
            aria-labelledby="drawer-tab-privacy"
            tabIndex={0}
            hidden={tab !== 'privacy'}
          >
            {item.state === 'unsupported' && (
              <div className="callout callout--warn">
                <AlertIcon size={17} />
                <span>
                  {t('error.unsupported', {
                    format: (scan?.format ?? 'FILE').toUpperCase(),
                  })}
                </span>
              </div>
            )}
            {item.state === 'error' && (
              <div className="callout callout--bad">
                <AlertIcon size={17} />
                <span>{t('error.unreadable')}</span>
              </div>
            )}
            {scan?.supported && findings.length === 0 && (
              <div className="callout callout--ok">
                <CheckIcon size={17} />
                <span>{t('drawer.noFindings')}</span>
              </div>
            )}
            {findings.map((finding, index) => (
              <FindingCard key={`${finding.id}-${index}`} finding={finding} />
            ))}
            {kept.map((finding, index) => (
              <article className="finding finding--kept" key={`kept-${index}`}>
                <header className="finding-head">
                  <span className="finding-icon">
                    <SparkIcon size={17} />
                  </span>
                  <div className="finding-title">
                    <h3>{t(finding.id as MessageKey)}</h3>
                    <p>{t(`${finding.id}.desc` as MessageKey)}</p>
                  </div>
                  <span className="badge" data-tone="low">
                    {t('drawer.kept')}
                  </span>
                </header>
              </article>
            ))}
            {(scan?.warnings ?? []).length > 0 && (
              <div className="warnings">
                <h4>{t('drawer.warnings')}</h4>
                <ul>
                  {(scan?.warnings ?? []).map((warning, index) => (
                    <li key={index} data-severity={warning.severity}>
                      {t(warning.id as MessageKey, warning.params)}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          <div
            role="tabpanel"
            id="drawer-panel-meta"
            aria-labelledby="drawer-tab-meta"
            tabIndex={0}
            hidden={tab !== 'meta'}
          >
            <MetadataTable
              report={meta.report}
              loading={meta.loading}
              error={meta.error}
              supported={item.scan?.supported !== false}
              compare={{
                on: compareOn,
                available: resultBlob !== null,
                toggle: () => setCompareOn((value) => !value),
                report: after.report,
                loading: after.loading,
                error: after.error,
                preview: {
                  before: item.file,
                  after: resultBlob,
                  reencoded: item.result?.reencoded ?? false,
                  notice: previewNotice,
                  orientationLost:
                    !(item.result?.reencoded ?? false) && (item.scan?.orientation ?? 1) > 1,
                },
              }}
            />
          </div>

          <div
            role="tabpanel"
            id="drawer-panel-structure"
            aria-labelledby="drawer-tab-structure"
            tabIndex={0}
            hidden={tab !== 'structure'}
          >
            <div className="structure">
              {item.state === 'unsupported' ? (
                <p className="muted">{t('drawer.noPreview')}</p>
              ) : (
                <table className="block-table">
                  <thead>
                    <tr>
                      <th>{t('drawer.block')}</th>
                      <th>{t('drawer.size')}</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {(scan?.blocks ?? []).map((block, index) => (
                      <tr key={`${block.name}-${index}`} data-kept={block.kept}>
                        <td>
                          <span className="mono">{block.name}</span>
                          {block.note && <span className="block-note">{block.note}</span>}
                        </td>
                        <td className="mono">{formatBytes(block.bytes)}</td>
                        <td>
                          <span className="badge" data-tone={block.kept ? 'low' : 'medium'}>
                            {block.kept ? t('drawer.kept') : t('drawer.dropped')}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>

        <footer className="drawer-foot">
          {(item.state === 'ready' || item.state === 'failed') && (
            <button type="button" className="btn btn--primary" onClick={onStrip}>
              <SparkIcon size={16} />
              {t('actions.strip')}
            </button>
          )}
          {canDownload && (
            <button type="button" className="btn btn--primary" onClick={onDownload}>
              <DownloadIcon size={16} />
              {t('actions.download')}
            </button>
          )}
          <button
            type="button"
            className="btn btn--ghost"
            onClick={() => void onExportReport(item.id)}
          >
            <DownloadIcon size={16} />
            {t('actions.report')}
          </button>
          <button type="button" className="btn btn--ghost" onClick={onClose}>
            {t('actions.close')}
          </button>
        </footer>
      </aside>
    </div>
  );
}
