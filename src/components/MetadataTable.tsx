import { useMemo, useState } from 'react';
import type { MetadataGroup, MetadataItem, MetadataReport } from '../core/metadata.ts';
import { useI18n } from '../i18n/index.tsx';
import type { MessageKey } from '../i18n/zh.ts';
import { hexDump } from '../lib/hex.ts';
import { BlobImage } from './BlobImage.tsx';

/** Bytes shown before the viewer is asked to page in more. */
const HEX_PAGE = 128;
const HEX_STEP = 1024;

export interface CompareView {
  on: boolean;
  /** False until the file has been stripped and an output blob exists. */
  available: boolean;
  toggle: () => void;
  report: MetadataReport | null;
  loading: boolean;
  error: string | null;
  /** The two images themselves, shown above the metadata panes. */
  preview: {
    before: Blob;
    after: Blob | null;
    /** True when the orientation bake re-encoded the pixels. */
    reencoded: boolean;
    /** Set for formats the browser cannot decode (HEIC, TIFF). */
    notice?: string;
    /** True when the orientation tag was dropped without baking it into pixels. */
    orientationLost?: boolean;
  };
}

interface Props {
  report: MetadataReport | null;
  loading: boolean;
  error: string | null;
  /** False for formats the engine cannot read at all. */
  supported: boolean;
  compare: CompareView;
}

function toggle(previous: ReadonlySet<string>, id: string): ReadonlySet<string> {
  const next = new Set(previous);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

function filterGroups(groups: MetadataGroup[], needle: string): MetadataGroup[] {
  if (!needle) return groups;
  return groups
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
}

function countGroups(groups: MetadataGroup[]): number {
  return groups.reduce((sum, group) => sum + group.items.length, 0);
}

/**
 * One entry. Values that carry a raw payload (MakerNote, UserComment, unknown
 * TIFF tags) can be expanded into a hex dump: the viewer never guesses what a
 * vendor blob means, it just shows the bytes.
 */
function MetaRow({ item, kept }: { item: MetadataItem; kept: boolean }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [limit, setLimit] = useState(HEX_PAGE);
  const bytes = item.bytes;
  const total = bytes?.length ?? 0;
  const shown = Math.min(limit, total);
  const remaining = total - shown;

  return (
    <div className="meta-row" data-kept={kept ? 'true' : undefined}>
      <dt>
        <span className="meta-name">{item.name}</span>
        {(item.id || item.type) && (
          <span className="meta-id">{[item.id, item.type].filter(Boolean).join(' · ')}</span>
        )}
      </dt>
      <dd>
        <span className="meta-value" title={item.value.length > 60 ? item.value : undefined}>
          {item.value}
        </span>
        {bytes && bytes.length > 0 && (
          <>
            <button
              type="button"
              className="meta-hex-toggle"
              aria-expanded={open}
              onClick={() => setOpen((value) => !value)}
            >
              {open ? t('meta.hexHide') : t('meta.hexShow')}
            </button>
            {open && (
              <div className="meta-hex">
                <ol className="meta-hex-rows">
                  {hexDump(bytes, shown).map((row) => (
                    <li key={row.offset}>
                      <span className="meta-hex-offset">{row.offset}</span>
                      <span className="meta-hex-bytes">{row.hex}</span>
                      <span className="meta-hex-ascii">{row.ascii}</span>
                    </li>
                  ))}
                </ol>
                <div className="meta-hex-foot">
                  <span>{t('meta.hexRange', { shown, total })}</span>
                  {remaining > 0 && (
                    <button
                      type="button"
                      className="text-button"
                      onClick={() => setLimit((value) => value + HEX_STEP)}
                    >
                      {t('meta.hexMore', { n: Math.min(HEX_STEP, remaining) })}
                    </button>
                  )}
                </div>
              </div>
            )}
          </>
        )}
      </dd>
    </div>
  );
}

function GroupList({
  groups,
  collapsed,
  onToggle,
  expandAll,
}: {
  groups: MetadataGroup[];
  collapsed: ReadonlySet<string>;
  onToggle: (id: string) => void;
  expandAll: boolean;
}) {
  const { t } = useI18n();

  return (
    <>
      {groups.map((group) => {
        const open = expandAll || !collapsed.has(group.id);
        return (
          <section className="meta-group" key={group.id}>
            <button
              type="button"
              className="meta-group-head"
              aria-expanded={open}
              onClick={() => onToggle(group.id)}
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
                {group.items.map((item, index) => (
                  <MetaRow
                    key={`${item.name}-${index}`}
                    item={item}
                    kept={item.removed ?? !group.removed}
                  />
                ))}
              </dl>
            )}
          </section>
        );
      })}
    </>
  );
}

