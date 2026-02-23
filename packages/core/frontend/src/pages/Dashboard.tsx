import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useEffect, useState } from 'react';
import { Bookmark, Share2, TrendingUp, Plus, ArrowRight, X, ChevronDown, ChevronRight, CheckCircle, Folder, Tag } from 'lucide-react';
import Button from '../components/ui/Button';
import { Card, CardContent } from '../components/ui/card';
import { Badge } from '../components/ui/badge';
import { StatCard } from '../components/StatCard';
import { EmptyState } from '../components/EmptyState';
import api from '../api/client';
import { useAppConfig } from '../contexts/AppConfigContext';

interface RecentBookmark {
  id: string;
  title: string;
  url: string;
  created_at: string;
  last_accessed_at?: string | null;
  folder_names?: string[];
  tag_names?: string[];
}

interface QuickAccessBookmark {
  id: string;
  title: string;
  url: string;
  slug: string;
}

interface DashboardStats {
  totalBookmarks: number;
  totalFolders: number;
  totalTags: number;
  sharedBookmarks: number;
  sharedFolders: number;
  recentBookmarks: RecentBookmark[];
  topTags: Array<{ id: string; name: string; bookmark_count: number }>;
  quickAccessBookmarks?: QuickAccessBookmark[];
  pinnedBookmarks?: QuickAccessBookmark[];
}

function getDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function getFaviconUrl(url: string): string {
  try {
    const host = new URL(url).hostname;
    return `https://www.google.com/s2/favicons?domain=${host}&sz=32`;
  } catch {
    return '';
  }
}

const PRO_TIP_DISMISSED_KEY = 'slugbase_dashboard_protip_dismissed';
const ONBOARDING_DISMISSED_KEY = 'slugbase_dashboard_onboarding_dismissed';

