import { useState, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import api from '../api/client';
import ConfirmDialog from '../components/ui/ConfirmDialog';
import { useConfirmDialog } from '../hooks/useConfirmDialog';
import { useToast } from '../components/ui/Toast';
import { Plus, Upload, Bookmark as BookmarkIcon, ExternalLink, FolderPlus, Tag as TagIcon, Share2, Trash2, Copy, ChevronLeft, ChevronRight } from 'lucide-react';
import BookmarkModal from '../components/modals/BookmarkModal';
import ImportModal from '../components/modals/ImportModal';
import ShareResourceDialog from '../components/sharing/ShareResourceDialog';
import Button from '../components/ui/Button';
import BookmarkTableView from '../components/bookmarks/BookmarkTableView';
import { DashboardBookmarkTile } from '../components/dashboard/DashboardBookmarkTile';
import { BulkMoveModal, BulkTagModal, BulkShareModal } from '../components/bookmarks/BulkActionModals';
import { type FilterKey } from '../components/bookmarks/FilterChips';
import { CollectionToolbar } from '../components/collections';
import { PageLoadingSkeleton } from '../components/ui/PageLoadingSkeleton';
import { Card } from '../components/ui/card';
import { useSidebar } from '../components/ui/sidebar';
import { useAppConfig } from '../contexts/AppConfigContext';
import { usePlan, usePlanLoadState, showBookmarkFolderScopeTabs, showTeamSharingUi } from '../contexts/PlanContext';

interface Bookmark {
  id: string;
  title: string;
  url: string;
  slug: string;
  forwarding_enabled: boolean;
  /** Owner's user_key for canonical forwarding URL (own or shared) */
  owner_user_key?: string;
  folders?: Array<{ id: string; name: string; icon?: string | null; shared_teams?: Array<{ id: string; name: string }>; shared_users?: Array<{ id: string; name: string; email: string }> }>;
  tags?: Array<{ id: string; name: string }>;
  shared_teams?: Array<{ id: string; name: string }>;
  shared_users?: Array<{ id: string; name: string; email: string }>;
  bookmark_type?: 'own' | 'shared';
  created_at?: string;
  access_count?: number;
  last_accessed_at?: string | null;
  pinned?: boolean;
}

type SortOption = 'recently_added' | 'alphabetical' | 'most_used' | 'recently_accessed';

const BOOKMARKS_VIEW_STORAGE_KEY = 'slugbase_bookmarks_view';

function getStoredBookmarksView(): 'cards' | 'table' {
  if (typeof window === 'undefined') return 'cards';
  try {
    const v = localStorage.getItem(BOOKMARKS_VIEW_STORAGE_KEY);
    if (v === 'table' || v === 'cards') return v;
  } catch {
    /* ignore */
  }
  return 'cards';
}

function bookmarkCategoryLabel(
  b: Bookmark,
  t: (key: string, options?: Record<string, unknown>) => string
): string {
  if (b.pinned) return t('dashboard.pinned');
  if (b.bookmark_type === 'shared') return t('common.scopeSharedWithMe');
  const folder = b.folders?.[0]?.name;
  if (folder) return folder.length > 28 ? `${folder.slice(0, 27)}…` : folder;
  return t('dashboard.quickAccessCategory');
}

export default function Bookmarks() {
  const { t } = useTranslation();
  const { pathPrefixForLinks } = useAppConfig();
  const prefix = (pathPrefixForLinks || '').replace(/\/+/g, '/') || '';
  const { user } = useAuth();
  const { isMobile, state: sidebarState } = useSidebar();
  const [searchParams, setSearchParams] = useSearchParams();
  const { showConfirm, dialogState } = useConfirmDialog();
  const { showToast } = useToast();
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const [folders, setFolders] = useState<any[]>([]);
  const [tags, setTags] = useState<any[]>([]);
  const [teams, setTeams] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [sortBy, setSortBy] = useState<SortOption>('recently_added');
  const [selectedBookmarks, setSelectedBookmarks] = useState<Set<string>>(new Set());
  const [allSelectedAcrossPages, setAllSelectedAcrossPages] = useState(false);
  const [bulkMode, setBulkMode] = useState(false);
  const [bulkMoveModalOpen, setBulkMoveModalOpen] = useState(false);
  const [bulkTagModalOpen, setBulkTagModalOpen] = useState(false);
  const [bulkShareModalOpen, setBulkShareModalOpen] = useState(false);
  const [importModalOpen, setImportModalOpen] = useState(false);
  const [searchInputValue, setSearchInputValue] = useState('');

  const selectedFolder = searchParams.get('folder_id') || '';
  const selectedTag = searchParams.get('tag_id') || '';
  const scopeParam = searchParams.get('scope');
  const scope = (scopeParam === 'mine' || scopeParam === 'shared_with_me' || scopeParam === 'shared_by_me' || scopeParam === 'shared')
    ? (scopeParam === 'shared' ? 'shared_with_me' : scopeParam)
    : 'all';
  const planInfo = usePlan();
  const planLoadState = usePlanLoadState();
  const showScopeTabs = showBookmarkFolderScopeTabs(planInfo, planLoadState);
  const showSharingUi = showTeamSharingUi(planInfo, planLoadState);
  const effectiveScope = showScopeTabs ? scope : 'all';
  const pinnedFilter = searchParams.get('pinned') === 'true';
  const searchQuery = searchParams.get('q') || '';
  const viewFromUrl = searchParams.get('view');
  const listView: 'cards' | 'table' = useMemo(() => {
    if (viewFromUrl === 'table' || viewFromUrl === 'cards') return viewFromUrl;
    return getStoredBookmarksView();
  }, [viewFromUrl]);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingBookmark, setEditingBookmark] = useState<Bookmark | null>(null);
  const [shareDialogOpen, setShareDialogOpen] = useState(false);
  const [sharingBookmark, setSharingBookmark] = useState<Bookmark | null>(null);
  const [page, setPage] = useState(0);
  const [total, setTotal] = useState(0);
  const PAGE_SIZE_OPTIONS = [50, 100, 200, 500] as const;
  const limitParam = searchParams.get('limit');
  const pageSize = (limitParam && PAGE_SIZE_OPTIONS.includes(Number(limitParam) as typeof PAGE_SIZE_OPTIONS[number]))
    ? Number(limitParam)
    : 50;

  useEffect(() => {
    if (!showScopeTabs && scope !== 'all') {
      const params = new URLSearchParams(searchParams);
      params.delete('scope');
      setSearchParams(params, { replace: true });
    }
  }, [showScopeTabs, scope, searchParams, setSearchParams]);

  useEffect(() => {
    setPage(0);
    setAllSelectedAcrossPages(false);
  }, [selectedFolder, selectedTag, sortBy, effectiveScope, pinnedFilter, searchQuery, pageSize]);

  useEffect(() => {
    loadData();
  }, [selectedFolder, selectedTag, sortBy, page, effectiveScope, pinnedFilter, searchQuery, pageSize, showScopeTabs]);

  // Handle query params from GlobalSearch and dashboard Edit link
  useEffect(() => {
    const createParam = searchParams.get('create');
    const importParam = searchParams.get('import');
    const exportParam = searchParams.get('export');
    const editId = searchParams.get('edit');

    if (createParam === 'true') {
      handleCreate();
      const params = new URLSearchParams(searchParams);
      params.delete('create');
      setSearchParams(params, { replace: true });
    } else if (importParam === 'true') {
      setImportModalOpen(true);
      const params = new URLSearchParams(searchParams);
      params.delete('import');
      setSearchParams(params, { replace: true });
    } else if (exportParam === 'true') {
      handleExport();
      const params = new URLSearchParams(searchParams);
      params.delete('export');
      setSearchParams(params, { replace: true });
    } else if (editId) {
      api.get(`/bookmarks/${editId}`)
        .then((res) => {
          setEditingBookmark(res.data);
          setModalOpen(true);
        })
        .catch((err: any) => {
          const status = err.response?.status;
          if (status === 403 || status === 404) {
            showToast(t('common.notFoundOrNoAccess'), 'error');
          }
        });
      const params = new URLSearchParams(searchParams);
      params.delete('edit');
      setSearchParams(params, { replace: true });
    }
  }, [searchParams]);

  function handleExport() {
    api.get('/bookmarks/export')
      .then(response => {
        const dataStr = JSON.stringify(response.data, null, 2);
        const dataBlob = new Blob([dataStr], { type: 'application/json' });
        const url = URL.createObjectURL(dataBlob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `slugbase-bookmarks-${new Date().toISOString().split('T')[0]}.json`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
        showToast(t('common.success'), 'success');
      })
      .catch(error => {
        console.error('Export failed:', error);
        showToast(t('common.error'), 'error');
      });
  }

  useEffect(() => {
    setSearchInputValue(searchQuery);
  }, [searchQuery]);

  useEffect(() => {
    const v = searchParams.get('view');
    if (v === 'cards' || v === 'table') {
      try {
        localStorage.setItem(BOOKMARKS_VIEW_STORAGE_KEY, v);
      } catch {
        /* ignore */
      }
    }
  }, [searchParams]);

  async function loadData() {
    try {
      const [bookmarksSettled, foldersSettled, tagsSettled, teamsSettled] = await Promise.allSettled([
        api.get('/bookmarks', {
          params: {
            folder_id: selectedFolder || undefined,
            tag_id: selectedTag || undefined,
            sort_by: sortBy,
            limit: pageSize,
            offset: page * pageSize,
            scope: effectiveScope !== 'all' ? effectiveScope : undefined,
            pinned: pinnedFilter ? 'true' : undefined,
            q: searchQuery.trim() || undefined,
          },
        }),
        api.get('/folders'),
        api.get('/tags'),
        showScopeTabs ? api.get('/teams') : Promise.resolve({ data: [] }),
      ]);
      if (bookmarksSettled.status === 'fulfilled') {
        const payload = bookmarksSettled.value.data;
        const items = payload.items ?? [];
        setTotal(payload.total ?? 0);
        setBookmarks(items);
      }
      if (foldersSettled.status === 'fulfilled') setFolders(foldersSettled.value.data ?? []);
      if (tagsSettled.status === 'fulfilled') setTags(tagsSettled.value.data ?? []);
      if (teamsSettled.status === 'fulfilled') setTeams(Array.isArray(teamsSettled.value.data) ? teamsSettled.value.data : []);
    } catch (error) {
      console.error('Failed to load data:', error);
    } finally {
      setLoading(false);
    }
  }

  const displayedBookmarks = bookmarks;

  const hasActiveFilters =
    !!selectedFolder ||
    !!selectedTag ||
    effectiveScope !== 'all' ||
    pinnedFilter ||
    !!searchQuery.trim() ||
    sortBy !== 'recently_added';

  function updateParams(updates: Record<string, string | undefined>) {
    const params = new URLSearchParams(searchParams);
    (Object.entries(updates) as [string, string | undefined][]).forEach(([k, v]) => {
      if (v === undefined || v === '') params.delete(k);
      else params.set(k, v);
    });
    setSearchParams(params);
  }

  function setListView(mode: 'cards' | 'table') {
    try {
      localStorage.setItem(BOOKMARKS_VIEW_STORAGE_KEY, mode);
    } catch {
      /* ignore */
    }
    updateParams({ view: mode });
  }

  function handleRemoveFilter(key: FilterKey) {
    if (key === 'folder_id') updateParams({ folder_id: undefined });
    else if (key === 'tag_id') updateParams({ tag_id: undefined });
    else if (key === 'sort') setSortBy('recently_added');
    else if (key === 'q') updateParams({ q: undefined });
    else if (key === 'pinned') updateParams({ pinned: undefined });
    else if (key === 'scope') updateParams({ scope: undefined });
  }

  function handleCreate() {
    setEditingBookmark(null);
    setModalOpen(true);
  }

  function handleEdit(bookmark: Bookmark) {
    setEditingBookmark(bookmark);
    setModalOpen(true);
  }

  function handleDelete(id: string, name?: string) {
    const bookmark = bookmarks.find(b => b.id === id);
    const bookmarkName = name || bookmark?.title || 'this bookmark';
    showConfirm(
      t('bookmarks.deleteBookmark'),
      t('bookmarks.deleteConfirmWithName', { name: bookmarkName }),
      async () => {
        try {
          await api.delete(`/bookmarks/${id}`);
          loadData();
          setSelectedBookmarks(prev => {
            const next = new Set(prev);
            next.delete(id);
            return next;
          });
          showToast(t('common.success'), 'success');
        } catch (error) {
          console.error('Failed to delete bookmark:', error);
          showToast(t('common.error'), 'error');
        }
      },
      { variant: 'danger', confirmText: t('common.delete'), cancelText: t('common.cancel') }
    );
  }

  function handleBulkDelete() {
    const count = selectedBookmarks.size;
    showConfirm(
      t('bookmarks.deleteBookmark'),
      t('bookmarks.deleteConfirm').replace('this bookmark', `${count} bookmarks`),
      async () => {
        try {
          await Promise.all(Array.from(selectedBookmarks).map(id => api.delete(`/bookmarks/${id}`)));
          loadData();
          setSelectedBookmarks(new Set());
          setAllSelectedAcrossPages(false);
          setBulkMode(false);
          showToast(t('common.success'), 'success');
        } catch (error) {
          console.error('Failed to delete bookmarks:', error);
          showToast(t('common.error'), 'error');
        }
      },
      { variant: 'danger', confirmText: t('common.delete'), cancelText: t('common.cancel') }
    );
  }

  async function handleBulkMove(folderIds: string[]) {
    try {
      await Promise.all(Array.from(selectedBookmarks).map(id => 
        api.put(`/bookmarks/${id}`, { folder_ids: folderIds })
      ));
      loadData();
      setSelectedBookmarks(new Set());
      setAllSelectedAcrossPages(false);
      setBulkMoveModalOpen(false);
      showToast(t('common.success'), 'success');
    } catch (error) {
      console.error('Failed to move bookmarks:', error);
      showToast(t('common.error'), 'error');
    }
  }

  async function handleBulkAddTags(tagIds: string[]) {
    try {
      // Get current tags for each bookmark and merge
      const bookmarkPromises = Array.from(selectedBookmarks).map(async (id) => {
        const bookmark = bookmarks.find(b => b.id === id);
        const currentTagIds = bookmark?.tags?.map(t => t.id) || [];
        const mergedTagIds = [...new Set([...currentTagIds, ...tagIds])];
        return api.put(`/bookmarks/${id}`, { tag_ids: mergedTagIds });
      });
      await Promise.all(bookmarkPromises);
      loadData();
      setSelectedBookmarks(new Set());
      setAllSelectedAcrossPages(false);
      setBulkTagModalOpen(false);
      showToast(t('common.success'), 'success');
    } catch (error) {
      console.error('Failed to add tags:', error);
      showToast(t('common.error'), 'error');
    }
  }

  async function handleBulkShare(sharing: { team_ids: string[]; user_ids: string[]; share_all_teams: boolean }) {
    try {
      await Promise.all(Array.from(selectedBookmarks).map(id => 
        api.put(`/bookmarks/${id}`, {
          team_ids: sharing.team_ids,
          user_ids: sharing.user_ids,
          share_all_teams: sharing.share_all_teams,
        })
      ));
      loadData();
      setSelectedBookmarks(new Set());
      setAllSelectedAcrossPages(false);
      setBulkShareModalOpen(false);
      showToast(t('common.success'), 'success');
    } catch (error) {
      console.error('Failed to share bookmarks:', error);
      showToast(t('common.error'), 'error');
    }
  }

  function handleCopyUrl(bookmark: Bookmark) {
    const baseUrl = window.location.origin;
    const url = bookmark.slug ? `${baseUrl}/go/${bookmark.slug}` : '';
    if (url) {
      navigator.clipboard.writeText(url);
      showToast(t('common.copied'), 'success');
    }
  }

  async function handleOpenBookmark(bookmark: Bookmark) {
    // Track access asynchronously (don't wait for it to complete)
    api.post(`/bookmarks/${bookmark.id}/track-access`).catch((error) => {
      console.error('Failed to track bookmark access:', error);
      // Don't show error to user, just log it
    });
    
    // Open the bookmark URL
    window.open(bookmark.url, '_blank', 'noopener,noreferrer');
  }

  function handleModalClose() {
    setModalOpen(false);
    setEditingBookmark(null);
    loadData();
  }

  function handleResetFilters() {
    setSearchParams({});
    setSortBy('recently_added');
  }

  function toggleSelectBookmark(id: string) {
    setSelectedBookmarks(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  function toggleSelectAll() {
    if (selectedBookmarks.size === displayedBookmarks.length) {
      setSelectedBookmarks(new Set());
    } else {
      setSelectedBookmarks(new Set(displayedBookmarks.map(b => b.id)));
    }
  }

  async function handleSelectAllRemaining() {
    try {
      const res = await api.get('/bookmarks/ids', {
        params: {
          folder_id: selectedFolder || undefined,
          tag_id: selectedTag || undefined,
          sort_by: sortBy,
          scope: effectiveScope !== 'all' ? effectiveScope : undefined,
          pinned: pinnedFilter ? 'true' : undefined,
          q: searchQuery.trim() || undefined,
        },
      });
      const ids = res.data?.ids ?? [];
      setSelectedBookmarks(prev => new Set([...prev, ...ids]));
      setAllSelectedAcrossPages(true);
    } catch (err) {
      console.error('Failed to fetch bookmark IDs:', err);
      showToast(t('common.error'), 'error');
    }
  }

  function handleDeselectAll() {
    setSelectedBookmarks(new Set());
    setAllSelectedAcrossPages(false);
  }

  const ALL_FILTER = '__all__';
  const folderOptions = [
    { value: ALL_FILTER, label: t('bookmarks.allFolders') },
    ...folders.map((f) => ({ value: f.id, label: f.name, icon: (f as any).icon })),
  ];

  const tagOptions = [
    { value: ALL_FILTER, label: t('bookmarks.allTags') },
    ...tags.map((t) => ({ value: t.id, label: t.name })),
  ];

  const sortOptions = [
    { value: 'recently_added', label: t('bookmarks.sortRecentlyAdded') },
    { value: 'alphabetical', label: t('bookmarks.sortAlphabetical') },
    { value: 'most_used', label: t('bookmarks.sortMostUsed') },
    { value: 'recently_accessed', label: t('bookmarks.sortRecentlyAccessed') },
  ];

  const filterChips = (() => {
    const list: { key: FilterKey; label: string; ariaLabel: string }[] = [];
    if (selectedFolder) {
      const name = folders.find((f: any) => f.id === selectedFolder)?.name ?? selectedFolder;
      list.push({ key: 'folder_id', label: `${t('bookmarks.folder')}: ${name}`, ariaLabel: t('bookmarks.clearFilters') + ` ${t('bookmarks.folder')}: ${name}` });
    }
    if (selectedTag) {
      const name = tags.find((t: any) => t.id === selectedTag)?.name ?? selectedTag;
      list.push({ key: 'tag_id', label: `${t('bookmarks.tags')}: ${name}`, ariaLabel: t('bookmarks.clearFilters') + ` ${t('bookmarks.tags')}: ${name}` });
    }
    if (sortBy !== 'recently_added') {
      const label = sortOptions.find(o => o.value === sortBy)?.label ?? sortBy;
      list.push({ key: 'sort', label: `Sort: ${label}`, ariaLabel: t('bookmarks.clearFilters') + ' Sort' });
    }
    if (searchQuery.trim()) {
      list.push({ key: 'q', label: `${t('common.search')}: ${searchQuery.trim()}`, ariaLabel: t('bookmarks.clearFilters') + ' ' + t('common.search') });
    }
    if (pinnedFilter) {
      list.push({ key: 'pinned', label: t('bookmarks.pinned'), ariaLabel: t('bookmarks.clearFilters') + ' ' + t('bookmarks.pinned') });
    }
    if (effectiveScope === 'mine') {
      list.push({ key: 'scope', label: t('bookmarks.scopeMine'), ariaLabel: t('bookmarks.clearFilters') + ' ' + t('bookmarks.scopeMine') });
    }
    if (effectiveScope === 'shared_with_me') {
      list.push({ key: 'scope', label: t('common.scopeSharedWithMe'), ariaLabel: t('bookmarks.clearFilters') + ' ' + t('common.scopeSharedWithMe') });
    }
    if (effectiveScope === 'shared_by_me') {
      list.push({ key: 'scope', label: t('common.scopeSharedByMe'), ariaLabel: t('bookmarks.clearFilters') + ' ' + t('common.scopeSharedByMe') });
    }
    return list;
  })();

  if (loading) {
    return <PageLoadingSkeleton lines={6} />;
  }

  return (
    <div className="space-y-6 pb-24">
      <CollectionToolbar
        title={t('bookmarks.title')}
        count={total}
        subtitle={
          hasActiveFilters || total > pageSize
            ? t('bookmarks.showingXOfY', { x: displayedBookmarks.length, y: total })
            : t('bookmarks.pageSubtitle')
        }
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
        createButton={{ label: t('bookmarks.create'), onClick: handleCreate }}
        filterChips={{
          chips: filterChips,
          onRemove: (key) => handleRemoveFilter(key as FilterKey),
          onClearAll: handleResetFilters,
          clearAllLabel: t('bookmarks.clearAllFilters'),
          clearAllAriaLabel: t('bookmarks.clearAllFilters'),
        }}
        search={{
          value: searchInputValue,
          onChange: setSearchInputValue,
          onSubmit: (value) => updateParams({ q: value || undefined }),
          placeholder: t('common.searchPlaceholder'),
          ariaLabel: t('common.searchPlaceholder'),
        }}
        folderFilter={{
          value: selectedFolder || ALL_FILTER,
          onChange: (value) => {
            const params = new URLSearchParams(searchParams);
            if (value && value !== ALL_FILTER) params.set('folder_id', value);
            else params.delete('folder_id');
            setSearchParams(params);
          },
          options: folderOptions,
          placeholder: t('bookmarks.filterByFolder'),
        }}
        tagFilter={{
          value: selectedTag || ALL_FILTER,
          onChange: (value) => {
            const params = new URLSearchParams(searchParams);
            if (value && value !== ALL_FILTER) params.set('tag_id', value);
            else params.delete('tag_id');
            setSearchParams(params);
          },
          options: tagOptions,
          placeholder: t('bookmarks.filterByTag'),
        }}
        sort={{
          value: sortBy,
          onChange: (value) => setSortBy(value as SortOption),
          options: sortOptions,
          className: 'min-w-[160px]',
        }}
        perPage={{
          value: pageSize,
          onChange: (value) => {
            updateParams({ limit: String(value) });
            setPage(0);
          },
          options: [...PAGE_SIZE_OPTIONS],
          label: t('bookmarks.perPage'),
        }}
        moreMenuLabel={t('bookmarks.toolbarMore')}
        pinnedToggle={{
          active: pinnedFilter,
          onClick: () => updateParams({ pinned: pinnedFilter ? undefined : 'true' }),
          label: t('bookmarks.pinned'),
        }}
        onImport={() => setImportModalOpen(true)}
        importLabel={t('bookmarks.import')}
        onExport={handleExport}
        exportLabel={t('bookmarks.export')}
        bulkSelect={
          !bulkMode && displayedBookmarks.length > 0
            ? { onClick: () => setBulkMode(true), label: t('bookmarks.bulkSelect') }
            : { onClick: () => setBulkMode(true), label: t('bookmarks.bulkSelect'), disabled: true }
        }
        viewDisplay={{
          value: listView,
          onChange: setListView,
          label: t('bookmarks.viewMode'),
          cardsLabel: t('bookmarks.viewCard'),
          tableLabel: t('bookmarks.viewList'),
        }}
      />

      {/* Bulk Actions Bar - sticky bottom, visible when selecting */}
      {bulkMode && (
        <div
          className="fixed bottom-0 right-0 z-50 flex flex-wrap items-center justify-between gap-4 border-t border-ghost bg-surface-high/95 p-4 backdrop-blur-sm shadow-[0_-8px_32px_rgba(0,0,0,0.12)] dark:shadow-[0_-8px_32px_rgba(0,0,0,0.35)]"
          style={
            !isMobile
              ? { left: sidebarState === 'expanded' ? '16rem' : '3rem' }
              : { left: 0 }
          }
        >
          <div className="flex flex-wrap items-center gap-3">
            {(allSelectedAcrossPages || selectedBookmarks.size === total) && total > 0 ? (
              <>
                <span className="text-sm text-muted-foreground">
                  {t('bookmarks.allSelected', { total })}
                </span>
                <button
                  type="button"
                  onClick={handleDeselectAll}
                  className="text-sm font-medium text-primary hover:text-primary/90"
                >
                  {t('bookmarks.deselectAll')}
                </button>
              </>
            ) : selectedBookmarks.size === displayedBookmarks.length && displayedBookmarks.length > 0 && total > pageSize ? (
              <>
                <span className="text-sm text-muted-foreground">
                  {t('bookmarks.selectAllOnPageAndRemaining', { pageCount: displayedBookmarks.length, total })}
                </span>
                <button
                  type="button"
                  onClick={handleSelectAllRemaining}
                  className="text-sm font-medium text-primary hover:text-primary/90"
                >
                  {t('bookmarks.selectAllRemaining', { total })}
                </button>
              </>
            ) : (
              <>
                <span className="text-sm font-medium text-foreground">
                  {t('bookmarks.selectedCount', { count: selectedBookmarks.size })}
                </span>
                <button
                  type="button"
                  onClick={toggleSelectAll}
                  className="text-sm font-medium text-primary hover:text-primary/90"
                >
                  {selectedBookmarks.size === displayedBookmarks.length ? t('bookmarks.deselectAll') : t('bookmarks.selectAll')}
                </button>
              </>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              icon={FolderPlus}
              onClick={() => setBulkMoveModalOpen(true)}
              disabled={selectedBookmarks.size === 0}
              className="border-ghost bg-surface"
            >
              {t('bookmarks.bulkMoveToFolder')}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              icon={TagIcon}
              onClick={() => setBulkTagModalOpen(true)}
              disabled={selectedBookmarks.size === 0}
              className="border-ghost bg-surface"
            >
              {t('bookmarks.bulkAddTags')}
            </Button>
            {showSharingUi ? (
              <Button
                variant="secondary"
                size="sm"
                icon={Share2}
                onClick={() => setBulkShareModalOpen(true)}
                disabled={selectedBookmarks.size === 0}
                className="border-ghost bg-surface"
              >
                {t('bookmarks.bulkShare')}
              </Button>
            ) : null}
            <Button
              variant="danger"
              size="sm"
              icon={Trash2}
              onClick={handleBulkDelete}
              disabled={selectedBookmarks.size === 0}
            >
              {t('bookmarks.bulkDelete')}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setBulkMode(false);
                setSelectedBookmarks(new Set());
                setAllSelectedAcrossPages(false);
              }}
            >
              {t('common.cancel')}
            </Button>
          </div>
        </div>
      )}

      {/* Bookmarks Display */}
      {displayedBookmarks.length === 0 ? (
        <Card className="flex flex-col items-center justify-center border-ghost bg-surface px-6 py-24">
          <div className="mb-6 flex h-20 w-20 items-center justify-center rounded-2xl bg-primary/15 shadow-glow">
            <BookmarkIcon className="h-10 w-10 text-primary" />
          </div>
          <h2 className="mb-3 text-center text-4xl font-black tracking-tight text-foreground">
            {hasActiveFilters ? t('bookmarks.noMatches') : t('bookmarks.empty')}
          </h2>
          <p className="mb-8 max-w-md text-center text-sm text-muted-foreground">
            {hasActiveFilters ? '' : t('bookmarks.emptyDescription')}
          </p>
          <div className="flex flex-wrap justify-center gap-3">
            {hasActiveFilters ? (
              <Button onClick={handleResetFilters} variant="primary" className="border-0 bg-primary-gradient text-primary-foreground shadow-glow hover:opacity-90">
                {t('bookmarks.clearFilters')}
              </Button>
            ) : (
              <>
                <Button
                  onClick={handleCreate}
                  variant="primary"
                  icon={Plus}
                  className="border-0 bg-primary-gradient text-primary-foreground shadow-glow hover:opacity-90"
                >
                  {t('bookmarks.emptyCreateFirst')}
                </Button>
                <Button variant="secondary" icon={Upload} onClick={() => setImportModalOpen(true)} className="border-ghost bg-surface-high">
                  {t('bookmarks.emptyImport')}
                </Button>
                <Link to={`${prefix}/search-engine-guide`}>
                  <Button variant="ghost" icon={ExternalLink}>
                    {t('bookmarks.emptyLearnForwarding')}
                  </Button>
                </Link>
              </>
            )}
          </div>
        </Card>
      ) : listView === 'cards' ? (
        <div className="grid grid-cols-1 items-stretch gap-6 sm:grid-cols-2 lg:grid-cols-4">
          {displayedBookmarks.map((bookmark) => {
            const isOwn = bookmark.bookmark_type !== 'shared';
            return (
              <DashboardBookmarkTile
                key={bookmark.id}
                bookmark={{
                  id: bookmark.id,
                  title: bookmark.title,
                  url: bookmark.url,
                  slug: bookmark.slug,
                }}
                pathPrefix={prefix}
                categoryLabel={bookmarkCategoryLabel(bookmark, t)}
                t={t}
                onOpen={() => handleOpenBookmark(bookmark)}
                onCopy={() => handleCopyUrl(bookmark)}
                bulkMode={bulkMode}
                selected={selectedBookmarks.has(bookmark.id)}
                onToggleSelect={() => toggleSelectBookmark(bookmark.id)}
                showEditLink={isOwn}
                listActions={
                  isOwn
                    ? {
                        onShare: showSharingUi
                          ? () => {
                              setSharingBookmark(bookmark);
                              setShareDialogOpen(true);
                            }
                          : undefined,
                        onDelete: () => handleDelete(bookmark.id, bookmark.title),
                        shareLabel: t('sharing.shareBookmark'),
                        deleteLabel: t('common.delete'),
                        moreAriaLabel: t('bookmarks.moreActions'),
                      }
                    : undefined
                }
              />
            );
          })}
        </div>
      ) : (
        <BookmarkTableView
          bookmarks={displayedBookmarks}
          selectedBookmarks={selectedBookmarks}
          onSelect={toggleSelectBookmark}
          onSelectAll={toggleSelectAll}
          onEdit={handleEdit}
          onDelete={handleDelete}
          onCopyUrl={handleCopyUrl}
          onShare={
            showSharingUi
              ? (bookmark) => {
                  setSharingBookmark(bookmark);
                  setShareDialogOpen(true);
                }
              : undefined
          }
          onOpen={handleOpenBookmark}
          bulkMode={bulkMode}
          user={user}
          t={t}
        />
      )}

      {/* Pagination footer */}
      {total > 0 && displayedBookmarks.length > 0 && (
        <div className="mt-6 flex flex-wrap items-center justify-between gap-4 rounded-xl border border-ghost bg-surface-low px-4 py-3">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-1">
            <span className="typography-label">{t('bookmarks.paginationTotalEntries', { count: total })}</span>
          </div>
          {total > pageSize ? (
            <div className="flex flex-wrap items-center gap-3">
              <span className="typography-label">
                {t('bookmarks.paginationPageOf', {
                  current: page + 1,
                  totalPages: Math.max(1, Math.ceil(total / pageSize)),
                })}
              </span>
              <div className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  icon={ChevronLeft}
                  className="h-9 w-9 border border-ghost bg-surface p-0"
                  onClick={() => setPage((p) => Math.max(0, p - 1))}
                  disabled={page === 0}
                  aria-label={t('bookmarks.paginationPrevious')}
                />
                <Button
                  variant="ghost"
                  size="sm"
                  icon={ChevronRight}
                  className="h-9 w-9 border border-ghost bg-surface p-0"
                  onClick={() => setPage((p) => p + 1)}
                  disabled={page * pageSize + displayedBookmarks.length >= total}
                  aria-label={t('bookmarks.paginationNext')}
                />
              </div>
            </div>
          ) : null}
        </div>
      )}

      {/* Search Engine Setup Guide Note */}
      {displayedBookmarks.length > 0 && (
        <Card className="mt-8 bg-primary/5 border-primary/20 p-4">
          <div className="flex items-start gap-3">
            <div className="flex-shrink-0">
              <div className="h-8 w-8 rounded-lg bg-primary/20 flex items-center justify-center">
                <Copy className="h-4 w-4 text-primary" />
              </div>
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm text-muted-foreground">
                {t('bookmarks.searchEngineNote')}{' '}
                <Link
                  to={`${prefix}/search-engine-guide`}
                  className="text-primary hover:text-primary/90 font-medium underline"
                >
                  {t('bookmarks.searchEngineGuideLink')}
                </Link>
              </p>
            </div>
          </div>
        </Card>
      )}

      <BookmarkModal
        bookmark={editingBookmark}
        folders={folders}
        tags={tags}
        isOpen={modalOpen}
        onClose={handleModalClose}
        onTagCreated={(newTag) => {
          setTags([...tags, newTag]);
        }}
      />

      {sharingBookmark && showSharingUi ? (
        <ShareResourceDialog
          resourceType="bookmark"
          resourceId={sharingBookmark.id}
          resourceName={sharingBookmark.title}
          isOpen={shareDialogOpen}
          onClose={() => { setShareDialogOpen(false); setSharingBookmark(null); }}
          onSuccess={loadData}
        />
      ) : null}

      <ImportModal
        isOpen={importModalOpen}
        onClose={() => setImportModalOpen(false)}
        onSuccess={() => {
          loadData();
        }}
      />

      {/* Bulk Move Modal */}
      {bulkMoveModalOpen && (
        <BulkMoveModal
          isOpen={bulkMoveModalOpen}
          onClose={() => setBulkMoveModalOpen(false)}
          onSave={handleBulkMove}
          folders={folders}
          t={t}
        />
      )}

      {/* Bulk Tag Modal */}
      {bulkTagModalOpen && (
        <BulkTagModal
          isOpen={bulkTagModalOpen}
          onClose={() => setBulkTagModalOpen(false)}
          onSave={handleBulkAddTags}
          tags={tags}
          onTagCreated={(newTag) => setTags([...tags, newTag])}
          t={t}
        />
      )}

      {/* Bulk Share Modal */}
      {bulkShareModalOpen && showSharingUi ? (
        <BulkShareModal
          isOpen={bulkShareModalOpen}
          onClose={() => setBulkShareModalOpen(false)}
          onSave={handleBulkShare}
          teams={teams}
          t={t}
        />
      ) : null}

      <ConfirmDialog {...dialogState} />
    </div>
  );
}


