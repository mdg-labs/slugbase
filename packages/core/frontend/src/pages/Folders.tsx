import { useState, useEffect, useMemo } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import api from '../api/client';
import ConfirmDialog from '../components/ui/ConfirmDialog';
import { useConfirmDialog } from '../hooks/useConfirmDialog';
import { Plus, Edit, Trash2, Share2, LayoutGrid, List, Folder, ChevronLeft, ChevronRight } from 'lucide-react';
import FolderModal from '../components/modals/FolderModal';
import ShareResourceDialog from '../components/sharing/ShareResourceDialog';
import Button from '../components/ui/Button';
import Select from '../components/ui/Select';
import Tooltip from '../components/ui/Tooltip';
import FolderIcon from '../components/FolderIcon';
import { PageHeader } from '../components/PageHeader';
import { EmptyState } from '../components/EmptyState';
import { PageLoadingSkeleton } from '../components/ui/PageLoadingSkeleton';
import { useAppConfig } from '../contexts/AppConfigContext';
import { ScopeSegmentedControl } from '../components/ScopeSegmentedControl';
import { FilterChips } from '../components/FilterChips';

interface Folder {
  id: string;
  name: string;
  icon?: string | null;
  shared_teams?: Array<{ id: string; name: string }>;
  shared_users?: Array<{ id: string; name: string; email: string }>;
  folder_type?: 'own' | 'shared';
  created_at?: string;
}

type ViewMode = 'card' | 'list';
type SortOption = 'alphabetical' | 'recently_added';

const DEFAULT_SORT: SortOption = 'alphabetical';

