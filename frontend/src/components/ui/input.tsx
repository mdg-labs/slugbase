import * as React from "react"

import { cn } from "@/lib/utils"

export interface InputProps extends React.ComponentProps<"input"> {
  /** Optional leading color dot (mockup `.input-dot`). */
  inputDot?: boolean
  /** Left slot — icon or custom node (mockup `.input .ico`). */
  leftSlot?: React.ReactNode
  /** Right slot — suffix controls. */
  rightSlot?: React.ReactNode
  /** Invalid state — border uses danger (auth invalid pattern). */
  invalid?: boolean
}

/**
 * Mockup `.input` shell (`styles.css` L352–370): `--bg-2`, `--border`, focus ring per Phase 2.2.
 */
const Input = React.forwardRef<HTMLInputElement, InputProps>(
  (
    {
      className,
      type,
      inputDot,
      leftSlot,
      rightSlot,
      invalid,
      disabled,
      ...props
    },
    ref
  ) => {
    return (
      <div
        className={cn(
          "flex min-h-9 w-full items-center gap-2 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--bg-2)] px-2.5 py-1.5 text-[12.5px] transition-[border-color,background,box-shadow]",
          "focus-within:border-[var(--accent-ring)] focus-within:bg-[var(--bg-1)] focus-within:shadow-[0_0_0_3px_var(--accent-bg)]",
          invalid &&
            "border-[rgba(248,113,113,0.5)] focus-within:border-[rgba(248,113,113,0.5)] focus-within:shadow-none",
          disabled && "pointer-events-none opacity-50",
          className
        )}
      >
        {inputDot ? (
          <span
            className="size-1.5 shrink-0 rounded-full bg-[var(--fg-3)]"
            aria-hidden
          />
        ) : null}
        {leftSlot ? (
          <span className="flex shrink-0 items-center text-[var(--fg-3)] [&_svg]:size-[14px]">
            {leftSlot}
          </span>
        ) : null}
        <input
          type={type}
          ref={ref}
          disabled={disabled}
          className="min-h-0 w-full min-w-0 flex-1 bg-transparent text-[12.5px] text-[var(--fg-0)] outline-none placeholder:text-[var(--fg-3)] disabled:cursor-not-allowed"
          {...props}
        />
        {rightSlot ? (
          <span className="flex shrink-0 items-center text-[var(--fg-3)] [&_svg]:size-[14px]">
            {rightSlot}
          </span>
        ) : null}
      </div>
    )
  }
)
Input.displayName = "Input"

export { Input }
