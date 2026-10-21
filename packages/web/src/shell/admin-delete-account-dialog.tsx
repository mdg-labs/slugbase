import { Button } from "@slugbase/ui";
import { FormOverlay, TypedConfirm, feedbackToast } from "@slugbase/ui/patterns";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useRouter } from "@tanstack/react-router";
import { useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import type { ProblemWorkspace } from "../api/client.ts";
import { ADMIN_ACCOUNTS_QUERY_KEY, deleteInstanceAccount, type AccountRefusal, type InstanceAccount } from "./admin-accounts.ts";
import { useAccountRefusalMessage, useRefreshAfterRefusal } from "./admin-account-dialogs.tsx";
import { ADMIN_WORKSPACES_QUERY_KEY } from "./admin-workspaces.ts";
import { INSTANCE_STATUS_QUERY_KEY } from "./instance-status.ts";

const WORKSPACES_PATH = "/admin/workspaces";

/**
 * Deletes another account (doc 03 section 12, `typed-confirm`): the admin types the account's address, and the dialog says that the
 * deletion is irreversible and that workspaces the account is the only member of go with it. The server asks for a fresh
 * re-authentication, which the API client answers with the shared prompt; an admin who closes it stays in the dialog, told that nothing
 * was sent. When the account is the only owner of workspaces that have other members, the dialog gives way to the list of those
 * workspaces; the last instance admin, a deployment extension's refusal and an account that is gone are explained in the dialog.
 */
export function AdminDeleteAccountDialog({ account, onClose }: { account: InstanceAccount; onClose: () => void }): ReactElement {
  const { t } = useTranslation();
  const router = useRouter();
  const queryClient = useQueryClient();
  const api = router.options.context.api;
  const refusalMessage = useAccountRefusalMessage();
  const refreshAfter = useRefreshAfterRefusal();
  const [refusal, setRefusal] = useState<AccountRefusal | undefined>(undefined);
  const [blocking, setBlocking] = useState<readonly ProblemWorkspace[] | undefined>(undefined);

  const remove = useMutation({
    mutationKey: ["admin", "accounts", "delete"],
    mutationFn: () => deleteInstanceAccount(api, account.id),
    onSuccess: (outcome) => {
      if (outcome.status === "done") {
        feedbackToast.success(t("admin.accounts.delete.done", { name: account.displayName }));
        void queryClient.invalidateQueries({ queryKey: ADMIN_ACCOUNTS_QUERY_KEY });
        void queryClient.invalidateQueries({ queryKey: ADMIN_WORKSPACES_QUERY_KEY });
        void queryClient.invalidateQueries({ queryKey: INSTANCE_STATUS_QUERY_KEY });
        onClose();
        return;
      }
      refreshAfter(outcome.refusal);
      if (outcome.refusal.kind === "lastOwner") {
        setBlocking(outcome.refusal.workspaces);
        return;
      }
      if (outcome.refusal.kind === "gone") {
        feedbackToast.error(t("admin.accounts.error.title"), refusalMessage(outcome.refusal));
        onClose();
        return;
      }
      setRefusal(outcome.refusal);
    },
  });

  if (blocking !== undefined) {
    return (
      <FormOverlay
        closeLabel={t("admin.accounts.delete.blocked.close")}
        description={t("admin.accounts.delete.blocked.description", { name: account.displayName })}
        onOpenChange={(open) => {
          if (!open) {
            onClose();
          }
        }}
        open
        title={t("admin.accounts.delete.blocked.title", { name: account.displayName })}
      >
        <div className="flex flex-col gap-4">
          {blocking.length === 0 ? null : (
            <ul aria-label={t("admin.accounts.delete.blocked.workspaces")} className="list-disc ps-5 text-sm font-medium">
              {blocking.map((workspace) => (
                <li key={workspace.id}>{workspace.name}</li>
              ))}
            </ul>
          )}
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button onClick={onClose} type="button" variant="outline">
              {t("admin.accounts.delete.blocked.close")}
            </Button>
            <Button render={<Link onClick={onClose} to={WORKSPACES_PATH} />}>{t("admin.accounts.delete.blocked.open")}</Button>
          </div>
        </div>
      </FormOverlay>
    );
  }

  return (
    <TypedConfirm
      cancelLabel={t("admin.accounts.cancel")}
      confirmLabel={t("admin.accounts.action.delete.label")}
      description={t("admin.accounts.delete.description", { name: account.displayName })}
      destructive
      error={refusal === undefined ? undefined : refusalMessage(refusal)}
      expected={account.email}
      inputLabel={t("admin.accounts.delete.confirmLabel", { email: account.email })}
      loading={remove.isPending}
      onConfirm={() => {
        setRefusal(undefined);
        remove.mutate();
      }}
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
      open
      title={t("admin.accounts.delete.title", { name: account.displayName })}
    />
  );
}
