import { useMemo, useState } from 'react';
import type { MetadataReport } from '../core/metadata.ts';
import { useI18n } from '../i18n/index.tsx';
import type { MessageKey } from '../i18n/zh.ts';

interface Props {
  report: MetadataReport | null;
  loading: boolean;
  error: string | null;
  /** False for formats the engine cannot read at all. */
  supported: boolean;
}

function toggle(previous: ReadonlySet<string>, id: string): ReadonlySet<string> {
  const next = new Set(previous);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/**
 * Every metadata entry the file carries, grouped by the container block it
 * lives in. Filtering is client-side because the whole listing is already in
 * memory once the tab is open.
 */
export function MetadataTable({ report, loading, error, supported }: Props) {
  const { t } = useI18n();
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const needle = query.trim().toLowerCase();

  const groups = useMemo(() => {
    if (!report) return [];
    if (!needle) return report.groups;
    return report.groups
      .map((group) => ({
        ...group,
        items: group.items.filter(
          (item) =>
            item.name.toLowerCase().includes(needle) ||
            item.value.toLowerCase().includes(needle) ||
            (item.id ?? '').toLowerCase().includes(needle),
        ),
      }))
      .filter((group) => group.items.length > 0);
  }, [report, needle]);

  if (loading) {
    return (
      <p className="meta-state">
        <span className="spinner" aria-hidden="true" />
        {t('meta.loading')}
      </p>
    );
  }
  if (error) {
    return (
      <div className="callout callout--bad">
        <span>{t('meta.failed')}</span>
      </div>
    );
  }
  if (!supported) return <p className="meta-state">{t('meta.unsupported')}</p>;
  if (!report) return null;
  if (report.groups.every((group) => group.id === 'file')) {
    return <p className="meta-state">{t('meta.empty')}</p>;
  }

  const matches = groups.reduce((sum, group) => sum + group.items.length, 0);

  return (
    <div className="meta">
      <div className="meta-toolbar">
        <input
          type="search"
          className="meta-search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t('meta.search')}
          aria-label={t('meta.search')}
        />
        <span className="meta-tally">
          {needle ? t('meta.matches', { n: matches }) : t('meta.count', { n: report.total })}
        </span>
      </div>

      {needle.length > 0 && matches === 0 && <p className="meta-state">{t('meta.noMatch')}</p>}

      {groups.map((group) => {
        const open = needle.length > 0 || !collapsed.has(group.id);
        return (
          <section className="meta-group" key={group.id}>
            <button
              type="button"
              className="meta-group-head"
              aria-expanded={open}
              onClick={() => setCollapsed((previous) => toggle(previous, group.id))}
            >
              <span className="meta-caret" aria-hidden="true">
                {open ? '▾' : '▸'}
              </span>
              <span className="meta-group-title">{t(group.titleKey as MessageKey)}</span>
              <span className="meta-group-count">{group.items.length}</span>
              <span className="badge" data-tone={group.removed ? 'medium' : 'low'}>
                {group.removed ? t('meta.removed') : t('meta.kept')}
              </span>
            </button>

            {open && (
              <dl className="meta-table">
                {group.items.map((item, index) => {
                  const kept = item.removed ?? !group.removed;
                  return (
                    <div
                      className="meta-row"
                      key={`${item.name}-${index}`}
                      data-kept={kept ? 'true' : undefined}
                    >
                      <dt>
                        <span className="meta-name">{item.name}</span>
                        {(item.id || item.type) && (
                          <span className="meta-id">{[item.id, item.type].filter(Boolean).join(' · ')}</span>
                        )}
                      </dt>
                      <dd title={item.value.length > 60 ? item.value : undefined}>{item.value}</dd>
                    </div>
                  );
                })}
              </dl>
            )}
          </section>
        );
      })}
    </div>
  );
}
