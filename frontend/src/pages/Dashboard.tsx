import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useEffect, useState } from 'react';
import { Share2, X, ChevronDown, ChevronRight, CheckCircle, Lightbulb, Upload, Download } from 'lucide-react';
import { StatCard } from '../components/StatCard';
import {
  CommandBarHero,
  StatsCardsRow,
  PinnedSection,
  QuickAccessSection,
  MostUsedTagsSection,
} from '../components/dashboard';
import api from '../api/client';
import { useAppConfig } from '../contexts/AppConfigContext';
import { isCloud } from '../config/mode';
import { PageHeader } from '../components/PageHeader';
import Button from '../components/ui/Button';
import ImportModal from '../components/modals/ImportModal';
import { useToast } from '../components/ui/Toast';

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
    <div className="mb-2 flex items-start gap-4 rounded-[var(--radius-lg)] border border-[var(--border)] border-l-4 border-l-[var(--accent)] bg-[var(--bg-1)] bg-gradient-to-br from-[var(--bg-1)] to-[var(--accent-bg)] px-5 py-4 shadow-[var(--shadow-sm)]">
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[var(--radius)] bg-[var(--accent-bg)]" aria-hidden>
        <Lightbulb className="h-4 w-4 text-[var(--accent-hi)]" />
      </div>
      <div className="flex-1 min-w-0 space-y-1.5">
        <p className="text-sm font-semibold text-[var(--fg-0)]">{t('dashboard.proTipTitle')}</p>
        <p className="text-sm text-[var(--fg-2)] leading-relaxed">
          {t('dashboard.proTipBeforeCode')}
          <code className="mx-0.5 rounded-[var(--radius-sm)] bg-[var(--bg-2)] px-1.5 py-0.5 font-mono text-xs text-[var(--fg-0)] border border-[var(--border)] align-middle">
            {t('dashboard.proTipCode')}
          </code>
          {t('dashboard.proTipAfterCode')}{' '}
          <Link
            to={`${pathPrefix}/search-engine-guide`.replace(/\/+/g, '/') || '/search-engine-guide'}
            className="font-medium text-[var(--accent-hi)] hover:underline"
          >
            {t('dashboard.proTipLink')}
          </Link>
        </p>
      </div>
      <button
        type="button"
        onClick={onDismiss}
        className="shrink-0 p-1 rounded-[var(--radius-sm)] text-[var(--fg-3)] hover:text-[var(--fg-0)] hover:bg-[var(--bg-hover)] transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)]"
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
    <div className="rounded-[var(--radius-lg)] border border-[var(--border)] border-l-4 border-l-[var(--accent)] bg-[var(--bg-1)] bg-gradient-to-r from-[var(--bg-1)] to-[var(--accent-bg)] overflow-hidden shadow-[var(--shadow-sm)]">
      <button
        type="button"
        onClick={() => setCollapsed(!collapsed)}
        className="w-full flex items-center gap-3 p-4 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)] focus-visible:ring-inset hover:bg-[var(--bg-hover)] transition-colors"
      >
        {collapsed ? (
          <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
        ) : (
          <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
        )}
        <span className="text-sm font-semibold text-[var(--fg-0)]">{t('dashboard.onboardingTitle')}</span>
      </button>
      {!collapsed && (
        <div className="px-4 pb-4 pt-0 border-t border-[var(--border-soft)]">
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
  const { showToast } = useToast();
  const { pathPrefixForLinks } = useAppConfig();
  const prefix = (pathPrefixForLinks || '').replace(/\/+/g, '/') || '';
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [importModalOpen, setImportModalOpen] = useState(false);
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

  function handleExport() {
    api.get('/bookmarks/export')
      .then((response) => {
        const dataStr = JSON.stringify(response.data, null, 2);
        const dataBlob = new Blob([dataStr], { type: 'application/json' });
        const urlObj = URL.createObjectURL(dataBlob);
        const link = document.createElement('a');
        link.href = urlObj;
        link.download = `slugbase-bookmarks-${new Date().toISOString().split('T')[0]}.json`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(urlObj);
        showToast(t('common.success'), 'success');
      })
      .catch(() => {
        showToast(t('common.error'), 'error');
      });
  }

  return (
    <div className="w-full min-w-0 max-w-full space-y-8 pb-2">
      <PageHeader
        title={t('dashboard.heroHeading')}
        subtitle={t('dashboard.heroSubtitle')}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" variant="ghost" size="sm" icon={Upload} onClick={() => setImportModalOpen(true)}>
              {t('bookmarks.import')}
            </Button>
            <Button type="button" variant="ghost" size="sm" icon={Download} onClick={handleExport}>
              {t('bookmarks.export')}
            </Button>
          </div>
        }
      />

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
                cta: (stats.tenantBookmarkCount ?? stats.totalBookmarks) >= stats.bookmarkLimit ? { label: t('plan.limitBookmarks', { limit: stats.bookmarkLimit }), onClick: () => { window.location.href = '/pricing'; } } : undefined,
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

      <CommandBarHero
        title={t('dashboard.heroHeading')}
        subtitle={t('dashboard.heroSubtitle')}
        searchPlaceholder={t('dashboard.searchPlaceholder')}
        shortcutHint={t('dashboard.commandSearchShortcut')}
        showTitleBlock={false}
      />

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

      {stats && (
        <OnboardingChecklist
          totalBookmarks={stats.totalBookmarks}
          totalFolders={stats.totalFolders}
          topTagsCount={stats.topTags.length}
          pathPrefix={prefix}
          t={t}
        />
      )}

      <QuickAccessSection
        items={quickAccess}
        pathPrefix={prefix}
        maxItems={PINNED_QUICK_ACCESS_MAX_ITEMS}
        subtitle={t('dashboard.quickAccessSubtitle')}
        t={t}
        onOpen={handleBookmarkOpen}
        onCopyUrl={handleCopyUrl}
      />

      {isCloud && stats?.plan === 'free' && (
        <div className="flex flex-col gap-4 rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--bg-1)] bg-gradient-to-br from-[var(--bg-1)] to-[var(--accent-bg)] p-6 shadow-[var(--shadow)]">
          <div>
            <h3 className="text-lg font-semibold text-[var(--accent-hi)]">{t('dashboard.aiPromoTitle')}</h3>
            <p className="mt-2 text-[13px] text-[var(--fg-2)] leading-relaxed">{t('dashboard.aiPromoDescription')}</p>
          </div>
          <Link
            to="/pricing"
            className="inline-flex items-center justify-center rounded-[var(--radius)] bg-[var(--accent-bg-hi)] px-4 py-2.5 text-[13px] font-semibold text-[var(--accent)] border border-[var(--accent-ring)] hover:bg-[var(--accent-bg)] transition-colors text-center"
          >
            {t('dashboard.upgradeToProCta')}
          </Link>
        </div>
      )}

      <PinnedSection
        items={pinnedBookmarks}
        pathPrefix={prefix}
        maxItems={PINNED_QUICK_ACCESS_MAX_ITEMS}
        subtitle={t('dashboard.pinnedSubtitle')}
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
              href={`${prefix}/bookmarks?scope=shared_with_me`.replace(/\/+/g, '/') || '/bookmarks?scope=shared_with_me'}
              iconContainerClassName="bg-[var(--accent-bg)]"
              iconColorClassName="text-[var(--accent-hi)]"
            />
            <StatCard
              label={t('dashboard.sharedFolders')}
              value={stats.sharedFolders}
              icon={Share2}
              href={`${prefix}/folders?scope=shared_with_me`.replace(/\/+/g, '/') || '/folders?scope=shared_with_me'}
              iconContainerClassName="bg-[var(--accent-bg)]"
              iconColorClassName="text-[var(--accent-hi)]"
            />
          </div>
        </section>
      )}

      {stats && stats.topTags.length > 0 && (
        <MostUsedTagsSection tags={stats.topTags} pathPrefix={prefix} t={t} />
      )}

      <ImportModal
        isOpen={importModalOpen}
        onClose={() => setImportModalOpen(false)}
        onSuccess={() => {
          loadStats();
        }}
      />
    </div>
  );
}
