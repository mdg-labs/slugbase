import { Button } from "@slugbase/ui";
import {
  AccountAvatar,
  Banner,
  DataTable,
  EmptyState,
  Loading,
  RowActions,
  SelectField,
  StatusBadge,
  type DataTableColumn,
  type RowAction,
} from "@slugbase/ui/patterns";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient, type InfiniteData } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { ME_QUERY_KEY, meQuery, type Me } from "../account/me.ts";
import { useIsGranted } from "../entitlements/index.ts";
import { useFormat } from "../i18n/use-format.ts";
import { ManageTeamsDialog } from "../teams/manage-teams-dialog.tsx";
import { EndMembershipDialog } from "./end-membership-dialog.tsx";
import { TransferOwnershipDialog } from "./transfer-ownership-dialog.tsx";
import { WorkspaceAdminOnly } from "./workspace-admin-only.tsx";
import {
  MEMBERS_QUERY_KEY,
  assignableRoles,
  canRemove,
  canTransferOwnership,
  changeMemberRole,
  membersQuery,
  moveOwnRole,
  withMember,
  type Member,
  type MemberList,
  type RoleChangeRefusal,
} from "./workspace-members.ts";
import { WORKSPACE_QUERY_KEY, workspaceQuery, type WorkspaceRole } from "./workspace.ts";

const ROLES: readonly WorkspaceRole[] = ["owner", "admin", "member"];

function useRoleLabel(): (role: WorkspaceRole) => string {
  const { t } = useTranslation();
  return (role) => {
    switch (role) {
      case "owner":
        return t("settings.members.role.owner");
      case "admin":
        return t("settings.members.role.admin");
      case "member":
        return t("settings.members.role.member");
    }
  };
}

