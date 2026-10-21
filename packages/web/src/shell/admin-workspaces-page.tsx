import { Button } from "@slugbase/ui";
import { Banner, Confirm, DataTable, EmptyState, Loading, RowActions, ShieldCheckIcon, StatusBadge, feedbackToast, type DataTableColumn, type RowAction } from "@slugbase/ui/patterns";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { ME_QUERY_KEY } from "../account/me.ts";
import { useFormat } from "../i18n/use-format.ts";
import { useAdminActionsEnabled, useRefreshStandingOnForbidden } from "./admin-access.ts";
import { CreateInstanceWorkspaceDialog } from "./admin-create-workspace-dialog.tsx";
import { DeleteInstanceWorkspaceDialog } from "./admin-delete-workspace-dialog.tsx";
import { OwnerInvitationDialog } from "./admin-owner-invitation-dialog.tsx";
import { ADMIN_WORKSPACES_QUERY_KEY, addMeAsMember, instanceWorkspacesQuery, type InstanceWorkspace, type MembershipRefusal } from "./admin-workspaces.ts";
import { WORKSPACES_QUERY_KEY } from "./workspaces.ts";

type Pending = { readonly kind: "addMe" | "invite" | "delete"; readonly workspace: InstanceWorkspace };

/**
 * Adds the calling admin to a workspace as a member, after a `confirm` that says the workspace's owners will see it (doc 03 section 12).
 * The call needs a fresh re-authentication, which the API client asks for with the shared prompt. A refusal is told in a toast.
 */
function AddMeConfirm({ workspace, onClose }: { workspace: InstanceWorkspace; onClose: () => void }): ReactElement {
  const { t } = useTranslation();
  const router = useRouter();
  const queryClient = useQueryClient();
  const api = router.options.context.api;

  function refusalMessage(refusal: MembershipRefusal): string {
    switch (refusal.kind) {
      case "reauthRequired":
        return t("admin.workspaces.addMe.error.reauthCancelled");
      case "forbidden":
        return t("admin.workspaces.addMe.error.forbidden");
      case "gone":
        return t("admin.workspaces.addMe.error.gone");
      case "alreadyMember":
        return t("admin.workspaces.addMe.error.alreadyMember");
    }
  }

  const join = useMutation({
    mutationKey: ["admin", "workspaces", "membership"],
    mutationFn: () => addMeAsMember(api, workspace.id),
    onSuccess: (outcome) => {
      if (outcome.status === "added") {
        feedbackToast.success(t("admin.workspaces.addMe.done", { name: workspace.name }));
        void queryClient.invalidateQueries({ queryKey: ADMIN_WORKSPACES_QUERY_KEY });
        void queryClient.invalidateQueries({ queryKey: ME_QUERY_KEY });
        void queryClient.invalidateQueries({ queryKey: WORKSPACES_QUERY_KEY });
      } else {
        feedbackToast.error(t("admin.workspaces.addMe.error.title", { name: workspace.name }), refusalMessage(outcome.refusal));
        if (outcome.refusal.kind === "forbidden") {
          void queryClient.invalidateQueries({ queryKey: ME_QUERY_KEY });
        } else if (outcome.refusal.kind === "gone" || outcome.refusal.kind === "alreadyMember") {
          void queryClient.invalidateQueries({ queryKey: ADMIN_WORKSPACES_QUERY_KEY });
          void queryClient.invalidateQueries({ queryKey: ME_QUERY_KEY });
        }
      }
      onClose();
    },
    onError: onClose,
  });

  return (
    <Confirm
      cancelLabel={t("admin.workspaces.addMe.cancel")}
      confirmLabel={t("admin.workspaces.addMe.action")}
      description={t("admin.workspaces.addMe.description", { name: workspace.name })}
      loading={join.isPending}
      onConfirm={() => {
        join.mutate();
      }}
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
      open
      title={t("admin.workspaces.addMe.title", { name: workspace.name })}
    />
  );
}

