import { CheckIcon } from "lucide-react";

/** Curated palette — semantic hues + accent variants aligned with design tokens. */
export const PRESET_COLORS = [
  "#7782f7",
  "#45c98a",
  "#e6b24e",
  "#f0686b",
  "#5ba4e6",
  "#56b6e6",
  "#e8944a",
  "#a77bea",
  "#b178f7",
  "#f78fb0",
  "#5fd6a0",
  "#8a90a0",
  "#6571ec",
  "#9aa2fa",
  "#efc878",
  "#f48a8c",
] as const;

export type ColorPickerLabels = {
  label: string;
  none: string;
};

export type ColorPickerProps = {
  value: string | null;
  onChange: (color: string | null) => void;
  labels: ColorPickerLabels;
  testId?: string;
};

export function ColorPicker({
  value,
  onChange,
  labels,
  testId = "color-picker",
}: ColorPickerProps) {
  return (
    <div className="flex flex-col gap-sp-2" data-testid={testId}>
      <span
        className="text-fg-muted"
        style={{ fontSize: "var(--text-small)", lineHeight: "var(--lh-small)" }}
      >
        {labels.label}
      </span>
      <div className="grid grid-cols-8 gap-sp-3" data-testid={`${testId}-grid`}>
        {PRESET_COLORS.map((swatch) => (
          <button
            key={swatch}
            type="button"
            className="relative h-7 w-7 rounded-full transition-transform hover:scale-110 focus:outline-none focus:ring-2 focus:ring-[color:var(--accent)] focus:ring-offset-2 focus:ring-offset-[color:var(--overlay)]"
            style={{ backgroundColor: swatch }}
            aria-label={swatch}
            aria-pressed={value === swatch}
            data-testid={`${testId}-swatch-${swatch.slice(1)}`}
            onClick={() => {
              onChange(value === swatch ? null : swatch);
            }}
          >
            {value === swatch && (
              <CheckIcon
                size={14}
                className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 text-white"
              />
            )}
          </button>
        ))}
      </div>
      {value && (
        <button
          type="button"
          className="self-start text-fg-muted transition-colors hover:text-fg"
          style={{ fontSize: "var(--text-small)" }}
          data-testid={`${testId}-clear`}
          onClick={() => {
            onChange(null);
          }}
        >
          {labels.none}
        </button>
      )}
    </div>
  );
}
