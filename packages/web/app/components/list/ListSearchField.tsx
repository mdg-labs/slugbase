import { useEffect, useRef, useState } from "react";

function SearchIcon() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 14 14"
      width={12}
      height={12}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      className="shrink-0 text-fg-subtle"
    >
      <circle cx="6" cy="6" r="4.5" />
      <line x1="9.5" y1="9.5" x2="12.5" y2="12.5" />
    </svg>
  );
}

function ClearIcon() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 14 14"
      width={14}
      height={14}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      className="shrink-0"
    >
      <path d="M3 3l8 8M11 3l-8 8" />
    </svg>
  );
}

export type ListSearchFieldProps = {
  value: string;
  /** Called after debounce when the input value changes */
  onChange: (value: string) => void;
  placeholder: string;
  /** Accessible name for the search input */
  ariaLabel: string;
  /** Accessible label for the clear button */
  clearAriaLabel: string;
  debounceMs?: number;
  className?: string;
  testId?: string;
};

/**
 * Prototype `.field` search input - controlled value with debounced onChange.
 */
export function ListSearchField({
  value,
  onChange,
  placeholder,
  ariaLabel,
  clearAriaLabel,
  debounceMs = 350,
  className = "",
  testId,
}: ListSearchFieldProps) {
  const [input, setInput] = useState(value);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setInput(value);
  }, [value]);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  function emitDebounced(next: string) {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      onChange(next);
    }, debounceMs);
  }

  function handleChange(next: string) {
    setInput(next);
    emitDebounced(next);
  }

  function handleClear() {
    setInput("");
    if (timerRef.current) clearTimeout(timerRef.current);
    onChange("");
  }

  return (
    <div
      className={`flex h-[34px] min-w-[12rem] flex-1 items-center gap-sp-4 rounded-md border border-[color:var(--border)] bg-raised px-sp-4 transition-[border-color,box-shadow] duration-micro focus-within:border-[color:var(--accent-border)] focus-within:shadow-[0_0_0_3px_var(--accent-subtle)] ${className}`}
    >
      <SearchIcon />
      <input
        type="search"
        value={input}
        onChange={(e) => {
          handleChange(e.target.value);
        }}
        placeholder={placeholder}
        aria-label={ariaLabel}
        className="min-w-0 flex-1 bg-transparent text-[length:var(--text-body)] text-fg placeholder:text-fg-faint focus:outline-none"
        data-testid={testId}
      />
      {input ? (
        <button
          type="button"
          className="shrink-0 text-fg-faint transition-colors hover:text-fg"
          aria-label={clearAriaLabel}
          onClick={handleClear}
        >
          <ClearIcon />
        </button>
      ) : null}
    </div>
  );
}
