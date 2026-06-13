import type { Config } from "tailwindcss";

/** CSS custom properties bridged from colors-and-type.css - no hard-coded hex in Tailwind theme. */
export const slugbaseCssVarColors = {
  accent: "var(--accent)",
  "accent-hover": "var(--accent-hover)",
  "accent-active": "var(--accent-active)",
  "accent-fg": "var(--accent-fg)",
  "accent-subtle": "var(--accent-subtle)",
  "accent-subtle-hover": "var(--accent-subtle-hover)",
  "accent-border": "var(--accent-border)",
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
  "success-fg": "var(--success-fg)",
  "success-subtle": "var(--success-subtle)",
  "success-text": "var(--success-text)",
  warning: "var(--warning)",
  "warning-fg": "var(--warning-fg)",
  "warning-subtle": "var(--warning-subtle)",
  "warning-text": "var(--warning-text)",
  danger: "var(--danger)",
  "danger-hover": "var(--danger-hover)",
  "danger-fg": "var(--danger-fg)",
  "danger-subtle": "var(--danger-subtle)",
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
        display: ["var(--text-display)", { lineHeight: "var(--lh-display)" }],
        h1: ["var(--text-h1)", { lineHeight: "var(--lh-h1)" }],
        h2: ["var(--text-h2)", { lineHeight: "var(--lh-h2)" }],
        h3: ["var(--text-h3)", { lineHeight: "var(--lh-h3)" }],
        "body-lg": ["var(--text-body-lg)", { lineHeight: "var(--lh-body-lg)" }],
        body: ["var(--text-body)", { lineHeight: "var(--lh-body)" }],
        small: ["var(--text-small)", { lineHeight: "var(--lh-small)" }],
        micro: ["var(--text-micro)", { lineHeight: "var(--lh-micro)" }],
        mono: ["var(--text-mono)", { lineHeight: "var(--lh-mono)" }],
      },
      borderRadius: {
        sm: "var(--r-sm)",
        md: "var(--r-md)",
        lg: "var(--r-lg)",
        xl: "var(--r-xl)",
        full: "var(--r-full)",
      },
      spacing: {
        "sp-1": "var(--sp-1)",
        "sp-2": "var(--sp-2)",
        "sp-3": "var(--sp-3)",
        "sp-4": "var(--sp-4)",
        "sp-5": "var(--sp-5)",
        "sp-6": "var(--sp-6)",
        "sp-7": "var(--sp-7)",
        "sp-8": "var(--sp-8)",
        "sp-9": "var(--sp-9)",
        "sp-10": "var(--sp-10)",
        "sp-11": "var(--sp-11)",
        "sp-12": "var(--sp-12)",
      },
      boxShadow: {
        raised: "var(--shadow-raised)",
        overlay: "var(--shadow-overlay)",
        popover: "var(--shadow-popover)",
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
      keyframes: {
        shimmer: {
          from: { backgroundPosition: "200% 0" },
          to: { backgroundPosition: "-200% 0" },
        },
        "toast-in": {
          from: { opacity: "0", transform: "translateX(16px)" },
          to: { opacity: "1", transform: "translateX(0)" },
        },
      },
      animation: {
        shimmer: "shimmer 1.3s ease-in-out infinite",
        "toast-in": "toast-in var(--dur) var(--ease)",
      },
    },
  },
} satisfies Pick<Config, "theme">;
