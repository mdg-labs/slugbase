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
      className="flex items-center rounded-lg border border-border bg-muted/50 p-0.5"
      role="group"
      aria-label={ariaLabel}
    >
      {options.map((opt) => (
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
          className={`px-3 py-1.5 text-sm rounded-md transition-colors ${
            value === opt.value ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
          }`}
          aria-pressed={value === opt.value}
          aria-label={opt.label}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
