import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

/** Mockup `.pill` (`styles.css` L396–412). Phase 2.3: 5×10 padding, 11.5px, tinted bg + text per variant. */
const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-full border px-2.5 py-[5px] text-[11.5px] font-medium leading-snug transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg-0)]",
  {
    variants: {
      variant: {
        default:
          "border-[var(--accent-ring)] bg-[var(--accent-bg)] text-[var(--accent-hi)]",
        secondary:
          "border-[var(--border)] bg-[var(--bg-3)] text-[var(--fg-2)]",
        destructive:
          "border-[rgba(248,113,113,0.3)] bg-[rgba(248,113,113,0.1)] text-[var(--danger)]",
        outline:
          "border-[var(--border)] bg-transparent text-[var(--fg-1)]",
        success:
          "border-[rgba(74,222,128,0.3)] bg-[rgba(74,222,128,0.1)] text-[var(--success)]",
        warn: "border-[rgba(251,191,36,0.3)] bg-[rgba(251,191,36,0.1)] text-[var(--warn)]",
        accent:
          "border-[var(--accent-ring)] bg-[var(--accent-bg)] text-[var(--accent-hi)]",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <div className={cn(badgeVariants({ variant }), className)} {...props} />
  )
}

export { Badge, badgeVariants }
