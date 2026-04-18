"use client"

import * as React from "react"

import { cn } from "@/lib/utils"

type Ctx = {
  value: string
  onValueChange: (value: string) => void
}

const SegmentedControlContext = React.createContext<Ctx | null>(null)

function useSegmentedControl() {
  const ctx = React.useContext(SegmentedControlContext)
  if (!ctx) {
    throw new Error(
      "SegmentedControlItem must be used within SegmentedControl"
    )
  }
  return ctx
}

export interface SegmentedControlProps {
  value: string
  onValueChange: (value: string) => void
  children: React.ReactNode
  className?: string
  /** Accessible label for the tablist. */
  "aria-label"?: string
}

/**
 * Mockup `.seg` (`styles.css` L768–786). Radix-free; Phase 4 migrates callsites.
 */
export function SegmentedControl({
  value,
  onValueChange,
  children,
  className,
  "aria-label": ariaLabel,
}: SegmentedControlProps) {
  const ctx = React.useMemo(
    () => ({ value, onValueChange }),
    [value, onValueChange]
  )

  return (
    <SegmentedControlContext.Provider value={ctx}>
      <div
        role="tablist"
        aria-label={ariaLabel}
        className={cn(
          "inline-flex gap-0.5 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--bg-2)] p-0.5",
          className
        )}
      >
        {children}
      </div>
    </SegmentedControlContext.Provider>
  )
}

export interface SegmentedControlItemProps {
  value: string
  children: React.ReactNode
  className?: string
  disabled?: boolean
}

export function SegmentedControlItem({
  value,
  children,
  className,
  disabled,
}: SegmentedControlItemProps) {
  const { value: groupValue, onValueChange } = useSegmentedControl()
  const isSelected = groupValue === value

  return (
    <button
      type="button"
      role="tab"
      aria-selected={isSelected}
      disabled={disabled}
      className={cn(
        "inline-flex items-center gap-1.5 rounded px-2.5 py-1 font-mono text-[11.5px] text-[var(--fg-2)] transition-colors",
        "hover:text-[var(--fg-0)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg-0)]",
        isSelected && "bg-[var(--bg-4)] text-[var(--fg-0)]",
        disabled && "pointer-events-none opacity-50",
        className
      )}
      onClick={() => onValueChange(value)}
    >
      {children}
    </button>
  )
}
