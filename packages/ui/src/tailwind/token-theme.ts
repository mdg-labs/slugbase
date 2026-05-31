import type { Config } from "tailwindcss";

/** CSS custom properties bridged from colors-and-type.css — no hard-coded hex in Tailwind theme. */
export const slugbaseCssVarColors = {
  accent: "var(--accent)",
  "accent-hover": "var(--accent-hover)",
  "accent-active": "var(--accent-active)",
  "accent-fg": "var(--accent-fg)",
  "accent-subtle": "var(--accent-subtle)",
  "accent-text": "var(--accent-text)",
  canvas: "var(--canvas)",
  base: "var(--base)",
  raised: "var(--raised)",
  "raised-2": "var(--raised-2)",
  overlay: "var(--overlay)",
  fg: "var(--fg)",
  "fg-muted": "var(--fg-muted)",
  "fg-subtle": "var(--fg-subtle)",
  "fg-faint": "var(--fg-faint)",
  success: "var(--success)",
  "success-text": "var(--success-text)",
  warning: "var(--warning)",
  "warning-text": "var(--warning-text)",
  danger: "var(--danger)",
  "danger-text": "var(--danger-text)",
} as const;

export type SlugbaseTokenColor = keyof typeof slugbaseCssVarColors;

/** Resolves a design-token color name to its CSS variable reference. */
export function resolveTokenColor(token: SlugbaseTokenColor): string {
  return slugbaseCssVarColors[token];
}

export const slugbaseTailwindPreset = {
  theme: {
    extend: {
      colors: slugbaseCssVarColors,
      fontFamily: {
        sans: ["var(--font-sans)"],
        mono: ["var(--font-mono)"],
      },
      fontSize: {
        body: ["var(--text-body)", { lineHeight: "var(--lh-body)" }],
        small: ["var(--text-small)", { lineHeight: "var(--lh-small)" }],
      },
      borderRadius: {
        sm: "var(--r-sm)",
        md: "var(--r-md)",
        lg: "var(--r-lg)",
        xl: "var(--r-xl)",
      },
      spacing: {
        "sp-2": "var(--sp-2)",
        "sp-3": "var(--sp-3)",
        "sp-4": "var(--sp-4)",
        "sp-5": "var(--sp-5)",
        "sp-6": "var(--sp-6)",
        "sp-7": "var(--sp-7)",
        "sp-8": "var(--sp-8)",
      },
      boxShadow: {
        raised: "var(--shadow-raised)",
        overlay: "var(--shadow-overlay)",
      },
      transitionDuration: {
        micro: "var(--dur-micro)",
        DEFAULT: "var(--dur)",
        overlay: "var(--dur-overlay)",
      },
      transitionTimingFunction: {
        DEFAULT: "var(--ease)",
        "in-out": "var(--ease-in-out)",
      },
    },
  },
} satisfies Pick<Config, "theme">;
