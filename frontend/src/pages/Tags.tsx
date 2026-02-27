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

interface Tag {
  id: string;
  name: string;
  created_at?: string;
}

type ViewMode = 'card' | 'list';
type SortOption = 'alphabetical' | 'recently_added';

const DEFAULT_SORT: SortOption = 'alphabetical';

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
  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    const saved = localStorage.getItem('tags-view-mode');
    return (saved === 'list' || saved === 'card') ? saved : 'card';
  });

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
    localStorage.setItem('tags-view-mode', viewMode);
  }, [viewMode]);

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

  const sortedTags = useMemo(() => {
    // Backend already sorts, but we can do client-side sorting if needed
    return [...tags];
  }, [tags]);

  function handleCreate() {
    setEditingTag(null);
    setModalOpen(true);
  }

  function handleEdit(tag: Tag) {
    setEditingTag(tag);
    setModalOpen(true);
  }

  function handleDelete(id: string) {
    const tag = tags.find(t => t.id === id);
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
        viewMode={{
          value: viewMode,
          onChange: setViewMode,
          cardLabel: t('tags.viewCard'),
          listLabel: t('tags.viewList'),
        }}
      />

      {/* Tags Display */}
      {sortedTags.length === 0 ? (
        <EmptyState
          icon={TagIcon}
          title={t('tags.empty')}
          description={t('tags.emptyDescription')}
          action={
            <Button onClick={handleCreate} variant="primary" icon={Plus}>
              {t('tags.create')}
            </Button>
          }
        />
      ) : viewMode === 'card' ? (
        <div className="grid gap-3 items-start [grid-template-columns:repeat(auto-fill,minmax(300px,1fr))]">
          {sortedTags.map((tag) => (
            <Card
              key={tag.id}
              className="group relative flex flex-col cursor-pointer rounded-lg border bg-card/95 dark:bg-card/90 transition-[border-color,box-shadow] duration-150 border-border/80 hover:border-primary/80 hover:shadow-[0_2px_6px_rgba(0,0,0,0.06)] dark:border-border/70 dark:hover:border-primary/80 dark:hover:shadow-[0_2px_6px_rgba(0,0,0,0.25)] px-3 pt-0 pb-1.5 focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2"
            >
              <Link
                to={`${prefix}/bookmarks?tag_id=${tag.id}`}
                className="absolute inset-0 rounded-lg z-0 focus:outline-none"
                aria-label={tag.name}
              />
              <header className="flex-shrink-0 flex items-center gap-1.5 min-w-0 pt-3 relative z-10">
                <div className="flex-shrink-0 w-7 h-7 rounded-md bg-background/90 dark:bg-muted/20 flex items-center justify-center border border-border/50 overflow-hidden">
                  <TagIcon className="h-4 w-4 text-purple-600 dark:text-purple-400" />
                </div>
                <div className="flex-1 min-w-0 min-h-0 overflow-hidden">
                  <h3 className="text-sm font-semibold text-foreground line-clamp-2 break-words leading-snug tracking-tight min-h-0">
                    {tag.name}
                  </h3>
                </div>
              </header>
              <footer className="flex-shrink-0 flex items-center justify-end gap-0.5 h-6 min-h-[24px] pt-2.5 relative z-10 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity duration-150 w-[52px] ml-auto">
                <Button
                  variant="ghost"
                  size="sm"
                  icon={Edit}
                  iconClassName="h-3.5 w-3.5 stroke-[1.5]"
                  onClick={(e) => { e.preventDefault(); e.stopPropagation(); handleEdit(tag); }}
                  className="h-6 w-6 p-0 min-w-6 text-muted-foreground hover:text-foreground"
                  title={t('common.edit')}
                />
                <Button
                  variant="ghost"
                  size="sm"
                  icon={Trash2}
                  iconClassName="h-3.5 w-3.5 stroke-[1.5]"
                  onClick={(e) => { e.preventDefault(); e.stopPropagation(); handleDelete(tag.id); }}
                  className="h-6 w-6 p-0 min-w-6 text-red-600 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300"
                  title={t('common.delete')}
                />
              </footer>
            </Card>
          ))}
        </div>
      ) : (
        <div className="overflow-x-auto bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700">
          <table className="w-full">
            <thead className="bg-gray-50 dark:bg-gray-900/50 border-b border-gray-200 dark:border-gray-700">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700 dark:text-gray-300 uppercase tracking-wide">
                  {t('tags.name')}
                </th>
                <th className="px-4 py-3 text-right text-xs font-semibold text-gray-700 dark:text-gray-300 uppercase tracking-wide">
                  {t('common.actions')}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
              {sortedTags.map((tag) => (
                <tr
                  key={tag.id}
                  className="hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors"
                >
                  <td className="px-4 py-3">
                    <Link
                      to={`${prefix}/bookmarks?tag_id=${tag.id}`}
                      className="flex items-center gap-3 hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded"
                    >
                      <div className="flex-shrink-0 w-8 h-8 rounded-lg bg-gradient-to-br from-purple-50 to-purple-100 dark:from-purple-900/30 dark:to-purple-800/20 flex items-center justify-center border border-purple-100 dark:border-purple-800/50">
                        <TagIcon className="h-4 w-4 text-purple-600 dark:text-purple-400" />
                      </div>
                      <div className="font-medium text-gray-900 dark:text-white text-[15px]">
                        {tag.name}
                      </div>
                    </Link>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-2">
                      <Button
                        variant="ghost"
                        size="sm"
                        icon={Edit}
                        onClick={() => handleEdit(tag)}
                        className="px-2"
                      />
                      <Button
                        variant="ghost"
                        size="sm"
                        icon={Trash2}
                        onClick={() => handleDelete(tag.id)}
                        title={t('common.delete')}
                        className="text-red-600 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300 px-2"
                      />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {totalTags > pageSize && (
        <div className="flex flex-wrap items-center justify-between gap-3 mt-4">
          <p className="text-sm text-muted-foreground">
            {t('bookmarks.paginationShowing', {
              from: page * pageSize + 1,
              to: Math.min(page * pageSize + sortedTags.length, totalTags),
              total: totalTags,
            })}
          </p>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              icon={ChevronLeft}
              onClick={() => updateParams({ page: String(Math.max(0, page - 1)) })}
              disabled={page === 0}
            >
              {t('bookmarks.paginationPrevious')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              icon={ChevronRight}
              iconPosition="right"
              onClick={() => updateParams({ page: String(page + 1) })}
              disabled={(page + 1) * pageSize >= totalTags}
            >
              {t('bookmarks.paginationNext')}
            </Button>
          </div>
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