/**
 * Every metadata entry the file carries, grouped by the container block it
 * lives in. Filtering is client-side because the whole listing is already in
 * memory once the tab is open.
 */
export function MetadataTable({ report, loading, error, supported, compare }: Props) {
  const { t } = useI18n();
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const needle = query.trim().toLowerCase();

  const groups = useMemo(
    () => (report ? filterGroups(report.groups, needle) : []),
    [report, needle],
  );
  const afterGroups = useMemo(
    () => (compare.report ? filterGroups(compare.report.groups, needle) : []),
    [compare.report, needle],
  );

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

  const hasExtra = report.groups.some((group) => group.id !== 'file');
  if (!hasExtra && !compare.available) return <p className="meta-state">{t('meta.empty')}</p>;

  const matches = countGroups(groups);
  const afterClean =
    compare.report !== null &&
    compare.report.groups.every((group) => group.id === 'file' || !group.removed);

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
        {compare.available && (
          <button
            type="button"
            className="meta-compare-toggle"
            aria-pressed={compare.on}
            onClick={compare.toggle}
          >
            {t('meta.compare')}
          </button>
        )}
      </div>

      {needle.length > 0 && matches === 0 && <p className="meta-state">{t('meta.noMatch')}</p>}

      {compare.on ? (
        <>
          <div className="meta-previews">
            {compare.preview.notice ? (
              <p className="meta-preview-empty">{compare.preview.notice}</p>
            ) : (
              <>
                <figure className="meta-preview">
                  <BlobImage blob={compare.preview.before} alt={t('meta.before')} />
                  <figcaption>{t('meta.before')}</figcaption>
                </figure>
                <figure className="meta-preview">
                  {compare.preview.after ? (
                    <BlobImage blob={compare.preview.after} alt={t('meta.after')} />
                  ) : null}
                  <figcaption>{t('meta.after')}</figcaption>
                </figure>
              </>
            )}
          </div>
          <p className="meta-preview-note">
            {compare.preview.reencoded ? t('meta.reencodedPixels') : t('meta.samePixels')}
          </p>
          {compare.preview.orientationLost && (
            <p className="meta-preview-note meta-preview-note--warn">
              {t('meta.orientationPreview')}
            </p>
          )}

          <div className="meta-compare">
            <section className="meta-pane">
              <h4 className="meta-pane-head">
                {t('meta.before')}
                <span className="meta-pane-count">{countGroups(groups)}</span>
              </h4>
              <GroupList
                groups={groups}
                collapsed={collapsed}
                onToggle={(id) => setCollapsed((previous) => toggle(previous, id))}
                expandAll={needle.length > 0}
              />
            </section>

            <section className="meta-pane">
              <h4 className="meta-pane-head">
                {t('meta.after')}
                <span className="meta-pane-count">
                  {compare.loading ? '…' : countGroups(afterGroups)}
                </span>
              </h4>
              {compare.loading && (
                <p className="meta-state">
                  <span className="spinner" aria-hidden="true" />
                  {t('meta.loading')}
                </p>
              )}
              {!compare.loading && compare.error && (
                <div className="callout callout--bad">
                  <span>{t('meta.failed')}</span>
                </div>
              )}
              {!compare.loading && !compare.error && (
                <>
                  {afterClean && needle.length === 0 && (
                    <p className="meta-after-clean">{t('meta.afterClean')}</p>
                  )}
                  {compare.report && (
                    <GroupList
                      groups={afterGroups}
                      collapsed={collapsed}
                      onToggle={(id) => setCollapsed((previous) => toggle(previous, id))}
                      expandAll={needle.length > 0}
                    />
                  )}
                </>
              )}
            </section>
          </div>
        </>
      ) : (
        <GroupList
          groups={groups}
          collapsed={collapsed}
          onToggle={(id) => setCollapsed((previous) => toggle(previous, id))}
          expandAll={needle.length > 0}
        />
      )}
    </div>
  );
}
