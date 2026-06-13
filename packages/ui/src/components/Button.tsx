import type { ButtonHTMLAttributes, ReactNode } from "react";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

export type ButtonSize = "default" | "sm" | "lg";

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  block?: boolean;
  children: ReactNode;
};

const variantClasses: Record<ButtonVariant, string> = {
  primary:
    "border border-transparent bg-accent text-accent-fg font-semibold hover:bg-accent-hover active:bg-accent-active disabled:opacity-50",
  secondary:
    "border border-[color:var(--border)] bg-raised text-fg hover:bg-raised-2 hover:border-[color:var(--border-strong)] disabled:opacity-50",
  ghost:
    "border border-transparent bg-transparent text-fg-muted hover:bg-raised hover:text-fg disabled:opacity-50",
  danger:
    "border border-transparent bg-danger text-danger-fg font-semibold hover:bg-danger-hover disabled:opacity-50",
};

const sizeClasses: Record<ButtonSize, string> = {
  default: "h-[34px] px-sp-5",
  sm: "h-[28px] px-sp-4",
  lg: "h-[44px] px-sp-6",
};

const sizeFontStyles: Record<ButtonSize, string> = {
  default: "var(--text-body)",
  sm: "var(--text-small)",
  lg: "var(--text-body-lg)",
};

export function Button({
  variant = "primary",
  size = "default",
  block = false,
  className = "",
  type = "button",
  children,
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      className={`inline-flex items-center justify-center gap-sp-3 rounded-md font-medium transition-colors duration-micro ease-in-out active:translate-y-[0.5px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-canvas disabled:cursor-not-allowed ${sizeClasses[size]} ${variantClasses[variant]}${block ? " w-full" : ""} ${className}`}
      style={{ fontSize: sizeFontStyles[size], lineHeight: "1" }}
      {...props}
    >
      {children}
    </button>
  );
}
