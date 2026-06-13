import * as CheckboxPrimitive from "@radix-ui/react-checkbox";

export type CheckboxProps = {
  checked?: boolean | "indeterminate";
  onCheckedChange?: (checked: boolean | "indeterminate") => void;
  disabled?: boolean;
  id?: string;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  className?: string;
};

/**
 * 3-state checkbox (off / on / indeterminate).
 * Styled to match prototype `.cb` pattern from app.css.
 * Uses Radix Checkbox primitive for accessible keyboard + pointer handling.
 */
export function Checkbox({
  checked,
  onCheckedChange,
  disabled,
  id,
  className = "",
  ...ariaProps
}: CheckboxProps) {
  return (
    <CheckboxPrimitive.Root
      id={id}
      checked={checked}
      onCheckedChange={onCheckedChange}
      disabled={disabled}
      className={`flex-none cursor-pointer rounded-sm bg-canvas transition-[background,border-color] duration-micro ease-in-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-canvas disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:border-accent data-[state=checked]:bg-accent data-[state=indeterminate]:border-accent data-[state=indeterminate]:bg-accent ${className}`}
      style={{
        width: "17px",
        height: "17px",
        border: "1.5px solid var(--border-strong)",
        display: "grid",
        placeItems: "center",
      }}
      {...(ariaProps["aria-label"] ? { "aria-label": ariaProps["aria-label"] } : {})}
      {...(ariaProps["aria-labelledby"]
        ? { "aria-labelledby": ariaProps["aria-labelledby"] }
        : {})}
    >
      <CheckboxPrimitive.Indicator className="flex items-center justify-center text-accent-fg">
        {checked === "indeterminate" ? (
          <span
            aria-hidden="true"
            className="block rounded-[2px] bg-accent-fg"
            style={{ width: "8px", height: "2px" }}
          />
        ) : (
          <svg
            aria-hidden="true"
            width="10"
            height="10"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="3"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="20 6 9 17 4 12" />
          </svg>
        )}
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}
