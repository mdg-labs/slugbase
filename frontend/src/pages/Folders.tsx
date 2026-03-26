import { useState, useEffect, useMemo } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import api from '../api/client';
import ConfirmDialog from '../components/ui/ConfirmDialog';
import { useConfirmDialog } from '../hooks/useConfirmDialog';
import { Plus, Edit, Trash2, Share2, Folder, ChevronLeft, ChevronRight } from 'lucide-react';
import FolderModal from '../components/modals/FolderModal';
import ShareResourceDialog from '../components/sharing/ShareResourceDialog';
import Button from '../components/ui/Button';
import Tooltip from '../components/ui/Tooltip';
import FolderIcon from '../components/FolderIcon';
import { CollectionToolbar } from '../components/collections';
import { EmptyState } from '../components/EmptyState';
import { PageLoadingSkeleton } from '../components/ui/PageLoadingSkeleton';
import { useAppConfig } from '../contexts/AppConfigContext';
import { Card } from '../components/ui/card';

interface Folder {
  id: string;
  name: string;
  icon?: string | null;
  shared_teams?: Array<{ id: string; name: string }>;
  shared_users?: Array<{ id: string; name: string; email: string }>;
  folder_type?: 'own' | 'shared';
  created_at?: string;
}

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
      <CollectionToolbar
        title={t('folders.title')}
        count={totalFolders}
        subtitle={
          hasActiveFilters || totalFolders > pageSize
            ? t('bookmarks.showingXOfY', { x: sortedFolders.length, y: totalFolders })
            : undefined
        }
        tabs={{
          value: scope,
          onChange: (s) => updateParams({ scope: s === 'all' ? undefined : s }),
          options: [
            { value: 'all', label: t('bookmarks.scopeAll') },
            { value: 'mine', label: t('bookmarks.scopeMine') },
            { value: 'shared_with_me', label: t('common.scopeSharedWithMe') },
            { value: 'shared_by_me', label: t('common.scopeSharedByMe') },
          ],
          ariaLabel: t('bookmarks.scopeAll'),
        }}
        createButton={{ label: t('folders.create'), onClick: handleCreate }}
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
      ) : (
        <div className="grid gap-3 items-stretch [grid-template-columns:repeat(auto-fill,minmax(300px,1fr))]">
          {sortedFolders.map((folder) => {
            const isShared = (folder.shared_teams && folder.shared_teams.length > 0) || (folder.shared_users && folder.shared_users.length > 0);
            return (
              <Card
                key={folder.id}
                className="group relative flex flex-col h-[101px] cursor-pointer rounded-lg border bg-card/95 dark:bg-card/90 transition-[border-color,box-shadow] duration-150 border-border/80 hover:border-primary/80 hover:shadow-[0_2px_6px_rgba(0,0,0,0.06)] dark:border-border/70 dark:hover:border-primary/80 dark:hover:shadow-[0_2px_6px_rgba(0,0,0,0.25)] px-3 pt-0 pb-1.5 focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2"
              >
                <Link
                  to={`${prefix}/bookmarks?folder_id=${folder.id}`}
                  className="absolute inset-0 rounded-lg z-0 focus:outline-none"
                  aria-label={folder.name}
                />
                <header className="flex-shrink-0 flex items-center gap-1.5 min-w-0 pt-3 relative z-10">
                  <div className="flex-shrink-0 w-7 h-7 rounded-md bg-background/90 dark:bg-muted/20 flex items-center justify-center border border-border/50 overflow-hidden">
                    <FolderIcon iconName={folder.icon} size={16} className="text-primary" />
                  </div>
                  <div className="flex-1 min-w-0 min-h-0 overflow-hidden">
                    <h3 className="text-sm font-semibold text-foreground line-clamp-2 break-words leading-snug tracking-tight min-h-0">
                      {folder.name}
                    </h3>
                  </div>
                </header>
                {isShared && (
                  <div className="flex-shrink-0 mt-1.5 relative z-10">
                    <Tooltip
                      content={
                        <div className="space-y-1">
                          <div className="font-semibold mb-1">{t('folders.sharedWith')}</div>
                          {folder.shared_teams?.map((team) => (
                            <div key={team.id} className="text-xs">• {team.name}</div>
                          ))}
                          {folder.shared_users?.map((user) => (
                            <div key={user.id} className="text-xs">• {user.name || user.email}</div>
                          ))}
                        </div>
                      }
                    >
                      <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 text-[10px] font-medium bg-emerald-500/10 dark:bg-emerald-500/10 text-muted-foreground rounded cursor-help">
                        <Share2 className="h-2.5 w-2.5" />
                        {t('folders.shared')}
                      </span>
                    </Tooltip>
                  </div>
                )}
                <div className="flex-1 min-h-0" aria-hidden />
                {folder.folder_type === 'own' && (
                  <footer className="flex-shrink-0 flex items-center justify-end gap-0.5 h-6 min-h-[24px] pt-2.5 relative z-10 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity duration-150 w-[76px] ml-auto">
                    <Button
                      variant="ghost"
                      size="sm"
                      icon={Share2}
                      iconClassName="h-3.5 w-3.5 stroke-[1.5]"
                      onClick={(e) => { e.preventDefault(); e.stopPropagation(); setSharingFolder(folder); setShareDialogOpen(true); }}
                      className="h-6 w-6 p-0 min-w-6 text-muted-foreground hover:text-foreground"
                      title={t('sharing.shareFolder')}
                    />
                    <Button
                      variant="ghost"
                      size="sm"
                      icon={Edit}
                      iconClassName="h-3.5 w-3.5 stroke-[1.5]"
                      onClick={(e) => { e.preventDefault(); e.stopPropagation(); handleEdit(folder); }}
                      className="h-6 w-6 p-0 min-w-6 text-muted-foreground hover:text-foreground"
                      title={t('common.edit')}
                    />
                    <Button
                      variant="ghost"
                      size="sm"
                      icon={Trash2}
                      iconClassName="h-3.5 w-3.5 stroke-[1.5]"
                      onClick={(e) => { e.preventDefault(); e.stopPropagation(); handleDelete(folder.id); }}
                      className="h-6 w-6 p-0 min-w-6 text-red-600 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300"
                      title={t('common.delete')}
                    />
                  </footer>
                )}
              </Card>
            );
          })}
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
