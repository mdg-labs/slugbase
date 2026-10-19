import { Button } from "@slugbase/ui";
import { FormOverlay, TypedConfirm, feedbackToast } from "@slugbase/ui/patterns";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import type { ApiProblemCode } from "../api/client.ts";
import { ME_QUERY_KEY } from "../account/me.ts";
import { leaveWorkspaceView } from "./workspace-departure.ts";
import { WORKSPACE_QUERY_KEY, deleteWorkspace, type Workspace } from "./workspace.ts";
import { WORKSPACES_QUERY_KEY } from "./workspaces.ts";

/**
 * Deletes the workspace (doc 03 section 11.6, doc 04 section 4.4): a `typed-confirm` on the workspace's name that says the
 * deletion is irreversible and removes every row of the workspace. The server asks for a fresh re-authentication, which the API
 * client answers with the shared prompt; an owner who closes it stays in the dialog, told that nothing was sent. When the
 * deployment's deletion guard refuses, the dialog gives way to the explanation for the code it answered with and offers nothing but
 * closing it. Once the request is accepted the app leaves the workspace like a removed member: it moves to the workspace the server
 * now has the account in, or to the page of an account with none.
 */
export function DeleteWorkspaceDialog({ workspace, onClose }: { workspace: Workspace; onClose: () => void }): ReactElement {
  const { t } = useTranslation();
  const router = useRouter();
  const queryClient = useQueryClient();
  const api = router.options.context.api;
  const [needsConfirmation, setNeedsConfirmation] = useState(false);
  const [blockedBy, setBlockedBy] = useState<ApiProblemCode | undefined>(undefined);

  const remove = useMutation({
    mutationKey: ["workspace", "delete"],
    mutationFn: () => deleteWorkspace(api),
    onSuccess: async (outcome) => {
      if (outcome.status === "accepted") {
        feedbackToast.success(t("settings.workspace.delete.done", { name: workspace.name }));
        await leaveWorkspaceView(api, queryClient, router);
        onClose();
        return;
      }
      const { refusal } = outcome;
      switch (refusal.kind) {
        case "reauthRequired":
          setNeedsConfirmation(true);
          return;
        case "guard":
          setBlockedBy(refusal.code);
          return;
        case "forbidden":
          // The caller's standing changed meanwhile, so what the page knows of it is out of date.
          void queryClient.invalidateQueries({ queryKey: ME_QUERY_KEY });
          void queryClient.invalidateQueries({ queryKey: WORKSPACE_QUERY_KEY });
          void queryClient.invalidateQueries({ queryKey: WORKSPACES_QUERY_KEY });
          feedbackToast.error(t("settings.workspace.delete.error.title"), t("settings.workspace.delete.error.forbidden"));
          onClose();
          return;
        case "gone":
          feedbackToast.error(t("settings.workspace.delete.error.title"), t("settings.workspace.delete.error.gone"));
          await leaveWorkspaceView(api, queryClient, router);
          onClose();
          return;
      }
    },
  });

  if (blockedBy !== undefined) {
    return (
      <FormOverlay
        closeLabel={t("settings.workspace.delete.blocked.close")}
        description={blockedBy === "billing_active" ? t("settings.workspace.delete.blocked.billingActive") : t("settings.workspace.delete.blocked.other")}
        onOpenChange={(open) => {
          if (!open) {
            onClose();
          }
        }}
        open
        title={t("settings.workspace.delete.blocked.title", { name: workspace.name })}
      >
        <div className="flex justify-end">
          <Button onClick={onClose} type="button" variant="outline">
            {t("settings.workspace.delete.blocked.close")}
          </Button>
        </div>
      </FormOverlay>
    );
  }

  return (
    <TypedConfirm
      cancelLabel={t("settings.workspace.delete.cancel")}
      confirmLabel={t("settings.workspace.delete.action")}
      description={t("settings.workspace.delete.description", { name: workspace.name })}
      destructive
      error={needsConfirmation ? t("settings.workspace.delete.error.reauthCancelled") : undefined}
      expected={workspace.name}
      inputLabel={t("settings.workspace.delete.confirmLabel", { name: workspace.name })}
      loading={remove.isPending}
      onConfirm={() => {
        setNeedsConfirmation(false);
        remove.mutate();
      }}
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
      open
      title={t("settings.workspace.delete.title", { name: workspace.name })}
    />
  );
}
