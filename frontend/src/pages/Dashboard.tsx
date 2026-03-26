import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useEffect, useState } from 'react';
import { Share2, X, ChevronDown, ChevronRight, CheckCircle, Lightbulb } from 'lucide-react';
import { StatCard } from '../components/StatCard';
import {
  CommandBarHero,
  StatsCardsRow,
  SlugPerformanceCard,
  PinnedSection,
  QuickAccessSection,
  MostUsedTagsSection,
} from '../components/dashboard';
import api from '../api/client';
import { useAppConfig } from '../contexts/AppConfigContext';
import { isCloud } from '../config/mode';

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
  /** Cloud: plan name (free, personal, team). */
  plan?: string;
  /** Cloud: bookmark limit for current plan (e.g. 50 for free), null when unlimited. */
  bookmarkLimit?: number | null;
  /** Cloud: true only when plan is team. */
  canShareWithTeams?: boolean;
  /** Cloud (free plan): total bookmarks in tenant for usage display. */
  tenantBookmarkCount?: number;
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
    <div className="flex items-start gap-3 rounded-xl border border-ghost border-l-4 border-l-primary bg-surface px-4 py-3 shadow-sm">
      <Lightbulb className="h-5 w-5 shrink-0 text-primary mt-0.5" aria-hidden />
      <div className="flex-1 min-w-0 space-y-1.5">
        <p className="text-sm font-bold text-foreground">{t('dashboard.proTipTitle')}</p>
        <p className="text-sm text-muted-foreground leading-relaxed">
          {t('dashboard.proTipBeforeCode')}
          <code className="mx-0.5 rounded-md bg-surface-low px-1.5 py-0.5 font-mono text-xs text-foreground border border-ghost align-middle">
            {t('dashboard.proTipCode')}
          </code>
          {t('dashboard.proTipAfterCode')}{' '}
          <Link
            to={`${pathPrefix}/search-engine-guide`.replace(/\/+/g, '/') || '/search-engine-guide'}
            className="text-primary font-medium hover:underline"
          >
            {t('dashboard.proTipLink')}
          </Link>
        </p>
      </div>
      <button
        type="button"
        onClick={onDismiss}
        className="shrink-0 p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-surface-high transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
    <div className="rounded-xl border border-ghost border-l-4 border-l-primary bg-surface overflow-hidden shadow-sm">
      <button
        type="button"
        onClick={() => setCollapsed(!collapsed)}
        className="w-full flex items-center gap-3 p-4 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset hover:bg-surface-high/40 transition-colors"
      >
        {collapsed ? (
          <ChevronRight className="h-5 w-5 text-muted-foreground shrink-0" />
        ) : (
          <ChevronDown className="h-5 w-5 text-muted-foreground shrink-0" />
        )}
        <span className="text-sm font-semibold text-foreground">{t('dashboard.onboardingTitle')}</span>
      </button>
      {!collapsed && (
        <div className="px-4 pb-4 pt-0 border-t border-ghost">
          <ul className="space-y-2 pt-3">
            {steps.map((step, i) => (
              <li key={i}>
                <Link
                  to={step.to}
                  className="flex items-center gap-3 text-sm text-muted-foreground hover:text-foreground transition-colors rounded-lg py-1"
                >
                  {step.done ? (
                    <CheckCircle className="h-4 w-4 text-primary shrink-0" />
                  ) : (
                    <span className="w-4 h-4 rounded-full border border-ghost bg-surface-low shrink-0" />
                  )}
                  <span>{step.label}</span>
                </Link>
              </li>
            ))}
          </ul>
          <button
            type="button"
            onClick={handleDismiss}
            className="mt-4 text-xs font-medium uppercase tracking-widest text-muted-foreground hover:text-foreground"
          >
            {t('dashboard.onboardingDismiss')}
          </button>
        </div>
      )}
    </div>
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
    <div className="space-y-8">
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

      <CommandBarHero
        title={t('dashboard.heroHeading')}
        subtitle={t('dashboard.heroSubtitle')}
        searchPlaceholder={t('dashboard.searchPlaceholder')}
        shortcutHint={t('dashboard.commandSearchShortcut')}
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

      <div className={`grid gap-4 items-stretch ${isCloud ? 'lg:grid-cols-2' : ''}`}>
        <SlugPerformanceCard t={t} className={isCloud ? '' : 'max-w-3xl'} />
        {isCloud && (
          <div className="rounded-xl border border-ghost bg-surface p-5 flex flex-col gap-4 justify-between min-h-[280px]">
            <div>
              <h3 className="text-lg font-semibold text-primary">{t('dashboard.aiPromoTitle')}</h3>
              <p className="mt-2 text-sm text-muted-foreground leading-relaxed">{t('dashboard.aiPromoDescription')}</p>
            </div>
            <Link
              to="/pricing"
              className="inline-flex items-center justify-center rounded-xl bg-primary-gradient px-4 py-2.5 text-sm font-semibold text-primary-foreground shadow-glow hover:opacity-90 transition-opacity text-center"
            >
              {t('dashboard.upgradeToProCta')}
            </Link>
          </div>
        )}
      </div>

      {stats && (
        <StatsCardsRow
          bookmarks={{
            label: t('dashboard.statsBookmarks'),
            value: stats.totalBookmarks,
            href: prefix + '/bookmarks',
            ...(stats.bookmarkLimit != null && {
              usage: {
                used: stats.tenantBookmarkCount ?? stats.totalBookmarks,
                limit: stats.bookmarkLimit,
                labelOverride: t('plan.bookmarksUsed', { count: stats.tenantBookmarkCount ?? stats.totalBookmarks, limit: stats.bookmarkLimit }),
                showProgress: true,
                cta: (stats.tenantBookmarkCount ?? stats.totalBookmarks) >= stats.bookmarkLimit ? { label: t('plan.limitBookmarks', { limit: stats.bookmarkLimit }), onClick: () => window.location.href = '/pricing' } : undefined,
              },
            }),
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

      {stats && (stats.sharedBookmarks > 0 || stats.sharedFolders > 0) && (
        <section className="space-y-3">
          <h2 className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
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
