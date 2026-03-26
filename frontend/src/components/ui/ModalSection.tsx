import * as React from 'react';
import { cn } from '@/lib/utils';

interface ModalSectionProps {
  title?: string;
  description?: string;
  children: React.ReactNode;
  className?: string;
}

export function ModalSection({
  title,
  description,
  children,
  className,
}: ModalSectionProps) {
  return (
    <div className={cn('space-y-3', className)}>
      {(title || description) && (
        <div>
          {title && (
            <h4 className="text-lg font-semibold leading-none text-foreground">
              {title}
            </h4>
          )}
          {description && (
            <p className="mt-1 text-xs text-muted-foreground">{description}</p>
          )}
        </div>
      )}
      {children}
    </div>
  );
}
