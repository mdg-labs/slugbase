import * as React from 'react';
import { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  description?: string;
  action?: React.ReactNode;
  className?: string;
}

/**
 * Mockup `.empty` (`gaps_styles.css` L628–654) — dashed tile, heading, body, primary sm CTA.
 */
export function EmptyState({ icon: Icon, title, description, action, className }: EmptyStateProps) {
  return (
    <div
      className={cn(
        'empty flex flex-col items-center gap-3 px-5 py-[60px] text-center',
        className
      )}
    >
      <div className="ill relative grid size-[76px] place-items-center rounded-[18px] border border-dashed border-[var(--border-strong)] bg-[var(--bg-2)] text-[var(--fg-3)] after:pointer-events-none after:absolute after:-inset-2 after:rounded-[22px] after:border after:border-dashed after:border-[var(--border-soft)] after:opacity-50">
        <Icon className="size-[26px]" strokeWidth={1.75} aria-hidden />
      </div>
      <h4 className="m-0 text-sm font-semibold text-[var(--fg-0)]">{title}</h4>
      {description && (
        <p className="m-0 max-w-[320px] text-[12.5px] leading-relaxed text-[var(--fg-2)]">
          {description}
        </p>
      )}
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}
