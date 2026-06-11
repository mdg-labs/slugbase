import type { ReactNode } from "react";

export type BadgeVariant = "accent" | "success" | "warning" | "neutral";

export type BadgeProps = {
  variant?: BadgeVariant;
  children: ReactNode;
  className?: string;
};

const variantClasses: Record<BadgeVariant, string> = {
  accent: "bg-accent-subtle text-accent-text",
  success: "bg-success-subtle text-success-text",
  warning: "bg-warning-subtle text-warning-text",
  neutral: "bg-raised-2 text-fg-muted",
};

/**
 * Status / plan badge - matches prototype `.badge` pattern.
 * Variant: accent | success | warning | neutral.
 */
export function Badge({
  variant = "neutral",
  children,
  className = "",
}: BadgeProps) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full font-semibold ${variantClasses[variant]} ${className}`}
      style={{
        height: "18px",
        padding: "0 7px",
        fontSize: "var(--text-micro)",
        lineHeight: "var(--lh-micro)",
        letterSpacing: "0.02em",
      }}
    >
      {children}
    </span>
  );
}
