import { Link } from 'react-router-dom';
import { LucideIcon } from 'lucide-react';
import { Card, CardContent } from './ui/card';
import { cn } from '@/lib/utils';

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
}

export function StatCard({ label, value, icon: Icon, href, dense, iconContainerClassName, iconColorClassName, className }: StatCardProps) {
  const content = (
    <>
      <div className="flex items-center justify-between">
        <div>
          <p className={cn('font-medium text-muted-foreground', dense ? 'text-xs' : 'text-sm')}>
            {label}
          </p>
          <p className={cn('font-semibold mt-2', dense ? 'text-xl' : 'text-2xl')}>
            {value}
          </p>
        </div>
        <div className={cn('rounded-lg', iconContainerClassName ?? 'bg-muted', dense ? 'p-2' : 'p-3')}>
          <Icon className={cn(iconColorClassName ?? 'text-muted-foreground', dense ? 'h-5 w-5' : 'h-6 w-6')} />
        </div>
      </div>
    </>
  );

  const cardClassName = cn(
    'transition-colors',
    href && 'cursor-pointer hover:border-primary/70 hover:bg-muted/50 focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2 rounded-xl',
    className
  );

  const contentPadding = dense ? 'p-3' : 'p-4';

  if (href) {
    return (
      <Link to={href} className="block focus:outline-none">
        <Card className={cardClassName}>
          <CardContent className={contentPadding}>
            {content}
          </CardContent>
        </Card>
      </Link>
    );
  }

  return (
    <Card className={cardClassName}>
      <CardContent className={contentPadding}>
        {content}
      </CardContent>
    </Card>
  );
}