function ProTipBanner({
  onDismiss,
  pathPrefix,
  t,
}: {
  onDismiss: () => void;
  pathPrefix: string;
  t: (key: string) => string;
}) {
  return (
    <div className="flex items-start gap-3 rounded-xl border border-border bg-card shadow-sm px-4 py-3">
      <p className="text-sm text-muted-foreground flex-1 min-w-0">
        {t('dashboard.proTipBody')}{' '}
        <Link to={`${pathPrefix}/search-engine-guide`.replace(/\/+/g, '/') || '/search-engine-guide'} className="text-primary font-medium hover:underline">
          {t('dashboard.proTipLink')}
        </Link>
      </p>
      <button
        type="button"
        onClick={onDismiss}
        className="shrink-0 p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label={t('dashboard.dismiss')}
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}

function OnboardingChecklist({
  totalBookmarks,
  totalFolders,
  topTagsCount,
  pathPrefix,
  t,
}: {
  totalBookmarks: number;
  totalFolders: number;
  topTagsCount: number;
  pathPrefix: string;
  t: (key: string) => string;
}) {
  const [collapsed, setCollapsed] = useState(true);
  const [dismissed, setDismissed] = useState(() => typeof window !== 'undefined' && !!localStorage.getItem(ONBOARDING_DISMISSED_KEY));
  const allDone = totalBookmarks > 0 && totalFolders > 0 && topTagsCount > 0;
  const show = !dismissed && !allDone;

  if (!show) return null;

  const steps = [
    { done: totalBookmarks > 0, label: t('dashboard.onboardingImport'), to: `${pathPrefix}/bookmarks?import=true`.replace(/\/+/g, '/') || '/bookmarks?import=true' },
    { done: false, label: t('dashboard.onboardingSearchEngine'), to: `${pathPrefix}/search-engine-guide`.replace(/\/+/g, '/') || '/search-engine-guide' },
    { done: totalFolders > 0, label: t('dashboard.onboardingFolder'), to: `${pathPrefix}/folders`.replace(/\/+/g, '/') || '/folders' },
    { done: topTagsCount > 0, label: t('dashboard.onboardingTag'), to: `${pathPrefix}/bookmarks`.replace(/\/+/g, '/') || '/bookmarks' },
  ];

  function handleDismiss() {
    localStorage.setItem(ONBOARDING_DISMISSED_KEY, '1');
    setDismissed(true);
    setCollapsed(true);
  }

  return (
    <Card className="border border-border bg-card shadow-sm">
      <button
        type="button"
        onClick={() => setCollapsed(!collapsed)}
        className="w-full flex items-center gap-2 p-4 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset rounded-t-xl"
      >
        {collapsed ? <ChevronRight className="h-5 w-5 text-muted-foreground" /> : <ChevronDown className="h-5 w-5 text-muted-foreground" />}
        <span className="font-medium text-sm">{t('dashboard.onboardingTitle')}</span>
      </button>
      {!collapsed && (
        <CardContent className="pt-0 pb-4 px-4">
          <ul className="space-y-2">
            {steps.map((step, i) => (
              <li key={i}>
                <Link
                  to={step.to}
                  className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
                >
                  {step.done ? <CheckCircle className="h-4 w-4 text-primary shrink-0" /> : <span className="w-4 h-4 rounded-full border border-muted-foreground shrink-0" />}
                  <span>{step.label}</span>
                </Link>
              </li>
            ))}
          </ul>
          <button
            type="button"
            onClick={handleDismiss}
            className="mt-3 text-xs text-muted-foreground hover:text-foreground"
          >
            {t('dashboard.onboardingDismiss')}
          </button>
        </CardContent>
      )}
    </Card>
  );
}

export default function Dashboard() {
  const { t } = useTranslation();
  const { pathPrefixForLinks } = useAppConfig();
  const prefix = (pathPrefixForLinks || '').replace(/\/+/g, '/') || '';
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [proTipDismissed, setProTipDismissed] = useState(() => typeof window !== 'undefined' && !!localStorage.getItem(PRO_TIP_DISMISSED_KEY));

  useEffect(() => {
    loadStats();
  }, []);

  async function loadStats() {
    try {
      const res = await api.get('/dashboard/stats');
      setStats(res.data);
    } catch (error) {
      console.error('Failed to load dashboard stats:', error);
    }
  }

  const quickAccess = stats?.quickAccessBookmarks ?? [];
  const pinnedBookmarks = stats?.pinnedBookmarks ?? [];

  return (
    <div className="space-y-8">
      {/* Feature discovery banner — dismissable, localStorage */}
      {!proTipDismissed && (
        <ProTipBanner
          onDismiss={() => {
            localStorage.setItem(PRO_TIP_DISMISSED_KEY, '1');
            setProTipDismissed(true);
          }}
          pathPrefix={prefix}
          t={t}
        />
      )}

      {/* Top stats: bookmarks / folders / tags */}
      {stats && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <StatCard
            label={t('dashboard.statsBookmarks')}
            value={stats.totalBookmarks}
            icon={Bookmark}
            href={prefix + '/bookmarks'}
            dense
            iconContainerClassName="bg-primary/20"
            iconColorClassName="text-primary"
          />
          <StatCard
            label={t('dashboard.statsFolders')}
            value={stats.totalFolders}
            icon={Folder}
            href={prefix + '/folders'}
            dense
            iconContainerClassName="bg-primary/20"
            iconColorClassName="text-primary"
          />
          <StatCard
            label={t('dashboard.statsTags')}
            value={stats.totalTags}
            icon={Tag}
            href={prefix + '/tags'}
            dense
            iconContainerClassName="bg-primary/20"
            iconColorClassName="text-primary"
          />
        </div>
      )}

      {/* Pinned bookmarks — same style as Quick Access */}
      <section className="space-y-3">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <h2 className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
            {t('dashboard.pinned')}
          </h2>
          <Link
            to={prefix + '/bookmarks?pinned=true'}
            className="text-sm font-medium text-primary hover:underline"
          >
            {t('dashboard.viewAll')}
            <ArrowRight className="inline-block ml-1 h-4 w-4" />
          </Link>
        </div>
        {pinnedBookmarks.length > 0 ? (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-8 gap-3 overflow-hidden min-w-0">
            {pinnedBookmarks.map((b) => (
              <button
                key={b.id}
                type="button"
                onClick={() => {
                  api.post(`/bookmarks/${b.id}/track-access`).catch(() => {});
                  window.open(b.url, '_blank', 'noopener,noreferrer');
                }}
                className="group flex flex-col rounded-xl border border-border bg-card p-3 hover:border-primary/50 hover:shadow-md transition-all text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              >
                <div className="flex items-start gap-2.5 mb-1.5">
                  <div className="relative h-7 w-7 shrink-0 rounded bg-muted overflow-hidden">
                    <img
                      src={getFaviconUrl(b.url)}
                      alt=""
                      className="h-7 w-7 w-full object-cover"
                      onError={(e) => {
                        (e.target as HTMLImageElement).style.display = 'none';
                        (e.target as HTMLImageElement).nextElementSibling?.classList.remove('hidden');
                      }}
                    />
                    <span className="hidden absolute inset-0 flex items-center justify-center bg-primary/10 rounded">
                      <Bookmark className="h-3.5 w-3.5 text-primary" />
                    </span>
                  </div>
                  <p className="font-medium text-foreground line-clamp-2 text-xs flex-1 min-w-0">{b.title}</p>
                </div>
                <p className="text-[11px] text-primary font-mono truncate" title={b.slug ? `go/${b.slug}` : undefined}>{b.slug ? `go/${b.slug}` : getDomain(b.url)}</p>
                <p className="text-[11px] text-muted-foreground truncate mt-0.5">{getDomain(b.url)}</p>
              </button>
            ))}
          </div>
        ) : (
          <Card className="border border-border bg-card shadow-sm">
            <CardContent className="p-6">
              <EmptyState
                icon={Bookmark}
                title={t('dashboard.noPinnedBookmarks')}
                description={t('dashboard.pinFromBookmarks')}
                action={
                  <Link to={prefix + '/bookmarks'}>
                    <Button variant="secondary">{t('dashboard.pinFromBookmarksLink')}</Button>
                  </Link>
                }
              />
            </CardContent>
          </Card>
        )}
      </section>

      {/* Quick Access bookmarks — horizontal card grid; responsive columns and scroll on narrow */}
      <section className="space-y-3">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <h2 className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
            {t('dashboard.quickAccess')}
          </h2>
          <Link
            to={prefix + '/bookmarks'}
            className="text-sm font-medium text-primary hover:underline"
          >
            {t('dashboard.viewAll')}
            <ArrowRight className="inline-block ml-1 h-4 w-4" />
          </Link>
        </div>
        {quickAccess.length > 0 ? (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-8 gap-3 overflow-hidden min-w-0">
            {quickAccess.map((b) => (
              <button
                key={b.id}
                type="button"
                onClick={() => {
                  api.post(`/bookmarks/${b.id}/track-access`).catch(() => {});
                  window.open(b.url, '_blank', 'noopener,noreferrer');
                }}
                className="group flex flex-col rounded-xl border border-border bg-card p-3 hover:border-primary/50 hover:shadow-md transition-all text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              >
                <div className="flex items-start gap-2.5 mb-1.5">
                  <div className="relative h-7 w-7 shrink-0 rounded bg-muted overflow-hidden">
                    <img
                      src={getFaviconUrl(b.url)}
                      alt=""
                      className="h-7 w-7 w-full object-cover"
                      onError={(e) => {
                        (e.target as HTMLImageElement).style.display = 'none';
                        (e.target as HTMLImageElement).nextElementSibling?.classList.remove('hidden');
                      }}
                    />
                    <span className="hidden absolute inset-0 flex items-center justify-center bg-primary/10 rounded">
                      <Bookmark className="h-3.5 w-3.5 text-primary" />
                    </span>
                  </div>
                  <p className="font-medium text-foreground line-clamp-2 text-xs flex-1 min-w-0">{b.title}</p>
                </div>
                <p className="text-[11px] text-primary font-mono truncate" title={`go/${b.slug}`}>go/{b.slug}</p>
                <p className="text-[11px] text-muted-foreground truncate mt-0.5">{getDomain(b.url)}</p>
              </button>
            ))}
          </div>
        ) : (
          <Card className="border border-border bg-card shadow-sm">
            <CardContent className="p-6">
              <EmptyState
                icon={Bookmark}
                title={t('dashboard.noQuickAccessBookmarks')}
                description={t('dashboard.noQuickAccessBookmarksHint')}
                action={
                  <Link to={`${prefix}/bookmarks?create=true`}>
                    <Button variant="primary" icon={Plus}>{t('bookmarks.create')}</Button>
                  </Link>
                }
              />
            </CardContent>
          </Card>
        )}
      </section>

      {/* Shared With You — only when has shared content */}
      {stats && (stats.sharedBookmarks > 0 || stats.sharedFolders > 0) && (
        <section className="space-y-3">
          <h2 className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
            {t('dashboard.sharedWithYou')}
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <StatCard
              label={t('dashboard.sharedBookmarks')}
              value={stats.sharedBookmarks}
              icon={Share2}
              href={prefix + '/shared'}
              iconContainerClassName="bg-primary/20"
              iconColorClassName="text-primary"
            />
            <StatCard
              label={t('dashboard.sharedFolders')}
              value={stats.sharedFolders}
              icon={Share2}
              href={prefix + '/shared'}
              iconContainerClassName="bg-primary/20"
              iconColorClassName="text-primary"
            />
          </div>
        </section>
      )}

      {/* Most used tags — small row; click goes to bookmarks filtered by tag */}
      {stats && stats.topTags.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-medium uppercase tracking-wide text-muted-foreground flex items-center gap-2">
            <TrendingUp className="h-4 w-4" />
            {t('dashboard.topTags')}
          </h2>
          <div className="flex flex-wrap gap-2">
            {stats.topTags.map((tag) => (
              <Link
                key={tag.id}
                to={`${prefix}/bookmarks?tag_id=${tag.id}`}
                className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-2.5 py-1.5 text-xs font-medium text-foreground hover:bg-accent hover:border-primary/50 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                title={t('dashboard.filterByTagHint')}
              >
                <span>{tag.name}</span>
                <Badge variant="secondary" className="text-[10px] px-1.5 py-0 font-normal">
                  {tag.bookmark_count}
                </Badge>
              </Link>
            ))}
          </div>
        </section>
      )}

      {/* Onboarding checklist — collapsible, show when incomplete and not dismissed */}
      {stats && (
        <OnboardingChecklist
          totalBookmarks={stats.totalBookmarks}
          totalFolders={stats.totalFolders}
          topTagsCount={stats.topTags.length}
          pathPrefix={prefix}
          t={t}
        />
      )}
    </div>
  );
}
