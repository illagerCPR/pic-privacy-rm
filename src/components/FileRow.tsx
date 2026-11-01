import { useState } from 'react';
import type { Item } from '../hooks/useWorkspace.ts';
import { useI18n } from '../i18n/index.tsx';
import { badgesFor } from '../lib/finding-ui.ts';
import { formatBytes } from '../lib/format.ts';
import {
  AlertIcon,
  CheckIcon,
  ChevronRightIcon,
  DownloadIcon,
  FileIcon,
  RefreshIcon,
  SparkIcon,
  XIcon,
} from './Icons.tsx';
import type { MessageKey } from '../i18n/zh.ts';

interface Props {
  item: Item;
  onDetails: () => void;
  onStrip: () => void;
  onDownload: () => void;
  onRemove: () => void;
}

function StatusPill({ item }: { item: Item }) {
  const { t } = useI18n();
  switch (item.state) {
    case 'scanning':
      return (
        <span className="status" data-tone="muted">
          <span className="spinner" aria-hidden="true" />
          {t('status.scanning')}
        </span>
      );
    case 'stripping':
      return (
        <span className="status" data-tone="active">
          <span className="spinner" aria-hidden="true" />
          {t('status.stripping')}
        </span>
      );
    case 'ready':
      return (
        <span className="status" data-tone="warn">
          {t('status.ready')}
        </span>
      );
    case 'clean':
      return (
        <span className="status" data-tone="ok">
          <CheckIcon size={14} />
          {t('status.clean')}
        </span>
      );
    case 'done':
      return (
        <span className="status" data-tone="ok">
          <CheckIcon size={14} />
          {t('status.done')} · {t('status.verified')}
        </span>
      );
    case 'unsupported':
      return (
        <span className="status" data-tone="bad">
          <AlertIcon size={14} />
          {t('status.unsupported')}
        </span>
      );
    case 'failed':
      return (
        <span className="status" data-tone="bad">
          <AlertIcon size={14} />
          {item.error ? t(item.error as MessageKey) : t('status.failed')}
        </span>
      );
    case 'error':
      return (
        <span className="status" data-tone="bad">
          <AlertIcon size={14} />
          {item.error ? t(item.error as MessageKey) : t('status.failed')}
        </span>
      );
    default:
      return null;
  }
}

export function FileRow({ item, onDetails, onStrip, onDownload, onRemove }: Props) {
  const { t } = useI18n();
  const [thumbBroken, setThumbBroken] = useState(false);
  const badges = item.scan ? badgesFor(item.scan.findings) : [];
  const visibleBadges = badges.slice(0, 4);
  const hiddenBadges = badges.slice(4);

  const showStrip = item.state === 'ready' || item.state === 'failed';
  const showDownload = item.state === 'done' || item.state === 'clean';
  // Neither browser can decode these, so the thumbnail degrades to an icon
  // while the strip pass works exactly as usual.
  const previewNotice =
    item.scan?.format === 'heic'
      ? t('notice.heif.preview')
      : item.scan?.format === 'tiff'
        ? t('notice.tiff.preview')
        : undefined;

  return (
    <li className={`file-row file-row--${item.state}`}>
      <div className="thumb" title={previewNotice}>
        {!thumbBroken ? (
          <img
            src={item.previewUrl}
            alt=""
            loading="lazy"
            decoding="async"
            onError={() => setThumbBroken(true)}
          />
        ) : (
          <FileIcon size={22} />
        )}
        {item.state === 'scanning' && <span className="thumb-veil" />}
      </div>

      <div className="file-body">
        <div className="file-line">
          <span className="file-name" title={item.name}>
            {item.name}
          </span>
          <span className="file-size">
            {formatBytes(item.size)}
            {item.result && item.result.size !== item.size && (
              <>
                <span className="file-size-arrow"> → </span>
                <strong>{formatBytes(item.result.size)}</strong>
              </>
            )}
          </span>
        </div>

        <div className="file-line file-line--meta">
          <StatusPill item={item} />
          {visibleBadges.map((badge) => (
            <span key={badge.key} className="badge" data-tone={badge.tone}>
              {t(badge.key)}
            </span>
          ))}
          {hiddenBadges.length > 0 && (
            <span className="badge" data-tone="low" title={hiddenBadges.map((b) => t(b.key)).join(' · ')}>
              {t('badge.more', { n: hiddenBadges.length })}
            </span>
          )}
          {item.result?.reencoded && (
            <span className="badge" data-tone="low">
              Canvas
            </span>
          )}
          {item.state === 'failed' && item.result && (
            <span className="badge" data-tone="high">
              {t('error.verifyFailed')}
            </span>
          )}
        </div>
      </div>

      <div className="file-actions">
        {(item.state === 'ready' || item.state === 'done' || item.state === 'failed') && (
          <button
            type="button"
            className="icon-btn"
            onClick={onDetails}
            title={t('actions.details')}
            aria-label={`${t('a11y.details')}: ${item.name}`}
          >
            <ChevronRightIcon size={17} />
          </button>
        )}
        {showStrip && (
          <button type="button" className="btn btn--subtle btn--sm" onClick={onStrip} disabled={item.state === 'stripping'}>
            {item.state === 'failed' ? <RefreshIcon size={15} /> : <SparkIcon size={15} />}
            {item.state === 'failed' ? t('actions.retry') : t('actions.strip')}
          </button>
        )}
        {showDownload && (
          <button
            type="button"
            className="btn btn--subtle btn--sm"
            onClick={onDownload}
            aria-label={`${t('a11y.download')}: ${item.name}`}
          >
            <DownloadIcon size={15} />
            {t('actions.download')}
          </button>
        )}
        <button
          type="button"
          className="icon-btn icon-btn--quiet"
          onClick={onRemove}
          title={t('actions.remove')}
          aria-label={`${t('a11y.remove')}: ${item.name}`}
        >
          <XIcon size={16} />
        </button>
      </div>
    </li>
  );
}
