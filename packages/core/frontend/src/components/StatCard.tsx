import { Link } from 'react-router-dom';
import { LucideIcon } from 'lucide-react';
import { Card, CardContent } from './ui/card';
import { cn } from '@/lib/utils';

/** Optional usage display for plan/limit (e.g. slugbase-cloud). Only rendered when used + limit are both set. */
export interface StatCardUsageProps {
  used: number;
  limit: number;
  /** e.g. "Bookmarks used" */
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
  /** Tailwind classes for the icon container (e.g. bg-blue-100 dark:bg-blue-900/20) */
  iconContainerClassName?: string;
  /** Tailwind classes for the icon color (e.g. text-blue-600 dark:text-blue-400) */
  iconColorClassName?: string;
  className?: string;
  /** Optional secondary line below value (e.g. "+12 this week") */
  secondaryLine?: string;
  /** Optional usage/limit display for cloud plan; only shown when both used and limit are provided */
  used?: number;
  limit?: number;
  labelOverride?: string;
  showProgress?: boolean;
  progressVariant?: 'normal' | 'warning' | 'danger';
  cta?: { label: string; onClick: () => void };
}

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
    <div className="flex items-stretch justify-between gap-3 flex-1 min-h-0">
      <div className="min-w-0 flex-1 flex flex-col">
        <div className="min-w-0">
          <p className={cn('text-muted-foreground', dense ? 'text-xs' : 'text-sm')}>
            {label}
          </p>
          <p className={cn('font-semibold mt-1 text-foreground', dense ? 'text-xl' : 'text-2xl')}>
            {value}
          </p>
          {secondaryLine && (
            <p className="mt-0.5 text-xs text-muted-foreground">{secondaryLine}</p>
          )}
          {hasUsage && (
            <p className="mt-1 text-xs text-muted-foreground">
              {labelOverride ?? label} {used} / {limit}
            </p>
          )}
        </div>
        {(showProgressBar || cta) && (
          <div className="mt-auto pt-2">
            {showProgressBar && (
              <div className="w-full overflow-hidden rounded-full bg-primary/20">
                <div
                  className={cn(
                    'h-2 transition-all',
                    progressVariant === 'warning' && 'bg-amber-500',
                    progressVariant === 'danger' && 'bg-destructive',
                    (progressVariant === 'normal' || !progressVariant) && 'bg-primary'
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
                className={cn('text-xs font-medium text-primary hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded', showProgressBar ? 'mt-2' : 'mt-0')}
              >
                {cta.label}
              </button>
            )}
          </div>
        )}
      </div>
      <div className={cn('shrink-0 rounded-lg self-center', iconContainerClassName ?? 'bg-muted', dense ? 'p-2' : 'p-3')}>
        <Icon className={cn(iconColorClassName ?? 'text-muted-foreground', dense ? 'h-5 w-5' : 'h-6 w-6')} />
      </div>
    </div>
  );

  const cardClassName = cn(
    'transition-colors h-full flex flex-col',
    href && 'cursor-pointer hover:border-primary/70 hover:bg-muted/50 focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2 rounded-xl',
    className
  );

  const contentPadding = dense ? 'p-3' : 'p-4';

  if (href) {
    return (
      <Link to={href} className="block h-full focus:outline-none">
        <Card className={cardClassName}>
          <CardContent className={cn(contentPadding, 'flex-1 flex flex-col min-h-0')}>
            {content}
          </CardContent>
        </Card>
      </Link>
    );
  }

  return (
    <Card className={cardClassName}>
      <CardContent className={cn(contentPadding, 'flex-1 flex flex-col min-h-0')}>
        {content}
      </CardContent>
    </Card>
  );
}
