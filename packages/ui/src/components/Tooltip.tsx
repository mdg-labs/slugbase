import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import type { ReactNode } from "react";

export const TooltipProvider = TooltipPrimitive.Provider;
export const Tooltip = TooltipPrimitive.Root;
export const TooltipTrigger = TooltipPrimitive.Trigger;

export type TooltipContentProps = {
  children: ReactNode;
  className?: string;
  testId?: string;
  sideOffset?: number;
};

export function TooltipContent({
  children,
  className = "",
  testId,
  sideOffset = 4,
}: TooltipContentProps) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        data-testid={testId}
        sideOffset={sideOffset}
        className={`z-[130] max-w-[280px] rounded-md border border-[color:var(--border-subtle)] bg-overlay px-sp-4 py-sp-3 text-small text-fg shadow-overlay ${className}`}
      >
        {children}
        <TooltipPrimitive.Arrow className="fill-[color:var(--overlay)]" />
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  );
}
