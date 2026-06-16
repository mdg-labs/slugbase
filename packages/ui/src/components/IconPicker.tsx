import { useMemo, useState } from "react";
import { CheckIcon, SearchIcon, XIcon } from "lucide-react";

import { FOLDER_ICON_NAMES } from "../icons/folder-icon-names.js";
import { LucideIcon } from "../icons/lucide-icon.js";

export type IconPickerLabels = {
  searchPlaceholder: string;
  noResults: string;
  clear: string;
};

export type IconPickerProps = {
  value: string | null;
  onChange: (icon: string | null) => void;
  labels: IconPickerLabels;
  id?: string;
  testId?: string;
};

function filterIconNames(query: string): readonly string[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return FOLDER_ICON_NAMES;
  return FOLDER_ICON_NAMES.filter((name) => name.includes(normalized));
}

export function IconPicker({
  value,
  onChange,
  labels,
  id,
  testId = "icon-picker",
}: IconPickerProps) {
  const [query, setQuery] = useState("");
  const matches = useMemo(() => filterIconNames(query), [query]);

  return (
    <div className="flex flex-col gap-sp-3" data-testid={testId}>
      <div className="relative">
        <SearchIcon
          size={15}
          className="pointer-events-none absolute left-sp-3 top-1/2 -translate-y-1/2 text-fg-muted"
          aria-hidden
        />
        <input
          id={id}
          type="search"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
          }}
          placeholder={labels.searchPlaceholder}
          className="w-full rounded-md border border-[color:var(--border)] bg-[color:var(--base)] py-sp-3 pl-sp-9 pr-sp-4 text-fg focus:outline-none focus:ring-2 focus:ring-[color:var(--accent)]"
          style={{ fontSize: "var(--text-body)" }}
          data-testid={`${testId}-search`}
        />
      </div>

      {value ? (
        <div className="flex items-center justify-between gap-sp-3">
          <span className="inline-flex items-center gap-sp-3 text-fg-muted" style={{ fontSize: "var(--text-small)" }}>
            <LucideIcon name={value} size={18} aria-hidden />
            <span className="font-mono">{value}</span>
          </span>
          <button
            type="button"
            className="inline-flex items-center gap-sp-2 text-fg-muted transition-colors hover:text-fg"
            style={{ fontSize: "var(--text-small)" }}
            onClick={() => {
              onChange(null);
            }}
            data-testid={`${testId}-clear`}
          >
            <XIcon size={14} aria-hidden />
            {labels.clear}
          </button>
        </div>
      ) : null}

      {matches.length === 0 ? (
        <p
          className="py-sp-5 text-center text-fg-subtle"
          style={{ fontSize: "var(--text-small)" }}
          data-testid={`${testId}-no-results`}
        >
          {labels.noResults}
        </p>
      ) : (
        <div
          className="grid max-h-[200px] grid-cols-8 gap-sp-2 overflow-y-auto rounded-md border border-[color:var(--border-subtle)] bg-[color:var(--base)] p-sp-3"
          role="listbox"
          aria-label={labels.searchPlaceholder}
          data-testid={`${testId}-grid`}
        >
          {matches.map((name) => {
            const selected = value === name;
            return (
              <button
                key={name}
                type="button"
                role="option"
                aria-selected={selected}
                title={name}
                className={[
                  "relative inline-grid h-9 w-9 place-items-center rounded-md border transition-colors",
                  selected
                    ? "border-[color:var(--accent)] bg-[color:var(--accent-subtle)] text-[color:var(--accent-text)]"
                    : "border-transparent text-fg-muted hover:border-[color:var(--border)] hover:bg-[color:var(--raised-2)] hover:text-fg",
                ].join(" ")}
                onClick={() => {
                  onChange(selected ? null : name);
                }}
                data-testid={`${testId}-option-${name}`}
              >
                <LucideIcon name={name} size={18} aria-hidden />
                {selected ? (
                  <CheckIcon
                    size={10}
                    className="absolute right-0.5 top-0.5 text-[color:var(--accent-text)]"
                    aria-hidden
                  />
                ) : null}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export { filterIconNames };
