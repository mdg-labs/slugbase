import { useTranslate } from "@tolgee/react";
import { useState } from "react";

import type { GoCandidate } from "./go-mode-api.js";

export type DisambiguationPanelProps = {
  slug: string;
  candidates: GoCandidate[];
  onOpen: (candidate: GoCandidate, remember: boolean) => void;
  onBack: () => void;
};

function GitForkIcon() {
  return (
    <svg
      aria-hidden
      className="h-5 w-5 shrink-0 text-fg-muted"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      viewBox="0 0 24 24"
    >
      <circle cx="6" cy="18" r="3" />
      <circle cx="18" cy="18" r="3" />
      <circle cx="12" cy="6" r="3" />
      <path d="M6 15V9a6 6 0 006 6 6 6 0 006-6v6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ExternalLinkIcon() {
  return (
    <svg
      aria-hidden
      className="h-[14px] w-[14px] shrink-0"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      viewBox="0 0 24 24"
    >
      <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6M15 3h6v6M10 14L21 3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ArrowLeftIcon() {
  return (
    <svg
      aria-hidden
      className="h-[13px] w-[13px] shrink-0"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      viewBox="0 0 24 24"
    >
      <path d="M19 12H5M12 19l-7-7 7-7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function DisambiguationPanel({
  slug,
  candidates,
  onOpen,
  onBack,
}: DisambiguationPanelProps) {
  const { t } = useTranslate();
  const [selectedId, setSelectedId] = useState<string>(candidates[0]?.id ?? "");
  const [remember, setRemember] = useState(false);

  const selected = candidates.find((c) => c.id === selectedId) ?? candidates[0];

  return (
    <div className="px-sp-4 py-sp-5">
      <div className="mb-sp-5 flex items-start gap-sp-4">
        <GitForkIcon />
        <div className="min-w-0 flex-1">
          <p className="mb-sp-2 text-[length:var(--text-body-lg)] font-semibold text-fg">
            {t("go.disambig.title")}
          </p>
          <p className="text-[length:var(--text-body)] text-fg-muted">
            {t("go.disambig.description", { slug })}
          </p>
        </div>
      </div>

      <div className="mb-sp-5 flex flex-col gap-sp-3">
        {candidates.map((candidate) => {
          const isSelected = candidate.id === selectedId;
          const initial = candidate.title.trim().charAt(0).toUpperCase() || "?";
          return (
            <button
              key={candidate.id}
              type="button"
              onClick={() => { setSelectedId(candidate.id); }}
              className={[
                "flex w-full cursor-pointer items-start gap-sp-4 rounded-lg border p-sp-4 text-left transition-colors",
                isSelected
                  ? "border-[color:var(--accent-border)] bg-accent-subtle"
                  : "border-[color:var(--border-subtle)] bg-canvas hover:border-[color:var(--border)] hover:bg-raised",
              ].join(" ")}
            >
              <span
                className={[
                  "mt-[2px] inline-grid h-[14px] w-[14px] shrink-0 place-items-center rounded-full border-2",
                  isSelected
                    ? "border-[color:var(--accent)] bg-accent"
                    : "border-[color:var(--border)] bg-canvas",
                ].join(" ")}
                aria-hidden
              />
              <span
                className="inline-grid h-9 w-9 shrink-0 place-items-center rounded-md font-mono text-sm font-bold text-white"
                style={{ background: "var(--accent)" }}
                aria-hidden
              >
                {initial}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[length:var(--text-body)] font-medium text-fg">
                  {candidate.title}
                </span>
                <span className="mt-[2px] block truncate font-mono text-[length:var(--text-small)] text-fg-faint">
                  {candidate.url}
                </span>
              </span>
            </button>
          );
        })}
      </div>

      <label className="mb-sp-5 flex cursor-pointer items-center gap-sp-3 select-none">
        <input
          type="checkbox"
          checked={remember}
          onChange={(e) => { setRemember(e.target.checked); }}
          className="h-[14px] w-[14px] accent-[color:var(--accent)]"
        />
        <span className="text-[length:var(--text-body)] text-fg-muted">
          {t("go.disambig.always_label", { slug })}
        </span>
      </label>

      <div className="flex flex-wrap items-center gap-sp-4">
        <button
          type="button"
          disabled={!selected}
          onClick={() => {
            if (selected) onOpen(selected, remember);
          }}
          className="inline-flex items-center gap-sp-2 rounded-md bg-accent px-sp-5 py-sp-3 text-[length:var(--text-body)] font-medium text-accent-fg transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40"
        >
          <ExternalLinkIcon />
          {t("go.disambig.open_action")}
        </button>
        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center gap-sp-2 text-[length:var(--text-small)] text-fg-subtle transition-colors hover:text-fg"
        >
          <ArrowLeftIcon />
          {t("go.disambig.back_action")}
        </button>
        <a
          href="/settings/account?tab=preferences"
          className="ml-auto text-[length:var(--text-small)] text-fg-faint hover:text-fg-subtle"
          onClick={(e) => {
            e.preventDefault();
          }}
        >
          {t("go.disambig.manage_prefs")}
        </a>
      </div>
    </div>
  );
}
