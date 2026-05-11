import { useState, useEffect, useMemo } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import api from '../api/client';
import ConfirmDialog from '../components/ui/ConfirmDialog';
import { useConfirmDialog } from '../hooks/useConfirmDialog';
import { Plus, Edit, Trash2, Share2, Folder, ChevronLeft, ChevronRight, Lock, MoreHorizontal } from 'lucide-react';
import FolderModal from '../components/modals/FolderModal';
import ShareResourceDialog from '../components/sharing/ShareResourceDialog';
import Button from '../components/ui/Button';
import Tooltip from '../components/ui/Tooltip';
import FolderIcon from '../components/FolderIcon';
import { CollectionToolbar } from '../components/collections';
import { EmptyState } from '../components/EmptyState';
import { PageLoadingSkeleton } from '../components/ui/PageLoadingSkeleton';
import { useAppConfig } from '../contexts/AppConfigContext';
import { usePlan, usePlanLoadState, showBookmarkFolderScopeTabs, showTeamSharingUi } from '../contexts/PlanContext';
import { Card } from '../components/ui/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../components/ui/dropdown-menu';
import { cn } from '@/lib/utils';

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

function formatShortDate(iso?: string) {
  if (!iso) return '-';
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return '-';
  }
}

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
  const planInfo = usePlan();
  const planLoadState = usePlanLoadState();
  const showScopeTabs = showBookmarkFolderScopeTabs(planInfo, planLoadState);
  const showSharingUi = showTeamSharingUi(planInfo, planLoadState);
  const effectiveScope = showScopeTabs ? scope : 'all';
  const sortParam = searchParams.get('sort');
  const sortBy = (sortParam === 'recently_added' || sortParam === 'alphabetical') ? sortParam : DEFAULT_SORT;
  const PAGE_SIZE_OPTIONS = [50, 100, 200, 500] as const;
  const limitParam = searchParams.get('limit');
  const pageSize = (limitParam && PAGE_SIZE_OPTIONS.includes(Number(limitParam) as typeof PAGE_SIZE_OPTIONS[number]))
    ? Number(limitParam)
    : 50;
  const page = Math.max(0, parseInt(searchParams.get('page') || '0', 10));
  const [totalFolders, setTotalFolders] = useState(0);
  const [folderSearch, setFolderSearch] = useState('');

  useEffect(() => {
    if (!showScopeTabs && scope !== 'all') {
      const params = new URLSearchParams(searchParams);
      params.delete('scope');
      setSearchParams(params, { replace: true });
    }
  }, [showScopeTabs, scope, searchParams, setSearchParams]);

  useEffect(() => {
    loadData();
  }, [sortBy, effectiveScope, page, pageSize, showScopeTabs]);

  async function loadData() {
    try {
      const foldersRes = await api.get('/folders', {
        params: {
          sort_by: sortBy,
          scope: effectiveScope !== 'all' ? effectiveScope : undefined,
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

  const hasActiveFilters = effectiveScope !== 'all' || sortBy !== DEFAULT_SORT;

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
    if (showScopeTabs && effectiveScope !== 'all') {
      const scopeLabel =
        effectiveScope === 'mine'
          ? t('bookmarks.scopeMine')
          : effectiveScope === 'shared_with_me'
            ? t('common.scopeSharedWithMe')
            : t('common.scopeSharedByMe');
      list.push({ key: 'scope', label: scopeLabel, ariaLabel: t('folders.clearFilters') + ' ' + scopeLabel });
    }
    if (sortBy !== DEFAULT_SORT) {
      const sortLabel = sortBy === 'recently_added' ? t('folders.sortRecentlyAdded') : t('folders.sortAlphabetical');
      list.push({ key: 'sort', label: `Sort: ${sortLabel}`, ariaLabel: t('folders.clearFilters') + ' Sort' });
    }
    return list;
  }, [showScopeTabs, effectiveScope, sortBy, t]);

  const sortedFolders = useMemo(() => [...folders], [folders]);
  const visibleFolders = useMemo(() => {
    const q = folderSearch.trim().toLowerCase();
    if (!q) return sortedFolders;
    return sortedFolders.filter((f) => f.name.toLowerCase().includes(q));
  }, [sortedFolders, folderSearch]);

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
            ? t('bookmarks.showingXOfY', { x: visibleFolders.length, y: totalFolders })
            : t('folders.pageSubtitle')
        }
        search={{
          value: folderSearch,
          onChange: setFolderSearch,
          onSubmit: setFolderSearch,
          placeholder: t('folders.name'),
          ariaLabel: t('common.search'),
        }}
        tabs={
          showScopeTabs
            ? {
                value: scope,
                onChange: (s) => updateParams({ scope: s === 'all' ? undefined : s }),
                options: [
                  { value: 'all', label: t('bookmarks.scopeAll') },
                  { value: 'mine', label: t('bookmarks.scopeMine') },
                  { value: 'shared_with_me', label: t('common.scopeSharedWithMe') },
                  { value: 'shared_by_me', label: t('common.scopeSharedByMe') },
                ],
                ariaLabel: t('bookmarks.scopeAll'),
              }
            : undefined
        }
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
              <Button onClick={handleCreate} variant="primary" icon={Plus} className="border-0 bg-primary-gradient text-primary-foreground shadow-glow hover:opacity-90">
                {t('folders.create')}
              </Button>
            }
          />
        )
      ) : visibleFolders.length === 0 ? (
        <EmptyState
          icon={Folder}
          title={t('bookmarks.noMatches')}
          description={t('folders.noMatchesDescription')}
          action={
            <Button onClick={() => setFolderSearch('')} variant="secondary">
              {t('bookmarks.clearFilters')}
            </Button>
          }
        />
      ) : (
        <div className="folder-grid grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {visibleFolders.map((folder) => {
            const isShared =
              (folder.shared_teams && folder.shared_teams.length > 0) ||
              (folder.shared_users && folder.shared_users.length > 0);
            const shareCount =
              (folder.shared_teams?.length ?? 0) + (folder.shared_users?.length ?? 0);
            return (
              <Card
                key={folder.id}
                className="folder-card group relative flex flex-col rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--bg-1)] p-4 shadow-[var(--shadow-sm)] transition-colors hover:border-[var(--border-strong)] hover:bg-[var(--bg-2)]"
              >
                <div className="flex items-start gap-3">
                  <Link
                    to={`${prefix}/bookmarks?folder_id=${folder.id}`}
                    className="f-ico flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-[var(--radius)] bg-[var(--accent-bg)]"
                  >
                    <FolderIcon iconName={folder.icon} size={18} className="text-[var(--accent-hi)]" />
                  </Link>
                  <div className="min-w-0 flex-1">
                    <Link
                      to={`${prefix}/bookmarks?folder_id=${folder.id}`}
                      className="f-title block truncate text-[13px] font-semibold text-[var(--fg-0)] hover:text-[var(--accent-hi)]"
                    >
                      {folder.name}
                    </Link>
                    <p className="f-desc mt-0.5 text-[11px] text-[var(--fg-3)]">{formatShortDate(folder.created_at)}</p>
                  </div>
                  {folder.folder_type === 'own' ? (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <button
                          type="button"
                          className="bm-menu rounded p-1 text-[var(--fg-3)] opacity-40 transition-opacity hover:bg-[var(--bg-3)] hover:opacity-100"
                          aria-label={t('common.actions')}
                        >
                          <MoreHorizontal className="h-4 w-4" />
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        {showSharingUi ? (
                          <DropdownMenuItem
                            onClick={() => {
                              setSharingFolder(folder);
                              setShareDialogOpen(true);
                            }}
                          >
                            <Share2 className="h-4 w-4" />
                            {t('sharing.shareFolder')}
                          </DropdownMenuItem>
                        ) : null}
                        <DropdownMenuItem onClick={() => handleEdit(folder)}>
                          <Edit className="h-4 w-4" />
                          {t('common.edit')}
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => handleDelete(folder.id)} className="text-destructive focus:text-destructive">
                          <Trash2 className="h-4 w-4" />
                          {t('common.delete')}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  ) : null}
                </div>
                <div className="f-meta mt-3 flex flex-wrap items-center gap-2 border-t border-[var(--border-soft)] pt-3 text-[11px] text-[var(--fg-3)]">
                  {isShared ? (
                    <>
                      <span className="inline-flex items-center gap-1">
                        <Share2 className="h-3 w-3" aria-hidden />
                        {t('folders.shared')}
                      </span>
                      <div className="f-shared flex -space-x-1.5">
                        {(() => {
                          const avatars: { key: string; tip: string; initials: string }[] = [];
                          folder.shared_teams?.forEach((team) => {
                            avatars.push({ key: `t-${team.id}`, tip: team.name, initials: team.name.slice(0, 2).toUpperCase() });
                          });
                          folder.shared_users?.forEach((u) => {
                            const label = u.name || u.email;
                            avatars.push({ key: `u-${u.id}`, tip: label, initials: label.slice(0, 2).toUpperCase() });
                          });
                          return (
                            <>
                              {avatars.slice(0, 4).map((a) => (
                                <Tooltip key={a.key} content={a.tip}>
                                  <span className="avatar sm inline-flex h-6 w-6 items-center justify-center rounded-full border border-[var(--border)] bg-[var(--bg-3)] text-[10px] font-semibold text-[var(--fg-1)]">
                                    {a.initials}
                                  </span>
                                </Tooltip>
                              ))}
                              {shareCount > 4 ? (
                                <span className="avatar sm inline-flex h-6 w-6 items-center justify-center rounded-full bg-[var(--bg-4)] text-[10px] text-[var(--fg-1)]">
                                  +{shareCount - 4}
                                </span>
                              ) : null}
                            </>
                          );
                        })()}
                      </div>
                    </>
                  ) : (
                    <span className="ml-auto inline-flex items-center gap-1 text-[var(--fg-3)]">
                      <Lock className="h-3 w-3" aria-hidden />
                      {t('sharing.notSharedYet')}
                    </span>
                  )}
                </div>
              </Card>
            );
          })}
          <button
            type="button"
            onClick={handleCreate}
            className={cn(
              'folder-card flex min-h-[140px] flex-col items-center justify-center rounded-[var(--radius-lg)] border border-dashed border-[var(--border-strong)] bg-transparent p-4 text-center text-[var(--fg-2)] transition-colors hover:border-[var(--accent-ring)] hover:bg-[var(--accent-bg)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)]'
            )}
          >
            <div className="mb-2 flex h-9 w-9 items-center justify-center rounded-[var(--radius)] bg-[var(--bg-2)] text-[var(--fg-3)]">
              <Plus className="h-4 w-4 text-[var(--accent-hi)]" aria-hidden />
            </div>
            <div className="text-[12.5px] font-medium text-[var(--fg-1)]">{t('folders.create')}</div>
            <div className="mt-0.5 text-[11px] text-[var(--fg-3)]">{t('folders.emptyDescription')}</div>
          </button>
        </div>
      )}

      {totalFolders > 0 && sortedFolders.length > 0 && (
        <div className="mt-6 flex flex-wrap items-center justify-between gap-4 rounded-xl border border-ghost bg-surface-low px-4 py-3">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-1">
            <span className="typography-label">{t('bookmarks.paginationTotalEntries', { count: totalFolders })}</span>
          </div>
          {totalFolders > pageSize ? (
            <div className="flex flex-wrap items-center gap-3">
              <span className="typography-label">
                {t('bookmarks.paginationPageOf', {
                  current: page + 1,
                  totalPages: Math.max(1, Math.ceil(totalFolders / pageSize)),
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
                  disabled={page * pageSize + sortedFolders.length >= totalFolders}
                  aria-label={t('bookmarks.paginationNext')}
                />
              </div>
            </div>
          ) : null}
        </div>
      )}

      <FolderModal
        folder={editingFolder}
        isOpen={modalOpen}
        onClose={handleModalClose}
        onSuccess={loadData}
      />

      {sharingFolder && showSharingUi ? (
        <ShareResourceDialog
          resourceType="folder"
          resourceId={sharingFolder.id}
          resourceName={sharingFolder.name}
          isOpen={shareDialogOpen}
          onClose={() => { setShareDialogOpen(false); setSharingFolder(null); }}
          onSuccess={loadData}
        />
      ) : null}

      <ConfirmDialog {...dialogState} />
    </div>
  );
}
