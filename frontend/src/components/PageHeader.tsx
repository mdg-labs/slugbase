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
    <div
      className={cn(
        'page-head mb-[18px] flex flex-wrap items-end gap-4',
        className
      )}
    >
      <div className="min-w-0">
        <h1
          className={cn(
            'm-0 text-[22px] font-semibold tracking-[-0.02em] text-[var(--fg-0)]',
            titleClassName
          )}
        >
          {title}
        </h1>
        {subtitle && (
          <p
            className={cn(
              'sub mt-0.5 text-[12.5px] text-[var(--fg-2)]',
              subtitleClassName
            )}
          >
            {subtitle}
          </p>
        )}
      </div>
      {actions && (
        <div className="actions ml-auto flex flex-wrap items-center gap-2">{actions}</div>
      )}
    </div>
  );
}
