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
    <div className="flex flex-wrap items-center gap-2">
      {chips.map(({ key, label, ariaLabel }) => (
        <Badge
          key={key}
          variant="secondary"
          className="inline-flex items-center gap-1.5 rounded-full border-0 bg-surface-low py-1 pl-2.5 pr-1 text-sm font-normal text-foreground"
        >
          <span>{label}</span>
          <button
            type="button"
            onClick={() => onRemove(key)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onRemove(key);
              }
            }}
            className="rounded-full p-0.5 text-muted-foreground hover:bg-surface-high hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={ariaLabel}
          >
            <X className="h-3.5 w-3.5" />
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
        className="text-sm text-muted-foreground hover:text-foreground underline focus:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded px-1"
        aria-label={clearAllAriaLabel}
      >
        {clearAllLabel}
      </button>
    </div>
  );
}
