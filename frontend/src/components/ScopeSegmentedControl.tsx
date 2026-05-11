import {
  SegmentedControl,
  SegmentedControlItem,
} from './ui/SegmentedControl';

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

/** Mockup `.seg` — implemented with `SegmentedControl` (Phase 2.6). */
export function ScopeSegmentedControl({
  value,
  onChange,
  options,
  ariaLabel,
}: ScopeSegmentedControlProps) {
  return (
    <SegmentedControl
      value={value}
      onValueChange={(next) => {
        if (next) onChange(next);
      }}
      className="flex-wrap"
      aria-label={ariaLabel}
    >
      {options.map((opt) => (
        <SegmentedControlItem
          key={opt.value}
          value={opt.value}
          aria-label={opt.label}
        >
          {opt.label}
        </SegmentedControlItem>
      ))}
    </SegmentedControl>
  );
}
