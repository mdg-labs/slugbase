import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useEffect, useState } from 'react';
import { Bookmark, Folder, Tag, ArrowRight, Share2, Clock, TrendingUp, Plus, Edit } from 'lucide-react';
import Button from '../components/ui/Button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import api from '../api/client';
import { appBasePath } from '../config/api';
import { useOrgPlan } from '../contexts/OrgPlanContext';
import { canCreateBookmark } from '../utils/plan';

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
  const { plan, bookmarkCount, bookmarkLimit } = useOrgPlan();
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

  const cards = [
    {
      to: '/bookmarks',
      icon: Bookmark,
      title: t('bookmarks.title'),
      description: t('dashboard.bookmarksDescription'),
      color: 'blue',
    },
    {
      to: '/folders',
      icon: Folder,
      title: t('folders.title'),
      description: t('dashboard.foldersDescription'),
      color: 'green',
    },
    {
      to: '/tags',
      icon: Tag,
      title: t('tags.title'),
      description: t('dashboard.tagsDescription'),
      color: 'purple',
    },
  ];

  const colorClasses = {
    blue: 'bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400 border-blue-200 dark:border-blue-800',
    green: 'bg-green-50 dark:bg-green-900/20 text-green-600 dark:text-green-400 border-green-200 dark:border-green-800',
    purple: 'bg-purple-50 dark:bg-purple-900/20 text-purple-600 dark:text-purple-400 border-purple-200 dark:border-purple-800',
  };

  return (
    <div className="space-y-8">
      <div className="text-center">
        <h1 className="flex items-center justify-center gap-2 text-2xl font-semibold text-gray-900 dark:text-white mb-3">
          <img
            src="/slugbase_icon_blue.svg"
            alt=""
            className="h-12 w-12 dark:hidden"
          />
          <img
            src="/slugbase_icon_white.svg"
            alt=""
            className="h-12 w-12 hidden dark:block"
          />
          {t('app.name')}
        </h1>
        <p className="text-lg text-gray-600 dark:text-gray-400">
          {t('app.tagline')}
        </p>
      </div>

      {/* Primary action: New Bookmark */}
      <div className="flex flex-col items-center gap-2">
        {atBookmarkLimit ? (
          <Link to={`${appBasePath}/admin?tab=billing`} className="w-full sm:w-auto">
            <Button variant="secondary" size="lg" icon={Plus} className="w-full sm:w-auto" title={t('plan.limitBookmarks')}>
              {t('plan.upgradeCta')}
            </Button>
          </Link>
        ) : (
          <Link to={`${appBasePath}/bookmarks?create=true`} className="w-full sm:w-auto">
            <Button variant="primary" size="lg" icon={Plus} className="w-full sm:w-auto">
              {t('bookmarks.create')}
            </Button>
          </Link>
        )}
        <p className="text-sm text-gray-500 dark:text-gray-400">
          {atBookmarkLimit ? t('plan.limitBookmarks') : t('dashboard.newBookmarkHint')}
        </p>
      </div>

      {/* Statistics Overview */}
      {stats && (
        <div className={denseMode ? 'space-y-4' : 'space-y-6'}>
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div>
              <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
                {t('dashboard.overview')}
              </h2>
              <p className="text-sm text-gray-500 dark:text-gray-400 -mt-2">
                {t('dashboard.overviewSubtitle')}
              </p>
            </div>
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

          {/* Stats Grid: Your library + Shared with you */}
          <div className={`max-w-5xl ${denseMode ? 'space-y-3' : 'space-y-4'}`}>
            <p className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
              {t('dashboard.yourLibrary')}
            </p>
            <div className={`grid grid-cols-1 gap-4 sm:grid-cols-3 ${denseMode ? 'gap-3' : ''}`}>
              <Card className={denseMode ? 'p-3' : ''}>
                <CardContent className={denseMode ? 'p-3 pt-0' : 'p-4'}>
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm font-medium text-muted-foreground">
                        {t('dashboard.totalBookmarks')}
                      </p>
                      <p className="text-2xl font-semibold mt-2">
                        {bookmarkLimit != null
                          ? t('plan.bookmarksUsed', { count: bookmarkCount, limit: bookmarkLimit })
                          : stats.totalBookmarks}
                      </p>
                    </div>
                    <div className="p-3 bg-blue-100 dark:bg-blue-900/20 rounded-lg">
                      <Bookmark className="h-6 w-6 text-blue-600 dark:text-blue-400" />
                    </div>
                  </div>
                </CardContent>
              </Card>
              <Card className={denseMode ? 'p-3' : ''}>
                <CardContent className={denseMode ? 'p-3 pt-0' : 'p-4'}>
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm font-medium text-muted-foreground">
                        {t('dashboard.totalFolders')}
                      </p>
                      <p className="text-2xl font-semibold mt-2">
                        {stats.totalFolders}
                      </p>
                    </div>
                    <div className="p-3 bg-green-100 dark:bg-green-900/20 rounded-lg">
                      <Folder className="h-6 w-6 text-green-600 dark:text-green-400" />
                    </div>
                  </div>
                </CardContent>
              </Card>
              <Card className={denseMode ? 'p-3' : ''}>
                <CardContent className={denseMode ? 'p-3 pt-0' : 'p-4'}>
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm font-medium text-muted-foreground">
                        {t('dashboard.totalTags')}
                      </p>
                      <p className="text-2xl font-semibold mt-2">
                        {stats.totalTags}
                      </p>
                    </div>
                    <div className="p-3 bg-purple-100 dark:bg-purple-900/20 rounded-lg">
                      <Tag className="h-6 w-6 text-purple-600 dark:text-purple-400" />
                    </div>
                  </div>
                </CardContent>
              </Card>
            </div>
            <p className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400 pt-2">
              {t('dashboard.sharedWithYou')}
            </p>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Card className={stats.sharedBookmarks === 0 ? 'bg-muted/50 border-muted' : ''}>
                <CardContent className={denseMode ? 'p-3 pt-0' : 'p-4'}>
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm font-medium text-muted-foreground">
                        {t('dashboard.sharedBookmarks')}
                      </p>
                      <p className={`text-2xl font-semibold mt-2 ${stats.sharedBookmarks === 0 ? 'text-muted-foreground' : ''}`}>
                        {stats.sharedBookmarks}
                      </p>
                    </div>
                    <div className="p-3 bg-green-100 dark:bg-green-900/20 rounded-lg">
                      <Share2 className="h-6 w-6 text-green-600 dark:text-green-400" />
                    </div>
                  </div>
                </CardContent>
              </Card>
              <Card className={stats.sharedFolders === 0 ? 'bg-muted/50 border-muted' : ''}>
                <CardContent className={denseMode ? 'p-3 pt-0' : 'p-4'}>
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm font-medium text-muted-foreground">
                        {t('dashboard.sharedFolders')}
                      </p>
                      <p className={`text-2xl font-semibold mt-2 ${stats.sharedFolders === 0 ? 'text-muted-foreground' : ''}`}>
                        {stats.sharedFolders}
                      </p>
                    </div>
                    <div className="p-3 bg-green-100 dark:bg-green-900/20 rounded-lg">
                      <Share2 className="h-6 w-6 text-green-600 dark:text-green-400" />
                    </div>
                  </div>
                </CardContent>
              </Card>
            </div>
          </div>

          {/* Recent Bookmarks and Top Tags */}
          <div className={`grid grid-cols-1 lg:grid-cols-2 ${denseMode ? 'gap-4' : 'gap-6'}`}>
            {/* Recent Bookmarks */}
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
                        className="flex-1 min-w-0"
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
                      <Link
                        to={`/bookmarks?edit=${bookmark.id}`}
                        className="flex-shrink-0 p-1.5 rounded-md text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 hover:bg-gray-100 dark:hover:bg-gray-600 opacity-0 group-hover/bookmark:opacity-100 transition-opacity focus:opacity-100 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 dark:focus:ring-offset-gray-800"
                        title={t('dashboard.editBookmark')}
                        aria-label={t('dashboard.editBookmark')}
                      >
                        <Edit className="h-4 w-4" />
                      </Link>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="space-y-2">
                  <p className="text-sm text-gray-500 dark:text-gray-400">
                    {t('dashboard.noRecentBookmarks')}
                  </p>
                  <p className="text-xs text-gray-400 dark:text-gray-500">
                    {t('dashboard.noRecentBookmarksHint')}
                  </p>
                  <Link
                    to={`${appBasePath}/bookmarks?create=true`}
                    className="inline-flex items-center gap-1 text-sm font-medium text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 rounded dark:focus-visible:ring-offset-gray-800"
                  >
                    {t('dashboard.goToBookmarks')}
                  </Link>
                </div>
              )}
              </CardContent>
            </Card>

            {/* Top Tags */}
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
                      to={`/bookmarks?tag_id=${tag.id}`}
                      className="flex items-center justify-between p-3 rounded-lg border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-gray-800"
                      aria-label={t('dashboard.tagBookmarkCount', { count: tag.bookmark_count })}
                    >
                      <span className="text-sm font-medium text-gray-900 dark:text-white">
                        {tag.name}
                      </span>
                      <span className="text-xs font-medium text-gray-500 dark:text-gray-400 bg-gray-100 dark:bg-gray-700/50 px-2 py-0.5 rounded">
                        {t('dashboard.tagBookmarkCount', { count: tag.bookmark_count })}
                      </span>
                    </Link>
                  ))}
                </div>
              ) : (
                <div className="space-y-2">
                  <p className="text-sm text-gray-500 dark:text-gray-400">
                    {t('dashboard.noTags')}
                  </p>
                  <p className="text-xs text-gray-400 dark:text-gray-500">
                    {t('dashboard.noTagsHint')}
                  </p>
                  <Link
                    to={`${appBasePath}/bookmarks`}
                    className="inline-flex items-center gap-1 text-sm font-medium text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 rounded dark:focus-visible:ring-offset-gray-800"
                  >
                    {t('dashboard.goToBookmarks')}
                  </Link>
                </div>
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
            <Link key={card.to} to={card.to} className="group block">
              <Card className="h-full transition-all hover:shadow-md focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2">
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
    </div>
  );
}
