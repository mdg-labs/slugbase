import type { ButtonHTMLAttributes, ReactNode } from "react";

export type ButtonVariant = "primary" | "secondary" | "ghost";

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  children: ReactNode;
};

const variantClasses: Record<ButtonVariant, string> = {
  primary:
    "border border-[color:var(--accent-border)] bg-accent text-accent-fg hover:bg-accent-hover active:bg-accent-active disabled:opacity-50",
  secondary:
    "border border-[color:var(--border)] bg-raised text-fg hover:bg-raised-2 disabled:opacity-50",
  ghost:
    "border border-transparent bg-transparent text-fg-muted hover:bg-raised hover:text-fg disabled:opacity-50",
};

export function Button({
  variant = "primary",
  className = "",
  type = "button",
  children,
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      className={`inline-flex items-center justify-center gap-sp-3 rounded-md px-sp-5 py-sp-3 font-medium transition-colors duration-micro ease-in-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-canvas disabled:cursor-not-allowed ${variantClasses[variant]} ${className}`}
      style={{ fontSize: "var(--text-body)", lineHeight: "var(--lh-body)" }}
      {...props}
    >
      {children}
    </button>
  );
}
