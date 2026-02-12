import { Link } from 'react-router-dom';
import { LucideIcon } from 'lucide-react';
import { Card, CardContent } from './ui/card';
import { cn } from '@/lib/utils';

interface StatCardProps {
  label: string;
  value: string | number;
  icon: LucideIcon;
  href?: string;
  /** Tailwind classes for the icon container (e.g. bg-blue-100 dark:bg-blue-900/20) */
  iconContainerClassName?: string;
  /** Tailwind classes for the icon color (e.g. text-blue-600 dark:text-blue-400) */
  iconColorClassName?: string;
  className?: string;
}

export function StatCard({ label, value, icon: Icon, href, iconContainerClassName, iconColorClassName, className }: StatCardProps) {
  const content = (
    <>
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-medium text-muted-foreground">
            {label}
          </p>
          <p className="text-2xl font-semibold mt-2">
            {value}
          </p>
        </div>
        <div className={cn('p-3 rounded-lg', iconContainerClassName ?? 'bg-muted')}>
          <Icon className={cn('h-6 w-6', iconColorClassName ?? 'text-muted-foreground')} />
        </div>
      </div>
    </>
  );

  const cardClassName = cn(
    'transition-colors',
    href && 'cursor-pointer hover:border-primary/70 hover:bg-muted/50 focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2 rounded-xl',
    className
  );

  if (href) {
    return (
      <Link to={href} className="block focus:outline-none">
        <Card className={cardClassName}>
          <CardContent className="p-4">
            {content}
          </CardContent>
        </Card>
      </Link>
    );
  }

  return (
    <Card className={cardClassName}>
      <CardContent className="p-4">
        {content}
      </CardContent>
    </Card>
  );
}