function WorkspacesTable({ workspaces, onAction }: { workspaces: readonly InstanceWorkspace[]; onAction: (action: Pending) => void }): ReactElement {
  const { t } = useTranslation();
  const format = useFormat();

  function actionsOf(workspace: InstanceWorkspace): readonly RowAction[] {
    const act = (kind: Pending["kind"]) => () => {
      onAction({ kind, workspace });
    };
    return [
      { id: "addMe", label: t("admin.workspaces.action.addMe"), onSelect: act("addMe") },
      ...(workspace.owners.length === 0 ? [{ id: "invite", label: t("admin.workspaces.action.invite"), onSelect: act("invite") }] : []),
      { id: "delete", label: t("admin.workspaces.action.delete"), destructive: true, onSelect: act("delete") },
    ];
  }

  const columns: readonly DataTableColumn<InstanceWorkspace>[] = [
    { id: "name", header: t("admin.workspaces.column.name"), cell: (workspace) => <span className="font-medium wrap-anywhere">{workspace.name}</span> },
    {
      id: "owners",
      header: t("admin.workspaces.column.owners"),
      cell: (workspace) =>
        workspace.owners.length === 0 ? (
          <StatusBadge variant="warning">{t("admin.workspaces.pendingOwner")}</StatusBadge>
        ) : (
          <ul className="flex flex-col gap-1">
            {workspace.owners.map((owner) => (
              <li className="flex flex-col" key={owner.accountId}>
                <span className="wrap-anywhere">{owner.displayName}</span>
                <span className="wrap-anywhere text-muted-foreground text-xs">{owner.email}</span>
              </li>
            ))}
          </ul>
        ),
    },
    { id: "members", header: t("admin.workspaces.column.members"), cell: (workspace) => format.number(workspace.memberCount) },
    { id: "created", header: t("admin.workspaces.column.created"), cell: (workspace) => format.date(new Date(workspace.createdAt), { dateStyle: "medium" }) },
    {
      id: "actions",
      header: t("admin.workspaces.column.actions"),
      hideHeader: true,
      className: "text-end",
      cell: (workspace) => <RowActions actions={actionsOf(workspace)} label={t("admin.workspaces.actionsFor", { name: workspace.name })} />,
    },
  ];

  return <DataTable columns={columns} label={t("admin.workspaces.table.label")} rowKey={(workspace) => workspace.id} rows={workspaces} />;
}

/**
 * `/admin/workspaces`, the workspaces of the instance (doc 03 section 12): each with its owners, member count and creation date, and
 * never its content. An admin creates a workspace for an owner, adds themselves to one as a member, re-issues the owner invitation of
 * one that waits for its first owner, or deletes one. The server refuses all of it to an admin without a second factor, so the page
 * asks for nothing and offers no action then; it says what is missing instead.
 */
export function AdminWorkspacesPage(): ReactElement {
  const { t } = useTranslation();
  const router = useRouter();
  const enabled = useAdminActionsEnabled();
  const list = useQuery({ ...instanceWorkspacesQuery(router.options.context.api), enabled });
  const [creating, setCreating] = useState(false);
  const [pending, setPending] = useState<Pending | undefined>(undefined);
  useRefreshStandingOnForbidden(list.error);

  function close(): void {
    setPending(undefined);
  }

  let body: ReactElement;
  if (!enabled) {
    body = (
      <EmptyState
        description={t("admin.workspaces.mfaRequired.description")}
        icon={<ShieldCheckIcon aria-hidden="true" />}
        title={t("admin.workspaces.mfaRequired.title")}
      />
    );
  } else if (list.data !== undefined) {
    body =
      list.data.length === 0 ? (
        <EmptyState
          actions={
            <Button
              onClick={() => {
                setCreating(true);
              }}
            >
              {t("admin.workspaces.create.open")}
            </Button>
          }
          description={t("admin.workspaces.empty.description")}
          title={t("admin.workspaces.empty.title")}
        />
      ) : (
        <WorkspacesTable onAction={setPending} workspaces={list.data} />
      );
  } else if (list.isError) {
    body = (
      <Banner
        action={
          <Button
            onClick={() => {
              void list.refetch();
            }}
            size="sm"
            variant="outline"
          >
            {t("admin.workspaces.loadFailed.retry")}
          </Button>
        }
        description={t("admin.workspaces.loadFailed.description")}
        title={t("admin.workspaces.loadFailed.title")}
        variant="error"
      />
    );
  } else {
    body = <Loading label={t("shell.loading")} />;
  }

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="font-semibold text-2xl leading-none">{t("admin.workspaces.title")}</h1>
        <Button
          disabled={!enabled}
          onClick={() => {
            setCreating(true);
          }}
        >
          {t("admin.workspaces.create.open")}
        </Button>
      </div>
      {body}
      {creating && enabled ? (
        <CreateInstanceWorkspaceDialog
          onClose={() => {
            setCreating(false);
          }}
        />
      ) : null}
      {pending?.kind === "addMe" ? <AddMeConfirm onClose={close} workspace={pending.workspace} /> : null}
      {pending?.kind === "invite" ? <OwnerInvitationDialog onClose={close} workspace={pending.workspace} /> : null}
      {pending?.kind === "delete" ? <DeleteInstanceWorkspaceDialog onClose={close} workspace={pending.workspace} /> : null}
    </>
  );
}
