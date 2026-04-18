import { useState, useEffect, useMemo } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import api from '../api/client';
import ConfirmDialog from '../components/ui/ConfirmDialog';
import { useConfirmDialog } from '../hooks/useConfirmDialog';
import { Plus, Edit, Trash2, Tag as TagIcon, ChevronLeft, ChevronRight, MoreHorizontal } from 'lucide-react';
import TagModal from '../components/modals/TagModal';
import Button from '../components/ui/Button';
import { CollectionToolbar } from '../components/collections';
import { EmptyState } from '../components/EmptyState';
import { PageLoadingSkeleton } from '../components/ui/PageLoadingSkeleton';
import { useAppConfig } from '../contexts/AppConfigContext';
import { Card } from '../components/ui/card';
import BookmarkCard from '../components/bookmarks/BookmarkCard';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../components/ui/dropdown-menu';
import { cn } from '@/lib/utils';

interface Tag {
  id: string;
  name: string;
  created_at?: string;
}

interface PreviewBookmark {
  id: string;
  title: string;
  url: string;
  slug: string;
  forwarding_enabled: boolean;
  folders?: Array<{ id: string; name: string; icon?: string | null }>;
  tags?: Array<{ id: string; name: string }>;
  bookmark_type?: 'own' | 'shared';
  pinned?: boolean;
  access_count?: number;
  last_accessed_at?: string | null;
}

type SortOption = 'alphabetical' | 'recently_added';

const DEFAULT_SORT: SortOption = 'alphabetical';

const DIST_COLORS = [
  'var(--t-violet)',
  'var(--t-blue)',
  'var(--t-cyan)',
  'var(--t-green)',
  'var(--t-amber)',
  'var(--t-rose)',
  'var(--t-pink)',
];

