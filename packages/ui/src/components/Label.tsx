import type { LabelHTMLAttributes, ReactNode } from "react";

export type LabelProps = LabelHTMLAttributes<HTMLLabelElement> & {
  children: ReactNode;
};

export function Label({ className = "", children, ...props }: LabelProps) {
  return (
    <label
      className={`font-medium text-fg-muted ${className}`}
      style={{ fontSize: "var(--text-small)", lineHeight: "var(--lh-small)" }}
      {...props}
    >
      {children}
    </label>
  );
}
