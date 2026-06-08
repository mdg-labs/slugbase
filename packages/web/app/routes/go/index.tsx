import { useTranslation } from "react-i18next";
import { useState } from "react";
import {
  Link,
  data,
  redirect,
  useFetcher,
  useLoaderData,
} from "react-router";
import type { LoaderFunctionArgs } from "react-router";

import type { GoCandidate } from "../../components/command-palette/go-mode-api.js";

const getApiBaseUrl = (): string => process.env["API_BASE_URL"] ?? "";

interface GoDisambiguationResult {
  kind: "disambiguation";
  slug: string;
  candidates: GoCandidate[];
}

export async function loader({ request, params }: LoaderFunctionArgs) {
  const slug = params["slug"] ?? "";
  const cookie = request.headers.get("Cookie") ?? "";
  const apiBaseUrl = getApiBaseUrl();

  try {
    const res = await fetch(`${apiBaseUrl}/go/${encodeURIComponent(slug)}`, {
      headers: cookie ? { Cookie: cookie } : {},
      redirect: "manual",
    });

    if (res.status === 302 || res.status === 301) {
      const location = res.headers.get("Location");
      if (location) return redirect(location);
    }

    if (res.status === 404) {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- RR7 response throw
      throw data({ error: "not_found", slug }, { status: 404 });
    }

    if (!res.ok) {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- RR7 response throw
      throw data({ error: "upstream_error", slug }, { status: 502 });
    }

    const result = (await res.json()) as GoDisambiguationResult;
    return { slug: result.slug, candidates: result.candidates };
  } catch (err) {
    if (err instanceof Response) throw err;
    // eslint-disable-next-line @typescript-eslint/only-throw-error -- RR7 response throw
    throw data({ error: "upstream_error", slug }, { status: 502 });
  }
}

function GitForkIcon() {
  return (
    <svg
      aria-hidden
      className="h-6 w-6 shrink-0 text-fg-muted"
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

function CheckCircleIcon() {
  return (
    <svg
      aria-hidden
      className="h-9 w-9 shrink-0 text-[color:var(--success-text)]"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      viewBox="0 0 24 24"
    >
      <circle cx="12" cy="12" r="10" />
      <path d="M9 12l2 2 4-4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export default function GoDisambiguatePage() {
  const { t } = useTranslation();
  const { slug, candidates } = useLoaderData<typeof loader>();
  const fetcher = useFetcher();

  const [selectedId, setSelectedId] = useState<string>(candidates[0]?.id ?? "");
  const [remember, setRemember] = useState(false);
  const [confirmed, setConfirmed] = useState<GoCandidate | null>(null);

  const selected = candidates.find((c) => c.id === selectedId) ?? candidates[0];

  const handleOpen = () => {
    if (!selected) return;
    setConfirmed(selected);
    void fetcher.submit(
      { bookmarkId: selected.id, remember: String(remember) },
      {
        method: "POST",
        action: `/api/go/${encodeURIComponent(slug)}/choose`,
        encType: "application/json",
      },
    );
    setTimeout(() => {
      window.location.assign(selected.url);
    }, 80);
  };

  if (confirmed) {
    return (
      <div className="flex flex-1 items-center justify-center px-sp-6 py-sp-12">
        <div className="flex max-w-[480px] flex-col items-center gap-sp-6 text-center">
          <CheckCircleIcon />
          <div>
            <p className="mb-sp-2 text-[length:var(--text-h3)] font-semibold text-fg">
              {t("go.disambig.opening_title", { title: confirmed.title })}
            </p>
            <p className="font-mono text-[length:var(--text-small)] text-fg-subtle">
              {confirmed.url}
            </p>
          </div>
          {remember && (
            <p className="text-[length:var(--text-small)] text-fg-subtle">
              {t("go.disambig.pref_saved", { slug })}
            </p>
          )}
          <button
            type="button"
            onClick={() => { setConfirmed(null); }}
            className="text-[length:var(--text-small)] text-fg-faint hover:text-fg-muted"
          >
            {t("go.disambig.back_action")}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-1 items-center justify-center px-sp-6 py-sp-12">
      <div className="w-full max-w-[560px]">
        <div className="mb-sp-6 flex items-start gap-sp-4">
          <GitForkIcon />
          <div className="min-w-0 flex-1">
            <h1 className="mb-sp-2 text-[length:var(--text-h2)] font-semibold text-fg">
              {t("go.disambig.title")}
            </h1>
            <p className="text-[length:var(--text-body-lg)] text-fg-muted">
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
                    "mt-[3px] inline-grid h-[14px] w-[14px] shrink-0 place-items-center rounded-full border-2",
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
            onClick={handleOpen}
            className="inline-flex items-center gap-sp-2 rounded-md bg-accent px-sp-6 py-sp-3 text-[length:var(--text-body)] font-medium text-accent-fg transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40"
          >
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
            {t("go.disambig.open_action")}
          </button>
          <Link
            to="/settings/account?tab=preferences"
            className="text-[length:var(--text-small)] text-fg-faint hover:text-fg-subtle"
          >
            {t("go.disambig.manage_prefs")}
          </Link>
        </div>
      </div>
    </div>
  );
}
