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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../components/ui/table';

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
      ) : (
        <Card className="overflow-hidden border-ghost bg-surface">
          <Table>
            <TableHeader>
              <TableRow className="border-0 hover:bg-transparent">
                <TableHead className={cellClass}>{t('folders.name')}</TableHead>
                <TableHead className={cellClass}>{t('folders.shared')}</TableHead>
                <TableHead className={cellClass}>{t('profile.createdAt')}</TableHead>
                <TableHead className={`${cellClass} text-right w-[120px]`}>{t('common.actions')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sortedFolders.map((folder) => {
                const isShared = (folder.shared_teams && folder.shared_teams.length > 0) || (folder.shared_users && folder.shared_users.length > 0);
                return (
                  <TableRow key={folder.id} className="border-0">
                    <TableCell className={cellClass}>
                      <Link
                        to={`${prefix}/bookmarks?folder_id=${folder.id}`}
                        className="flex items-center gap-3 rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                      >
                        <div className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-primary/25 bg-gradient-to-br from-primary/15 to-primary/25">
                          <FolderIcon iconName={folder.icon} size={16} className="text-primary" />
                        </div>
                        <span className="text-sm font-semibold text-foreground">{folder.name}</span>
                      </Link>
                    </TableCell>
                    <TableCell className={cellClass}>
                      {isShared ? (
                        <Tooltip
                          content={
                            <div className="space-y-1">
                              <div className="font-semibold mb-1">{t('folders.sharedWith')}</div>
                              {folder.shared_teams?.map((team) => (
                                <div key={team.id} className="text-xs">• {team.name}</div>
                              ))}
                              {folder.shared_users?.map((u) => (
                                <div key={u.id} className="text-xs">• {u.name || u.email}</div>
                              ))}
                            </div>
                          }
                        >
                          <span className="inline-flex cursor-help items-center gap-1 rounded-full bg-surface-low px-2.5 py-0.5 text-xs font-medium text-muted-foreground">
                            <Share2 className="h-3 w-3" />
                            {t('folders.shared')}
                          </span>
                        </Tooltip>
                      ) : (
                        <span className="text-sm text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className={cellClass}>
                      <span className="text-sm text-muted-foreground">{formatShortDate(folder.created_at)}</span>
                    </TableCell>
                    <TableCell className={`${cellClass} text-right`}>
                      {folder.folder_type === 'own' ? (
                        <div className="flex items-center justify-end gap-0.5">
                          <Button
                            variant="ghost"
                            size="sm"
                            icon={Share2}
                            iconClassName="h-3.5 w-3.5 stroke-[1.5]"
                            onClick={() => { setSharingFolder(folder); setShareDialogOpen(true); }}
                            className="h-8 w-8 p-0 min-w-8 text-muted-foreground hover:text-foreground"
                            title={t('sharing.shareFolder')}
                          />
                          <Button
                            variant="ghost"
                            size="sm"
                            icon={Edit}
                            iconClassName="h-3.5 w-3.5 stroke-[1.5]"
                            onClick={() => handleEdit(folder)}
                            className="h-8 w-8 p-0 min-w-8 text-muted-foreground hover:text-foreground"
                            title={t('common.edit')}
                          />
                          <Button
                            variant="ghost"
                            size="sm"
                            icon={Trash2}
                            iconClassName="h-3.5 w-3.5 stroke-[1.5]"
                            onClick={() => handleDelete(folder.id)}
                            className="h-8 w-8 p-0 min-w-8 text-destructive hover:text-destructive"
                            title={t('common.delete')}
                          />
                        </div>
                      ) : (
                        <span className="text-sm text-muted-foreground">—</span>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </Card>
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
