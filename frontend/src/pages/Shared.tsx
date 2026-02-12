import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { isCloud } from '../config/mode';
import api from '../api/client';
import { useToast } from '../components/ui/Toast';
import { Share2, ExternalLink, Copy, Tag as TagIcon, Users, User } from 'lucide-react';
import Button from '../components/ui/Button';
import Favicon from '../components/Favicon';
import FolderIcon from '../components/FolderIcon';
import { PageLoadingSkeleton } from '../components/ui/PageLoadingSkeleton';

interface SharedBookmark {
  id: string;
  title: string;
  url: string;
  slug: string;
  forwarding_enabled: boolean;
  /** Owner's user_key for canonical forwarding URL */
  owner_user_key?: string;
  folders?: Array<{ id: string; name: string }>;
  tags?: Array<{ id: string; name: string }>;
  shared_teams?: Array<{ id: string; name: string }>;
  shared_users?: Array<{ id: string; name: string; email: string }>;
  user_id: string;
  user_name?: string;
  user_email?: string;
}

interface SharedFolder {
  id: string;
  name: string;
  icon?: string | null;
  shared_teams?: Array<{ id: string; name: string }>;
  shared_users?: Array<{ id: string; name: string; email: string }>;
  user_id: string;
  user_name?: string;
  user_email?: string;
  bookmark_count?: number;
}

