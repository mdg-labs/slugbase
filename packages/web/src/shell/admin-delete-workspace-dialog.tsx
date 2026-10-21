import { Button } from "@slugbase/ui";
import { FormOverlay, TypedConfirm, feedbackToast } from "@slugbase/ui/patterns";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { ME_QUERY_KEY } from "../account/me.ts";
import type { ApiProblemCode } from "../api/client.ts";
import { ADMIN_WORKSPACES_QUERY_KEY, deleteInstanceWorkspace, type InstanceWorkspace } from "./admin-workspaces.ts";
import { INSTANCE_STATUS_QUERY_KEY } from "./instance-status.ts";
import { WORKSPACES_QUERY_KEY } from "./workspaces.ts";

/**
 * Deletes a workspace of the instance (doc 03 section 12, `typed-confirm`): the admin types the workspace's name, and the dialog says
 * that the deletion is irreversible. The server asks for a fresh re-authentication, which the API client answers with the shared
 * prompt; an admin who closes it stays in the dialog, told that nothing was sent. When the deployment's deletion guard refuses, the
 * dialog gives way to the explanation for the code it answered with. Once the request is accepted the workspace leaves the list.
 */
export function DeleteInstanceWorkspaceDialog({ workspace, onClose }: { workspace: InstanceWorkspace; onClose: () => void }): ReactElement {
  const { t } = useTranslation();
  const router = useRouter();
  const queryClient = useQueryClient();
  const api = router.options.context.api;
  const [needsConfirmation, setNeedsConfirmation] = useState(false);
  const [blockedBy, setBlockedBy] = useState<ApiProblemCode | undefined>(undefined);

  function refresh(): void {
    void queryClient.invalidateQueries({ queryKey: ADMIN_WORKSPACES_QUERY_KEY });
    void queryClient.invalidateQueries({ queryKey: INSTANCE_STATUS_QUERY_KEY });
    void queryClient.invalidateQueries({ queryKey: WORKSPACES_QUERY_KEY });
    void queryClient.invalidateQueries({ queryKey: ME_QUERY_KEY });
  }

  const remove = useMutation({
    mutationKey: ["admin", "workspaces", "delete"],
    mutationFn: () => deleteInstanceWorkspace(api, workspace.id),
    onSuccess: (outcome) => {
      if (outcome.status === "accepted") {
        feedbackToast.success(t("admin.workspaces.delete.done", { name: workspace.name }));
        refresh();
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
          void queryClient.invalidateQueries({ queryKey: ME_QUERY_KEY });
          feedbackToast.error(t("admin.workspaces.delete.error.title"), t("admin.workspaces.delete.error.forbidden"));
          onClose();
          return;
        case "gone":
          feedbackToast.error(t("admin.workspaces.delete.error.title"), t("admin.workspaces.delete.error.gone"));
          refresh();
          onClose();
          return;
      }
    },
  });

  if (blockedBy !== undefined) {
    return (
      <FormOverlay
        closeLabel={t("admin.workspaces.delete.blocked.close")}
        description={blockedBy === "billing_active" ? t("admin.workspaces.delete.blocked.billingActive") : t("admin.workspaces.delete.blocked.other")}
        onOpenChange={(open) => {
          if (!open) {
            onClose();
          }
        }}
        open
        title={t("admin.workspaces.delete.blocked.title", { name: workspace.name })}
      >
        <div className="flex justify-end">
          <Button onClick={onClose} type="button" variant="outline">
            {t("admin.workspaces.delete.blocked.close")}
          </Button>
        </div>
      </FormOverlay>
    );
  }

  return (
    <TypedConfirm
      cancelLabel={t("admin.workspaces.delete.cancel")}
      confirmLabel={t("admin.workspaces.delete.action")}
      description={t("admin.workspaces.delete.description", { name: workspace.name })}
      destructive
      error={needsConfirmation ? t("admin.workspaces.delete.error.reauthCancelled") : undefined}
      expected={workspace.name}
      inputLabel={t("admin.workspaces.delete.confirmLabel", { name: workspace.name })}
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
      title={t("admin.workspaces.delete.title", { name: workspace.name })}
    />
  );
}
