import type { ButtonHTMLAttributes, ReactNode } from "react";

export type IconButtonSize = "default" | "sm";

export type IconButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  size?: IconButtonSize;
  active?: boolean;
  children: ReactNode;
  "aria-label": string;
};

const sizeClasses: Record<IconButtonSize, string> = {
  default: "h-[34px] w-[34px]",
  sm: "h-[28px] w-[28px]",
};

/**
 * Icon-only action button — matches prototype `.icon-btn` pattern from app.css.
 * Requires `aria-label` for accessibility.
 */
export function IconButton({
  size = "default",
  active = false,
  className = "",
  type = "button",
  children,
  ...props
}: IconButtonProps) {
  return (
    <button
      type={type}
      className={`inline-grid cursor-pointer place-items-center rounded-md border border-transparent bg-transparent transition-[background,color,border-color] duration-micro ease-in-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-canvas disabled:cursor-not-allowed disabled:opacity-50 ${
        active
          ? "bg-accent-subtle text-accent-text"
          : "text-fg-muted hover:bg-raised hover:text-fg"
      } ${sizeClasses[size]} ${className}`}
      {...props}
    >
      {children}
    </button>
  );
}
