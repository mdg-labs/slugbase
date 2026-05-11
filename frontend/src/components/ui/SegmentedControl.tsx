"use client"

import * as React from "react"
import * as ToggleGroupPrimitive from "@radix-ui/react-toggle-group"
import type { ToggleGroupSingleProps } from "@radix-ui/react-toggle-group"

import { cn } from "@/lib/utils"

/**
 * Mockup `.seg` (`styles.css` L768–786). Built on Radix Toggle Group (`type="single"`).
 * Phase 4 migrates `ScopeSegmentedControl`, Bookmarks view toggle, etc.
 */
const SegmentedControl = React.forwardRef<
  React.ElementRef<typeof ToggleGroupPrimitive.Root>,
  Omit<ToggleGroupSingleProps, "type">
>(({ className, ...props }, ref) => (
  <ToggleGroupPrimitive.Root
    ref={ref}
    type="single"
    className={cn(
      "inline-flex gap-0.5 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--bg-2)] p-0.5",
      className
    )}
    {...props}
  />
))
SegmentedControl.displayName = "SegmentedControl"

const SegmentedControlItem = React.forwardRef<
  React.ElementRef<typeof ToggleGroupPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof ToggleGroupPrimitive.Item>
>(({ className, children, ...props }, ref) => (
  <ToggleGroupPrimitive.Item
    ref={ref}
    className={cn(
      "inline-flex items-center justify-center gap-1.5 rounded px-2.5 py-1 font-mono text-[11.5px] font-medium text-[var(--fg-2)] transition-colors",
      "hover:text-[var(--fg-0)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg-0)]",
      "data-[state=on]:bg-[var(--bg-4)] data-[state=on]:text-[var(--fg-0)]",
      className
    )}
    {...props}
  >
    {children}
  </ToggleGroupPrimitive.Item>
))
SegmentedControlItem.displayName = "SegmentedControlItem"

export { SegmentedControl, SegmentedControlItem }
