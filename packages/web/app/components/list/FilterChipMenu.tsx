import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

function ChevronDownIcon() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 12 12"
      width={11}
      height={11}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      className="opacity-50"
    >
      <path d="M2 4.5l4 4 4-4" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 12 12"
      width={11}
      height={11}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M2 6.5l3 3 5-6" />
    </svg>
  );
}

function useClickOutside(
  ref: React.RefObject<HTMLElement | null>,
  handler: () => void,
  active: boolean,
) {
  useEffect(() => {
    if (!active) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) handler();
    };
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("mousedown", onDown);
    };
  }, [active, handler, ref]);
}

export type FilterChipMenuProps = {
  label: ReactNode;
  active?: boolean;
  align?: "left" | "right";
  width?: number;
  children: ReactNode;
  testId?: string;
};

/** Prototype `.chip` dropdown - filter/sort menus with active state. */
export function FilterChipMenu({
  label,
  active,
  align = "left",
  width = 220,
  children,
  testId,
}: FilterChipMenuProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const closeHandler = useCallback(() => {
    setOpen(false);
  }, []);
  useClickOutside(ref, closeHandler, open);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        className={[
          "inline-flex items-center gap-sp-3 rounded-md border px-sp-4 py-sp-3 text-[length:var(--text-small)]",
          active
            ? "border-[color:var(--accent-border)] bg-[color:var(--accent-subtle)] text-accent-text"
            : "border-[color:var(--border)] bg-[color:var(--raised)] text-fg-muted hover:text-fg",
        ].join(" ")}
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid={testId}
        onClick={() => {
          setOpen((prev) => !prev);
        }}
      >
        {label}
        <ChevronDownIcon />
      </button>
      {open ? (
        <div
          className="absolute top-[calc(100%+4px)] z-[80] overflow-hidden rounded-lg border border-[color:var(--border-strong)] bg-overlay shadow-overlay"
          style={{
            [align]: 0,
            minWidth: width,
          }}
          role="menu"
        >
          {children}
        </div>
      ) : null}
    </div>
  );
}

export function FilterChipMenuHead({ children }: { children: ReactNode }) {
  return (
    <p
      className="px-sp-4 py-sp-2 text-[length:var(--text-caption)] font-medium uppercase tracking-wide text-fg-subtle"
    >
      {children}
    </p>
  );
}

export type FilterChipMenuItemProps = {
  children: ReactNode;
  icon?: ReactNode;
  checked?: boolean;
  onClick?: () => void;
};

export function FilterChipMenuItem({
  children,
  icon,
  checked,
  onClick,
}: FilterChipMenuItemProps) {
  return (
    <button
      type="button"
      role="menuitem"
      className="flex w-full items-center gap-sp-3 px-sp-4 py-sp-3 text-left text-[length:var(--text-small)] text-fg-muted hover:bg-[color:var(--raised)] hover:text-fg"
      onClick={onClick}
    >
      {icon ? <span className="text-fg-subtle">{icon}</span> : null}
      <span className="flex-1">{children}</span>
      {checked ? (
        <span className="text-accent-text">
          <CheckIcon />
        </span>
      ) : null}
    </button>
  );
}