export default function Shared() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const { showToast } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const [bookmarks, setBookmarks] = useState<SharedBookmark[]>([]);
  const [folders, setFolders] = useState<SharedFolder[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'bookmarks' | 'folders'>('bookmarks');
  const selectedFolderId = searchParams.get('folder_id') || '';

  useEffect(() => {
    loadData();
  }, [selectedFolderId]);

  async function loadData() {
    try {
      const [bookmarksRes, foldersRes] = await Promise.all([
        api.get('/bookmarks', { params: { folder_id: selectedFolderId || undefined } }),
        api.get('/folders'),
      ]);
      
      // Filter to only shared items (not owned by current user)
      const sharedBookmarks = bookmarksRes.data.filter((b: SharedBookmark) => b.user_id !== user?.id && (b as any).bookmark_type === 'shared');
      const sharedFolders = foldersRes.data.filter((f: SharedFolder) => f.user_id !== user?.id && (f as any).folder_type === 'shared');
      
      setBookmarks(sharedBookmarks);
      setFolders(sharedFolders);
    } catch (error) {
      console.error('Failed to load shared data:', error);
    } finally {
      setLoading(false);
    }
  }

  function handleFolderClick(folderId: string) {
    setSearchParams({ folder_id: folderId });
    setActiveTab('bookmarks'); // Switch to bookmarks tab when filtering by folder
  }

  function handleCopyUrl(bookmark: SharedBookmark) {
    const baseUrl = window.location.origin;
    const url = bookmark.slug ? `${baseUrl}/go/${bookmark.slug}` : '';
    if (url) {
      navigator.clipboard.writeText(url);
      showToast(t('bookmarks.copied'), 'success');
    }
  }

  if (loading) {
    return <PageLoadingSkeleton lines={6} />;
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-semibold text-gray-900 dark:text-white flex items-center gap-3">
          <Share2 className="h-8 w-8" />
          {t('shared.title')}
        </h1>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          {t('shared.description')}
        </p>
        {selectedFolderId && (
          <div className="mt-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setSearchParams({})}
              className="text-xs"
            >
              {t('common.clearFilter')}
            </Button>
          </div>
        )}
      </div>

      {/* Tabs */}
      <div className="flex gap-2 border-b border-gray-200 dark:border-gray-700">
        <button
          onClick={() => setActiveTab('bookmarks')}
          className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 ${
            activeTab === 'bookmarks'
              ? 'border-blue-500 text-blue-600 dark:text-blue-400'
              : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'
          }`}
        >
          {t('shared.bookmarks')} ({bookmarks.length})
        </button>
        <button
          onClick={() => setActiveTab('folders')}
          className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 ${
            activeTab === 'folders'
              ? 'border-blue-500 text-blue-600 dark:text-blue-400'
              : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'
          }`}
        >
          {t('shared.folders')} ({folders.length})
        </button>
      </div>

      {/* Content */}
      {activeTab === 'bookmarks' ? (
        bookmarks.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 px-4 bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700">
            <Share2 className="h-12 w-12 text-gray-400 dark:text-gray-500 mb-4" />
            <p className="text-gray-500 dark:text-gray-400 text-lg">{t('shared.noBookmarks')}</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {bookmarks.map((bookmark) => (
              <div
                key={bookmark.id}
                className="group bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 hover:border-blue-400 dark:hover:border-blue-500 hover:shadow-lg transition-all duration-200 flex flex-col"
              >
                <div className="p-4 space-y-3 flex-1 flex flex-col">
                  {/* Header with icon */}
                  <div className="flex items-start gap-3">
                    <div className="flex-shrink-0 w-12 h-12 rounded-xl bg-gradient-to-br from-blue-50 to-blue-100 dark:from-blue-900/30 dark:to-blue-800/20 flex items-center justify-center border border-blue-100 dark:border-blue-800/50 overflow-hidden">
                      <Favicon url={bookmark.url} size={24} />
                    </div>
                    <div className="flex-1 min-w-0 pt-0.5">
                      <h3 className="text-[15px] font-medium text-gray-900 dark:text-white line-clamp-2 leading-snug mb-1.5">
                        {bookmark.title}
                      </h3>
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-300 rounded-md border border-green-200 dark:border-green-800/50">
                        <Share2 className="h-3 w-3" />
                        {t('bookmarks.shared')}
                      </span>
                    </div>
                  </div>

                  {/* Shared by (in CLOUD avoid exposing owner email) */}
                  <div className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400 px-1">
                    <User className="h-3 w-3" />
                    <span className="truncate">
                      {isCloud
                        ? (bookmark.user_name || t('shared.sharedWithYou'))
                        : (bookmark.user_name || bookmark.user_email || t('shared.unknownUser'))}
                    </span>
                  </div>

                  {/* URL */}
                  <p className="text-xs text-gray-500 dark:text-gray-400 truncate flex items-center gap-1.5 px-1">
                    <ExternalLink className="h-3 w-3 flex-shrink-0 opacity-60" />
                    <span className="truncate">{bookmark.url}</span>
                  </p>

                  {/* Tags & Folders */}
                  {((bookmark.folders && bookmark.folders.length > 0) || (bookmark.tags && bookmark.tags.length > 0)) && (
                    <div className="flex flex-wrap gap-1.5">
                    {bookmark.folders?.slice(0, 2).map((folder) => (
                      <span
                        key={folder.id}
                        onClick={(e) => {
                          e.stopPropagation();
                          handleFolderClick(folder.id);
                        }}
                        className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300 rounded-md border border-blue-200 dark:border-blue-800/50 cursor-pointer hover:bg-blue-100 dark:hover:bg-blue-900/30 transition-colors"
                      >
                        <FolderIcon iconName={(folder as any).icon} size={12} className="text-blue-700 dark:text-blue-300" />
                        {folder.name}
                      </span>
                    ))}
                      {bookmark.tags?.slice(0, 2).map((tag) => (
                        <span
                          key={tag.id}
                          className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium bg-purple-50 dark:bg-purple-900/20 text-purple-700 dark:text-purple-300 rounded-md border border-purple-200 dark:border-purple-800/50"
                        >
                          <TagIcon className="h-3 w-3" />
                          {tag.name}
                        </span>
                      ))}
                    </div>
                  )}

                  {/* Forwarding URL */}
                  {bookmark.forwarding_enabled && (
                    <div className="flex items-center gap-2 px-3 py-2 bg-gray-50 dark:bg-gray-900/30 rounded-lg border border-gray-200 dark:border-gray-700">
                      <code className="text-xs font-mono text-gray-700 dark:text-gray-300 truncate flex-1">
                        /{bookmark.slug}
                      </code>
                      <button
                        onClick={() => handleCopyUrl(bookmark)}
                        className="flex-shrink-0 p-1.5 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 rounded-md hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
                        title={t('bookmarks.copyUrl')}
                      >
                        <Copy className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  )}

                  {/* Actions */}
                  <div className="pt-3 mt-auto border-t border-gray-100 dark:border-gray-700/50">
                    <a
                      href={bookmark.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="w-full"
                    >
                      <Button variant="primary" size="sm" icon={ExternalLink} className="w-full text-xs">
                        {t('bookmarks.open')}
                      </Button>
                    </a>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )
      ) : (
        folders.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 px-4 bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700">
            <Share2 className="h-12 w-12 text-gray-400 dark:text-gray-500 mb-4" />
            <p className="text-gray-500 dark:text-gray-400 text-lg">{t('shared.noFolders')}</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {folders.map((folder) => (
              <div
                key={folder.id}
                onClick={() => handleFolderClick(folder.id)}
                className="group bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 hover:border-blue-400 dark:hover:border-blue-500 hover:shadow-lg transition-all duration-200 flex flex-col cursor-pointer"
              >
                <div className="p-4 space-y-3 flex-1 flex flex-col">
                  {/* Header with icon */}
                  <div className="flex items-start gap-3">
                    <div className="flex-shrink-0 w-12 h-12 rounded-xl bg-gradient-to-br from-blue-50 to-blue-100 dark:from-blue-900/30 dark:to-blue-800/20 flex items-center justify-center border border-blue-100 dark:border-blue-800/50">
                      <FolderIcon iconName={folder.icon} size={24} className="text-blue-600 dark:text-blue-400" />
                    </div>
                    <div className="flex-1 min-w-0 pt-0.5">
                      <h3 className="text-[15px] font-medium text-gray-900 dark:text-white truncate mb-1.5">
                        {folder.name}
                      </h3>
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-300 rounded-md border border-green-200 dark:border-green-800/50">
                        <Share2 className="h-3 w-3" />
                        {t('folders.shared')}
                      </span>
                    </div>
                  </div>

                  {/* Shared by (in CLOUD avoid exposing owner email) */}
                  <div className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400 px-1">
                    <User className="h-3 w-3" />
                    <span className="truncate">
                      {isCloud
                        ? (folder.user_name || t('shared.sharedWithYou'))
                        : (folder.user_name || folder.user_email || t('shared.unknownUser'))}
                    </span>
                  </div>

                  {/* Sharing info */}
                  <div className="flex flex-wrap gap-1.5">
                    {folder.shared_teams && folder.shared_teams.length > 0 && (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium bg-indigo-50 dark:bg-indigo-900/20 text-indigo-700 dark:text-indigo-300 rounded-md border border-indigo-200 dark:border-indigo-800/50">
                        <Users className="h-3 w-3" />
                        {folder.shared_teams.length}
                      </span>
                    )}
                    {folder.shared_users && folder.shared_users.length > 0 && (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300 rounded-md border border-blue-200 dark:border-blue-800/50">
                        <User className="h-3 w-3" />
                        {folder.shared_users.length}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )
      )}
    </div>
  );
}
