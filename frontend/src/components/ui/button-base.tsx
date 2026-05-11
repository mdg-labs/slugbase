import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

/** Matches `styles.css` `.btn` (L322–349); Phase 2.1 variant split (neutral default vs primary). */
const buttonVariants = cva(
  "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-[var(--radius-sm)] font-medium transition-[background,border-color,color,opacity] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg-0)] disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default:
          "border border-[var(--border)] bg-[var(--bg-3)] text-[var(--fg-1)] shadow-none hover:bg-[var(--bg-2)] hover:text-[var(--fg-0)] hover:border-[var(--border-strong)]",
        primary:
          "border border-[var(--accent-ring)] bg-[var(--accent-bg-hi)] text-[var(--accent)] shadow-none hover:bg-[var(--accent-bg)] hover:text-[var(--accent-hi)]",
        destructive:
          "border border-transparent bg-[rgba(248,113,113,0.12)] text-[var(--danger)] shadow-none hover:border-[rgba(248,113,113,0.3)] hover:bg-[rgba(248,113,113,0.16)]",
        outline:
          "border border-[var(--border)] bg-transparent text-[var(--fg-1)] shadow-none hover:bg-[var(--bg-hover)] hover:text-[var(--fg-0)] hover:border-[var(--border-strong)]",
        secondary:
          "border border-[var(--border)] bg-[var(--bg-2)] text-[var(--fg-1)] shadow-none hover:bg-[var(--bg-3)] hover:text-[var(--fg-0)] hover:border-[var(--border-strong)]",
        ghost:
          "border border-transparent bg-transparent text-[var(--fg-2)] shadow-none hover:bg-[var(--bg-hover)] hover:text-[var(--fg-0)]",
        link: "rounded-none border-0 bg-transparent text-[var(--accent)] underline-offset-4 hover:underline",
      },
      size: {
        default:
          "min-h-0 px-[11px] py-[6px] text-[13px] leading-none [&_svg]:size-[14px]",
        sm: "min-h-0 px-2.5 py-[5px] text-[11.5px] leading-none [&_svg]:size-3.5",
        lg: "min-h-0 px-8 py-2.5 text-[13px] leading-none [&_svg]:size-[14px]",
        icon: "size-7 min-h-7 min-w-[28px] p-[6px] [&_svg]:size-[14px]",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button"
    return (
      <Comp
        className={cn(buttonVariants({ variant, size }), className)}
        ref={ref}
        {...props}
      />
    )
  }
)
Button.displayName = "Button"

export { Button, buttonVariants }
