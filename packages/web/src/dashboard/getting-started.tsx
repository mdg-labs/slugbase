import { Button, Checkbox } from "@slugbase/ui";
import { Banner, SettingsSection, UsageMeter } from "@slugbase/ui/patterns";
import { Link, useRouter } from "@tanstack/react-router";
import { useId, type ReactElement, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useUpdatePreferences } from "../account/use-update-preferences.ts";
import { useCanSaveBookmarks } from "../bookmarks/can-save-bookmarks.ts";
import { useBookmarkModal } from "../bookmarks/modal-search.ts";
import type { Dashboard } from "./dashboard.ts";

/** Where the Import and export page lives (doc 03 section 11.5). The Import action appears once the app has a route there. */
const IMPORT_PAGE = "/settings/account/data";

interface Step {
  readonly id: "bookmark" | "slug" | "browser" | "folder" | "import";
  readonly label: string;
  readonly done: boolean;
  /** The step's action, or nothing where the action has nowhere to go yet. */
  readonly action: ReactElement | null;
}

function ActionLink({ to, search, children }: { readonly to: string; readonly search?: { readonly create: 1 }; readonly children: ReactNode }): ReactElement {
  return (
    <Button render={<Link {...(search === undefined ? {} : { search })} to={to} />} size="sm" variant="outline">
      {children}
    </Button>
  );
}

function useSteps(onboarding: Dashboard["onboarding"]): readonly Step[] {
  const { t } = useTranslation();
  const router = useRouter();
  const modal = useBookmarkModal();
  const canSave = useCanSaveBookmarks();
  const hasImportPage = Object.hasOwn(router.routesByPath, IMPORT_PAGE);
  return [
    {
      id: "bookmark",
      label: t("home.gettingStarted.step.bookmark"),
      done: onboarding.bookmarkAdded,
      action: canSave ? (
        <Button
          onClick={() => {
            modal.openNew();
          }}
          size="sm"
          variant="outline"
        >
          {t("bookmarks.new")}
        </Button>
      ) : null,
    },
    { id: "slug", label: t("home.gettingStarted.step.slug"), done: onboarding.slugGiven, action: <ActionLink to="/forwarding">{t("home.gettingStarted.action.forwarding")}</ActionLink> },
    { id: "browser", label: t("home.gettingStarted.step.browser"), done: onboarding.browserSetupDone, action: <ActionLink to="/forwarding">{t("home.gettingStarted.action.setup")}</ActionLink> },
    {
      id: "folder",
      label: t("home.gettingStarted.step.folder"),
      done: onboarding.folderCreated,
      action: (
        <ActionLink search={{ create: 1 }} to="/folders">
          {t("home.gettingStarted.action.folder")}
        </ActionLink>
      ),
    },
    { id: "import", label: t("home.gettingStarted.step.import"), done: onboarding.importDone, action: hasImportPage ? <ActionLink to={IMPORT_PAGE}>{t("home.gettingStarted.action.import")}</ActionLink> : null },
  ];
}

function StepRow({ step }: { readonly step: Step }): ReactElement {
  const labelId = useId();
  return (
    <li className="flex items-center gap-3 py-1.5">
      <Checkbox aria-labelledby={labelId} checked={step.done} readOnly />
      <span className={step.done ? "min-w-0 flex-1 text-muted-foreground text-sm line-through" : "min-w-0 flex-1 text-sm"} id={labelId}>
        {step.label}
      </span>
      {step.action}
    </li>
  );
}

/**
 * The Getting started checklist of the home screen (doc 03 section 2, doc 02 section 9.3). Its boxes are read-only: the first three
 * and the folder complete from what the member has, the browser setup and the import from the keys stored on the account. Dismiss stores
 * the dismissal and the card is gone only once the server has it; a failed save leaves the card and says so. A complete checklist
 * collapses to one line.
 */
export function GettingStarted({ onboarding }: { readonly onboarding: Dashboard["onboarding"] }): ReactElement | null {
  const { t } = useTranslation();
  const steps = useSteps(onboarding);
  const update = useUpdatePreferences();
  if (onboarding.dismissed) {
    return null;
  }
  const done = steps.filter((step) => step.done).length;
  const dismiss = (
    <Button
      loading={update.isPending}
      onClick={() => {
        update.mutate({ onboarding: { checklistDismissed: true } });
      }}
      size="sm"
      variant="outline"
    >
      {t("home.gettingStarted.dismiss")}
    </Button>
  );
  const failed = update.isError ? (
    <p className="text-destructive-text text-sm" role="alert">
      {t("home.gettingStarted.dismissFailed")}
    </p>
  ) : null;
  if (done === steps.length) {
    return (
      <div className="flex flex-col gap-2">
        <Banner action={dismiss} title={t("home.gettingStarted.allSet")} variant="success" />
        {failed}
      </div>
    );
  }
  return (
    <SettingsSection description={t("home.gettingStarted.description")} footer={dismiss} title={t("home.gettingStarted.title")}>
      <div className="flex flex-col gap-3">
        <UsageMeter label={t("home.gettingStarted.progress")} max={steps.length} value={done} valueLabel={t("home.gettingStarted.done", { done, total: steps.length })} />
        <ul className="flex flex-col divide-y">
          {steps.map((step) => (
            <StepRow key={step.id} step={step} />
          ))}
        </ul>
        {failed}
      </div>
    </SettingsSection>
  );
}
