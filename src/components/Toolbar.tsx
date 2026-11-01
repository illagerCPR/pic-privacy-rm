import type { StripOptions } from '../core/types.ts';
import { useI18n } from '../i18n/index.tsx';
import { formatBytes } from '../lib/format.ts';
import { AlertIcon, DownloadIcon, SparkIcon, TrashIcon } from './Icons.tsx';

export interface Stats {
  total: number;
  sensitive: number;
  clean: number;
  done: number;
  failed: number;
  reclaimable: number;
}

interface Props {
  stats: Stats;
  options: StripOptions;
  setOptions: (patch: Partial<StripOptions>) => void;
  bake: boolean;
  setBake: (value: boolean) => void;
  orientationCount: number;
  onStripAll: () => void;
  onDownloadAll: () => void;
  onClear: () => void;
  onCancelBatch: () => void;
  cancelling: boolean;
  busy: boolean;
  progress: { done: number; total: number } | null;
  canStripAll: boolean;
  canDownloadAll: boolean;
}

function Toggle(props: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
  hint: string;
}) {
  return (
    <label className="setting">
      <span className="setting-head">
        <input
          type="checkbox"
          className="sr-only"
          checked={props.checked}
          onChange={(event) => props.onChange(event.target.checked)}
        />
        <span className={`switch${props.checked ? ' is-on' : ''}`} aria-hidden="true">
          <span className="switch-thumb" />
        </span>
        <span className="setting-label">{props.label}</span>
      </span>
      <span className="setting-hint">{props.hint}</span>
    </label>
  );
}

export function Toolbar(props: Props) {
  const { t } = useI18n();
  const { stats, progress } = props;
  const percent = progress && progress.total > 0 ? (progress.done / progress.total) * 100 : 0;

  return (
    <div className="toolbar-wrap">
      <div className="toolbar">
        <div className="stats">
          <span className="stats-main">{t('stats.files', { n: stats.total })}</span>
          {stats.sensitive > 0 && (
            <span className="stats-figure stats-figure--warn">
              {t('stats.sensitive', { n: stats.sensitive })}
            </span>
          )}
          {stats.reclaimable > 0 && (
            <span className="stats-figure">{t('stats.reclaim', { bytes: formatBytes(stats.reclaimable) })}</span>
          )}
          {stats.clean > 0 && <span className="stats-figure">{t('stats.clean', { n: stats.clean })}</span>}
          {stats.done > 0 && (
            <span className="stats-figure stats-figure--ok">{t('stats.done', { n: stats.done })}</span>
          )}
          {stats.failed > 0 && (
            <span className="stats-figure stats-figure--bad">{t('stats.failed', { n: stats.failed })}</span>
          )}
        </div>
        <div className="toolbar-actions">
          <button
            type="button"
            className="btn btn--primary"
            onClick={props.onStripAll}
            disabled={!props.canStripAll || props.busy}
          >
            <SparkIcon size={17} />
            {t('actions.stripAll')}
          </button>
          <button
            type="button"
            className="btn btn--ghost"
            onClick={props.onDownloadAll}
            disabled={!props.canDownloadAll}
          >
            <DownloadIcon size={17} />
            {t('actions.downloadAll')}
          </button>
          <button type="button" className="btn btn--quiet" onClick={props.onClear} disabled={props.busy}>
            <TrashIcon size={16} />
            {t('actions.clear')}
          </button>
        </div>
      </div>

      {progress && (
        <div className="progress" role="status" aria-live="polite" aria-label={t('a11y.progress')}>
          <div className="progress-track">
            <div className="progress-bar" style={{ width: `${percent}%` }} />
          </div>
          <span className="progress-text">
            {progress.done} / {progress.total}
          </span>
          <button
            type="button"
            className="btn btn--quiet btn--sm"
            onClick={props.onCancelBatch}
            disabled={props.cancelling}
          >
            {props.cancelling ? t('status.cancelling') : t('actions.cancelBatch')}
          </button>
        </div>
      )}

      <div className="settings" aria-label={t('settings.title')}>
        <Toggle
          checked={props.options.truncateTrailer}
          onChange={(value) => props.setOptions({ truncateTrailer: value })}
          label={t('settings.truncate')}
          hint={t('settings.truncateHint')}
        />
        <Toggle
          checked={props.options.keepIcc}
          onChange={(value) => props.setOptions({ keepIcc: value })}
          label={t('settings.keepIcc')}
          hint={t('settings.keepIccHint')}
        />
        <Toggle
          checked={props.bake}
          onChange={props.setBake}
          label={t('settings.bake')}
          hint={t('settings.bakeHint')}
        />
        {!props.bake && props.orientationCount > 0 && (
          <div className="settings-callout" role="note">
            <AlertIcon size={16} />
            <span className="settings-callout-text">
              {t('settings.orientationHint', { n: props.orientationCount })}
            </span>
            <button
              type="button"
              className="btn btn--subtle btn--sm"
              onClick={() => props.setBake(true)}
            >
              {t('settings.orientationFix')}
            </button>
          </div>
        )}
        {props.bake && props.orientationCount > 0 && (
          <p className="settings-note">
            {t('stats.files', { n: props.orientationCount })} · {t('badge.orientation')} →{' '}
            {t('settings.bake')}
          </p>
        )}
      </div>
    </div>
  );
}
