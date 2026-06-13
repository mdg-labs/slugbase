import type { InputHTMLAttributes, ReactNode } from "react";

export type InputSize = "default" | "lg";

export type InputProps = Omit<InputHTMLAttributes<HTMLInputElement>, "size"> & {
  invalid?: boolean;
  size?: InputSize;
  startIcon?: ReactNode;
  endIcon?: ReactNode;
};

const sizeHeight: Record<InputSize, string> = {
  default: "34px",
  lg: "42px",
};

const sizeFontSize: Record<InputSize, string> = {
  default: "var(--text-body)",
  lg: "var(--text-body-lg)",
};

export function Input({
  invalid = false,
  size = "default",
  startIcon,
  endIcon,
  className = "",
  ...props
}: InputProps) {
  const borderColor = invalid
    ? "var(--danger)"
    : "var(--border)";
  const focusBorderColor = invalid
    ? "var(--danger)"
    : "var(--accent-border)";
  const focusShadow = invalid
    ? "0 0 0 3px var(--danger-subtle)"
    : "0 0 0 3px var(--accent-subtle)";

  return (
    <div
      className={`flex w-full items-center gap-sp-4 rounded-md border bg-raised px-sp-4 transition-[border-color,box-shadow] duration-micro ease-in-out focus-within:outline-none has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-50 ${className}`}
      style={{
        height: sizeHeight[size],
        borderColor,
      }}
      onFocus={(e) => {
        e.currentTarget.style.borderColor = focusBorderColor;
        e.currentTarget.style.boxShadow = focusShadow;
      }}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) {
          e.currentTarget.style.borderColor = borderColor;
          e.currentTarget.style.boxShadow = "";
        }
      }}
    >
      {startIcon ? (
        <span aria-hidden="true" className="shrink-0 text-fg-subtle">
          {startIcon}
        </span>
      ) : null}
      <input
        className="min-w-0 flex-1 bg-transparent text-fg placeholder:text-fg-faint focus:outline-none disabled:cursor-not-allowed"
        aria-invalid={invalid || undefined}
        style={{ fontSize: sizeFontSize[size], lineHeight: "var(--lh-body)" }}
        {...props}
      />
      {endIcon ? (
        <span aria-hidden="true" className="shrink-0 text-fg-subtle">
          {endIcon}
        </span>
      ) : null}
    </div>
  );
}
