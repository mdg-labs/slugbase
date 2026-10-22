import { Button } from "@slugbase/ui";
import { Banner, FormOverlay } from "@slugbase/ui/patterns";
import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Slot } from "../extensions/index.ts";

/**
 * What the limit says in place of the creation form: the limit, the `entitlement.upgradeAction` slot, and a way to
 * leave. Where no extension fills the slot, the limit is all it says.
 */
export function WorkspaceLimitContent({ onClose }: { onClose: () => void }): ReactElement {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-4">
      <Banner description={t("workspaces.create.error.limitReached")} title={t("workspaces.create.limit.title")} variant="info" />
      <Slot name="entitlement.upgradeAction" />
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button onClick={onClose} type="button" variant="outline">
          {t("workspaces.create.dismiss")}
        </Button>
      </div>
    </div>
  );
}

/**
 * What "New workspace" opens for an account that owns as many workspaces as its `workspaces.ownMax` entitlement
 * allows: the limit, and the `entitlement.upgradeAction` slot in place of the form. Where no extension fills the
 * slot, the limit is all it says.
 */
export function WorkspaceLimitDialog({ onClose }: { onClose: () => void }): ReactElement {
  const { t } = useTranslation();
  return (
    <FormOverlay
      closeLabel={t("workspaces.create.close")}
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
      open
      title={t("workspaces.create.title")}
    >
      <WorkspaceLimitContent onClose={onClose} />
    </FormOverlay>
  );
}
