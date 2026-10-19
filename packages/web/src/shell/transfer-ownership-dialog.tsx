import { CheckboxField, TypedConfirm, feedbackToast } from "@slugbase/ui/patterns";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { MEMBERS_QUERY_KEY, moveOwnRole, transferOwnership, type Member, type OwnershipRefusal } from "./workspace-members.ts";
import { WORKSPACE_QUERY_KEY } from "./workspace.ts";
import { WORKSPACES_QUERY_KEY } from "./workspaces.ts";

/**
 * Transfers the ownership of the workspace to a member (doc 03 section 11.7, doc 02 section 3.3): a `typed-confirm` on the
 * recipient's name, with the option to stay as admin. The server asks for a fresh re-authentication, which the API client
 * answers with the shared prompt; a member who closes it stays in the dialog, told that nothing was sent. After a transfer
 * that steps the caller down, what the page knows of the caller's role moves with the server's rotated session.
 */
export function TransferOwnershipDialog({ member, onClose }: { member: Member; onClose: () => void }): ReactElement {
  const { t } = useTranslation();
  const router = useRouter();
  const queryClient = useQueryClient();
  const api = router.options.context.api;
  const [stayAdmin, setStayAdmin] = useState(false);
  const [needsConfirmation, setNeedsConfirmation] = useState(false);
  const name = member.displayName;

  function refusalMessage(refusal: Exclude<OwnershipRefusal, "reauthRequired">): string {
    switch (refusal) {
      case "lastOwner":
        return t("settings.members.transfer.error.lastOwner");
      case "forbidden":
        return t("settings.members.transfer.error.forbidden");
      case "notAMember":
        return t("settings.members.transfer.error.notAMember");
    }
  }

  const transfer = useMutation({
    mutationKey: ["workspace", "members", "transfer"],
    mutationFn: (demoteSelf: boolean) => transferOwnership(api, member.accountId, demoteSelf),
    onSuccess: (outcome, demoteSelf) => {
      if (outcome.status === "refused") {
        if (outcome.refusal === "reauthRequired") {
          setNeedsConfirmation(true);
          return;
        }
        // What the page lists is out of date, or the caller's standing changed meanwhile.
        void queryClient.invalidateQueries({ queryKey: MEMBERS_QUERY_KEY });
        void queryClient.invalidateQueries({ queryKey: WORKSPACE_QUERY_KEY });
        void queryClient.invalidateQueries({ queryKey: WORKSPACES_QUERY_KEY });
        feedbackToast.error(t("settings.members.transfer.error.title"), refusalMessage(outcome.refusal));
        onClose();
        return;
      }
      void queryClient.invalidateQueries({ queryKey: MEMBERS_QUERY_KEY });
      if (demoteSelf) {
        moveOwnRole(queryClient, "admin");
      }
      feedbackToast.success(t(demoteSelf ? "settings.members.transfer.doneStepDown" : "settings.members.transfer.done", { name }));
      onClose();
    },
  });

  return (
    <TypedConfirm
      cancelLabel={t("settings.members.transfer.cancel")}
      confirmLabel={t("settings.members.transfer.action")}
      description={t("settings.members.transfer.description", { name })}
      destructive
      error={needsConfirmation ? t("settings.members.transfer.error.reauthCancelled") : undefined}
      expected={name}
      inputLabel={t("settings.members.transfer.confirmLabel", { name })}
      loading={transfer.isPending}
      onConfirm={() => {
        setNeedsConfirmation(false);
        transfer.mutate(stayAdmin);
      }}
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
      open
      title={t("settings.members.transfer.title", { name })}
    >
      <div className="flex flex-col gap-1">
        <CheckboxField checked={stayAdmin} label={t("settings.members.transfer.stayAdmin")} onCheckedChange={setStayAdmin} />
        <p className="text-muted-foreground text-sm">{t("settings.members.transfer.stayAdminNote", { name })}</p>
      </div>
    </TypedConfirm>
  );
}
