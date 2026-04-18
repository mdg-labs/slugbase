import { Link } from 'react-router-dom';
import { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

/** Optional usage display for plan/limit (hosted cloud). Only rendered when used + limit are both set. */
export interface StatCardUsageProps {
  used: number;
  limit: number;
  /** Full usage line (e.g. translated "Bookmarks used: 0/50"); when set, replaces the default "{label} {used} / {limit}" line */
  labelOverride?: string;
  showProgress?: boolean;
  progressVariant?: 'normal' | 'warning' | 'danger';
  /** Upgrade CTA; only pass in cloud when plan limits apply */
  cta?: { label: string; onClick: () => void };
}

interface StatCardProps {
  label: string;
  value: string | number;
  icon: LucideIcon;
  href?: string;
  /** Use compact padding and smaller icon for dense layouts */
  dense?: boolean;
  /** Tailwind classes for the icon container (e.g. bg-primary/15) */
  iconContainerClassName?: string;
  /** Tailwind classes for the icon color (e.g. text-primary) */
  iconColorClassName?: string;
  className?: string;
  /** Optional secondary line below value (e.g. "+12 this week") */
  secondaryLine?: string;
  /** Optional usage/limit display for cloud plan; only shown when both used and limit are provided */
  used?: number;
  limit?: number;
  /** When set with used/limit, shown as the sole usage line (see StatCardUsageProps) */
  labelOverride?: string;
  showProgress?: boolean;
  progressVariant?: 'normal' | 'warning' | 'danger';
  cta?: { label: string; onClick: () => void };
}

/** Mockup `.stat` (`styles.css` L429–464): label mono caps, large value, optional delta, spark icon. */
export function StatCard({
  label,
  value,
  icon: Icon,
  href,
  dense,
  iconContainerClassName,
  iconColorClassName,
  className,
  secondaryLine,
  used: usedProp,
  limit: limitProp,
  labelOverride,
  showProgress = true,
  progressVariant = 'normal',
  cta,
}: StatCardProps) {
  const hasUsage = usedProp != null && limitProp != null;
  const used = hasUsage ? usedProp : 0;
  const limit = hasUsage ? limitProp : 0;
  const showProgressBar = hasUsage && showProgress;
  const progressPercent = limit > 0 ? Math.min(100, (used / limit) * 100) : 0;

  const content = (
    <>
      <p className="label font-mono text-[11px] uppercase tracking-[0.06em] text-[var(--fg-2)]">
        {label}
      </p>
      <p
        className={cn(
          'value font-semibold tabular-nums tracking-[-0.02em] text-[var(--fg-0)]',
          dense ? 'text-xl' : 'text-[26px] leading-[1.1]'
        )}
      >
        {value}
      </p>
      {secondaryLine && (
        <p
          className={cn(
            'delta mt-0.5 font-mono text-[11px]',
            secondaryLine.trim().startsWith('+')
              ? 'text-[var(--success)]'
              : secondaryLine.trim().startsWith('-')
                ? 'text-[var(--danger)]'
                : 'text-[var(--fg-2)]'
          )}
        >
          {secondaryLine}
        </p>
      )}
      {hasUsage && (
        <p className="mt-1 font-mono text-[11px] text-[var(--fg-2)]">
          {labelOverride ?? `${label} ${used} / ${limit}`}
        </p>
      )}
      {(showProgressBar || cta) && (
        <div className="mt-auto pt-2">
          {showProgressBar && (
            <div className="h-2 w-full overflow-hidden rounded-full bg-[var(--bg-3)]">
              <div
                className={cn(
                  'h-full transition-all',
                  progressVariant === 'warning' && 'bg-[var(--warn)]',
                  progressVariant === 'danger' && 'bg-[var(--danger)]',
                  (progressVariant === 'normal' || !progressVariant) &&
                    'bg-[var(--accent)]'
                )}
                style={{ width: `${progressPercent}%` }}
              />
            </div>
          )}
          {cta && (
            <button
              type="button"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                cta.onClick();
              }}
              className={cn(
                'rounded text-xs font-medium text-[var(--accent)] hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg-1)]',
                showProgressBar ? 'mt-2' : 'mt-0'
              )}
            >
              {cta.label}
            </button>
          )}
        </div>
      )}
      <div
        className={cn(
          'spark pointer-events-none absolute right-3 top-3 opacity-80',
          iconContainerClassName
        )}
      >
        <Icon
          className={cn(
            dense ? 'size-5' : 'size-5',
            iconColorClassName ?? 'text-[var(--fg-3)]'
          )}
          strokeWidth={1.75}
        />
      </div>
    </>
  );

  const shellClass = cn(
    'stat relative flex min-h-0 flex-col gap-1 overflow-hidden rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg-1)] px-4 py-3.5',
    dense && 'px-3 py-3',
    href &&
      'cursor-pointer transition-[border-color,background] hover:border-[var(--border-strong)] hover:bg-[var(--bg-2)] focus-within:ring-2 focus-within:ring-[var(--accent-ring)] focus-within:ring-offset-2 focus-within:ring-offset-[var(--bg-0)]',
    className
  );

  if (href) {
    return (
      <Link to={href} className="block h-full min-h-0 focus:outline-none">
        <div className={shellClass}>{content}</div>
      </Link>
    );
  }

  return <div className={shellClass}>{content}</div>;
}
