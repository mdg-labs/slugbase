import { useState, useEffect, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import api from '../api/client';
import ConfirmDialog from '../components/ui/ConfirmDialog';
import { useConfirmDialog } from '../hooks/useConfirmDialog';
import { Plus, Edit, Trash2, Tag as TagIcon, LayoutGrid, List } from 'lucide-react';
import TagModal from '../components/modals/TagModal';
import Button from '../components/ui/Button';
import Select from '../components/ui/Select';
import { PageHeader } from '../components/PageHeader';
import { EmptyState } from '../components/EmptyState';
import { PageLoadingSkeleton } from '../components/ui/PageLoadingSkeleton';
import { appBasePath } from '../config/api';

interface Tag {
  id: string;
  name: string;
  created_at?: string;
}

type ViewMode = 'card' | 'list';
type SortOption = 'alphabetical' | 'recently_added';

export default function Tags() {
  const { t } = useTranslation();
  const { showConfirm, dialogState } = useConfirmDialog();
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
  const [sortBy, setSortBy] = useState<SortOption>('alphabetical');

  useEffect(() => {
    localStorage.setItem('tags-view-mode', viewMode);
  }, [viewMode]);

  useEffect(() => {
    localStorage.setItem('tags-compact-mode', compactMode.toString());
  }, [compactMode]);

  useEffect(() => {
    loadTags();
  }, [sortBy]);

  async function loadTags() {
    try {
      const res = await api.get('/tags', { params: { sort_by: sortBy } });
      setTags(res.data);
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
      <div className="sticky top-0 z-40 space-y-4 pb-4 -mx-4 sm:-mx-6 lg:-mx-8 px-4 sm:px-6 lg:px-8 pt-0 -mt-8 bg-background border-b shadow-sm">
        <PageHeader
          className="pt-4"
          title={t('tags.title')}
          subtitle={`${tags.length} ${tags.length === 1 ? t('common.tag') : t('common.tags')}`}
          actions={
            <Button onClick={handleCreate} icon={Plus}>
              {t('tags.create')}
            </Button>
          }
        />

        {/* Toolbar: Sort, View Modes */}
        {sortedTags.length > 0 && (
        <div className="flex flex-wrap items-center gap-3 bg-card rounded-lg border p-4 shadow-sm">
          {/* Sort */}
          <div className="flex items-center gap-2">
            <Select
              value={sortBy}
              onChange={(value) => setSortBy(value as SortOption)}
              options={sortOptions}
              className="min-w-[160px]"
            />
          </div>

          {/* View Mode Toggle */}
          <div className="flex items-center gap-2 border-l border-gray-200 dark:border-gray-700 pl-3 ml-auto">
            <div className="flex items-center gap-1 bg-gray-100 dark:bg-gray-700 rounded-lg p-1">
              <button
                onClick={() => setViewMode('card')}
                className={`p-1.5 rounded transition-colors ${
                  viewMode === 'card'
                    ? 'bg-white dark:bg-gray-600 text-blue-600 dark:text-blue-400 shadow-sm'
                    : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'
                }`}
                title={t('tags.viewCard')}
              >
                <LayoutGrid className="h-4 w-4" />
              </button>
              <button
                onClick={() => setViewMode('list')}
                className={`p-1.5 rounded transition-colors ${
                  viewMode === 'list'
                    ? 'bg-white dark:bg-gray-600 text-blue-600 dark:text-blue-400 shadow-sm'
                    : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'
                }`}
                title={t('tags.viewList')}
              >
                <List className="h-4 w-4" />
              </button>
            </div>
            <button
              onClick={() => setCompactMode(!compactMode)}
              className={`px-3 py-1.5 text-sm rounded-lg transition-colors ${
                compactMode
                  ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300'
                  : 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-600'
              }`}
              title={t('tags.compactMode')}
            >
              {t('tags.compactMode')}
            </button>
          </div>
        </div>
        )}
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
        <div className={`grid grid-cols-1 gap-4 ${
          compactMode 
            ? 'sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6' 
            : 'sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5'
        }`}>
          {sortedTags.map((tag) => (
            <div
              key={tag.id}
              className={`group bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 hover:border-purple-400 dark:hover:border-purple-500 hover:shadow-lg transition-all duration-200 flex flex-col ${compactMode ? 'p-2.5' : 'p-4'}`}
            >
              <Link
                to={`${appBasePath}/bookmarks?tag_id=${tag.id}`}
                className="flex-1 flex flex-col min-w-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded"
              >
                <div className="space-y-3 flex-1 flex flex-col">
                  <div className="flex items-start gap-3">
                    <div className={`flex-shrink-0 ${compactMode ? 'w-10 h-10' : 'w-12 h-12'} rounded-xl bg-gradient-to-br from-purple-50 to-purple-100 dark:from-purple-900/30 dark:to-purple-800/20 flex items-center justify-center border border-purple-100 dark:border-purple-800/50`}>
                      <TagIcon className={`${compactMode ? 'h-5 w-5' : 'h-6 w-6'} text-purple-600 dark:text-purple-400`} />
                    </div>
                    <div className="flex-1 min-w-0 pt-0.5">
                      <h3 className={`${compactMode ? 'text-xs' : 'text-[15px]'} font-medium text-gray-900 dark:text-white truncate`}>
                        {tag.name}
                      </h3>
                    </div>
                  </div>
                  {/* TODO: Add bookmark_count when backend supports it */}
                  <p className="text-xs text-muted-foreground">—</p>
                </div>
              </Link>
              <div className={`flex gap-2 pt-3 mt-auto border-t border-gray-100 dark:border-gray-700/50 ${compactMode ? 'pt-2' : ''}`}>
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={Edit}
                    onClick={() => handleEdit(tag)}
                    className={`flex-1 ${compactMode ? 'text-xs px-2 py-1' : 'text-xs'}`}
                  >
                    {t('common.edit')}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={Trash2}
                    onClick={() => handleDelete(tag.id)}
                    title={t('common.delete')}
                    className={`text-red-600 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300 ${compactMode ? 'px-1.5' : 'px-2'}`}
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
                      to={`${appBasePath}/bookmarks?tag_id=${tag.id}`}
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