function MembersTable({ viewerRole, viewerId }: { viewerRole: WorkspaceRole; viewerId: string | undefined }): ReactElement {
  const { t } = useTranslation();
  const format = useFormat();
  const router = useRouter();
  const queryClient = useQueryClient();
  const api = router.options.context.api;
  const roleLabel = useRoleLabel();
  const members = useInfiniteQuery(membersQuery(api));
  const [refusals, setRefusals] = useState<ReadonlyMap<string, RoleChangeRefusal>>(new Map());
  const [removing, setRemoving] = useState<Member | undefined>(undefined);
  const [transferring, setTransferring] = useState<Member | undefined>(undefined);
  const [managingTeams, setManagingTeams] = useState<Member | undefined>(undefined);
  // The server decides in the end; where the entitlements are not known yet the action is offered.
  const canManageTeams = useIsGranted("teams.manage");

  const change = useMutation({
    mutationKey: ["workspace", "members", "role"],
    mutationFn: ({ member, role }: { member: Member; role: WorkspaceRole }) => changeMemberRole(api, member.accountId, role),
    onSuccess: (outcome, { member }) => {
      if (outcome.status === "refused") {
        setRefusals((current) => new Map(current).set(member.accountId, outcome.refusal));
        if (outcome.refusal !== "lastOwner") {
          // The member or the caller's own standing changed meanwhile: what the page lists is out of date.
          void queryClient.invalidateQueries({ queryKey: MEMBERS_QUERY_KEY });
          void queryClient.invalidateQueries({ queryKey: WORKSPACE_QUERY_KEY });
        }
        return;
      }
      setRefusals((current) => {
        const next = new Map(current);
        next.delete(member.accountId);
        return next;
      });
      queryClient.setQueryData<InfiniteData<MemberList, string | undefined>>(MEMBERS_QUERY_KEY, (data) => withMember(data, outcome.member));
      if (member.accountId === queryClient.getQueryData<Me>(ME_QUERY_KEY)?.account.id) {
        // The server rotated the session's token with the change; what the page knows of the caller's role moves with it.
        moveOwnRole(queryClient, outcome.member.role);
      }
    },
  });

  const items = members.data?.pages.flatMap((page) => page.items) ?? [];
  const dateTime = (value: string): string => format.date(new Date(value), { dateStyle: "medium", timeStyle: "short" });

  function refusalMessage(refusal: RoleChangeRefusal | undefined): string | undefined {
    switch (refusal) {
      case undefined:
        return undefined;
      case "lastOwner":
        return t("settings.members.error.lastOwner");
      case "forbidden":
        return t("settings.members.error.forbidden");
      case "notAMember":
        return t("settings.members.error.notAMember");
    }
  }

  function actionsOf(member: Member): readonly RowAction[] {
    const roleActions = assignableRoles(viewerRole, member).map((role) => ({
      id: role,
      label:
        role === "owner"
          ? t("settings.members.action.makeOwner")
          : role === "admin"
            ? t("settings.members.action.makeAdmin")
            : t("settings.members.action.makeMember"),
      disabled: change.isPending,
      onSelect: () => {
        change.mutate({ member, role });
      },
    }));
    const transferAction: readonly RowAction[] = canTransferOwnership(viewerRole, viewerId, member)
      ? [
          {
            id: "transfer",
            label: t("settings.members.action.transfer"),
            onSelect: () => {
              setTransferring(member);
            },
          },
        ]
      : [];
    const teamsAction: readonly RowAction[] = canManageTeams
      ? [
          {
            id: "teams",
            label: t("settings.members.action.manageTeams"),
            onSelect: () => {
              setManagingTeams(member);
            },
          },
        ]
      : [];
    return canRemove(viewerRole, viewerId, member)
      ? [
          ...roleActions,
          ...teamsAction,
          ...transferAction,
          {
            id: "remove",
            label: t("settings.members.action.remove"),
            destructive: true,
            onSelect: () => {
              setRemoving(member);
            },
          },
        ]
      : [...roleActions, ...teamsAction, ...transferAction];
  }

  const columns: readonly DataTableColumn<Member>[] = [
    {
      id: "name",
      header: t("settings.members.column.name"),
      cell: (member) => (
        <span className="flex items-center gap-2">
          <AccountAvatar name={member.displayName} seed={member.accountId} />
          <span className="font-medium">{member.displayName}</span>
          {member.accountId === viewerId ? <StatusBadge variant="info">{t("settings.members.you")}</StatusBadge> : null}
        </span>
      ),
    },
    { id: "email", header: t("settings.members.column.email"), cell: (member) => member.email },
    {
      id: "role",
      header: t("settings.members.column.role"),
      cell: (member) => {
        const assignable = assignableRoles(viewerRole, member);
        if (assignable.length === 0) {
          return <StatusBadge variant={member.role === "member" ? "neutral" : "info"}>{roleLabel(member.role)}</StatusBadge>;
        }
        return (
          <SelectField
            className="w-36"
            disabled={change.isPending}
            error={refusalMessage(refusals.get(member.accountId))}
            hideLabel
            label={t("settings.members.roleOf", { name: member.displayName })}
            onValueChange={(next) => {
              const role = ROLES.find((candidate) => candidate === next);
              if (role !== undefined && role !== member.role) {
                change.mutate({ member, role });
              }
            }}
            options={ROLES.filter((role) => role === member.role || assignable.includes(role)).map((role) => ({ value: role, label: roleLabel(role) }))}
            value={member.role}
          />
        );
      },
    },
    {
      id: "teams",
      header: t("settings.members.column.teams"),
      cell: (member) =>
        member.teams.length === 0 ? (
          <span className="text-muted-foreground">{t("settings.members.teams.none")}</span>
        ) : (
          <ul aria-label={t("settings.members.teams.of", { name: member.displayName })} className="flex flex-wrap gap-1">
            {member.teams.map((team) => (
              <li key={team.id}>
                <StatusBadge>{team.name}</StatusBadge>
              </li>
            ))}
          </ul>
        ),
    },
    { id: "joined", header: t("settings.members.column.joined"), cell: (member) => dateTime(member.joinedAt) },
    {
      id: "lastActive",
      header: t("settings.members.column.lastActive"),
      cell: (member) => (member.lastActiveAt === null ? t("settings.members.never") : dateTime(member.lastActiveAt)),
    },
    {
      id: "actions",
      header: t("settings.members.column.actions"),
      hideHeader: true,
      className: "text-end",
      cell: (member) => <RowActions actions={actionsOf(member)} label={t("settings.members.actionsFor", { name: member.displayName })} />,
    },
  ];

  return (
    <>
      {members.isPending ? <Loading label={t("shell.loading")} /> : null}
      {members.isError ? (
        <Banner
          action={
            <Button
              onClick={() => {
                void members.refetch();
              }}
              size="sm"
              variant="outline"
            >
              {t("settings.account.loadFailed.retry")}
            </Button>
          }
          description={t("settings.account.loadFailed.description")}
          title={t("settings.members.loadFailed.title")}
          variant="error"
        />
      ) : null}
      {removing !== undefined && viewerId !== undefined ? (
        <EndMembershipDialog
          onClose={() => {
            setRemoving(undefined);
          }}
          target={{ kind: "remove", member: removing, viewerId }}
        />
      ) : null}
      {managingTeams === undefined ? null : (
        <ManageTeamsDialog
          member={managingTeams}
          onClose={() => {
            setManagingTeams(undefined);
          }}
        />
      )}
      {transferring === undefined ? null : (
        <TransferOwnershipDialog
          member={transferring}
          onClose={() => {
            setTransferring(undefined);
          }}
        />
      )}
      {items.length === 0 ? null : (
        <>
          <DataTable columns={columns} label={t("settings.members.title")} rowKey={(member) => member.accountId} rows={items} />
          {items.length === 1 && !members.hasNextPage ? (
            <EmptyState description={t("settings.members.single.description")} title={t("settings.members.single.title")} />
          ) : null}
          {members.hasNextPage ? (
            <div className="flex justify-center">
              <Button
                loading={members.isFetchingNextPage}
                onClick={() => {
                  void members.fetchNextPage();
                }}
                variant="outline"
              >
                {t("settings.members.loadMore")}
              </Button>
            </div>
          ) : null}
        </>
      )}
    </>
  );
}

function MembersContent(): ReactElement | null {
  const { t } = useTranslation();
  const router = useRouter();
  const api = router.options.context.api;
  const workspace = useQuery(workspaceQuery(api));
  const me = useQuery(meQuery(api));
  // The guard around this renders it only once the workspace is loaded and its role is an admin's or an owner's.
  if (workspace.data === undefined) {
    return null;
  }
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="font-semibold text-xl">{t("settings.members.title")}</h1>
        <p className="text-muted-foreground text-sm">{t("settings.members.description")}</p>
      </div>
      <MembersTable viewerId={me.data?.account.id} viewerRole={workspace.data.role} />
    </div>
  );
}

/** `/settings/workspace/members` (doc 03 section 11.7): the workspace's members, with their roles changed in place. */
export function WorkspaceMembersPage(): ReactElement {
  return (
    <WorkspaceAdminOnly>
      <MembersContent />
    </WorkspaceAdminOnly>
  );
}
