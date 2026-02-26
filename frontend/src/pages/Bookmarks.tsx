import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import api from '../api/client';
import ConfirmDialog from '../components/ui/ConfirmDialog';
import { useConfirmDialog } from '../hooks/useConfirmDialog';
import { useToast } from '../components/ui/Toast';
import { Plus, LayoutGrid, List, CheckSquare, Download, Upload, Bookmark as BookmarkIcon, ExternalLink, FolderPlus, Tag as TagIcon, Share2, Trash2, Copy, ChevronLeft, ChevronRight, Pin, Search } from 'lucide-react';
import BookmarkModal from '../components/modals/BookmarkModal';
import ImportModal from '../components/modals/ImportModal';
import ShareResourceDialog from '../components/sharing/ShareResourceDialog';
import Button from '../components/ui/Button';
import Select from '../components/ui/Select';
import BookmarkCard from '../components/bookmarks/BookmarkCard';
import BookmarkTableView from '../components/bookmarks/BookmarkTableView';
import { BulkMoveModal, BulkTagModal, BulkShareModal } from '../components/bookmarks/BulkActionModals';
import { FilterChips, type FilterKey } from '../components/bookmarks/FilterChips';
import { ScopeSegmentedControl } from '../components/ScopeSegmentedControl';
import { PageLoadingSkeleton } from '../components/ui/PageLoadingSkeleton';
import { Card } from '../components/ui/card';
import { PageHeader } from '../components/PageHeader';
import { useSidebar } from '../components/ui/sidebar';
import { useAppConfig } from '../contexts/AppConfigContext';

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

