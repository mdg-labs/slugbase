import type { ReactNode } from "react";

export type KbdProps = {
  children: ReactNode;
  className?: string;
};

/** Keyboard hint badge — matches prototype `Kbd` styling via design tokens. */
export function Kbd({ children, className = "" }: KbdProps) {
  return (
    <kbd
      className={[
        "inline-flex min-h-[18px] min-w-[18px] items-center justify-center rounded-sm",
        "border border-[color:var(--border-subtle)] bg-raised px-sp-2",
        "font-mono text-[10px] font-medium leading-none text-fg-subtle",
        className,
      ].join(" ")}
    >
      {children}
    </kbd>
  );
}
