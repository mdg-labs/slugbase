import { useState } from "react";

interface ShownOncePanelProps {
  values: string[];
  labelKey: string;
  warningKey: string;
  copyActionKey: string;
  copiedKey: string;
  t: (key: string) => string;
}

export function ShownOncePanel({
  values,
  labelKey,
  warningKey,
  copyActionKey,
  copiedKey,
  t,
}: ShownOncePanelProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = (): void => {
    void navigator.clipboard.writeText(values.join("\n")).then(() => {
      setCopied(true);
      setTimeout(() => { setCopied(false); }, 2000);
    });
  };

  return (
    <div className="flex flex-col gap-sp-4">
      <div
        role="alert"
        className="rounded-md border border-[color:var(--warning-subtle)] bg-[color:var(--warning-subtle)] px-sp-4 py-sp-3 text-warning-text"
        style={{ fontSize: "var(--text-small)", lineHeight: "var(--lh-small)" }}
      >
        {t(warningKey)}
      </div>
      <div
        className="rounded-lg border border-[color:var(--border)] bg-raised p-sp-4"
        aria-label={t(labelKey)}
      >
        {values.length === 1 ? (
          <code
            className="block break-all text-fg"
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "var(--text-mono)",
            }}
          >
            {values[0]}
          </code>
        ) : (
          <div className="grid grid-cols-2 gap-sp-2">
            {values.map((value) => (
              <code
                key={value}
                className="select-all text-fg"
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: "var(--text-mono)",
                }}
              >
                {value}
              </code>
            ))}
          </div>
        )}
      </div>
      <button
        type="button"
        onClick={handleCopy}
        className="self-start rounded-md border border-[color:var(--border)] bg-raised px-sp-5 py-sp-3 font-medium text-fg hover:bg-raised-2"
        style={{ fontSize: "var(--text-body)" }}
      >
        {copied ? t(copiedKey) : t(copyActionKey)}
      </button>
    </div>
  );
}
