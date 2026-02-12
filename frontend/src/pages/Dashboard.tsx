import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useEffect, useState } from 'react';
import { Bookmark, Folder, Tag, Share2, Clock, TrendingUp, Plus, Edit, Trash2, Copy, ExternalLink, ArrowRight } from 'lucide-react';
import Button from '../components/ui/Button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { Badge } from '../components/ui/badge';
import { PageHeader } from '../components/PageHeader';
import { StatCard } from '../components/StatCard';
import { EmptyState } from '../components/EmptyState';
import Tooltip from '../components/ui/Tooltip';
import api from '../api/client';
import { appBasePath } from '../config/api';
import { useOrgPlan } from '../contexts/OrgPlanContext';
import { canCreateBookmark } from '../utils/plan';
import { useConfirmDialog } from '../hooks/useConfirmDialog';
import { useToast } from '../components/ui/Toast';
import ConfirmDialog from '../components/ui/ConfirmDialog';

interface RecentBookmark {
  id: string;
  title: string;
  url: string;
  created_at: string;
  last_accessed_at?: string | null;
  folder_names?: string[];
  tag_names?: string[];
}

interface DashboardStats {
  totalBookmarks: number;
  totalFolders: number;
  totalTags: number;
  sharedBookmarks: number;
  sharedFolders: number;
  recentBookmarks: RecentBookmark[];
  topTags: Array<{ id: string; name: string; bookmark_count: number }>;
}

function formatLastOpened(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / (24 * 60 * 60 * 1000));
  if (diffDays === 0) return 'today';
  if (diffDays === 1) return 'yesterday';
  if (diffDays < 7) return `${diffDays} days ago`;
  if (diffDays < 30) return `${Math.floor(diffDays / 7)} weeks ago`;
  return date.toLocaleDateString();
}

