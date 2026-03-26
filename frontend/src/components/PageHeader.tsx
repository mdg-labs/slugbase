import * as React from 'react';
import { cn } from '@/lib/utils';

interface PageHeaderProps {
  title: string;
  subtitle?: string;
  actions?: React.ReactNode;
  className?: string;
  /** Obsidian / Stitch collection pages: heavy display title */
  titleClassName?: string;
  subtitleClassName?: string;
}

export function PageHeader({
  title,
  subtitle,
  actions,
  className,
  titleClassName,
  subtitleClassName,
}: PageHeaderProps) {
  return (
    <div className={cn('flex flex-wrap items-end justify-between gap-4', className)}>
      <div className="min-w-0 space-y-1">
        <h1 className={cn('text-2xl font-semibold tracking-tight text-foreground', titleClassName)}>
          {title}
        </h1>
        {subtitle && (
          <p className={cn('text-sm text-muted-foreground', subtitleClassName)}>
            {subtitle}
          </p>
        )}
      </div>
      {actions && (
        <div className="flex items-center gap-2">
          {actions}
        </div>
      )}
    </div>
  );
}
