import { X } from 'lucide-react';

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
        <span
          key={key}
          className="inline-flex items-center gap-1.5 pl-2.5 pr-1.5 py-1 rounded-md bg-muted text-muted-foreground text-sm border border-border"
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
            className="p-0.5 rounded hover:bg-muted-foreground/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={ariaLabel}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </span>
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
