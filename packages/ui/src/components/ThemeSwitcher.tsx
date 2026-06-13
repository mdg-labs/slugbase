import type { ThemePreference } from "../theme/theme-types.js";
import { useTheme } from "../theme/theme-context.js";

export type ThemeSwitcherLabels = {
  group: string;
  light: string;
  dark: string;
  auto: string;
};

const OPTIONS: ThemePreference[] = ["light", "dark", "auto"];

export type ThemeSwitcherProps = {
  labels: ThemeSwitcherLabels;
};

export function ThemeSwitcher({ labels }: ThemeSwitcherProps) {
  const { preference, setPreference } = useTheme();

  const labelFor = (value: ThemePreference): string => {
    switch (value) {
      case "light":
        return labels.light;
      case "dark":
        return labels.dark;
      case "auto":
        return labels.auto;
    }
  };

  return (
    <div
      className="inline-flex rounded-md border border-[color:var(--border)] bg-raised p-sp-2"
      role="group"
      aria-label={labels.group}
      data-testid="theme-switcher"
    >
      {OPTIONS.map((value) => {
        const active = preference === value;
        return (
          <button
            key={value}
            type="button"
            aria-pressed={active}
            className={
              active
                ? "rounded-sm bg-accent px-sp-5 py-sp-3 text-small font-medium text-accent-fg transition-micro"
                : "rounded-sm px-sp-5 py-sp-3 text-small text-fg-muted transition-micro hover:bg-raised-2 hover:text-fg"
            }
            onClick={() => {
              setPreference(value);
            }}
          >
            {labelFor(value)}
          </button>
        );
      })}
    </div>
  );
}
