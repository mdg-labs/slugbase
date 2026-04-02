import * as React from 'react';
import { LucideIcon } from 'lucide-react';
import { Card, CardContent } from './ui/card';
import { cn } from '@/lib/utils';

interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  description?: string;
  action?: React.ReactNode;
  className?: string;
}

export function EmptyState({ icon: Icon, title, description, action, className }: EmptyStateProps) {
  return (
    <Card
      className={cn(
        'flex flex-col items-center justify-center border border-ghost py-16 px-6 hover:bg-surface',
        className
      )}
    >
      <CardContent className="flex flex-col items-center text-center p-0 pt-0">
        <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-primary/10">
          <Icon className="h-8 w-8 text-primary" />
        </div>
        <h3 className="mb-2 text-xl font-semibold tracking-tight text-foreground">
          {title}
        </h3>
        {description && (
          <p className="mb-6 max-w-md text-sm leading-relaxed text-muted-foreground">
            {description}
          </p>
        )}
        {action && <div>{action}</div>}
      </CardContent>
    </Card>
  );
}
