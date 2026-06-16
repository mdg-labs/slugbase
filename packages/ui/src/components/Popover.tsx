import * as PopoverPrimitive from "@radix-ui/react-popover";
import type { ReactNode } from "react";

export const Popover = PopoverPrimitive.Root;
export const PopoverTrigger = PopoverPrimitive.Trigger;
export const PopoverClose = PopoverPrimitive.Close;

export type PopoverContentProps = {
  children: ReactNode;
  className?: string;
  testId?: string;
  align?: "start" | "center" | "end";
  sideOffset?: number;
};

export function PopoverContent({
  children,
  className = "",
  testId,
  align = "start",
  sideOffset = 4,
}: PopoverContentProps) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        data-testid={testId}
        align={align}
        sideOffset={sideOffset}
        className={`z-[130] max-h-[min(360px,70vh)] w-[min(320px,92vw)] overflow-y-auto rounded-lg border border-[color:var(--border)] bg-[color:var(--overlay)] p-sp-4 shadow-lg focus:outline-none ${className}`}
      >
        {children}
      </PopoverPrimitive.Content>
    </PopoverPrimitive.Portal>
  );
}
