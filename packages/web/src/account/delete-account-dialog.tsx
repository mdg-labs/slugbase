import { Button } from "@slugbase/ui";
import { Banner, FormOverlay, Loading, TypedConfirm, feedbackToast } from "@slugbase/ui/patterns";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useRouter } from "@tanstack/react-router";
import { useState, type ReactElement } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import type { ApiProblemCode, ProblemWorkspace } from "../api/client.ts";
import { useSwitchFailureMessage, useWorkspaceSwitch, workspacesQuery } from "../shell/workspaces.ts";
import { deleteAccount } from "./delete-account.ts";
import { meQuery, type Account } from "./me.ts";

type Blocked =
  | { readonly kind: "lastOwner"; readonly workspaces: readonly ProblemWorkspace[] }
  | { readonly kind: "lastInstanceAdmin" }
  | { readonly kind: "guard"; readonly code: ApiProblemCode };

const MEMBERS_PATH = "/settings/workspace/members";

/** The workspaces the account is the only member of, which go with it. */
function DeletedWithAccount(): ReactElement {
  const { t } = useTranslation();
  const router = useRouter();
  const list = useQuery({ ...workspacesQuery(router.options.context.api), staleTime: 0 });

  if (list.isError) {
    return (
      <Banner
        action={
          <Button
            onClick={() => {
              void list.refetch();
            }}
            size="sm"
            variant="outline"
          >
            {t("settings.account.loadFailed.retry")}
          </Button>
        }
        description={t("settings.account.delete.workspaces.loadFailed.description")}
        title={t("settings.account.delete.workspaces.loadFailed.title")}
        variant="error"
      />
    );
  }
  if (list.data === undefined) {
    return <Loading label={t("shell.loading")} />;
  }
  const sole = list.data.items.filter(({ memberCount }) => memberCount === 1);
  return (
    <div className="flex flex-col gap-2 text-sm" data-slot="deleted-workspaces">
      {sole.length === 0 ? (
        <p>{t("settings.account.delete.workspaces.none")}</p>
      ) : (
        <>
          <p>{t("settings.account.delete.workspaces.some", { count: sole.length })}</p>
          <ul className="list-disc ps-5 font-medium">
            {sole.map((workspace) => (
              <li key={workspace.id}>{workspace.name}</li>
            ))}
          </ul>
        </>
      )}
      <p className="text-muted-foreground">{t("settings.account.delete.workspaces.others")}</p>
    </div>
  );
}

function blockedDescription(blocked: Blocked, t: TFunction): string {
  switch (blocked.kind) {
    case "lastOwner":
      return t("settings.account.delete.blocked.lastOwner");
    case "lastInstanceAdmin":
      return t("settings.account.delete.blocked.lastInstanceAdmin");
    case "guard":
      return blocked.code === "billing_active" ? t("settings.account.delete.blocked.billingActive") : t("settings.account.delete.blocked.other");
  }
}

function BlockedDialog({ blocked, onClose }: { blocked: Blocked; onClose: () => void }): ReactElement {
  const { t } = useTranslation();
  const router = useRouter();
  const me = useQuery(meQuery(router.options.context.api));
  const { pending, switchTo } = useWorkspaceSwitch();
  const switchFailureMessage = useSwitchFailureMessage();

  async function openMembers(workspaceId: string): Promise<void> {
    if (me.data?.activeWorkspaceId !== workspaceId) {
      const outcome = await switchTo(workspaceId);
      if (outcome.status !== "switched") {
        if (outcome.status === "failed" && outcome.failure !== undefined) {
          feedbackToast.error(t("workspaces.switch.failed.title"), switchFailureMessage(outcome.failure));
        }
        return;
      }
    }
    onClose();
    await router.navigate({ to: MEMBERS_PATH });
  }

  return (
    <FormOverlay
      closeLabel={t("settings.account.delete.blocked.close")}
      description={blockedDescription(blocked, t)}
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
      open
      title={t("settings.account.delete.blocked.title")}
    >
      <div className="flex flex-col gap-4">
        {blocked.kind === "lastOwner" && blocked.workspaces.length > 0 ? (
          <ul aria-label={t("settings.account.delete.blocked.workspaces")} className="flex flex-col gap-1 text-sm">
            {blocked.workspaces.map((workspace) => (
              <li key={workspace.id}>
                <Link
                  aria-disabled={pending}
                  className="text-foreground underline underline-offset-4"
                  onClick={(event) => {
                    event.preventDefault();
                    if (!pending) {
                      void openMembers(workspace.id);
                    }
                  }}
                  to={MEMBERS_PATH}
                >
                  {t("settings.account.delete.blocked.members", { name: workspace.name })}
                </Link>
              </li>
            ))}
          </ul>
        ) : null}
        <div className="flex justify-end">
          <Button onClick={onClose} type="button" variant="outline">
            {t("settings.account.delete.blocked.close")}
          </Button>
        </div>
      </div>
    </FormOverlay>
  );
}

/**
 * Deletes the account (doc 03 section 11.1, doc 02 section 2.10): a `typed-confirm` on the account's email that lists the
 * workspaces which go with the account. The server asks for a fresh re-authentication, which the API client answers with the
 * shared prompt; a member who closes it stays in the dialog, told that nothing was sent. When the account is the last owner of a
 * workspace with other members, the last instance admin, or a deployment extension refuses, the dialog gives way to the explanation
 * and offers nothing but closing it (for the last owner, also the members screens of the blocking workspaces). Once the deletion is
 * accepted the app drops everything it cached and shows the sign-in page.
 */
export function DeleteAccountDialog({ account, onClose }: { account: Account; onClose: () => void }): ReactElement {
  const { t } = useTranslation();
  const router = useRouter();
  const queryClient = useQueryClient();
  const api = router.options.context.api;
  const [problem, setProblem] = useState<"reauth" | "mismatch" | undefined>(undefined);
  const [blocked, setBlocked] = useState<Blocked | undefined>(undefined);
  const list = useQuery({ ...workspacesQuery(api), staleTime: 0 });

  const remove = useMutation({
    mutationKey: ["account", "delete"],
    mutationFn: () => deleteAccount(api, account.email),
    onSuccess: (outcome) => {
      if (outcome.status === "accepted") {
        feedbackToast.success(t("settings.account.delete.done"));
        router.history.replace("/login");
        queryClient.clear();
        return;
      }
      const { refusal } = outcome;
      switch (refusal.kind) {
        case "reauthRequired":
          setProblem("reauth");
          return;
        case "emailMismatch":
          setProblem("mismatch");
          return;
        case "lastOwner":
        case "lastInstanceAdmin":
        case "guard":
          setBlocked(refusal);
          return;
      }
    },
  });

  if (blocked !== undefined) {
    return <BlockedDialog blocked={blocked} onClose={onClose} />;
  }

  return (
    <TypedConfirm
      cancelLabel={t("settings.account.delete.cancel")}
      confirmDisabled={list.data === undefined || list.isError || list.isFetching}
      confirmLabel={t("settings.account.delete.action")}
      description={t("settings.account.delete.description")}
      destructive
      error={
        problem === "reauth"
          ? t("settings.account.delete.error.reauthCancelled")
          : problem === "mismatch"
            ? t("settings.account.delete.error.mismatch")
            : undefined
      }
      expected={account.email}
      inputLabel={t("settings.account.delete.confirmLabel", { email: account.email })}
      loading={remove.isPending}
      onConfirm={() => {
        setProblem(undefined);
        remove.mutate();
      }}
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
      open
      title={t("settings.account.delete.title")}
    >
      <DeletedWithAccount />
    </TypedConfirm>
  );
}
