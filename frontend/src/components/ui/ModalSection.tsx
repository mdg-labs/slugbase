import * as React from 'react';
import { cn } from '@/lib/utils';

interface ModalSectionProps {
  title?: string;
  description?: string;
  children: React.ReactNode;
  className?: string;
}

/** Labelled modal block — uses mockup `.field` label rhythm (`styles.css` L715–724). */
export function ModalSection({
  title,
  description,
  children,
  className,
}: ModalSectionProps) {
  return (
    <div className={cn('field mb-4 last:mb-0', className)}>
      {(title || description) && (
        <div className="mb-3">
          {title && (
            <div className="mb-1.5 block font-mono text-[11px] uppercase tracking-[0.06em] text-[var(--fg-2)]">
              {title}
            </div>
          )}
          {description && (
            <p className="text-[12.5px] leading-relaxed text-[var(--fg-2)]">{description}</p>
          )}
        </div>
      )}
      {children}
    </div>
  );
}
