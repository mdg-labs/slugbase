import { useNavigate } from 'react-router-dom';
import type { LucideIcon } from 'lucide-react';
import { Plus } from 'lucide-react';

export interface DashedDashboardCtaCardProps {
  to: string;
  title: string;
  description: string;
  Icon?: LucideIcon;
}

/**
 * Dashed-border dashboard CTA tile (Quick Access empty / Pinned empty).
 */
export function DashedDashboardCtaCard({ to, title, description, Icon = Plus }: DashedDashboardCtaCardProps) {
  const navigate = useNavigate();

  return (
    <button
      type="button"
      onClick={() => navigate(to)}
      aria-label={`${title}. ${description}`}
      className="group flex min-h-[220px] flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed border-ghost bg-transparent p-6 text-center transition-all duration-300 hover:border-primary/50 hover:bg-primary/5 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span className="flex h-10 w-10 items-center justify-center rounded-full border border-ghost bg-surface text-muted-foreground transition-transform group-hover:scale-110">
        <Icon className="h-5 w-5 text-primary" aria-hidden />
      </span>
      <div className="space-y-1">
        <span className="block text-sm font-bold text-muted-foreground">{title}</span>
        <span className="block text-[10px] text-muted-foreground/80">{description}</span>
      </div>
    </button>
  );
}
