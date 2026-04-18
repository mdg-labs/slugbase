import { X } from 'lucide-react';
import { Badge } from './ui/badge';

export interface FilterChipItem {
  key: string;
  label: string;
  ariaLabel: string;
}

interface FilterChipsProps {
  chips: FilterChipItem[];
  onRemove: (key: string) => void;
  onClearAll: () => void;
  clearAllLabel: string;
  clearAllAriaLabel: string;
}

export function FilterChips({ chips, onRemove, onClearAll, clearAllLabel, clearAllAriaLabel }: FilterChipsProps) {
  if (chips.length === 0) return null;

  return (
    <div className="tag-wall flex flex-wrap items-center gap-2">
      {chips.map(({ key, label, ariaLabel }) => (
        <Badge
          key={key}
          variant="secondary"
          className="tag-chip inline-flex h-auto items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--bg-1)] py-1.5 pl-2.5 pr-1 text-[12.5px] font-medium text-[var(--fg-0)] transition-[background,border-color] hover:border-[var(--border-strong)] hover:bg-[var(--bg-2)]"
        >
          <span className="name">{label}</span>
          <button
            type="button"
            onClick={() => onRemove(key)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onRemove(key);
              }
            }}
            className="rounded p-0.5 text-[var(--fg-3)] hover:bg-[var(--bg-3)] hover:text-[var(--fg-0)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)]"
            aria-label={ariaLabel}
          >
            <X className="h-3.5 w-3.5" strokeWidth={1.75} />
          </button>
        </Badge>
      ))}
      <button
        type="button"
        onClick={onClearAll}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onClearAll();
          }
        }}
        className="rounded px-1 text-[12.5px] text-[var(--fg-2)] underline decoration-[var(--border-strong)] underline-offset-2 hover:text-[var(--fg-0)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)]"
        aria-label={clearAllAriaLabel}
      >
        {clearAllLabel}
      </button>
    </div>
  );
}