export default function Dashboard() {
  const { t } = useTranslation();
  const { plan, bookmarkCount, bookmarkLimit, refresh } = useOrgPlan();
  const { showConfirm, dialogState } = useConfirmDialog();
  const { showToast } = useToast();
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [denseMode, setDenseMode] = useState(() => localStorage.getItem('dashboard-dense') === 'true');
  const atBookmarkLimit = !canCreateBookmark(plan, bookmarkCount, bookmarkLimit);

  useEffect(() => {
    loadStats();
  }, []);

  useEffect(() => {
    localStorage.setItem('dashboard-dense', String(denseMode));
  }, [denseMode]);

  async function loadStats() {
    try {
      const res = await api.get('/dashboard/stats');
      setStats(res.data);
    } catch (error) {
      console.error('Failed to load dashboard stats:', error);
    }
  }

  function handleCopyUrl(bookmark: RecentBookmark) {
    navigator.clipboard.writeText(bookmark.url);
    showToast(t('common.copied'), 'success');
  }

  function handleDeleteBookmark(bookmark: RecentBookmark) {
    showConfirm(
      t('bookmarks.deleteBookmark'),
      t('bookmarks.deleteConfirmWithName', { name: bookmark.title }),
      async () => {
        try {
          await api.delete(`/bookmarks/${bookmark.id}`);
          loadStats();
          refresh();
          showToast(t('common.success'), 'success');
        } catch (error) {
          console.error('Failed to delete bookmark:', error);
          showToast(t('common.error'), 'error');
        }
      },
      { variant: 'danger', confirmText: t('common.delete'), cancelText: t('common.cancel') }
    );
  }

  const cards = [
    { to: appBasePath + '/bookmarks', icon: Bookmark, title: t('bookmarks.title'), description: t('dashboard.bookmarksDescription'), color: 'blue' },
    { to: appBasePath + '/folders', icon: Folder, title: t('folders.title'), description: t('dashboard.foldersDescription'), color: 'green' },
    { to: appBasePath + '/tags', icon: Tag, title: t('tags.title'), description: t('dashboard.tagsDescription'), color: 'purple' },
  ];

  const colorClasses = {
    blue: 'bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400 border-blue-200 dark:border-blue-800',
    green: 'bg-green-50 dark:bg-green-900/20 text-green-600 dark:text-green-400 border-green-200 dark:border-green-800',
    purple: 'bg-purple-50 dark:bg-purple-900/20 text-purple-600 dark:text-purple-400 border-purple-200 dark:border-purple-800',
  };

  return (
    <div className="space-y-8">
      <PageHeader
        title={t('dashboard.overview')}
        subtitle={t('dashboard.overviewSubtitle')}
        actions={
          <div className="flex items-center gap-2">
            <Link to={appBasePath + '/folders'} className="text-sm text-muted-foreground hover:text-foreground transition-colors">
              {t('dashboard.createFolder')}
            </Link>
            <span className="text-muted-foreground">·</span>
            <Link to={appBasePath + '/tags'} className="text-sm text-muted-foreground hover:text-foreground transition-colors">
              {t('dashboard.createTag')}
            </Link>
            {atBookmarkLimit ? (
              <Link to={`${appBasePath}/admin?tab=billing`}>
                <Button variant="secondary" size="lg" icon={Plus} title={t('plan.limitBookmarks')}>
                  {t('plan.upgradeCta')}
                </Button>
              </Link>
            ) : (
              <Link to={`${appBasePath}/bookmarks?create=true`}>
                <Button variant="primary" size="lg" icon={Plus}>
                  {t('bookmarks.create')}
                </Button>
              </Link>
            )}
          </div>
        }
      />

      {stats && (
        <div className={denseMode ? 'space-y-4' : 'space-y-6'}>
          <div className="flex items-center justify-between flex-wrap gap-2">
            <h2 className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
              {t('dashboard.yourLibrary')}
            </h2>
            <button
              type="button"
              onClick={() => setDenseMode(!denseMode)}
              className={`px-3 py-1.5 text-sm rounded-lg transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-gray-900 ${
                denseMode
                  ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300'
                  : 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-600'
              }`}
              title={t('dashboard.denseView')}
            >
              {t('dashboard.denseView')}
            </button>
          </div>

          <div className={`grid grid-cols-1 gap-4 sm:grid-cols-3 ${denseMode ? 'gap-3' : ''}`}>
            <StatCard
              label={t('dashboard.totalBookmarks')}
              value={bookmarkLimit != null ? t('plan.bookmarksUsed', { count: bookmarkCount, limit: bookmarkLimit }) : stats.totalBookmarks}
              icon={Bookmark}
              href={appBasePath + '/bookmarks'}
              iconContainerClassName="bg-blue-100 dark:bg-blue-900/20"
              iconColorClassName="text-blue-600 dark:text-blue-400"
            />
            <StatCard
              label={t('dashboard.totalFolders')}
              value={stats.totalFolders}
              icon={Folder}
              href={appBasePath + '/folders'}
              iconContainerClassName="bg-green-100 dark:bg-green-900/20"
              iconColorClassName="text-green-600 dark:text-green-400"
            />
            <StatCard
              label={t('dashboard.totalTags')}
              value={stats.totalTags}
              icon={Tag}
              href={appBasePath + '/tags'}
              iconContainerClassName="bg-purple-100 dark:bg-purple-900/20"
              iconColorClassName="text-purple-600 dark:text-purple-400"
            />
          </div>

          <p className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400 pt-2">
            {t('dashboard.sharedWithYou')}
          </p>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <StatCard
              label={t('dashboard.sharedBookmarks')}
              value={stats.sharedBookmarks}
              icon={Share2}
              href={appBasePath + '/shared'}
              iconContainerClassName={stats.sharedBookmarks === 0 ? 'bg-muted' : 'bg-green-100 dark:bg-green-900/20'}
              iconColorClassName={stats.sharedBookmarks === 0 ? 'text-muted-foreground' : 'text-green-600 dark:text-green-400'}
            />
            <StatCard
              label={t('dashboard.sharedFolders')}
              value={stats.sharedFolders}
              icon={Share2}
              href={appBasePath + '/shared'}
              iconContainerClassName={stats.sharedFolders === 0 ? 'bg-muted' : 'bg-green-100 dark:bg-green-900/20'}
              iconColorClassName={stats.sharedFolders === 0 ? 'text-muted-foreground' : 'text-green-600 dark:text-green-400'}
            />
          </div>

          <div className={`grid grid-cols-1 lg:grid-cols-2 ${denseMode ? 'gap-4' : 'gap-6'}`}>
            <Card>
              <CardHeader className={denseMode ? 'p-3 pb-2' : 'p-4 pb-2'}>
                <CardTitle className="flex items-center gap-2 text-[15px]">
                  <Clock className="h-5 w-5 text-muted-foreground" />
                  {t('dashboard.recentBookmarks')}
                </CardTitle>
              </CardHeader>
              <CardContent className={denseMode ? 'p-3 pt-0' : 'p-4 pt-0'}>
                {stats.recentBookmarks.length > 0 ? (
                  <div className="space-y-3">
                    {stats.recentBookmarks.map((bookmark) => (
                      <div
                        key={bookmark.id}
                        className="group/bookmark flex items-start gap-2 p-3 rounded-lg border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors"
                      >
                        <a
                          href={bookmark.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex-1 min-w-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 rounded"
                          title={t('dashboard.openBookmark')}
                        >
                          <p className="text-sm font-medium text-gray-900 dark:text-white line-clamp-1">
                            {bookmark.title}
                          </p>
                          <p className="text-xs text-gray-500 dark:text-gray-400 mt-1 truncate">
                            {bookmark.url}
                          </p>
                          {(bookmark.folder_names?.length || bookmark.tag_names?.length || bookmark.last_accessed_at) ? (
                            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 mt-2 text-xs text-gray-500 dark:text-gray-400">
                              {bookmark.folder_names?.length ? (
                                <span className="inline-flex items-center gap-1">
                                  <Folder className="h-3 w-3" />
                                  {bookmark.folder_names.slice(0, 2).join(', ')}
                                </span>
                              ) : null}
                              {bookmark.tag_names?.length ? (
                                <span className="inline-flex items-center gap-1">
                                  <Tag className="h-3 w-3" />
                                  {bookmark.tag_names.slice(0, 3).join(', ')}
                                </span>
                              ) : null}
                              {bookmark.last_accessed_at ? (
                                <span>{t('dashboard.lastOpened', { time: formatLastOpened(bookmark.last_accessed_at) })}</span>
                              ) : null}
                            </div>
                          ) : null}
                        </a>
                        <div className="flex items-center gap-0.5 opacity-0 group-hover/bookmark:opacity-100 transition-opacity focus-within:opacity-100">
                          <Tooltip content={t('dashboard.openBookmark')}>
                            <a
                              href={bookmark.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="p-1.5 rounded-md text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 hover:bg-gray-100 dark:hover:bg-gray-600 transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 dark:focus:ring-offset-gray-800"
                              aria-label={t('dashboard.openBookmark')}
                            >
                              <ExternalLink className="h-4 w-4" />
                            </a>
                          </Tooltip>
                          <Tooltip content={t('dashboard.editBookmark')}>
                            <Link
                              to={`${appBasePath}/bookmarks?edit=${bookmark.id}`}
                              className="p-1.5 rounded-md text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 hover:bg-gray-100 dark:hover:bg-gray-600 transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 dark:focus:ring-offset-gray-800"
                              aria-label={t('dashboard.editBookmark')}
                            >
                              <Edit className="h-4 w-4" />
                            </Link>
                          </Tooltip>
                          <Tooltip content={t('dashboard.copyUrl')}>
                            <button
                              type="button"
                              onClick={(e) => { e.preventDefault(); handleCopyUrl(bookmark); }}
                              className="p-1.5 rounded-md text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 hover:bg-gray-100 dark:hover:bg-gray-600 transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 dark:focus:ring-offset-gray-800"
                              aria-label={t('dashboard.copyUrl')}
                            >
                              <Copy className="h-4 w-4" />
                            </button>
                          </Tooltip>
                          <Tooltip content={t('dashboard.deleteBookmark')}>
                            <button
                              type="button"
                              onClick={(e) => { e.preventDefault(); handleDeleteBookmark(bookmark); }}
                              className="p-1.5 rounded-md text-gray-400 hover:text-red-600 dark:hover:text-red-400 hover:bg-gray-100 dark:hover:bg-gray-600 transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 dark:focus:ring-offset-gray-800"
                              aria-label={t('dashboard.deleteBookmark')}
                            >
                              <Trash2 className="h-4 w-4" />
                            </button>
                          </Tooltip>
                          <Tooltip content={t('dashboard.shareBookmark')}>
                            <Link
                              to={`${appBasePath}/bookmarks?edit=${bookmark.id}`}
                              className="p-1.5 rounded-md text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 hover:bg-gray-100 dark:hover:bg-gray-600 transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 dark:focus:ring-offset-gray-800"
                              aria-label={t('dashboard.shareBookmark')}
                            >
                              <Share2 className="h-4 w-4" />
                            </Link>
                          </Tooltip>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <EmptyState
                    icon={Bookmark}
                    title={t('dashboard.noRecentBookmarks')}
                    description={t('dashboard.noRecentBookmarksHint')}
                    action={
                      atBookmarkLimit ? (
                        <Link to={`${appBasePath}/admin?tab=billing`}>
                          <Button variant="secondary" icon={Plus}>{t('plan.upgradeCta')}</Button>
                        </Link>
                      ) : (
                        <Link to={`${appBasePath}/bookmarks?create=true`}>
                          <Button variant="primary" icon={Plus}>{t('bookmarks.create')}</Button>
                        </Link>
                      )
                    }
                  />
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className={denseMode ? 'p-3 pb-1' : 'p-4 pb-1'}>
                <CardTitle className="flex items-center gap-2 text-[15px]">
                  <TrendingUp className="h-5 w-5 text-muted-foreground" />
                  {t('dashboard.topTags')}
                </CardTitle>
                <CardDescription className="mb-4">
                  {t('dashboard.filterByTagHint')}
                </CardDescription>
              </CardHeader>
              <CardContent className={denseMode ? 'p-3 pt-0' : 'p-4 pt-0'}>
                {stats.topTags.length > 0 ? (
                  <div className="space-y-3">
                    {stats.topTags.map((tag) => (
                      <Link
                        key={tag.id}
                        to={`${appBasePath}/bookmarks?tag_id=${tag.id}`}
                        className="flex items-center justify-between p-3 rounded-lg border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-gray-800"
                        aria-label={t('dashboard.tagBookmarkCount', { count: tag.bookmark_count })}
                      >
                        <span className="text-sm font-medium text-gray-900 dark:text-white">
                          {tag.name}
                        </span>
                        <Badge variant="secondary" className="text-xs">
                          {t('dashboard.tagBookmarkCount', { count: tag.bookmark_count })}
                        </Badge>
                      </Link>
                    ))}
                  </div>
                ) : (
                  <EmptyState
                    icon={Tag}
                    title={t('dashboard.noTags')}
                    description={t('dashboard.noTagsHint')}
                    action={
                      <Link to={appBasePath + '/bookmarks'}>
                        <Button variant="secondary">{t('dashboard.goToBookmarks')}</Button>
                      </Link>
                    }
                  />
                )}
              </CardContent>
            </Card>
          </div>
        </div>
      )}

      {/* Quick Access Cards */}
      <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
        {cards.map((card) => {
          const Icon = card.icon;
          return (
            <Link key={card.to} to={card.to} className="group block focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-xl">
              <Card className="h-full transition-all hover:shadow-md hover:border-primary/70">
                <CardHeader className="space-y-4">
                  <div className={`inline-flex w-fit p-3 rounded-lg border ${colorClasses[card.color as keyof typeof colorClasses]}`}>
                    <Icon className="h-6 w-6" />
                  </div>
                  <div>
                    <CardTitle className="text-[15px] mb-1">{card.title}</CardTitle>
                    <CardDescription>{card.description}</CardDescription>
                  </div>
                  <div className="flex items-center text-sm font-medium text-muted-foreground group-hover:text-primary transition-colors">
                    {t('common.view')}
                    <ArrowRight className="ml-2 h-4 w-4" />
                  </div>
                </CardHeader>
              </Card>
            </Link>
          );
        })}
      </div>

      <ConfirmDialog {...dialogState} />
    </div>
  );
}
