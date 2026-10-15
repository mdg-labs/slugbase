import type { ReactElement, ReactNode } from "react";
import { Badge } from "../components/ui/badge.tsx";

export type StatusBadgeVariant = "info" | "neutral" | "success" | "warning" | "error";

const VARIANTS = {
  neutral: "outline",
  info: "info",
  success: "success",
  warning: "warning",
  error: "error",
} as const satisfies Record<StatusBadgeVariant, "outline" | "info" | "success" | "warning" | "error">;

export interface StatusBadgeProps {
  /** The state the badge names; it sets the colour. The label carries the meaning, never the colour alone. */
  variant?: StatusBadgeVariant;
  children: ReactNode;
  className?: string;
}

/** A short label for a state, such as "This device" or "Verified" (doc 03 `status-badge`): a coss Badge. */
export function StatusBadge({ variant = "neutral", children, className }: StatusBadgeProps): ReactElement {
  return (
    <Badge className={className} data-slot="status-badge" variant={VARIANTS[variant]}>
      {children}
    </Badge>
  );
}
