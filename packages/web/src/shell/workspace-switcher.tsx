import { feedbackToast, type WorkspaceSwitcherAction, type WorkspaceSwitcherProps } from "@slugbase/ui/patterns";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { meQuery } from "../account/me.ts";
import { ENTITLEMENTS_QUERY_KEY, WorkspaceLimitDialog, useWorkspaceLimitReached } from "../entitlements/index.ts";
import { Slot, useSlotFilled } from "../extensions/index.ts";
import { CreateWorkspaceDialog } from "./create-workspace-dialog.tsx";
import { useSwitchFailureMessage, useWorkspaceSwitch, workspacesQuery } from "./workspaces.ts";

const WORKSPACE_SETTINGS_PATH = "/settings/workspace";

/**
 * What the sidebar header's workspace switcher shows and does (doc 03 "App shell"), and the create-workspace
 * dialog it opens, which the shell renders over the page. The active workspace comes from the account, the menu from
 * the list of workspaces, and a list that cannot be loaded says so rather than showing an empty one.
 */
export function useWorkspaceSwitcher(): { switcher: WorkspaceSwitcherProps; dialog: ReactElement | null } {
  const { t } = useTranslation();
  const router = useRouter();
  const queryClient = useQueryClient();
  const api = router.options.context.api;
  const me = useQuery({ ...meQuery(api), staleTime: Number.POSITIVE_INFINITY });
  const list = useQuery(workspacesQuery(api));
  const { pending, switchTo } = useWorkspaceSwitch();
  const switchFailureMessage = useSwitchFailureMessage();
  const limitReached = useWorkspaceLimitReached();
  const planFilled = useSlotFilled("sidebar.workspacePlan");
  // Which dialog "New workspace" opened is settled when it opens: a workspace it creates raises the count, and the limit may be reached while it is open.
  const [creating, setCreating] = useState<"form" | "limit" | undefined>(undefined);

  const activeId = me.data?.activeWorkspaceId ?? undefined;
  const activeName =
    me.data?.memberships.find(({ workspaceId }) => workspaceId === activeId)?.name ?? list.data?.items.find(({ id }) => id === activeId)?.name;

  const actions: WorkspaceSwitcherAction[] = [];
  // At the account's limit the action stays, and opens the upgrade path in place of the form.
  if (list.data?.canCreate === true || limitReached) {
    actions.push({
      id: "new",
      label: t("workspaces.switcher.new"),
      onSelect: () => {
        setCreating(limitReached ? "limit" : "form");
      },
    });
  }
  if (activeId !== undefined) {
    actions.push({
      id: "settings",
      label: t("workspaces.switcher.settings"),
      onSelect: () => {
        void router.navigate({ to: WORKSPACE_SETTINGS_PATH });
      },
    });
  }

  // A workspace the dialog created counts against the limit, and the entitlements say how much.
  function closeCreating(): void {
    setCreating(undefined);
    void queryClient.invalidateQueries({ queryKey: ENTITLEMENTS_QUERY_KEY });
  }

  const switcher: WorkspaceSwitcherProps = {
    active: activeId === undefined || activeName === undefined ? undefined : { id: activeId, name: activeName },
    fallbackName: me.isError ? t("workspaces.switcher.unavailable") : t("workspaces.switcher.none"),
    label: t("workspaces.switcher.label"),
    loading: me.isPending,
    ...(planFilled ? { plan: <Slot name="sidebar.workspacePlan" /> } : {}),
    disabled: pending,
    groupLabel: t("workspaces.switcher.groupLabel"),
    workspaces: list.data?.items.map(({ id, name }) => ({ id, name })) ?? [],
    listState: list.isError ? "error" : list.data === undefined ? "loading" : "ready",
    loadingLabel: t("shell.loading"),
    errorMessage: t("workspaces.switcher.loadFailed"),
    retryLabel: t("workspaces.switcher.retry"),
    onRetry: () => {
      void list.refetch();
      if (me.isError) {
        void me.refetch();
      }
    },
    emptyMessage: t("workspaces.switcher.empty"),
    onSelect: (workspaceId) => {
      void switchTo(workspaceId).then((outcome) => {
        if (outcome.status === "failed" && outcome.failure !== undefined) {
          feedbackToast.error(t("workspaces.switch.failed.title"), switchFailureMessage(outcome.failure));
        }
      });
    },
    actions,
  };

  return {
    switcher,
    dialog:
      creating === "limit" ? (
        <WorkspaceLimitDialog onClose={closeCreating} />
      ) : creating === "form" ? (
        <CreateWorkspaceDialog onClose={closeCreating} />
      ) : null,
  };
}
