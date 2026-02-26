import { useState, useEffect, useMemo } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import api from '../api/client';
import ConfirmDialog from '../components/ui/ConfirmDialog';
import { useConfirmDialog } from '../hooks/useConfirmDialog';
import { Plus, Edit, Trash2, Tag as TagIcon, LayoutGrid, List, ChevronLeft, ChevronRight } from 'lucide-react';
import TagModal from '../components/modals/TagModal';
import Button from '../components/ui/Button';
import Select from '../components/ui/Select';
import { PageHeader } from '../components/PageHeader';
import { EmptyState } from '../components/EmptyState';
import { PageLoadingSkeleton } from '../components/ui/PageLoadingSkeleton';
import { useAppConfig } from '../contexts/AppConfigContext';
import { FilterChips } from '../components/FilterChips';

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
  const [compactMode, setCompactMode] = useState(() => {
    return localStorage.getItem('tags-compact-mode') === 'true';
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
    localStorage.setItem('tags-compact-mode', compactMode.toString());
  }, [compactMode]);

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
      {/* Sticky controls bar: header + toolbar - stays visible when scrolling */}
      <div className="sticky top-0 z-40 space-y-4 pb-4 -mx-4 sm:-mx-6 lg:-mx-8 px-4 sm:px-6 lg:px-8 pt-0 -mt-8 bg-background shadow-sm">
        <PageHeader
          className="pt-4"
          title={`${t('tags.title')} (${totalTags})`}
          subtitle={
            hasActiveFilters || totalTags > pageSize
              ? t('bookmarks.showingXOfY', { x: sortedTags.length, y: totalTags })
              : undefined
          }
          actions={
            <Button onClick={handleCreate} icon={Plus}>
              {t('tags.create')}
            </Button>
          }
        />

        <FilterChips
          chips={filterChips}
          onRemove={handleRemoveFilter}
          onClearAll={handleResetFilters}
          clearAllLabel={t('bookmarks.clearAllFilters')}
          clearAllAriaLabel={t('bookmarks.clearAllFilters')}
        />

        {/* Toolbar: Sort, Page size, View Modes - same card style as Bookmarks/Folders */}
        <div className="flex flex-wrap items-center gap-3 bg-card rounded-lg border border-border p-4 shadow-sm">
          <div className="flex items-center gap-2">
            <Select
              value={sortBy}
              onChange={(value) => updateParams({ sort: value as SortOption })}
              options={sortOptions}
              className="min-w-[160px]"
            />
          </div>
          <div className="flex items-center gap-2">
            <Select
              value={String(pageSize)}
              onChange={(value) => updateParams({ limit: value })}
              options={PAGE_SIZE_OPTIONS.map((n) => ({ value: String(n), label: String(n) }))}
              className="min-w-[80px]"
            />
            <span className="text-sm text-muted-foreground whitespace-nowrap">{t('bookmarks.perPage')}</span>
          </div>
          <div className="flex items-center gap-2 border-l border-border pl-3 ml-auto">
            <div className="flex items-center gap-1 bg-muted/50 rounded-lg p-1 border border-border">
              <button
                onClick={() => setViewMode('card')}
                className={`p-1.5 rounded transition-colors ${
                  viewMode === 'card' ? 'bg-background text-primary shadow-sm' : 'text-muted-foreground hover:text-foreground'
                }`}
                title={t('tags.viewCard')}
              >
                <LayoutGrid className="h-4 w-4" />
              </button>
              <button
                onClick={() => setViewMode('list')}
                className={`p-1.5 rounded transition-colors ${
                  viewMode === 'list' ? 'bg-background text-primary shadow-sm' : 'text-muted-foreground hover:text-foreground'
                }`}
                title={t('tags.viewList')}
              >
                <List className="h-4 w-4" />
              </button>
            </div>
            <button
              onClick={() => setCompactMode(!compactMode)}
              className={`px-3 py-1.5 text-sm rounded-lg transition-colors ${
                compactMode ? 'bg-primary/20 text-primary' : 'bg-muted text-muted-foreground hover:bg-accent'
              }`}
              title={t('tags.compactMode')}
            >
              {t('tags.compactMode')}
            </button>
          </div>
        </div>
      </div>

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
        <div className={`grid grid-cols-1 gap-3 items-stretch ${
          compactMode 
            ? 'sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-8' 
            : 'sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6'
        }`}>
          {sortedTags.map((tag) => (
            <div
              key={tag.id}
              className={`group bg-card rounded-lg border border-border hover:border-primary/70 hover:bg-muted/50 hover:shadow-md transition-all duration-200 flex flex-col h-full min-h-0 ${compactMode ? 'p-2.5 min-h-[160px]' : 'p-2.5 min-h-[140px]'}`}
            >
              <Link
                to={`${prefix}/bookmarks?tag_id=${tag.id}`}
                className="flex-1 flex flex-col min-w-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded"
              >
                <div className="space-y-3 flex-1 flex flex-col">
                  <div className="flex items-start gap-3">
                    <div className={`flex-shrink-0 ${compactMode ? 'w-9 h-9' : 'w-10 h-10'} rounded-xl bg-gradient-to-br from-purple-50 to-purple-100 dark:from-purple-900/30 dark:to-purple-800/20 flex items-center justify-center border border-purple-100 dark:border-purple-800/50`}>
                      <TagIcon className={`${compactMode ? 'h-4 w-4' : 'h-5 w-5'} text-purple-600 dark:text-purple-400`} />
                    </div>
                    <div className="flex-1 min-w-0 pt-0.5">
                      <h3 className={`${compactMode ? 'text-xs' : 'text-sm'} font-medium text-foreground truncate`}>
                        {tag.name}
                      </h3>
                    </div>
                  </div>
                  {/* TODO: Add bookmark_count when backend supports it */}
                  <p className="text-xs text-muted-foreground">—</p>
                </div>
              </Link>
              <div className={`flex gap-1.5 pt-2.5 mt-auto shrink-0 border-t border-border ${compactMode ? 'pt-2' : ''}`}>
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={Edit}
                    iconClassName="h-3.5 w-3.5 stroke-[1.5]"
                    onClick={() => handleEdit(tag)}
                    className="flex-1 h-8 min-w-0 text-xs"
                  >
                    {t('common.edit')}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={Trash2}
                    iconClassName="h-3.5 w-3.5 stroke-[1.5]"
                    onClick={() => handleDelete(tag.id)}
                    title={t('common.delete')}
                    className="h-8 w-8 p-0 flex-shrink-0 text-red-600 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300"
                  />
                </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="overflow-x-auto bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700">
          <table className="w-full">
            <thead className="bg-gray-50 dark:bg-gray-900/50 border-b border-gray-200 dark:border-gray-700">
              <tr>
                <th className={`${compactMode ? 'px-2 py-1.5' : 'px-4 py-3'} text-left ${compactMode ? 'text-[10px]' : 'text-xs'} font-semibold text-gray-700 dark:text-gray-300 uppercase tracking-wide`}>
                  {t('tags.name')}
                </th>
                <th className={`${compactMode ? 'px-2 py-1.5' : 'px-4 py-3'} text-right ${compactMode ? 'text-[10px]' : 'text-xs'} font-semibold text-gray-700 dark:text-gray-300 uppercase tracking-wide`}>
                  {t('common.actions')}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
              {sortedTags.map((tag) => (
                <tr
                  key={tag.id}
                  className={`hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors ${compactMode ? 'h-10' : ''}`}
                >
                  <td className={`${compactMode ? 'px-2 py-1.5' : 'px-4 py-3'}`}>
                    <Link
                      to={`${prefix}/bookmarks?tag_id=${tag.id}`}
                      className={`flex items-center ${compactMode ? 'gap-2' : 'gap-3'} hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded`}
                    >
                      <div className={`flex-shrink-0 ${compactMode ? 'w-6 h-6' : 'w-8 h-8'} rounded-lg bg-gradient-to-br from-purple-50 to-purple-100 dark:from-purple-900/30 dark:to-purple-800/20 flex items-center justify-center border border-purple-100 dark:border-purple-800/50`}>
                        <TagIcon className={`${compactMode ? 'h-3 w-3' : 'h-4 w-4'} text-purple-600 dark:text-purple-400`} />
                      </div>
                      <div className={`font-medium text-gray-900 dark:text-white ${compactMode ? 'text-xs' : 'text-[15px]'}`}>
                        {tag.name}
                      </div>
                    </Link>
                  </td>
                  {!compactMode && (
                    <td className="px-4 py-3 text-xs text-muted-foreground">—</td>
                  )}
                  <td className={`${compactMode ? 'px-2 py-1.5' : 'px-4 py-3'}`}>
                    <div className={`flex items-center justify-end ${compactMode ? 'gap-1' : 'gap-2'}`}>
                      <Button
                        variant="ghost"
                        size="sm"
                        icon={Edit}
                        onClick={() => handleEdit(tag)}
                        className={compactMode ? 'px-1 h-6' : 'px-2'}
                      />
                      <Button
                        variant="ghost"
                        size="sm"
                        icon={Trash2}
                        onClick={() => handleDelete(tag.id)}
                        title={t('common.delete')}
                        className={`text-red-600 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300 ${compactMode ? 'px-1 h-6' : 'px-2'}`}
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