export default function Tags() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { pathPrefixForLinks } = useAppConfig();
  const prefix = (pathPrefixForLinks || '').replace(/\/+/g, '/') || '';
  const { showConfirm, dialogState } = useConfirmDialog();
  const [searchParams, setSearchParams] = useSearchParams();
  const [tags, setTags] = useState<Tag[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingTag, setEditingTag] = useState<Tag | null>(null);
  const sortParam = searchParams.get('sort');
  const sortBy = sortParam === 'recently_added' || sortParam === 'alphabetical' ? sortParam : DEFAULT_SORT;
  const PAGE_SIZE_OPTIONS = [50, 100, 200, 500] as const;
  const limitParam = searchParams.get('limit');
  const pageSize =
    limitParam && PAGE_SIZE_OPTIONS.includes(Number(limitParam) as (typeof PAGE_SIZE_OPTIONS)[number])
      ? Number(limitParam)
      : 50;
  const page = Math.max(0, parseInt(searchParams.get('page') || '0', 10));
  const [totalTags, setTotalTags] = useState(0);
  const selectedTagId = searchParams.get('tag_id') || '';
  const [tagQuery, setTagQuery] = useState('');
  const [topTags, setTopTags] = useState<Array<{ id: string; name: string; bookmark_count: number }>>([]);
  const [previewBookmarks, setPreviewBookmarks] = useState<PreviewBookmark[]>([]);
  const [previewLoading, setPreviewLoading] = useState(false);

  useEffect(() => {
    loadTags();
  }, [sortBy, page, pageSize]);

  useEffect(() => {
    api
      .get('/dashboard/stats')
      .then((res) => {
        setTopTags(res.data?.topTags ?? []);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!selectedTagId) {
      setPreviewBookmarks([]);
      return;
    }
    setPreviewLoading(true);
    api
      .get('/bookmarks', {
        params: { tag_id: selectedTagId, limit: 12, sort_by: 'recently_added' },
      })
      .then((res) => {
        const payload = res.data;
        setPreviewBookmarks(payload.items ?? []);
      })
      .catch(() => setPreviewBookmarks([]))
      .finally(() => setPreviewLoading(false));
  }, [selectedTagId]);

  function updateParams(updates: { sort?: string; limit?: string; page?: string; tag_id?: string | null }) {
    const params = new URLSearchParams(searchParams);
    if (updates.sort !== undefined) {
      if (updates.sort === DEFAULT_SORT || updates.sort === '') params.delete('sort');
      else params.set('sort', updates.sort);
    }
    if (updates.limit !== undefined) {
      if (updates.limit === '' || updates.limit === '50') params.delete('limit');
      else params.set('limit', updates.limit);
      params.set('page', '0');
    }
    if (updates.page !== undefined) {
      if (updates.page === '0' || updates.page === '') params.delete('page');
      else params.set('page', updates.page);
    }
    if (updates.tag_id !== undefined) {
      if (!updates.tag_id) params.delete('tag_id');
      else params.set('tag_id', updates.tag_id);
    }
    setSearchParams(params);
  }

  const hasActiveFilters = sortBy !== DEFAULT_SORT;

  function handleRemoveFilter(key: string) {
    if (key === 'sort') updateParams({ sort: DEFAULT_SORT });
  }

  function handleResetFilters() {
    updateParams({ sort: DEFAULT_SORT });
  }

  const filterChips = useMemo(() => {
    const list: { key: string; label: string; ariaLabel: string }[] = [];
    if (sortBy !== DEFAULT_SORT) {
      const sortLabel = sortBy === 'recently_added' ? t('tags.sortRecentlyAdded') : t('tags.sortAlphabetical');
      list.push({ key: 'sort', label: `Sort: ${sortLabel}`, ariaLabel: t('tags.clearFilters') + ' Sort' });
    }
    return list;
  }, [sortBy, t]);

  async function loadTags() {
    try {
      const res = await api.get('/tags', {
        params: { sort_by: sortBy, limit: pageSize, offset: page * pageSize },
      });
      const data = res.data;
      if (data && typeof data === 'object' && 'items' in data && 'total' in data) {
        setTags(Array.isArray((data as { items: Tag[] }).items) ? (data as { items: Tag[] }).items : []);
        setTotalTags(Number((data as { total: number }).total) || 0);
      } else {
        setTags(Array.isArray(data) ? data : []);
        setTotalTags(Array.isArray(data) ? data.length : 0);
      }
    } catch (error) {
      console.error('Failed to load tags:', error);
    } finally {
      setLoading(false);
    }
  }

  const sortedTags = useMemo(() => [...tags], [tags]);
  const visibleTags = useMemo(() => {
    const q = tagQuery.trim().toLowerCase();
    if (!q) return sortedTags;
    return sortedTags.filter((tg) => tg.name.toLowerCase().includes(q));
  }, [sortedTags, tagQuery]);

  function handleCreate() {
    setEditingTag(null);
    setModalOpen(true);
  }

  function handleEdit(tag: Tag) {
    setEditingTag(tag);
    setModalOpen(true);
  }

  function handleDelete(id: string) {
    const tag = tags.find((tg) => tg.id === id);
    const tagName = tag?.name || 'this tag';
    showConfirm(
      t('tags.deleteTag'),
      t('tags.deleteConfirmWithName', { name: tagName }),
      async () => {
        try {
          await api.delete(`/tags/${id}`);
          loadTags();
          if (selectedTagId === id) updateParams({ tag_id: null });
        } catch (error) {
          console.error('Failed to delete tag:', error);
        }
      },
      { variant: 'danger', confirmText: t('common.delete'), cancelText: t('common.cancel') }
    );
  }

  function handleModalClose() {
    setModalOpen(false);
    setEditingTag(null);
  }

  const sortOptions = [
    { value: 'alphabetical', label: t('tags.sortAlphabetical') },
    { value: 'recently_added', label: t('tags.sortRecentlyAdded') },
  ];

  const maxTopCount = topTags[0]?.bookmark_count ?? 1;

  if (loading) {
    return <PageLoadingSkeleton lines={6} />;
  }

  return (
    <div className="space-y-6 pb-24">
      <CollectionToolbar
        title={t('tags.title')}
        count={totalTags}
        subtitle={
          hasActiveFilters || totalTags > pageSize
            ? t('bookmarks.showingXOfY', { x: sortedTags.length, y: totalTags })
            : t('tags.pageSubtitle')
        }
        search={{
          value: tagQuery,
          onChange: setTagQuery,
          onSubmit: setTagQuery,
          placeholder: t('tags.name'),
          ariaLabel: t('common.search'),
        }}
        createButton={{ label: t('tags.create'), onClick: handleCreate }}
        filterChips={{
          chips: filterChips,
          onRemove: handleRemoveFilter,
          onClearAll: handleResetFilters,
          clearAllLabel: t('bookmarks.clearAllFilters'),
          clearAllAriaLabel: t('bookmarks.clearAllFilters'),
        }}
        sort={{
          value: sortBy,
          onChange: (value) => updateParams({ sort: value as SortOption }),
          options: sortOptions,
          className: 'min-w-[160px]',
        }}
        perPage={{
          value: pageSize,
          onChange: (value) => {
            updateParams({ limit: String(value) });
          },
          options: [...PAGE_SIZE_OPTIONS],
          label: t('bookmarks.perPage'),
        }}
        moreMenuLabel={t('bookmarks.toolbarMore')}
      />

      {sortedTags.length === 0 ? (
        hasActiveFilters ? (
          <EmptyState
            icon={TagIcon}
            title={t('bookmarks.noMatches')}
            description={t('tags.noMatchesDescription')}
            action={
              <Button onClick={handleResetFilters} variant="secondary">
                {t('bookmarks.clearAllFilters')}
              </Button>
            }
          />
        ) : (
          <EmptyState
            icon={TagIcon}
            title={t('tags.empty')}
            description={t('tags.emptyDescription')}
            action={
              <Button onClick={handleCreate} variant="primary" icon={Plus} className="border-0 bg-primary-gradient text-primary-foreground shadow-glow hover:opacity-90">
                {t('tags.create')}
              </Button>
            }
          />
        )
      ) : (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_300px] xl:grid-cols-[1fr_320px]">
          <div className="space-y-6 min-w-0">
            <Card className="rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--bg-1)] p-4 shadow-[var(--shadow-sm)]">
              <div className="mb-3 font-mono text-[10px] uppercase tracking-[0.06em] text-[var(--fg-3)]">
                {t('tags.title')}
              </div>
              {visibleTags.length === 0 ? (
                <p className="text-[13px] text-[var(--fg-2)]">{t('tags.noMatchesDescription')}</p>
              ) : (
                <div className="tag-wall flex flex-wrap gap-2">
                  {visibleTags.map((tag, idx) => {
                    const selected = selectedTagId === tag.id;
                    return (
                      <div key={tag.id} className="group/chip inline-flex items-center gap-0.5">
                        <button
                          type="button"
                          onClick={() => updateParams({ tag_id: selected ? null : tag.id })}
                          className={cn(
                            'tag-chip inline-flex items-center gap-1.5 rounded-[var(--radius)] border px-2.5 py-1.5 text-left text-[12.5px] transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)]',
                            selected
                              ? 'border-[var(--accent-ring)] bg-[var(--accent-bg)] text-[var(--accent-hi)] ring-1 ring-[var(--accent-ring)]'
                              : 'border-[var(--border)] bg-[var(--bg-2)] text-[var(--fg-1)] hover:border-[var(--border-strong)]'
                          )}
                        >
                          <span
                            className="dot h-1.5 w-1.5 shrink-0 rounded-full"
                            style={{ background: DIST_COLORS[idx % DIST_COLORS.length] }}
                            aria-hidden
                          />
                          <span className="name max-w-[12rem] truncate">{tag.name}</span>
                        </button>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <button
                              type="button"
                              className="rounded p-1 text-[var(--fg-3)] opacity-0 transition-opacity hover:bg-[var(--bg-3)] group-hover/chip:opacity-100"
                              aria-label={t('common.actions')}
                            >
                              <MoreHorizontal className="h-4 w-4" />
                            </button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem asChild>
                              <Link to={`${prefix}/bookmarks?tag_id=${tag.id}`}>{t('dashboard.goToBookmarks')}</Link>
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => handleEdit(tag)}>
                              <Edit className="h-4 w-4" />
                              {t('common.edit')}
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => handleDelete(tag.id)} className="text-destructive focus:text-destructive">
                              <Trash2 className="h-4 w-4" />
                              {t('common.delete')}
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    );
                  })}
                </div>
              )}
            </Card>

            {selectedTagId ? (
              <section className="space-y-3">
                <h2 className="font-mono text-[10px] uppercase tracking-[0.06em] text-[var(--fg-3)]">
                  {t('shared.bookmarks')}
                </h2>
                {previewLoading ? (
                  <p className="text-[13px] text-[var(--fg-2)]">{t('common.loading')}</p>
                ) : previewBookmarks.length === 0 ? (
                  <EmptyState icon={TagIcon} title={t('bookmarks.noMatches')} />
                ) : (
                  <div className="bm-grid grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                    {previewBookmarks.map((b) => (
                      <BookmarkCard
                        key={b.id}
                        bookmark={b}
                        compact
                        bulkMode={false}
                        selected={false}
                        onSelect={() => {}}
                        onEdit={() =>
                          navigate(`${prefix}/bookmarks?edit=${encodeURIComponent(b.id)}`.replace(/\/+/g, '/'))
                        }
                        onDelete={() =>
                          showConfirm(
                            t('bookmarks.deleteBookmark'),
                            t('bookmarks.deleteConfirmWithName', { name: b.title }),
                            async () => {
                              try {
                                await api.delete(`/bookmarks/${b.id}`);
                                const res = await api.get('/bookmarks', {
                                  params: { tag_id: selectedTagId, limit: 12, sort_by: 'recently_added' },
                                });
                                setPreviewBookmarks(res.data?.items ?? []);
                                loadTags();
                              } catch {
                                /* ignore */
                              }
                            },
                            { variant: 'danger', confirmText: t('common.delete'), cancelText: t('common.cancel') }
                          )
                        }
                        onCopyUrl={() => {
                          const u = b.slug ? `${window.location.origin}/go/${b.slug}` : '';
                          if (u) navigator.clipboard.writeText(u);
                        }}
                        onOpen={() => window.open(b.url, '_blank', 'noopener,noreferrer')}
                        t={t}
                      />
                    ))}
                  </div>
                )}
              </section>
            ) : null}
          </div>

          <div className="min-w-0 space-y-4">
            <Card className="rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--bg-1)] p-4 shadow-[var(--shadow-sm)]">
              <div className="text-[13px] font-semibold text-[var(--fg-0)]">{t('dashboard.topTags')}</div>
              <div className="mt-0.5 text-[11.5px] text-[var(--fg-2)]">{t('tags.pageSubtitle')}</div>
              <div className="mt-4 space-y-2">
                {topTags.length === 0 ? (
                  <p className="text-[12.5px] text-[var(--fg-3)]">—</p>
                ) : (
                  topTags.slice(0, 10).map((tg, i) => {
                    const pct = maxTopCount > 0 ? Math.round((tg.bookmark_count / maxTopCount) * 100) : 0;
                    return (
                      <div key={tg.id}>
                        <div className="mb-1 flex items-center gap-1.5 text-[12px] text-[var(--fg-1)]">
                          <span className="dot h-1.5 w-1.5 rounded-full" style={{ background: DIST_COLORS[i % DIST_COLORS.length] }} />
                          <span className="min-w-0 flex-1 truncate">{tg.name}</span>
                          <span className="font-mono text-[11px] text-[var(--fg-3)]">{tg.bookmark_count}</span>
                        </div>
                        <div className="h-1 overflow-hidden rounded-full bg-[var(--bg-3)]">
                          <div
                            className="h-full rounded-full opacity-80"
                            style={{
                              width: `${pct}%`,
                              background: DIST_COLORS[i % DIST_COLORS.length],
                            }}
                          />
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </Card>
          </div>
        </div>
      )}

      {totalTags > 0 && sortedTags.length > 0 && (
        <div className="mt-6 flex flex-wrap items-center justify-between gap-4 rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--bg-1)] px-4 py-3">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-1">
            <span className="typography-label font-mono text-[11px] text-[var(--fg-2)]">
              {t('bookmarks.paginationTotalEntries', { count: totalTags })}
            </span>
          </div>
          {totalTags > pageSize ? (
            <div className="flex flex-wrap items-center gap-3">
              <span className="typography-label font-mono text-[11px] text-[var(--fg-2)]">
                {t('bookmarks.paginationPageOf', {
                  current: page + 1,
                  totalPages: Math.max(1, Math.ceil(totalTags / pageSize)),
                })}
              </span>
              <div className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  icon={ChevronLeft}
                  className="h-9 w-9 border border-[var(--border)] bg-[var(--bg-2)] p-0"
                  onClick={() => updateParams({ page: String(Math.max(0, page - 1)) })}
                  disabled={page === 0}
                  aria-label={t('bookmarks.paginationPrevious')}
                />
                <Button
                  variant="ghost"
                  size="sm"
                  icon={ChevronRight}
                  className="h-9 w-9 border border-[var(--border)] bg-[var(--bg-2)] p-0"
                  onClick={() => updateParams({ page: String(page + 1) })}
                  disabled={(page + 1) * pageSize >= totalTags}
                  aria-label={t('bookmarks.paginationNext')}
                />
              </div>
            </div>
          ) : null}
        </div>
      )}

      <TagModal tag={editingTag} isOpen={modalOpen} onClose={handleModalClose} onSuccess={loadTags} />

      <ConfirmDialog {...dialogState} />
    </div>
  );
}
