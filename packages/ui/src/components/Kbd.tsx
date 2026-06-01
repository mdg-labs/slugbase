import type { ReactNode } from "react";

export type KbdProps = {
  children: ReactNode;
  className?: string;
};

/**
 * Keyboard hint badge — 11px mono, canvas bg, 3D bottom border.
 * Matches prototype `.kbd` from app.css.
 */
export function Kbd({ children, className = "" }: KbdProps) {
  return (
    <kbd
      className={[
        "inline-flex min-h-[18px] min-w-[18px] items-center justify-center gap-[2px] rounded-sm",
        "border border-[color:var(--border)] bg-canvas",
        "font-mono font-medium leading-none text-fg-muted",
        className,
      ].join(" ")}
      style={{
        fontSize: "11px",
        padding: "3px 5px",
        borderBottomWidth: "2px",
      }}
    >
      {children}
    </kbd>
  );
}
