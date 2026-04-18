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
 * Dashed “New folder” / empty-state tile (mockup `folder-card` dashed variant).
 */
export function DashedDashboardCtaCard({ to, title, description, Icon = Plus }: DashedDashboardCtaCardProps) {
  const navigate = useNavigate();

  return (
    <button
      type="button"
      onClick={() => navigate(to)}
      aria-label={`${title}. ${description}`}
      className="group flex min-h-[140px] flex-col items-center justify-center gap-2 rounded-[var(--radius-lg)] border border-dashed border-[var(--border-strong)] bg-transparent px-4 py-6 text-center text-[var(--fg-2)] transition-colors hover:border-[var(--accent-ring)] hover:bg-[var(--accent-bg)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)]"
    >
      <span className="flex h-9 w-9 items-center justify-center rounded-[var(--radius)] bg-[var(--bg-2)] text-[var(--fg-3)] transition-transform group-hover:scale-105">
        <Icon className="h-4 w-4 text-[var(--accent-hi)]" aria-hidden />
      </span>
      <div className="space-y-0.5">
        <span className="block text-[12.5px] font-medium text-[var(--fg-1)]">{title}</span>
        <span className="block text-[11px] text-[var(--fg-3)]">{description}</span>
      </div>
    </button>
  );
}
