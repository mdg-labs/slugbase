import { useTranslate } from "@tolgee/react";
import { useEffect, useMemo, useState } from "react";

import {
  CHECKLIST_DISMISSED_KEY,
  CHECKLIST_ITEM_IDS,
  CHECKLIST_STORAGE_KEY,
  type ChecklistItemId,
} from "./dashboard.constants.js";
import { deriveChecklistCompletion } from "./dashboard.utils.js";
import type { DashboardData } from "./dashboard.types.js";

export type DashboardOnboardingChecklistProps = {
  data: DashboardData;
};

type ChecklistState = Record<ChecklistItemId, boolean>;

const CHECKLIST_LABEL_KEYS: Record<
  ChecklistItemId,
  { label: string; description: string }
> = {
  import: {
    label: "dashboard.checklist.import_label",
    description: "dashboard.checklist.import_description",
  },
  browser_shortcut: {
    label: "dashboard.checklist.browser_shortcut_label",
    description: "dashboard.checklist.browser_shortcut_description",
  },
  folder: {
    label: "dashboard.checklist.folder_label",
    description: "dashboard.checklist.folder_description",
  },
  tag: {
    label: "dashboard.checklist.tag_label",
    description: "dashboard.checklist.tag_description",
  },
};

function readStoredChecklist(): ChecklistState {
  const defaults: ChecklistState = {
    import: false,
    browser_shortcut: false,
    folder: false,
    tag: false,
  };

  if (typeof window === "undefined") {
    return defaults;
  }

  try {
    const raw = window.localStorage.getItem(CHECKLIST_STORAGE_KEY);
    if (!raw) {
      return defaults;
    }
    const parsed = JSON.parse(raw) as Partial<ChecklistState>;
    return { ...defaults, ...parsed };
  } catch {
    return defaults;
  }
}

function readDismissed(): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  try {
    return window.localStorage.getItem(CHECKLIST_DISMISSED_KEY) === "true";
  } catch {
    return false;
  }
}

export function DashboardOnboardingChecklist({
  data,
}: DashboardOnboardingChecklistProps) {
  const { t } = useTranslate();
  const [checked, setChecked] = useState<ChecklistState>(() =>
    readStoredChecklist(),
  );
  const [dismissed, setDismissed] = useState(() => readDismissed());

  const autoCompleted = useMemo(
    () => deriveChecklistCompletion(data),
    [data],
  );

  const mergedChecked = useMemo(
    () => ({
      ...checked,
      ...autoCompleted,
    }),
    [checked, autoCompleted],
  );

  useEffect(() => {
    window.localStorage.setItem(
      CHECKLIST_STORAGE_KEY,
      JSON.stringify(checked),
    );
  }, [checked]);

  useEffect(() => {
    window.localStorage.setItem(
      CHECKLIST_DISMISSED_KEY,
      dismissed ? "true" : "false",
    );
  }, [dismissed]);

  const doneCount = CHECKLIST_ITEM_IDS.filter(
    (id) => mergedChecked[id],
  ).length;
  const allDone = doneCount === CHECKLIST_ITEM_IDS.length;
  const progress = Math.round((doneCount / CHECKLIST_ITEM_IDS.length) * 100);

  if (dismissed && !allDone) {
    return null;
  }

  const toggleItem = (id: ChecklistItemId) => {
    if (autoCompleted[id]) {
      return;
    }
    setChecked((current) => ({ ...current, [id]: !current[id] }));
  };

  return (
    <section
      className="overflow-hidden rounded-lg border border-[color:var(--border-subtle)] bg-raised"
      data-testid="dashboard-onboarding-checklist"
    >
      <div className="flex items-center gap-sp-4 border-b border-[color:var(--border-subtle)] px-sp-6 py-sp-5">
        <h2 className="m-0 flex flex-1 items-center gap-sp-3 font-semibold text-fg">
          <span aria-hidden>☑</span>
          {t("dashboard.checklist.title")}
        </h2>
        {!allDone ? (
          <span className="font-mono text-small text-fg-subtle">
            {doneCount}/{CHECKLIST_ITEM_IDS.length}
          </span>
        ) : (
          <span className="rounded-sm bg-[color:var(--success-subtle)] px-sp-3 py-sp-2 text-small font-medium text-success-text">
            {t("dashboard.checklist.complete_badge")}
          </span>
        )}
        {!allDone ? (
          <button
            type="button"
            className="rounded-sm px-sp-2 py-sp-2 text-fg-subtle transition-colors duration-micro hover:bg-raised-2 hover:text-fg"
            onClick={() => {
              setDismissed(true);
            }}
            aria-label={t("dashboard.checklist.dismiss_aria")}
          >
            ×
          </button>
        ) : null}
      </div>

      {!allDone ? (
        <>
          <div
            className="h-[3px] bg-canvas"
            role="progressbar"
            aria-valuenow={progress}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div
              className="h-full rounded-full bg-accent transition-all duration-[var(--dur)] ease-[var(--ease)]"
              style={{ width: `${String(progress)}%` }}
            />
          </div>
          <ul className="m-0 list-none p-sp-4">
            {CHECKLIST_ITEM_IDS.map((id) => {
              const isDone = mergedChecked[id];
              const keys = CHECKLIST_LABEL_KEYS[id];
              return (
                <li key={id}>
                  <button
                    type="button"
                    className="flex w-full items-start gap-sp-4 rounded-sm px-sp-4 py-sp-4 text-left transition-colors duration-micro hover:bg-raised-2"
                    onClick={() => {
                      toggleItem(id);
                    }}
                  >
                    <span
                      className={[
                        "mt-[2px] inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border",
                        isDone
                          ? "border-[color:var(--accent-border)] bg-accent text-accent-fg"
                          : "border-[color:var(--border-subtle)] bg-canvas",
                      ].join(" ")}
                      aria-hidden
                    >
                      {isDone ? "✓" : ""}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span
                        className={[
                          "block text-body",
                          isDone
                            ? "text-fg-subtle line-through"
                            : "text-fg-muted",
                        ].join(" ")}
                      >
                        {t(keys.label)}
                      </span>
                      {!isDone ? (
                        <span className="mt-sp-2 block text-small text-fg-faint">
                          {t(keys.description)}
                        </span>
                      ) : null}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      ) : (
        <div className="px-sp-6 py-sp-5 text-body text-fg-subtle">
          {t("dashboard.checklist.complete_message")}
          {dismissed ? (
            <button
              type="button"
              className="ml-sp-3 text-small text-accent-text hover:underline"
              onClick={() => {
                setDismissed(false);
              }}
            >
              {t("dashboard.checklist.show_again")}
            </button>
          ) : null}
        </div>
      )}
    </section>
  );
}
