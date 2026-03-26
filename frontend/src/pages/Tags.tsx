import { useState, useEffect, useMemo } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import api from '../api/client';
import ConfirmDialog from '../components/ui/ConfirmDialog';
import { useConfirmDialog } from '../hooks/useConfirmDialog';
import { Plus, Edit, Trash2, Tag as TagIcon, ChevronLeft, ChevronRight } from 'lucide-react';
import TagModal from '../components/modals/TagModal';
import Button from '../components/ui/Button';
import { CollectionToolbar } from '../components/collections';
import { EmptyState } from '../components/EmptyState';
import { PageLoadingSkeleton } from '../components/ui/PageLoadingSkeleton';
import { useAppConfig } from '../contexts/AppConfigContext';
import { Card } from '../components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../components/ui/table';

interface Tag {
  id: string;
  name: string;
  created_at?: string;
}

type SortOption = 'alphabetical' | 'recently_added';

const DEFAULT_SORT: SortOption = 'alphabetical';

const cellClass = 'px-4 py-3';

function formatShortDate(iso?: string) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return '—';
  }
}

export default function Tags() {
  const { t } = useTranslation();
  const { pathPrefixForLinks } = useAppConfig();
  const prefix = (pathPrefixForLinks || '').replace(/\/+/g, '/') || '';
  const { showConfirm, dialogState } = useConfirmDialog();
  const [searchParams, setSearchParams] = useSearchParams();
  const [tags, setTags] = useState<Tag[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingTag, setEditingTag] = useState<Tag | null>(null);
  const sortParam = searchParams.get('sort');
  const sortBy = (sortParam === 'recently_added' || sortParam === 'alphabetical') ? sortParam : DEFAULT_SORT;
  const PAGE_SIZE_OPTIONS = [50, 100, 200, 500] as const;
  const limitParam = searchParams.get('limit');
  const pageSize = (limitParam && PAGE_SIZE_OPTIONS.includes(Number(limitParam) as typeof PAGE_SIZE_OPTIONS[number]))
    ? Number(limitParam)
    : 50;
  const page = Math.max(0, parseInt(searchParams.get('page') || '0', 10));
  const [totalTags, setTotalTags] = useState(0);

  useEffect(() => {
    loadTags();
  }, [sortBy, page, pageSize]);

  function updateParams(updates: { sort?: string; limit?: string; page?: string }) {
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

  function handleCreate() {
    setEditingTag(null);
    setModalOpen(true);
  }

  function handleEdit(tag: Tag) {
    setEditingTag(tag);
    setModalOpen(true);
  }

  function handleDelete(id: string) {
    const tag = tags.find(tg => tg.id === id);
    const tagName = tag?.name || 'this tag';
    showConfirm(
      t('tags.deleteTag'),
      t('tags.deleteConfirmWithName', { name: tagName }),
      async () => {
        try {
          await api.delete(`/tags/${id}`);
          loadTags();
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
            : undefined
        }
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
        <Card className="overflow-hidden border-ghost bg-surface">
          <Table>
            <TableHeader>
              <TableRow className="border-0 hover:bg-transparent">
                <TableHead className={cellClass}>{t('tags.name')}</TableHead>
                <TableHead className={cellClass}>{t('profile.createdAt')}</TableHead>
                <TableHead className={`${cellClass} text-right w-[88px]`}>{t('common.actions')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sortedTags.map((tag) => (
                <TableRow key={tag.id} className="border-0">
                  <TableCell className={cellClass}>
                    <Link
                      to={`${prefix}/bookmarks?tag_id=${tag.id}`}
                      className="flex items-center gap-3 rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                    >
                      <div className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-primary/25 bg-gradient-to-br from-primary/15 to-accent/20">
                        <TagIcon className="h-4 w-4 text-primary" />
                      </div>
                      <span className="text-sm font-semibold text-foreground">{tag.name}</span>
                    </Link>
                  </TableCell>
                  <TableCell className={cellClass}>
                    <span className="text-sm text-muted-foreground">{formatShortDate(tag.created_at)}</span>
                  </TableCell>
                  <TableCell className={`${cellClass} text-right`}>
                    <div className="flex items-center justify-end gap-0.5">
                      <Button
                        variant="ghost"
                        size="sm"
                        icon={Edit}
                        iconClassName="h-3.5 w-3.5 stroke-[1.5]"
                        onClick={() => handleEdit(tag)}
                        className="h-8 w-8 p-0 min-w-8 text-muted-foreground hover:text-foreground"
                        title={t('common.edit')}
                      />
                      <Button
                        variant="ghost"
                        size="sm"
                        icon={Trash2}
                        iconClassName="h-3.5 w-3.5 stroke-[1.5]"
                        onClick={() => handleDelete(tag.id)}
                        className="h-8 w-8 p-0 min-w-8 text-destructive hover:text-destructive"
                        title={t('common.delete')}
                      />
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}

      {totalTags > 0 && sortedTags.length > 0 && (
        <div className="mt-6 flex flex-wrap items-center justify-between gap-4 rounded-xl border border-ghost bg-surface-low px-4 py-3">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-1">
            <span className="typography-label">{t('bookmarks.paginationTotalEntries', { count: totalTags })}</span>
          </div>
          {totalTags > pageSize ? (
            <div className="flex flex-wrap items-center gap-3">
              <span className="typography-label">
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
                  className="h-9 w-9 border border-ghost bg-surface p-0"
                  onClick={() => updateParams({ page: String(Math.max(0, page - 1)) })}
                  disabled={page === 0}
                  aria-label={t('bookmarks.paginationPrevious')}
                />
                <Button
                  variant="ghost"
                  size="sm"
                  icon={ChevronRight}
                  className="h-9 w-9 border border-ghost bg-surface p-0"
                  onClick={() => updateParams({ page: String(page + 1) })}
                  disabled={(page + 1) * pageSize >= totalTags}
                  aria-label={t('bookmarks.paginationNext')}
                />
              </div>
            </div>
          ) : null}
        </div>
      )}

      <TagModal
        tag={editingTag}
        isOpen={modalOpen}
        onClose={handleModalClose}
        onSuccess={loadTags}
      />

      <ConfirmDialog {...dialogState} />
    </div>
  );
}
