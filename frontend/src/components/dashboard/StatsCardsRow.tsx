import { Bookmark, Folder, Tag } from 'lucide-react';
import { Bar, BarChart, Cell, ResponsiveContainer, XAxis, YAxis } from 'recharts';
import { StatCard, type StatCardUsageProps } from '../StatCard';

/** Placeholder series for dashboard performance widget (no org-wide analytics API yet). */
const SLUG_PERFORMANCE_PLACEHOLDER = [
  { name: 'Mon', value: 8 },
  { name: 'Tue', value: 12 },
  { name: 'Wed', value: 6 },
  { name: 'Thu', value: 15 },
  { name: 'Fri', value: 10 },
  { name: 'Sat', value: 4 },
  { name: 'Sun', value: 14 },
];

const PRIMARY_BAR = 'hsl(var(--chart-1))';
const MUTED_BAR = 'hsl(var(--surface-high))';

export interface StatItem {
  label: string;
  value: number;
  href: string;
  secondaryLine?: string;
  /** Optional usage/limit for cloud; in core leave undefined */
  usage?: StatCardUsageProps;
}

export interface StatsCardsRowProps {
  bookmarks: StatItem;
  folders: StatItem;
  tags: StatItem;
  /** Optional; for denser layouts */
  dense?: boolean;
}

/**
 * Row of three stat cards: bookmarks, folders, tags.
 * Supports optional usage/limit/CTA per card for slugbase-cloud (pass usage in cloud only).
 */
export function StatsCardsRow({ bookmarks, folders, tags, dense }: StatsCardsRowProps) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 items-stretch">
      <StatCard
        label={bookmarks.label}
        value={bookmarks.value}
        icon={Bookmark}
        href={bookmarks.href}
        dense={dense}
        iconContainerClassName="bg-primary/20"
        iconColorClassName="text-primary"
        secondaryLine={bookmarks.secondaryLine}
        used={bookmarks.usage?.used}
        limit={bookmarks.usage?.limit}
        labelOverride={bookmarks.usage?.labelOverride}
        showProgress={bookmarks.usage?.showProgress}
        progressVariant={bookmarks.usage?.progressVariant}
        cta={bookmarks.usage?.cta}
      />
      <StatCard
        label={folders.label}
        value={folders.value}
        icon={Folder}
        href={folders.href}
        dense={dense}
        iconContainerClassName="bg-primary/20"
        iconColorClassName="text-primary"
        secondaryLine={folders.secondaryLine}
        used={folders.usage?.used}
        limit={folders.usage?.limit}
        labelOverride={folders.usage?.labelOverride}
        showProgress={folders.usage?.showProgress}
        progressVariant={folders.usage?.progressVariant}
        cta={folders.usage?.cta}
      />
      <StatCard
        label={tags.label}
        value={tags.value}
        icon={Tag}
        href={tags.href}
        dense={dense}
        iconContainerClassName="bg-primary/20"
        iconColorClassName="text-primary"
        secondaryLine={tags.secondaryLine}
        used={tags.usage?.used}
        limit={tags.usage?.limit}
        labelOverride={tags.usage?.labelOverride}
        showProgress={tags.usage?.showProgress}
        progressVariant={tags.usage?.progressVariant}
        cta={tags.usage?.cta}
      />
    </div>
  );
}

export interface SlugPerformanceCardProps {
  t: (key: string) => string;
  className?: string;
}

/**
 * Slug / shortcut opens over time — illustrative bars until analytics API exists.
 */
export function SlugPerformanceCard({ t, className = '' }: SlugPerformanceCardProps) {
  const highlightIndex = SLUG_PERFORMANCE_PLACEHOLDER.length - 1;

  return (
    <div
      className={`relative flex min-h-[280px] flex-col gap-3 overflow-hidden rounded-2xl border border-ghost bg-surface p-6 shadow-xl ${className}`.trim()}
    >
      <div
        className="pointer-events-none absolute inset-0 bg-gradient-to-br from-primary/[0.07] to-transparent"
        aria-hidden
      />
      <div className="relative z-[1] flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-lg font-semibold text-foreground">{t('dashboard.performanceTitle')}</h3>
        <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-widest text-muted-foreground">
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
          </span>
          {t('dashboard.liveLabel')}
        </div>
      </div>
      <p className="relative z-[1] text-sm text-muted-foreground">{t('dashboard.performanceSubtitle')}</p>
      <div className="relative z-[1] flex min-h-[200px] w-full flex-1 pt-2">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={SLUG_PERFORMANCE_PLACEHOLDER} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
            <XAxis
              dataKey="name"
              tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }}
              axisLine={false}
              tickLine={false}
            />
            <YAxis hide />
            <Bar dataKey="value" radius={[6, 6, 0, 0]} maxBarSize={36}>
              {SLUG_PERFORMANCE_PLACEHOLDER.map((_, i) => (
                <Cell key={SLUG_PERFORMANCE_PLACEHOLDER[i].name} fill={i === highlightIndex ? PRIMARY_BAR : MUTED_BAR} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
