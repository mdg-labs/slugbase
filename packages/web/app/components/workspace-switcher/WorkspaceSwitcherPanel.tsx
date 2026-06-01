import { useTranslate } from "@tolgee/react";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";

import type { WorkspaceListItem } from "./workspace-switcher-api.js";
import {
  activateWorkspace,
  createWorkspace,
} from "./workspace-switcher-api.js";

export type WorkspaceSwitcherPanelProps = {
  /** All workspaces the user belongs to */
  workspaces: WorkspaceListItem[];
  /** Currently active workspace ID */
  activeWorkspaceId: string;
  onClose: () => void;
};

function CheckIcon() {
  return (
    <svg
      aria-hidden
      className="h-[15px] w-[15px] shrink-0 text-accent-text"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.25"
      viewBox="0 0 24 24"
    >
      <path d="M20 6L9 17l-5-5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function LoaderIcon() {
  return (
    <svg
      aria-hidden
      className="h-[22px] w-[22px] animate-spin text-fg-subtle"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      viewBox="0 0 24 24"
    >
      <path d="M21 12a9 9 0 11-6.219-8.56" strokeLinecap="round" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg
      aria-hidden
      className="h-[14px] w-[14px] shrink-0"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.25"
      viewBox="0 0 24 24"
    >
      <path d="M12 5v14M5 12h14" strokeLinecap="round" />
    </svg>
  );
}

function ZapIcon() {
  return (
    <svg
      aria-hidden
      className="h-[14px] w-[14px] shrink-0"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      viewBox="0 0 24 24"
    >
      <path
        d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Derive a deterministic avatar color from a workspace ID. */
function workspaceAvatarColor(id: string): string {
  const palette = [
    "#7782f7", "#45c98a", "#e6b24e", "#f0686b",
    "#64b5f6", "#ba68c8", "#4db6ac", "#ff8a65",
  ];
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  }
  return palette[hash % palette.length] ?? "#7782f7";
}

type PanelView = "list" | "switching" | "create" | "create-blocked";

/**
 * Workspace switcher overlay panel (prototype §30).
 * Sits above the sidebar in a portal-like absolute overlay.
 */
export function WorkspaceSwitcherPanel({
  workspaces,
  activeWorkspaceId,
  onClose,
}: WorkspaceSwitcherPanelProps) {
  const { t } = useTranslate();
  const navigate = useNavigate();
  const [view, setView] = useState<PanelView>("list");
  const [switchingName, setSwitchingName] = useState("");
  const [newName, setNewName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const activeWorkspace = workspaces.find((w) => w.id === activeWorkspaceId);
  const canCreateMore = activeWorkspace?.plan !== "free" || workspaces.length === 0;

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("keydown", onKey); };
  }, [onClose]);

  async function handleSwitch(ws: WorkspaceListItem) {
    if (ws.id === activeWorkspaceId) return;
    setSwitchingName(ws.name);
    setView("switching");
    try {
      await activateWorkspace(ws.id);
      void navigate(0);
    } catch {
      setView("list");
    }
  }

  function handleCreateClick() {
    if (!canCreateMore) {
      setView("create-blocked");
    } else {
      setView("create");
    }
  }

  async function handleCreate() {
    if (!newName.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      await createWorkspace(newName.trim());
      void navigate(0);
    } catch {
      setError(t("app.workspace_switcher.create_error"));
      setSubmitting(false);
    }
  }

  return (
    <div className="ws-overlay fixed inset-0 z-50" style={{ zIndex: 200 }}>
      {/* Backdrop */}
      <div
        className="absolute inset-0"
        style={{ background: "var(--overlay-scrim)" }}
        onClick={onClose}
        aria-hidden
      />

      {/* Panel */}
      <div
        ref={panelRef}
        className="absolute left-sp-4 top-sp-4 flex w-[280px] flex-col rounded-lg border border-[color:var(--border)] bg-overlay"
        style={{ boxShadow: "var(--shadow-overlay)" }}
        role="dialog"
        aria-label={t("app.workspace_switcher.title")}
      >
        {view === "list" && (
          <>
            <div className="border-b border-[color:var(--border-subtle)] px-sp-4 py-sp-3">
              <p className="text-[length:var(--text-micro)] font-medium uppercase tracking-wide text-fg-subtle">
                {t("app.workspace_switcher.title")}
              </p>
            </div>

            <div className="flex flex-col py-sp-2">
              {workspaces.map((ws) => {
                const color = workspaceAvatarColor(ws.id);
                const letter = ws.name.trim().charAt(0).toUpperCase() || "?";
                const isActive = ws.id === activeWorkspaceId;
                return (
                  <button
                    key={ws.id}
                    className="flex w-full items-center gap-sp-3 px-sp-3 py-sp-2 text-left transition-colors hover:bg-raised"
                    onClick={() => { void handleSwitch(ws); }}
                    disabled={isActive}
                  >
                    <span
                      className="inline-grid h-[28px] w-[28px] shrink-0 place-items-center rounded-md font-mono text-[11px] font-bold"
                      style={{ background: color, color: "#0b0c14" }}
                      aria-hidden
                    >
                      {letter}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[length:var(--text-body)] font-medium text-fg">
                        {ws.name}
                      </span>
                      <span className="block text-[length:var(--text-micro)] text-fg-subtle capitalize">
                        {ws.plan} · {ws.role.toLowerCase()}
                      </span>
                    </span>
                    {isActive && <CheckIcon />}
                  </button>
                );
              })}
            </div>

            <div className="border-t border-[color:var(--border-subtle)] px-sp-2 py-sp-2">
              <button
                className="flex w-full items-center gap-sp-3 rounded-md px-sp-3 py-sp-2 text-[length:var(--text-body)] text-fg-muted transition-colors hover:bg-raised hover:text-fg"
                onClick={handleCreateClick}
              >
                <PlusIcon />
                {t("app.workspace_switcher.create")}
              </button>
            </div>
          </>
        )}

        {view === "switching" && (
          <div className="flex flex-col items-center gap-sp-4 px-sp-6 py-sp-8">
            <LoaderIcon />
            <p className="text-[length:var(--text-body)] text-fg-muted">
              {t("app.workspace_switcher.switching_to", { name: switchingName })}
            </p>
          </div>
        )}

        {(view === "create" || view === "create-blocked") && (
          <div className="flex flex-col gap-sp-5 p-sp-5">
            <h3 className="text-[length:var(--text-h3)] font-semibold text-fg">
              {view === "create-blocked"
                ? t("app.workspace_switcher.upgrade_title")
                : t("app.workspace_switcher.create_title")}
            </h3>

            {view === "create-blocked" ? (
              <>
                <p className="text-[length:var(--text-body)] leading-relaxed text-fg-muted">
                  {t("app.workspace_switcher.upgrade_body")}
                </p>
                <div className="flex gap-sp-3">
                  <button
                    className="inline-flex items-center gap-sp-2 rounded-md bg-accent px-sp-4 py-sp-2 text-[length:var(--text-small)] font-medium text-accent-fg transition-colors hover:bg-accent-hover"
                    onClick={onClose}
                  >
                    <ZapIcon />
                    {t("app.workspace_switcher.upgrade_cta")}
                  </button>
                  <button
                    className="rounded-md px-sp-4 py-sp-2 text-[length:var(--text-small)] text-fg-muted transition-colors hover:bg-raised hover:text-fg"
                    onClick={() => { setView("list"); }}
                  >
                    {t("app.workspace_switcher.create_cancel")}
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="flex flex-col gap-sp-2">
                  <label
                    htmlFor="ws-name-input"
                    className="text-[length:var(--text-small)] font-medium text-fg-muted"
                  >
                    {t("app.workspace_switcher.create_name_label")}
                  </label>
                  <input
                    id="ws-name-input"
                    type="text"
                    autoFocus
                    value={newName}
                    onChange={(e) => { setNewName(e.target.value); }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void handleCreate();
                    }}
                    placeholder={t("app.workspace_switcher.create_name_placeholder")}
                    className="h-[36px] rounded-md border border-[color:var(--border)] bg-raised px-sp-4 text-[length:var(--text-body)] text-fg placeholder:text-fg-faint focus:border-accent focus:outline-none focus:ring-0"
                  />
                  {error && (
                    <p className="text-[length:var(--text-small)] text-danger-text">{error}</p>
                  )}
                </div>
                <div className="flex gap-sp-3">
                  <button
                    className="inline-flex items-center gap-sp-2 rounded-md bg-accent px-sp-4 py-sp-2 text-[length:var(--text-small)] font-medium text-accent-fg transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40"
                    disabled={!newName.trim() || submitting}
                    onClick={() => void handleCreate()}
                  >
                    <PlusIcon />
                    {submitting
                      ? t("app.workspace_switcher.create_loading")
                      : t("app.workspace_switcher.create_submit")}
                  </button>
                  <button
                    className="rounded-md px-sp-4 py-sp-2 text-[length:var(--text-small)] text-fg-muted transition-colors hover:bg-raised hover:text-fg"
                    onClick={() => { setView("list"); }}
                  >
                    {t("app.workspace_switcher.create_cancel")}
                  </button>
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
