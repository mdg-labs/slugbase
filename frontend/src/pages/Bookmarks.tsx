import { useState, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import api from '../api/client';
import ConfirmDialog from '../components/ui/ConfirmDialog';
import { useConfirmDialog } from '../hooks/useConfirmDialog';
import { useToast } from '../components/ui/Toast';
import { Plus, LayoutGrid, List, X, CheckSquare, Download, Upload, Bookmark as BookmarkIcon, ExternalLink, FolderPlus, Tag as TagIcon, Share2, Trash2, Copy } from 'lucide-react';
import BookmarkModal from '../components/modals/BookmarkModal';
import ImportModal from '../components/modals/ImportModal';
import Button from '../components/ui/Button';
import Select from '../components/ui/Select';
import BookmarkCard from '../components/bookmarks/BookmarkCard';
import BookmarkTableView from '../components/bookmarks/BookmarkTableView';
import { BulkMoveModal, BulkTagModal, BulkShareModal } from '../components/bookmarks/BulkActionModals';
import { appBasePath } from '../config/api';

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
  const { user } = useAuth();
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
  const [bulkMode, setBulkMode] = useState(false);
  const [bulkMoveModalOpen, setBulkMoveModalOpen] = useState(false);
  const [bulkTagModalOpen, setBulkTagModalOpen] = useState(false);
  const [bulkShareModalOpen, setBulkShareModalOpen] = useState(false);
  const [importModalOpen, setImportModalOpen] = useState(false);
  
  const selectedFolder = searchParams.get('folder_id') || '';
  const selectedTag = searchParams.get('tag_id') || '';
  const [modalOpen, setModalOpen] = useState(false);
  const [editingBookmark, setEditingBookmark] = useState<Bookmark | null>(null);

  useEffect(() => {
    loadData();
  }, [selectedFolder, selectedTag]);

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

  async function loadData() {
    try {
      const [bookmarksRes, foldersRes, tagsRes, teamsRes] = await Promise.all([
        api.get('/bookmarks', { 
          params: { 
            folder_id: selectedFolder || undefined, 
            tag_id: selectedTag || undefined,
            sort_by: sortBy 
          } 
        }),
        api.get('/folders'),
        api.get('/tags'),
        api.get('/teams'),
      ]);
      // Filter to only show own bookmarks (not shared)
      const ownBookmarks = bookmarksRes.data.filter((b: Bookmark) => b.bookmark_type === 'own');
      setBookmarks(ownBookmarks);
      setFolders(foldersRes.data);
      setTags(tagsRes.data);
      setTeams(teamsRes.data);
    } catch (error) {
      console.error('Failed to load data:', error);
    } finally {
      setLoading(false);
    }
  }

  const sortedBookmarks = useMemo(() => {
    const sorted = [...bookmarks];
    switch (sortBy) {
      case 'alphabetical':
        return sorted.sort((a, b) => a.title.localeCompare(b.title));
      case 'most_used':
        return sorted.sort((a, b) => (b.access_count || 0) - (a.access_count || 0));
      case 'recently_accessed':
        return sorted.sort((a, b) => {
          const aDate = a.last_accessed_at ? new Date(a.last_accessed_at).getTime() : 0;
          const bDate = b.last_accessed_at ? new Date(b.last_accessed_at).getTime() : 0;
          return bDate - aDate;
        });
      case 'recently_added':
      default:
        return sorted.sort((a, b) => {
          const aDate = a.created_at ? new Date(a.created_at).getTime() : 0;
          const bDate = b.created_at ? new Date(b.created_at).getTime() : 0;
          return bDate - aDate;
        });
    }
  }, [bookmarks, sortBy]);

  const hasActiveFilters = selectedFolder || selectedTag;

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
      setBulkShareModalOpen(false);
      showToast(t('common.success'), 'success');
    } catch (error) {
      console.error('Failed to share bookmarks:', error);
      showToast(t('common.error'), 'error');
    }
  }

  function handleCopyUrl(bookmark: Bookmark) {
    const baseUrl = window.location.origin;
    const userKey = bookmark.owner_user_key ?? user?.user_key;
    const url = userKey && bookmark.slug ? `${baseUrl}/${userKey}/${bookmark.slug}` : '';
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
    if (selectedBookmarks.size === sortedBookmarks.length) {
      setSelectedBookmarks(new Set());
    } else {
      setSelectedBookmarks(new Set(sortedBookmarks.map(b => b.id)));
    }
  }

  const folderOptions = [
    { value: '', label: t('bookmarks.allFolders') },
    ...folders.map((f) => ({ value: f.id, label: f.name, icon: (f as any).icon })),
  ];

  const tagOptions = [
    { value: '', label: t('bookmarks.allTags') },
    ...tags.map((t) => ({ value: t.id, label: t.name })),
  ];

  const sortOptions = [
    { value: 'recently_added', label: t('bookmarks.sortRecentlyAdded') },
    { value: 'alphabetical', label: t('bookmarks.sortAlphabetical') },
    { value: 'most_used', label: t('bookmarks.sortMostUsed') },
    { value: 'recently_accessed', label: t('bookmarks.sortRecentlyAccessed') },
  ];

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="text-gray-500 dark:text-gray-400">{t('common.loading')}</div>
      </div>
    );
  }

  return (
    <div className="space-y-6 pb-24">
      {/* Sticky Header */}
      <div className="sticky top-0 z-40 bg-gray-50 dark:bg-gray-900 -mx-4 px-4 pt-4 pb-4 border-b border-gray-200 dark:border-gray-700 -mb-4 shadow-sm">
        <div className="flex items-center justify-between flex-wrap gap-4">
          <div>
            <h1 className="text-2xl font-semibold text-gray-900 dark:text-white">
              {t('bookmarks.title')}
            </h1>
            <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">
              {bookmarks.length} {bookmarks.length === 1 ? t('common.bookmark') : t('common.bookmarks')}
            </p>
          </div>
          <div className="flex items-center gap-2">
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
        </div>
      </div>

      {/* Sticky Toolbar: Filters, Sort, View Modes */}
      <div className="sticky top-[140px] z-30 flex flex-wrap items-center gap-3 bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-4 shadow-sm">
        {/* Filters */}
        <div className="flex flex-wrap gap-3 flex-1 min-w-[200px]">
          <div className="flex-1 min-w-[180px]">
            <Select
              value={selectedFolder}
              onChange={(value) => {
                const params = new URLSearchParams(searchParams);
                if (value) {
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
              value={selectedTag}
              onChange={(value) => {
                const params = new URLSearchParams(searchParams);
                if (value) {
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
          {hasActiveFilters && (
            <Button
              variant="secondary"
              size="sm"
              icon={X}
              onClick={handleResetFilters}
            >
              {t('bookmarks.resetFilters')}
            </Button>
          )}
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

        {/* View Mode Toggle */}
        <div className="flex items-center gap-2 border-l border-gray-200 dark:border-gray-700 pl-3">
          <div className="flex items-center gap-1 bg-gray-100 dark:bg-gray-700 rounded-lg p-1">
            <button
              onClick={() => setViewMode('card')}
              className={`p-1.5 rounded transition-colors ${
                viewMode === 'card'
                  ? 'bg-white dark:bg-gray-600 text-blue-600 dark:text-blue-400 shadow-sm'
                  : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'
              }`}
              title={t('bookmarks.viewCard')}
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
              title={t('bookmarks.viewList')}
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
            title={t('bookmarks.compactMode')}
          >
            {t('bookmarks.compactMode')}
          </button>
        </div>
      </div>

      {/* Sticky Bulk Actions Bar */}
      {bulkMode && (
        <div className="fixed bottom-0 left-0 right-0 z-50 flex items-center justify-between bg-blue-50 dark:bg-blue-900/20 border-t border-blue-200 dark:border-blue-800 shadow-lg p-4">
          <div className="flex items-center gap-3">
            <button
              onClick={toggleSelectAll}
              className="text-sm text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300"
            >
              {selectedBookmarks.size === sortedBookmarks.length ? t('bookmarks.deselectAll') : t('bookmarks.selectAll')}
            </button>
            <span className="text-sm text-gray-700 dark:text-gray-300">
              {t('bookmarks.selectedCount', { count: selectedBookmarks.size })}
            </span>
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
              }}
            >
              {t('common.cancel')}
            </Button>
          </div>
        </div>
      )}

      {/* Bulk Actions Toolbar Toggle */}
      {!bulkMode && sortedBookmarks.length > 0 && (
        <div className="flex justify-end">
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

      {/* Bookmarks Display */}
      {sortedBookmarks.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 px-4 bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700">
          <div className="w-16 h-16 rounded-full bg-blue-100 dark:bg-blue-900/30 flex items-center justify-center mb-4">
            <BookmarkIcon className="h-8 w-8 text-blue-600 dark:text-blue-400" />
          </div>
          <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-2">
            {t('bookmarks.empty')}
          </h3>
          <p className="text-sm text-gray-600 dark:text-gray-400 mb-6 text-center max-w-md">
            {t('bookmarks.emptyDescription')}
          </p>
          <div className="flex flex-wrap gap-3 justify-center">
            <Button onClick={handleCreate} variant="primary" icon={Plus}>
              {t('bookmarks.emptyCreateFirst')}
            </Button>
            <Button variant="secondary" icon={Upload} onClick={() => setImportModalOpen(true)}>
              {t('bookmarks.emptyImport')}
            </Button>
            <Link to={`${appBasePath}/search-engine-guide`}>
              <Button variant="ghost" icon={ExternalLink}>
                {t('bookmarks.emptyLearnForwarding')}
              </Button>
            </Link>
          </div>
        </div>
      ) : viewMode === 'card' ? (
        <div className={`grid grid-cols-1 gap-4 ${
          compactMode 
            ? 'sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6' 
            : 'sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4'
        }`}>
          {sortedBookmarks.map((bookmark) => (
            <BookmarkCard
              key={bookmark.id}
              bookmark={bookmark}
              compact={compactMode}
              selected={selectedBookmarks.has(bookmark.id)}
              onSelect={() => toggleSelectBookmark(bookmark.id)}
              onEdit={() => handleEdit(bookmark)}
              onDelete={() => handleDelete(bookmark.id, bookmark.title)}
              onCopyUrl={() => handleCopyUrl(bookmark)}
              onOpen={() => handleOpenBookmark(bookmark)}
              bulkMode={bulkMode}
              t={t}
            />
          ))}
        </div>
      ) : viewMode === 'list' ? (
        <BookmarkTableView
          bookmarks={sortedBookmarks}
          selectedBookmarks={selectedBookmarks}
          onSelect={toggleSelectBookmark}
          onSelectAll={toggleSelectAll}
          onEdit={handleEdit}
          onDelete={handleDelete}
          onCopyUrl={handleCopyUrl}
          onOpen={handleOpenBookmark}
          bulkMode={bulkMode}
          user={user}
          t={t}
          compact={compactMode}
        />
      ) : null}

      {/* Search Engine Setup Guide Note */}
      {sortedBookmarks.length > 0 && (
        <div className="mt-8 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-xl p-4">
          <div className="flex items-start gap-3">
            <div className="flex-shrink-0">
              <div className="h-8 w-8 rounded-lg bg-blue-100 dark:bg-blue-900/30 flex items-center justify-center">
                <Copy className="h-4 w-4 text-blue-600 dark:text-blue-400" />
              </div>
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm text-gray-700 dark:text-gray-300">
                {t('bookmarks.searchEngineNote')}{' '}
                <Link
                  to={`${appBasePath}/search-engine-guide`}
                  className="text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300 font-medium underline"
                >
                  {t('bookmarks.searchEngineGuideLink')}
                </Link>
              </p>
            </div>
          </div>
        </div>
      )}

      <BookmarkModal
        bookmark={editingBookmark}
        folders={folders}
        tags={tags}
        teams={teams}
        isOpen={modalOpen}
        onClose={handleModalClose}
        onTagCreated={(newTag) => {
          setTags([...tags, newTag]);
        }}
      />

      <ImportModal
        isOpen={importModalOpen}
        onClose={() => setImportModalOpen(false)}
        onSuccess={loadData}
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


