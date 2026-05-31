import type { InputHTMLAttributes } from "react";

export type InputProps = InputHTMLAttributes<HTMLInputElement> & {
  invalid?: boolean;
};

export function Input({ invalid = false, className = "", ...props }: InputProps) {
  return (
    <input
      className={`w-full rounded-md border bg-raised px-sp-4 py-sp-3 text-fg placeholder:text-fg-faint focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-2 focus:ring-offset-canvas disabled:cursor-not-allowed disabled:opacity-50 ${
        invalid
          ? "border-[color:var(--danger)] focus:ring-danger"
          : "border-[color:var(--border)]"
      } ${className}`}
      style={{ fontSize: "var(--text-body)", lineHeight: "var(--lh-body)" }}
      aria-invalid={invalid || undefined}
      {...props}
    />
  );
}