export default function Folders() {
  const { t } = useTranslation();
  const { pathPrefixForLinks } = useAppConfig();
  const prefix = (pathPrefixForLinks || '').replace(/\/+/g, '/') || '';
  const { showConfirm, dialogState } = useConfirmDialog();
  const [searchParams, setSearchParams] = useSearchParams();
  const [folders, setFolders] = useState<Folder[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingFolder, setEditingFolder] = useState<Folder | null>(null);
  const [shareDialogOpen, setShareDialogOpen] = useState(false);
  const [sharingFolder, setSharingFolder] = useState<Folder | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    const saved = localStorage.getItem('folders-view-mode');
    return (saved === 'list' || saved === 'card') ? saved : 'card';
  });
  const [compactMode, setCompactMode] = useState(() => {
    return localStorage.getItem('folders-compact-mode') === 'true';
  });

  const scopeParam = searchParams.get('scope');
  const scope = (scopeParam === 'mine' || scopeParam === 'shared_with_me' || scopeParam === 'shared_by_me')
    ? scopeParam
    : 'all';
  const sortParam = searchParams.get('sort');
  const sortBy = (sortParam === 'recently_added' || sortParam === 'alphabetical') ? sortParam : DEFAULT_SORT;
  const PAGE_SIZE_OPTIONS = [50, 100, 200, 500] as const;
  const limitParam = searchParams.get('limit');
  const pageSize = (limitParam && PAGE_SIZE_OPTIONS.includes(Number(limitParam) as typeof PAGE_SIZE_OPTIONS[number]))
    ? Number(limitParam)
    : 50;
  const page = Math.max(0, parseInt(searchParams.get('page') || '0', 10));
  const [totalFolders, setTotalFolders] = useState(0);

  useEffect(() => {
    localStorage.setItem('folders-view-mode', viewMode);
  }, [viewMode]);

  useEffect(() => {
    localStorage.setItem('folders-compact-mode', compactMode.toString());
  }, [compactMode]);

  useEffect(() => {
    loadData();
  }, [sortBy, scope, page, pageSize]);

  async function loadData() {
    try {
      const foldersRes = await api.get('/folders', {
        params: {
          sort_by: sortBy,
          scope: scope !== 'all' ? scope : undefined,
          limit: pageSize,
          offset: page * pageSize,
        },
      });
      const data = foldersRes.data;
      if (data && typeof data === 'object' && 'items' in data && 'total' in data) {
        setFolders(Array.isArray((data as { items: Folder[] }).items) ? (data as { items: Folder[] }).items : []);
        setTotalFolders(Number((data as { total: number }).total) || 0);
      } else {
        setFolders(Array.isArray(data) ? data : []);
        setTotalFolders(Array.isArray(data) ? data.length : 0);
      }
    } catch (error) {
      console.error('Failed to load data:', error);
    } finally {
      setLoading(false);
    }
  }

  function updateParams(updates: { scope?: string; sort?: string; limit?: string; page?: string }) {
    const params = new URLSearchParams(searchParams);
    if (updates.scope !== undefined) {
      if (updates.scope === 'all' || updates.scope === '') params.delete('scope');
      else params.set('scope', updates.scope);
    }
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

  const hasActiveFilters = scope !== 'all' || sortBy !== DEFAULT_SORT;

  function handleRemoveFilter(key: string) {
    if (key === 'scope') updateParams({ scope: 'all' });
    else if (key === 'sort') updateParams({ sort: DEFAULT_SORT });
  }

  function handleResetFilters() {
    updateParams({ scope: 'all', sort: DEFAULT_SORT });
  }

  const sortOptions = [
    { value: 'alphabetical' as const, label: t('folders.sortAlphabetical') },
    { value: 'recently_added' as const, label: t('folders.sortRecentlyAdded') },
  ];

  const filterChips = useMemo(() => {
    const list: { key: string; label: string; ariaLabel: string }[] = [];
    if (scope !== 'all') {
      const scopeLabel = scope === 'mine' ? t('bookmarks.scopeMine') : scope === 'shared_with_me' ? t('common.scopeSharedWithMe') : t('common.scopeSharedByMe');
      list.push({ key: 'scope', label: scopeLabel, ariaLabel: t('folders.clearFilters') + ' ' + scopeLabel });
    }
    if (sortBy !== DEFAULT_SORT) {
      const sortLabel = sortBy === 'recently_added' ? t('folders.sortRecentlyAdded') : t('folders.sortAlphabetical');
      list.push({ key: 'sort', label: `Sort: ${sortLabel}`, ariaLabel: t('folders.clearFilters') + ' Sort' });
    }
    return list;
  }, [scope, sortBy, t]);

  const sortedFolders = useMemo(() => [...folders], [folders]);

  function handleCreate() {
    setEditingFolder(null);
    setModalOpen(true);
  }

  function handleEdit(folder: Folder) {
    setEditingFolder(folder);
    setModalOpen(true);
  }

  function handleDelete(id: string) {
    const folder = folders.find(f => f.id === id);
    const folderName = folder?.name || 'this folder';
    showConfirm(
      t('folders.deleteFolder'),
      t('folders.deleteConfirmWithName', { name: folderName }),
      async () => {
        try {
          await api.delete(`/folders/${id}`);
          loadData();
        } catch (error) {
          console.error('Failed to delete folder:', error);
        }
      },
      { variant: 'danger', confirmText: t('common.delete'), cancelText: t('common.cancel') }
    );
  }

  function handleModalClose() {
    setModalOpen(false);
    setEditingFolder(null);
  }

  if (loading) {
    return <PageLoadingSkeleton lines={6} />;
  }

  return (
    <div className="space-y-6 pb-24">
      {/* Sticky controls bar: header + toolbar - stays visible when scrolling */}
      <div className="sticky top-0 z-40 space-y-4 pb-4 -mx-4 sm:-mx-6 lg:-mx-8 px-4 sm:px-6 lg:px-8 pt-0 -mt-8 bg-background border-b shadow-sm">
        <PageHeader
          className="pt-4"
          title={`${t('folders.title')} (${totalFolders})`}
          subtitle={
            hasActiveFilters || totalFolders > pageSize
              ? t('bookmarks.showingXOfY', { x: sortedFolders.length, y: totalFolders })
              : undefined
          }
          actions={
            <div className="flex flex-wrap items-center gap-2">
              <ScopeSegmentedControl
                value={scope}
                onChange={(s) => updateParams({ scope: s === 'all' ? undefined : s })}
                options={[
                  { value: 'all', label: t('bookmarks.scopeAll') },
                  { value: 'mine', label: t('bookmarks.scopeMine') },
                  { value: 'shared_with_me', label: t('common.scopeSharedWithMe') },
                  { value: 'shared_by_me', label: t('common.scopeSharedByMe') },
                ]}
                ariaLabel={t('bookmarks.scopeAll')}
              />
              <Button onClick={handleCreate} icon={Plus}>
                {t('folders.create')}
              </Button>
            </div>
          }
        />

        <FilterChips
          chips={filterChips}
          onRemove={handleRemoveFilter}
          onClearAll={handleResetFilters}
          clearAllLabel={t('bookmarks.clearAllFilters')}
          clearAllAriaLabel={t('bookmarks.clearAllFilters')}
        />

        {/* Toolbar: Sort, Page size, View Modes */}
        <div className="flex flex-wrap items-center gap-3 bg-card rounded-lg border p-4 shadow-sm">
          {/* Sort */}
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
          {/* View Mode Toggle */}
          <div className="flex items-center gap-2 border-l border-gray-200 dark:border-gray-700 pl-3 ml-auto">
            <div className="flex items-center gap-1 bg-gray-100 dark:bg-gray-700 rounded-lg p-1">
              <button
                onClick={() => setViewMode('card')}
                className={`p-1.5 rounded transition-colors ${
                  viewMode === 'card'
                    ? 'bg-card text-primary shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
                title={t('folders.viewCard')}
              >
                <LayoutGrid className="h-4 w-4" />
              </button>
              <button
                onClick={() => setViewMode('list')}
                className={`p-1.5 rounded transition-colors ${
                  viewMode === 'list'
                    ? 'bg-card text-primary shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
                title={t('folders.viewList')}
              >
                <List className="h-4 w-4" />
              </button>
            </div>
            <button
              onClick={() => setCompactMode(!compactMode)}
              className={`px-3 py-1.5 text-sm rounded-lg transition-colors ${
                compactMode
                  ? 'bg-primary/20 text-primary'
                  : 'bg-muted text-muted-foreground hover:bg-accent'
              }`}
              title={t('folders.compactMode')}
            >
              {t('folders.compactMode')}
            </button>
          </div>
        </div>
      </div>

      {/* Folders Display */}
      {sortedFolders.length === 0 ? (
        hasActiveFilters ? (
          <EmptyState
            icon={Folder}
            title={t('bookmarks.noMatches')}
            description={t('folders.noMatchesDescription')}
            action={
              <Button onClick={handleResetFilters} variant="secondary">
                {t('bookmarks.clearAllFilters')}
              </Button>
            }
          />
        ) : (
          <EmptyState
            icon={Folder}
            title={t('folders.empty')}
            description={t('folders.emptyDescription')}
            action={
              <Button onClick={handleCreate} variant="primary" icon={Plus}>
                {t('folders.create')}
              </Button>
            }
          />
        )
      ) : viewMode === 'card' ? (
        <div className={`grid grid-cols-1 gap-3 items-stretch ${
          compactMode 
            ? 'sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-8' 
            : 'sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6'
        }`}>
          {sortedFolders.map((folder) => (
            <div
              key={folder.id}
              className={`group bg-card rounded-lg border border-border hover:border-primary/70 hover:bg-muted/50 hover:shadow-md transition-all duration-200 flex flex-col h-full min-h-0 ${compactMode ? 'p-2.5 min-h-[160px]' : 'p-2.5 min-h-[140px]'}`}
            >
              <Link
                to={`${prefix}/bookmarks?folder_id=${folder.id}`}
                className="flex-1 flex flex-col min-w-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded"
              >
                <div className="space-y-3 flex-1 flex flex-col">
                  <div className="flex items-start gap-3">
                    <div className={`flex-shrink-0 ${compactMode ? 'w-9 h-9' : 'w-10 h-10'} rounded-xl bg-primary/20 flex items-center justify-center border border-primary/30`}>
                      <FolderIcon iconName={folder.icon} size={compactMode ? 18 : 20} className="text-primary" />
                    </div>
                    <div className="flex-1 min-w-0 pt-0.5">
                      <h3 className={`${compactMode ? 'text-xs' : 'text-sm'} font-medium text-foreground truncate mb-1`}>
                        {folder.name}
                      </h3>
                      {folder.shared_teams && folder.shared_teams.length > 0 && (
                        <Tooltip
                          content={
                            <div className="space-y-1">
                              <div className="font-semibold mb-1">{t('folders.sharedWith')}</div>
                              {folder.shared_teams.map((team) => (
                                <div key={team.id} className="text-xs">• {team.name}</div>
                              ))}
                              {folder.shared_users && folder.shared_users.length > 0 && (
                                folder.shared_users.map((user) => (
                                  <div key={user.id} className="text-xs">• {user.name || user.email}</div>
                                ))
                              )}
                            </div>
                          }
                        >
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-300 rounded-md border border-green-200 dark:border-green-800/50 cursor-help">
                            <Share2 className="h-3 w-3" />
                            {t('folders.shared')}
                          </span>
                        </Tooltip>
                      )}
                    </div>
                  </div>
                  {/* TODO: Add bookmark_count when backend supports it */}
                  <p className="text-xs text-muted-foreground">—</p>
                </div>
              </Link>
              {folder.folder_type === 'own' && (
                <div className={`flex gap-1.5 pt-2.5 mt-auto shrink-0 border-t border-border ${compactMode ? 'pt-2' : ''}`}>
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={Share2}
                    iconClassName="h-3.5 w-3.5 stroke-[1.5]"
                    onClick={() => { setSharingFolder(folder); setShareDialogOpen(true); }}
                    title={t('sharing.shareFolder')}
                    className="h-8 w-8 p-0 flex-shrink-0"
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={Edit}
                    iconClassName="h-3.5 w-3.5 stroke-[1.5]"
                    onClick={() => handleEdit(folder)}
                    className="flex-1 h-8 min-w-0 text-xs"
                  >
                    {t('common.edit')}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={Trash2}
                    iconClassName="h-3.5 w-3.5 stroke-[1.5]"
                    onClick={() => handleDelete(folder.id)}
                    title={t('common.delete')}
                    className="h-8 w-8 p-0 flex-shrink-0 text-red-600 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300"
                  />
                </div>
              )}
            </div>
          ))}
        </div>
      ) : (
        <div className="overflow-x-auto bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700">
          <table className="w-full">
            <thead className="bg-gray-50 dark:bg-gray-900/50 border-b border-gray-200 dark:border-gray-700">
              <tr>
                <th className={`${compactMode ? 'px-2 py-1.5' : 'px-4 py-3'} text-left ${compactMode ? 'text-[10px]' : 'text-xs'} font-semibold text-gray-700 dark:text-gray-300 uppercase tracking-wide`}>
                  {t('folders.name')}
                </th>
                {!compactMode && (
                  <th className={`${compactMode ? 'px-2 py-1.5' : 'px-4 py-3'} text-left ${compactMode ? 'text-[10px]' : 'text-xs'} font-semibold text-gray-700 dark:text-gray-300 uppercase tracking-wide`}>
                    {t('bookmarks.title')}
                  </th>
                )}
                {!compactMode && (
                  <th className={`${compactMode ? 'px-2 py-1.5' : 'px-4 py-3'} text-left ${compactMode ? 'text-[10px]' : 'text-xs'} font-semibold text-gray-700 dark:text-gray-300 uppercase tracking-wide`}>
                    {t('folders.shared')}
                  </th>
                )}
                <th className={`${compactMode ? 'px-2 py-1.5' : 'px-4 py-3'} text-right ${compactMode ? 'text-[10px]' : 'text-xs'} font-semibold text-gray-700 dark:text-gray-300 uppercase tracking-wide`}>
                  {t('common.actions')}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
              {sortedFolders.map((folder) => (
                <tr
                  key={folder.id}
                  className={`hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors ${compactMode ? 'h-10' : ''}`}
                >
                  <td className={`${compactMode ? 'px-2 py-1.5' : 'px-4 py-3'}`}>
                    <Link
                      to={`${prefix}/bookmarks?folder_id=${folder.id}`}
                      className={`flex items-center ${compactMode ? 'gap-2' : 'gap-3'} hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded`}
                    >
                      <div className={`flex-shrink-0 ${compactMode ? 'w-6 h-6' : 'w-8 h-8'} rounded-lg bg-primary/20 flex items-center justify-center border border-primary/30`}>
                        <FolderIcon iconName={folder.icon} size={compactMode ? 12 : 16} className="text-primary" />
                      </div>
                      <div className={`font-medium text-gray-900 dark:text-white ${compactMode ? 'text-xs' : 'text-[15px]'}`}>
                        {folder.name}
                      </div>
                    </Link>
                  </td>
                  {!compactMode && (
                    <td className="px-4 py-3 text-xs text-muted-foreground">—</td>
                  )}
                  {!compactMode && (
                    <td className={`${compactMode ? 'px-2 py-1.5' : 'px-4 py-3'}`}>
                      {folder.shared_teams && folder.shared_teams.length > 0 ? (
                        <Tooltip
                          content={
                            <div className="space-y-1">
                              <div className="font-semibold mb-1">{t('folders.sharedWith')}</div>
                              {folder.shared_teams.map((team) => (
                                <div key={team.id} className="text-xs">
                                  • {team.name}
                                </div>
                              ))}
                              {folder.shared_users && folder.shared_users.length > 0 && (
                                <>
                                  {folder.shared_users.map((user) => (
                                    <div key={user.id} className="text-xs">
                                      • {user.name || user.email}
                                    </div>
                                  ))}
                                </>
                              )}
                            </div>
                          }
                        >
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-300 rounded-md cursor-help">
                            <Share2 className="h-3 w-3" />
                            {t('folders.shared')}
                          </span>
                        </Tooltip>
                      ) : (
                        <span className="text-xs text-gray-500 dark:text-gray-400">-</span>
                      )}
                    </td>
                  )}
                  <td className={`${compactMode ? 'px-2 py-1.5' : 'px-4 py-3'}`}>
                    {folder.folder_type === 'own' && (
                      <div className={`flex items-center justify-end ${compactMode ? 'gap-1' : 'gap-2'}`}>
                        <Button
                          variant="ghost"
                          size="sm"
                          icon={Share2}
                          onClick={() => { setSharingFolder(folder); setShareDialogOpen(true); }}
                          title={t('sharing.shareFolder')}
                          className={compactMode ? 'px-1 h-6' : 'px-2'}
                        />
                        <Button
                          variant="ghost"
                          size="sm"
                          icon={Edit}
                          onClick={() => handleEdit(folder)}
                          className={compactMode ? 'px-1 h-6' : 'px-2'}
                        />
                        <Button
                          variant="ghost"
                          size="sm"
                          icon={Trash2}
                          onClick={() => handleDelete(folder.id)}
                          title={t('common.delete')}
                          className={`text-red-600 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300 ${compactMode ? 'px-1 h-6' : 'px-2'}`}
                        />
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {totalFolders > pageSize && sortedFolders.length > 0 && (
        <div className="flex items-center justify-between gap-4 mt-6 py-4 border-t border-border">
          <p className="text-sm text-muted-foreground">
            {t('bookmarks.paginationShowing', {
              from: page * pageSize + 1,
              to: Math.min(page * pageSize + sortedFolders.length, totalFolders),
              total: totalFolders,
            })}
          </p>
          <div className="flex gap-2">
            <Button
              variant="secondary"
              size="sm"
              icon={ChevronLeft}
              onClick={() => updateParams({ page: String(Math.max(0, page - 1)) })}
              disabled={page === 0}
            >
              {t('bookmarks.paginationPrevious')}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              icon={ChevronRight}
              iconPosition="right"
              onClick={() => updateParams({ page: String(page + 1) })}
              disabled={page * pageSize + sortedFolders.length >= totalFolders}
            >
              {t('bookmarks.paginationNext')}
            </Button>
          </div>
        </div>
      )}

      <FolderModal
        folder={editingFolder}
        isOpen={modalOpen}
        onClose={handleModalClose}
        onSuccess={loadData}
      />

      {sharingFolder && (
        <ShareResourceDialog
          resourceType="folder"
          resourceId={sharingFolder.id}
          resourceName={sharingFolder.name}
          isOpen={shareDialogOpen}
          onClose={() => { setShareDialogOpen(false); setSharingFolder(null); }}
          onSuccess={loadData}
        />
      )}

      <ConfirmDialog {...dialogState} />
    </div>
  );
}
