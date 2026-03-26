export interface ScopeOption {
  value: string;
  label: string;
}

interface ScopeSegmentedControlProps {
  value: string;
  onChange: (value: string) => void;
  options: ScopeOption[];
  ariaLabel?: string;
}

export function ScopeSegmentedControl({ value, onChange, options, ariaLabel }: ScopeSegmentedControlProps) {
  return (
    <div
      className="flex items-center gap-0.5 rounded-lg bg-surface-low p-1"
      role="group"
      aria-label={ariaLabel}
    >
      {options.map((opt) => {
        const selected = value === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => onChange(opt.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onChange(opt.value);
              }
            }}
            className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
              selected
                ? 'bg-primary/15 text-primary shadow-sm'
                : 'text-muted-foreground hover:bg-surface-high hover:text-foreground'
            }`}
            aria-pressed={selected}
            aria-label={opt.label}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
