import { useEffect, useMemo, useRef, useState } from 'react';
import type { MetadataReport } from '../core/metadata.ts';
import type { C2paManifest, Field, Finding } from '../core/types.ts';
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
import { MetadataTable } from './MetadataTable.tsx';

type Group = NonNullable<Field['group']>;
const GROUP_ORDER: Group[] = ['gps', 'device', 'author', 'time', 'software', 'capture', 'other'];

function BlobImage({ blob, alt, className }: { blob: Blob; alt: string; className?: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const objectUrl = URL.createObjectURL(blob);
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [blob]);
  return url ? <img className={className} src={url} alt={alt} loading="lazy" decoding="async" /> : null;
}

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
            <a href={finding.params.mapUrl} target="_blank" rel="noreferrer noopener" className="text-link">
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
    { label: t('c2pa.issuer'), value: manifest.issuer === manifest.signer ? undefined : manifest.issuer },
    { label: t('c2pa.algorithm'), value: manifest.algorithm },
    { label: t('c2pa.validity'), value: validityText(manifest.certValidFrom, manifest.certValidTo) },
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
  const tr = (key: string, params?: Record<string, string | number>) => t(key as MessageKey, params);
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
  const dialogRef = useRef<HTMLElement | null>(null);
  const openerRef = useRef<HTMLElement | null>(null);

  const [compareOn, setCompareOn] = useState(false);
  const [after, setAfter] = useState<{
    loading: boolean;
    report: MetadataReport | null;
    error: string | null;
  }>({ loading: false, report: null, error: null });
  const afterLoadedFor = useRef<Blob | null>(null);
  const itemId = item?.id;
  const resultBlob = item?.result?.blob ?? null;

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

  // Focus moves into the dialog when it opens, so Tab does not keep walking the
  // page behind it, and goes back to the button that opened it on close.
  useEffect(() => {
    if (!itemId) return undefined;
    const active = document.activeElement;
    openerRef.current = active instanceof HTMLElement ? active : null;
    dialogRef.current?.focus();
    return () => {
      const opener = openerRef.current;
      openerRef.current = null;
      if (opener?.isConnected) opener.focus();
    };
  }, [itemId]);

  useEffect(() => {
    if (!item) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [item, onClose]);

  // A modal dialog has to wrap Tab at both ends, otherwise focus lands on the
  // page underneath a panel the user cannot see.
  const trapTab = (event: React.KeyboardEvent<HTMLElement>): void => {
    if (event.key !== 'Tab') return;
    const root = event.currentTarget;
    const nodes = Array.from(
      root.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((node) => node.getClientRects().length > 0);
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    if (!first || !last) {
      event.preventDefault();
      return;
    }
    const active = document.activeElement;
    if (!(active instanceof Node) || !root.contains(active)) {
      event.preventDefault();
      first.focus();
      return;
    }
    if (event.shiftKey && (active === first || active === root)) {
      event.preventDefault();
      last.focus();
      return;
    }
    if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  };

  if (!item) return null;

  const scan = item.scan;
  const findings = (scan?.findings ?? []).filter((finding) => finding.category !== 'icc');
  const kept = (scan?.findings ?? []).filter((finding) => finding.category === 'icc');
  const canDownload = item.state === 'done' || item.state === 'clean';

  return (
    <div className="drawer-layer">
      <div className="drawer-backdrop" role="presentation" onClick={onClose} />
      <aside
        ref={dialogRef}
        className="drawer"
        role="dialog"
        aria-modal="true"
        aria-label={t('drawer.title')}
        tabIndex={-1}
        onKeyDown={trapTab}
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
          <button type="button" className="icon-btn" onClick={onClose} aria-label={t('actions.close')}>
            <XIcon size={18} />
          </button>
        </header>

        <div className="drawer-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'privacy'}
            className={tab === 'privacy' ? 'is-active' : ''}
            onClick={() => setTab('privacy')}
          >
            {t('drawer.privacy')}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'structure'}
            className={tab === 'structure' ? 'is-active' : ''}
            onClick={() => setTab('structure')}
          >
            {t('drawer.structure')}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'meta'}
            className={tab === 'meta' ? 'is-active' : ''}
            onClick={() => setTab('meta')}
          >
            {t('drawer.metadata')}
          </button>
        </div>

        <div className="drawer-body">
          {tab === 'privacy' && (
            <>
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
            </>
          )}

          {tab === 'meta' && (
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
              }}
            />
          )}

          {tab === 'structure' && (
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
          )}
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
