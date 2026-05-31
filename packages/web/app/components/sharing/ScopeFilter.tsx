import { useTranslate } from "@tolgee/react";
import { useEffect, useRef, useState } from "react";

import { SHARING_SCOPE_OPTIONS, type SharingScope } from "./sharing.types.js";
import { getSharingScopeOption } from "./sharing-scope-option.js";

export type ScopeFilterProps = {
  value: SharingScope;
  onChange: (scope: SharingScope) => void;
  disabled?: boolean;
};

export function ScopeFilter({ value, onChange, disabled = false }: ScopeFilterProps) {
  const { t } = useTranslate();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const current = getSharingScopeOption(value);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
    };
  }, [open]);

  return (
    <div className="relative" ref={rootRef}>
      <button
        type="button"
        className={[
          "inline-flex items-center gap-sp-3 rounded-md border px-sp-4 py-sp-3 text-small",
          value !== "all"
            ? "border-[color:var(--accent-border)] bg-[color:var(--accent-subtle)] text-accent-text"
            : "border-[color:var(--border)] bg-[color:var(--raised)] text-fg-muted",
          disabled ? "cursor-not-allowed opacity-60" : "hover:text-fg",
        ].join(" ")}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        data-testid="sharing-scope-filter-trigger"
        onClick={() => {
          if (!disabled) setOpen((prev) => !prev);
        }}
      >
        <ScopeGlyph icon={current.icon} />
        <span>{t(current.labelKey)}</span>
        <span aria-hidden className="text-fg-subtle">
          ▾
        </span>
      </button>

      {open ? (
        <div
          className="absolute left-0 top-[calc(100%+var(--sp-2))] z-[80] min-w-[13rem] rounded-lg border border-[color:var(--border-strong)] bg-overlay p-sp-2 shadow-overlay"
          role="menu"
          data-testid="sharing-scope-filter-menu"
        >
          <p
            className="px-sp-4 py-sp-2 text-small font-medium uppercase tracking-wide text-fg-subtle"
            style={{ fontSize: "var(--text-caption)" }}
          >
            {t("sharing.scope.menu_heading")}
          </p>
          {SHARING_SCOPE_OPTIONS.map((option) => (
            <button
              key={option.id}
              type="button"
              role="menuitemradio"
              aria-checked={value === option.id}
              className={[
                "flex w-full items-center gap-sp-3 rounded-md px-sp-4 py-sp-3 text-left text-small",
                value === option.id
                  ? "bg-[color:var(--accent-subtle)] text-accent-text"
                  : "text-fg-muted hover:bg-[color:var(--raised)] hover:text-fg",
              ].join(" ")}
              data-testid={`sharing-scope-option-${option.id}`}
              onClick={() => {
                onChange(option.id);
                setOpen(false);
              }}
            >
              <ScopeGlyph icon={option.icon} />
              <span className="flex-1">{t(option.labelKey)}</span>
              {value === option.id ? (
                <span aria-hidden className="text-accent-text">
                  ✓
                </span>
              ) : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ScopeGlyph({ icon }: { icon: string }) {
  const glyph =
    icon === "layers"
      ? "▤"
      : icon === "user"
        ? "◉"
        : icon === "users"
          ? "◎"
          : "↗";
  return (
    <span
      aria-hidden
      className="grid h-[18px] w-[18px] place-items-center rounded-sm text-fg-subtle"
      style={{ fontSize: "11px" }}
    >
      {glyph}
    </span>
  );
}
