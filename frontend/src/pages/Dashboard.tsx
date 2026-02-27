import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useEffect, useState } from 'react';
import { Share2, X, ChevronDown, ChevronRight, CheckCircle } from 'lucide-react';
import { Card, CardContent } from '../components/ui/card';
import { StatCard } from '../components/StatCard';
import {
  DashboardHeader,
  StatsCardsRow,
  PinnedSection,
  QuickAccessSection,
  MostUsedTagsSection,
} from '../components/dashboard';
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

const PRO_TIP_DISMISSED_KEY = 'slugbase_dashboard_protip_dismissed';
const ONBOARDING_DISMISSED_KEY = 'slugbase_dashboard_onboarding_dismissed';
const PINNED_QUICK_ACCESS_MAX_ITEMS = 6;

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
        <Link
          to={`${pathPrefix}/search-engine-guide`.replace(/\/+/g, '/') || '/search-engine-guide'}
          className="text-primary font-medium hover:underline"
        >
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
  const [dismissed, setDismissed] = useState(
    () => typeof window !== 'undefined' && !!localStorage.getItem(ONBOARDING_DISMISSED_KEY)
  );
  const allDone = totalBookmarks > 0 && totalFolders > 0 && topTagsCount > 0;
  const show = !dismissed && !allDone;

  if (!show) return null;

  const steps = [
    {
      done: totalBookmarks > 0,
      label: t('dashboard.onboardingImport'),
      to: `${pathPrefix}/bookmarks?import=true`.replace(/\/+/g, '/') || '/bookmarks?import=true',
    },
    {
      done: false,
      label: t('dashboard.onboardingSearchEngine'),
      to: `${pathPrefix}/search-engine-guide`.replace(/\/+/g, '/') || '/search-engine-guide',
    },
    {
      done: totalFolders > 0,
      label: t('dashboard.onboardingFolder'),
      to: `${pathPrefix}/folders`.replace(/\/+/g, '/') || '/folders',
    },
    {
      done: topTagsCount > 0,
      label: t('dashboard.onboardingTag'),
      to: `${pathPrefix}/bookmarks`.replace(/\/+/g, '/') || '/bookmarks',
    },
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
        {collapsed ? (
          <ChevronRight className="h-5 w-5 text-muted-foreground" />
        ) : (
          <ChevronDown className="h-5 w-5 text-muted-foreground" />
        )}
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
                  {step.done ? (
                    <CheckCircle className="h-4 w-4 text-primary shrink-0" />
                  ) : (
                    <span className="w-4 h-4 rounded-full border border-muted-foreground shrink-0" />
                  )}
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
  const [proTipDismissed, setProTipDismissed] = useState(
    () => typeof window !== 'undefined' && !!localStorage.getItem(PRO_TIP_DISMISSED_KEY)
  );

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

  function handleBookmarkOpen(id: string, url: string) {
    api.post(`/bookmarks/${id}/track-access`).catch(() => {});
    window.open(url, '_blank', 'noopener,noreferrer');
  }

  function handleCopyUrl(url: string) {
    navigator.clipboard.writeText(url).catch(() => {});
  }

  return (
    <div className="space-y-6">
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

      <DashboardHeader
        title={t('dashboard.overview')}
        subtitle={t('dashboard.overviewSubtitle')}
      />

      {stats && (
        <StatsCardsRow
          bookmarks={{
            label: t('dashboard.statsBookmarks'),
            value: stats.totalBookmarks,
            href: prefix + '/bookmarks',
          }}
          folders={{
            label: t('dashboard.statsFolders'),
            value: stats.totalFolders,
            href: prefix + '/folders',
          }}
          tags={{
            label: t('dashboard.statsTags'),
            value: stats.totalTags,
            href: prefix + '/tags',
          }}
        />
      )}

      <PinnedSection
        items={pinnedBookmarks}
        pathPrefix={prefix}
        maxItems={PINNED_QUICK_ACCESS_MAX_ITEMS}
        t={t}
        onOpen={handleBookmarkOpen}
        onCopyUrl={handleCopyUrl}
      />

      <QuickAccessSection
        items={quickAccess}
        pathPrefix={prefix}
        maxItems={PINNED_QUICK_ACCESS_MAX_ITEMS}
        subtitle={t('dashboard.quickAccessSubtitle')}
        t={t}
        onOpen={handleBookmarkOpen}
        onCopyUrl={handleCopyUrl}
      />

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

      {stats && stats.topTags.length > 0 && (
        <MostUsedTagsSection tags={stats.topTags} pathPrefix={prefix} t={t} />
      )}

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