type ViewMode = 'card' | 'list';
type SortOption = 'recently_added' | 'alphabetical' | 'most_used' | 'recently_accessed';

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
  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    const saved = localStorage.getItem('bookmarks-view-mode');
    return (saved === 'list' || saved === 'card') ? saved : 'card';
  });
  const [compactMode, setCompactMode] = useState(() => {
    return localStorage.getItem('bookmarks-compact-mode') === 'true';
  });
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
  const pinnedFilter = searchParams.get('pinned') === 'true';
  const searchQuery = searchParams.get('q') || '';
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
    setPage(0);
    setAllSelectedAcrossPages(false);
  }, [selectedFolder, selectedTag, sortBy, scope, pinnedFilter, searchQuery, pageSize]);

  useEffect(() => {
    loadData();
  }, [selectedFolder, selectedTag, sortBy, page, scope, pinnedFilter, searchQuery, pageSize]);

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
    localStorage.setItem('bookmarks-view-mode', viewMode);
  }, [viewMode]);

  useEffect(() => {
    localStorage.setItem('bookmarks-compact-mode', compactMode.toString());
  }, [compactMode]);

  useEffect(() => {
    setSearchInputValue(searchQuery);
  }, [searchQuery]);

  async function loadData() {
    try {
      const [bookmarksRes, foldersRes, tagsRes, teamsRes] = await Promise.all([
        api.get('/bookmarks', {
          params: {
            folder_id: selectedFolder || undefined,
            tag_id: selectedTag || undefined,
            sort_by: sortBy,
            limit: pageSize,
            offset: page * pageSize,
            scope: scope !== 'all' ? scope : undefined,
            pinned: pinnedFilter ? 'true' : undefined,
            q: searchQuery.trim() || undefined,
          },
        }),
        api.get('/folders'),
        api.get('/tags'),
        api.get('/teams'),
      ]);
      const payload = bookmarksRes.data;
      const items = payload.items ?? [];
      setTotal(payload.total ?? 0);
      setBookmarks(items);
      setFolders(foldersRes.data);
      setTags(tagsRes.data);
      setTeams(teamsRes.data);
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
    scope !== 'all' ||
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

  async function handlePinToggle(bookmark: Bookmark) {
    if (bookmark.bookmark_type !== 'own') return;
    try {
      await api.put(`/bookmarks/${bookmark.id}`, { pinned: !bookmark.pinned });
      loadData();
      showToast(bookmark.pinned ? t('bookmarks.unpinned') : t('bookmarks.pinned'), 'success');
    } catch {
      showToast(t('common.error'), 'error');
    }
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
          scope: scope !== 'all' ? scope : undefined,
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
    if (scope === 'mine') {
      list.push({ key: 'scope', label: t('bookmarks.scopeMine'), ariaLabel: t('bookmarks.clearFilters') + ' ' + t('bookmarks.scopeMine') });
    }
    if (scope === 'shared_with_me') {
      list.push({ key: 'scope', label: t('common.scopeSharedWithMe'), ariaLabel: t('bookmarks.clearFilters') + ' ' + t('common.scopeSharedWithMe') });
    }
    if (scope === 'shared_by_me') {
      list.push({ key: 'scope', label: t('common.scopeSharedByMe'), ariaLabel: t('bookmarks.clearFilters') + ' ' + t('common.scopeSharedByMe') });
    }
    return list;
  })();

  if (loading) {
    return <PageLoadingSkeleton lines={6} />;
  }

  return (
    <div className="space-y-6 pb-24">
      {/* Sticky controls bar: header + filters/toolbar - stays visible when scrolling */}
      <div className="sticky top-0 z-40 space-y-4 pb-4 -mx-4 sm:-mx-6 lg:-mx-8 px-4 sm:px-6 lg:px-8 pt-0 -mt-8 bg-background shadow-sm">
        <PageHeader
          className="pt-4"
          title={`${t('bookmarks.title')} (${total})`}
          subtitle={
            hasActiveFilters
              ? t('bookmarks.showingXOfY', { x: displayedBookmarks.length, y: total })
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
            <Button
              variant={pinnedFilter ? 'secondary' : 'ghost'}
              size="sm"
              icon={Pin}
              onClick={() => updateParams({ pinned: pinnedFilter ? undefined : 'true' })}
              title={t('bookmarks.pinned')}
              aria-pressed={pinnedFilter}
            >
              <span className="hidden sm:inline">{t('bookmarks.pinned')}</span>
            </Button>
            <Button
              variant="ghost"
              size="sm"
              icon={Upload}
              onClick={() => setImportModalOpen(true)}
              title={t('bookmarks.import')}
            >
              <span className="hidden sm:inline">{t('bookmarks.import')}</span>
            </Button>
            <Button
              variant="ghost"
              size="sm"
              icon={Download}
              onClick={handleExport}
              title={t('bookmarks.export')}
            >
              <span className="hidden sm:inline">{t('bookmarks.export')}</span>
            </Button>
            <Button onClick={handleCreate} icon={Plus}>
              {t('bookmarks.create')}
            </Button>
          </div>
        }
        />

        <FilterChips
          chips={filterChips}
          onRemove={(key) => handleRemoveFilter(key as FilterKey)}
          onClearAll={handleResetFilters}
          clearAllLabel={t('bookmarks.clearAllFilters')}
          clearAllAriaLabel={t('bookmarks.clearAllFilters')}
        />

        {/* Toolbar: Search, Filters, Sort, View Modes */}
        <div className="flex flex-wrap items-center gap-3 bg-card rounded-lg border p-4 shadow-sm">
        <div className="flex items-center gap-2 min-w-[200px] flex-1">
          <Search className="h-4 w-4 text-muted-foreground flex-shrink-0" aria-hidden />
          <input
            type="search"
            value={searchInputValue}
            onChange={(e) => setSearchInputValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') updateParams({ q: (e.target as HTMLInputElement).value.trim() || undefined });
            }}
            placeholder={t('common.searchPlaceholder')}
            className="flex-1 min-w-0 rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            aria-label={t('common.searchPlaceholder')}
          />
        </div>
        {/* Filters */}
        <div className="flex flex-wrap gap-3 flex-1 min-w-[200px]">
          <div className="flex-1 min-w-[180px]">
            <Select
              value={selectedFolder || ALL_FILTER}
              onChange={(value) => {
                const params = new URLSearchParams(searchParams);
                if (value && value !== ALL_FILTER) {
                  params.set('folder_id', value);
                } else {
                  params.delete('folder_id');
                }
                setSearchParams(params);
              }}
              options={folderOptions}
              placeholder={t('bookmarks.filterByFolder')}
            />
          </div>
          <div className="flex-1 min-w-[180px]">
            <Select
              value={selectedTag || ALL_FILTER}
              onChange={(value) => {
                const params = new URLSearchParams(searchParams);
                if (value && value !== ALL_FILTER) {
                  params.set('tag_id', value);
                } else {
                  params.delete('tag_id');
                }
                setSearchParams(params);
              }}
              options={tagOptions}
              placeholder={t('bookmarks.filterByTag')}
            />
          </div>
        </div>

        {/* Sort */}
        <div className="flex items-center gap-2">
          <Select
            value={sortBy}
            onChange={(value) => setSortBy(value as SortOption)}
            options={sortOptions}
            className="min-w-[160px]"
          />
        </div>

        {/* Page size */}
        <div className="flex items-center gap-2">
          <Select
            value={String(pageSize)}
            onChange={(value) => {
              updateParams({ limit: value });
              setPage(0);
            }}
            options={PAGE_SIZE_OPTIONS.map((n) => ({ value: String(n), label: String(n) }))}
            className="min-w-[80px]"
          />
          <span className="text-sm text-muted-foreground whitespace-nowrap">{t('bookmarks.perPage')}</span>
        </div>

        {/* View Mode Toggle */}
        <div className="flex items-center gap-2 border-l border-gray-200 dark:border-gray-700 pl-3">
          <div className="flex items-center gap-1 bg-gray-100 dark:bg-gray-700 rounded-lg p-1">
            <button
              onClick={() => setViewMode('card')}
              className={`p-1.5 rounded transition-colors ${
                viewMode === 'card'
                  ? 'bg-card text-primary shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
              title={t('bookmarks.viewCard')}
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
              title={t('bookmarks.viewList')}
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
            title={t('bookmarks.compactMode')}
          >
            {t('bookmarks.compactMode')}
          </button>
        </div>

        {/* Bulk Select Toggle */}
        {!bulkMode && displayedBookmarks.length > 0 && (
          <div className="flex items-center gap-2 border-l border-gray-200 dark:border-gray-700 pl-3">
            <Button
              variant="ghost"
              size="sm"
              icon={CheckSquare}
              onClick={() => setBulkMode(true)}
            >
              {t('bookmarks.bulkSelect')}
            </Button>
          </div>
        )}
        </div>
      </div>

      {/* Bulk Actions Bar - sticky bottom, visible when selecting */}
      {bulkMode && (
        <div
          className="fixed bottom-0 right-0 z-50 flex items-center justify-between bg-background border-t-2 border-primary shadow-[0_-4px_12px_rgba(0,0,0,0.08)] dark:shadow-[0_-4px_12px_rgba(0,0,0,0.3)] p-4"
          style={
            !isMobile
              ? { left: sidebarState === 'expanded' ? '16rem' : '3rem' }
              : { left: 0 }
          }
        >
          <div className="flex items-center gap-3">
            {(allSelectedAcrossPages || selectedBookmarks.size === total) && total > 0 ? (
              <>
                <span className="text-sm text-gray-700 dark:text-gray-300">
                  {t('bookmarks.allSelected', { total })}
                </span>
                <button
                  onClick={handleDeselectAll}
                  className="text-sm text-primary hover:text-primary/90"
                >
                  {t('bookmarks.deselectAll')}
                </button>
              </>
            ) : selectedBookmarks.size === displayedBookmarks.length && displayedBookmarks.length > 0 && total > pageSize ? (
              <>
                <span className="text-sm text-gray-700 dark:text-gray-300">
                  {t('bookmarks.selectAllOnPageAndRemaining', { pageCount: displayedBookmarks.length, total })}
                </span>
                <button
                  onClick={handleSelectAllRemaining}
                  className="text-sm text-primary hover:text-primary/90"
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
                  onClick={toggleSelectAll}
                  className="text-sm text-primary hover:text-primary/90"
                >
                  {selectedBookmarks.size === displayedBookmarks.length ? t('bookmarks.deselectAll') : t('bookmarks.selectAll')}
                </button>
              </>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              icon={FolderPlus}
              onClick={() => setBulkMoveModalOpen(true)}
              disabled={selectedBookmarks.size === 0}
            >
              {t('bookmarks.bulkMoveToFolder')}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              icon={TagIcon}
              onClick={() => setBulkTagModalOpen(true)}
              disabled={selectedBookmarks.size === 0}
            >
              {t('bookmarks.bulkAddTags')}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              icon={Share2}
              onClick={() => setBulkShareModalOpen(true)}
              disabled={selectedBookmarks.size === 0}
            >
              {t('bookmarks.bulkShare')}
            </Button>
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
        <Card className="flex flex-col items-center justify-center py-20 px-4">
          <div className="w-16 h-16 rounded-full bg-primary/20 flex items-center justify-center mb-4">
            <BookmarkIcon className="h-8 w-8 text-primary" />
          </div>
          <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-2">
            {hasActiveFilters ? t('bookmarks.noMatches') : t('bookmarks.empty')}
          </h3>
          <p className="text-sm text-gray-600 dark:text-gray-400 mb-6 text-center max-w-md">
            {hasActiveFilters ? '' : t('bookmarks.emptyDescription')}
          </p>
          <div className="flex flex-wrap gap-3 justify-center">
            {hasActiveFilters ? (
              <Button onClick={handleResetFilters} variant="primary">
                {t('bookmarks.clearFilters')}
              </Button>
            ) : (
              <>
                <Button onClick={handleCreate} variant="primary" icon={Plus}>
                  {t('bookmarks.emptyCreateFirst')}
                </Button>
                <Button
                  variant="secondary"
                  icon={Upload}
                  onClick={() => setImportModalOpen(true)}
                >
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
      ) : viewMode === 'card' ? (
        <div className={`grid grid-cols-1 gap-3 items-stretch ${
          compactMode 
            ? 'sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-8' 
            : 'sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6'
        }`}>
          {displayedBookmarks.map((bookmark) => (
            <BookmarkCard
              key={bookmark.id}
              bookmark={bookmark}
              compact={compactMode}
              selected={selectedBookmarks.has(bookmark.id)}
              onSelect={() => toggleSelectBookmark(bookmark.id)}
              onEdit={() => handleEdit(bookmark)}
              onDelete={() => handleDelete(bookmark.id, bookmark.title)}
              onCopyUrl={() => handleCopyUrl(bookmark)}
              onShare={() => { setSharingBookmark(bookmark); setShareDialogOpen(true); }}
              onOpen={() => handleOpenBookmark(bookmark)}
              onPinToggle={bookmark.bookmark_type === 'own' ? () => handlePinToggle(bookmark) : undefined}
              bulkMode={bulkMode}
              t={t}
            />
          ))}
        </div>
      ) : viewMode === 'list' ? (
        <BookmarkTableView
          bookmarks={displayedBookmarks}
          selectedBookmarks={selectedBookmarks}
          onSelect={toggleSelectBookmark}
          onSelectAll={toggleSelectAll}
          onEdit={handleEdit}
          onDelete={handleDelete}
          onCopyUrl={handleCopyUrl}
          onShare={(bookmark) => { setSharingBookmark(bookmark); setShareDialogOpen(true); }}
          onOpen={handleOpenBookmark}
          bulkMode={bulkMode}
          user={user}
          t={t}
          compact={compactMode}
        />
      ) : null}

      {/* Pagination */}
      {total > pageSize && displayedBookmarks.length > 0 && (
        <div className="flex items-center justify-between gap-4 mt-6 py-4 border-t border-gray-200 dark:border-gray-700">
          <p className="text-sm text-gray-600 dark:text-gray-400">
            {t('bookmarks.paginationShowing', {
              from: page * pageSize + 1,
              to: Math.min(page * pageSize + displayedBookmarks.length, total),
              total,
            })}
          </p>
          <div className="flex gap-2">
            <Button
              variant="secondary"
              size="sm"
              icon={ChevronLeft}
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={page === 0}
            >
              {t('bookmarks.paginationPrevious')}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              icon={ChevronRight}
              iconPosition="right"
              onClick={() => setPage((p) => p + 1)}
              disabled={page * pageSize + displayedBookmarks.length >= total}
            >
              {t('bookmarks.paginationNext')}
            </Button>
          </div>
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
              <p className="text-sm text-gray-700 dark:text-gray-300">
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

      {sharingBookmark && (
        <ShareResourceDialog
          resourceType="bookmark"
          resourceId={sharingBookmark.id}
          resourceName={sharingBookmark.title}
          isOpen={shareDialogOpen}
          onClose={() => { setShareDialogOpen(false); setSharingBookmark(null); }}
          onSuccess={loadData}
        />
      )}

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
      {bulkShareModalOpen && (
        <BulkShareModal
          isOpen={bulkShareModalOpen}
          onClose={() => setBulkShareModalOpen(false)}
          onSave={handleBulkShare}
          teams={teams}
          t={t}
        />
      )}

      <ConfirmDialog {...dialogState} />
    </div>
  );
}


