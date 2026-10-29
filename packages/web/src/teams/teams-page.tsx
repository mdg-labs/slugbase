import { Button, Skeleton } from "@slugbase/ui";
import {
  AvatarStack,
  Banner,
  Confirm,
  DataTable,
  EmptyState,
  Loading,
  PlusIcon,
  RowActions,
  feedbackToast,
  type DataTableColumn,
  type RowAction,
} from "@slugbase/ui/patterns";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { EntitlementGate } from "../entitlements/index.ts";
import { useFormat } from "../i18n/use-format.ts";
import { inPlaceRefusals } from "../shell/mutation-error-toasts.tsx";
import { canAdminister, workspaceQuery } from "../shell/workspace.ts";
import { TeamForm } from "./team-form.tsx";
import { TEAMS_QUERY_KEY, deleteTeam, teamFailureOf, teamListQuery, teamQuery, type Team } from "./teams.ts";

const SKELETON_ROWS = ["a", "b", "c", "d"] as const;

/** The avatars of a team's members. The list holds only their count, so the members are read per team; a team whose members could not be read shows the count alone. */
function TeamMembers({ team }: { team: Team }): ReactElement {
  const { t } = useTranslation();
  const format = useFormat();
  const router = useRouter();
  const detail = useQuery(teamQuery(router.options.context.api, team.id));
  const people = detail.data?.members.map(({ accountId, displayName }) => ({ id: accountId, name: displayName })) ?? [];
  let stack: ReactElement | null = null;
  if (detail.isPending) {
    stack = <Skeleton aria-hidden="true" className="h-6 w-14 rounded-full" />;
  } else if (people.length > 0) {
    stack = <AvatarStack label={t("teams.members.stack", { names: people.map(({ name }) => name).join(", ") })} people={people} />;
  }
  return (
    <span className="flex items-center gap-2">
      {stack}
      <span className="text-muted-foreground text-sm">{format.number(team.memberCount)}</span>
    </span>
  );
}

function TeamsContent(): ReactElement {
  const { t } = useTranslation();
  const router = useRouter();
  const queryClient = useQueryClient();
  const api = router.options.context.api;
  const workspace = useQuery(workspaceQuery(api));
  const teams = useInfiniteQuery(teamListQuery(api));
  // Only an admin or an owner changes teams; the server decides in the end, so a role not yet known shows the list alone.
  const editable = workspace.data !== undefined && canAdminister(workspace.data.role);
  const [form, setForm] = useState<{ readonly team: Team | undefined } | undefined>(undefined);
  const [deleting, setDeleting] = useState<Team | undefined>(undefined);

  const remove = useMutation({
    mutationKey: ["teams", "delete"],
    meta: inPlaceRefusals([{ status: 404, code: "not_found" }]),
    mutationFn: (team: Team) => deleteTeam(api, team.id),
    onSuccess: (_result, team) => {
      feedbackToast.success(t("teams.delete.done", { name: team.name }));
      setDeleting(undefined);
    },
    onError: (error) => {
      // A team that is gone already is gone from the list too once it is read again.
      if (teamFailureOf(error)?.kind === "notFound") {
        feedbackToast.info(t("teams.delete.gone"));
        setDeleting(undefined);
      }
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: TEAMS_QUERY_KEY });
    },
  });

  const items = teams.data?.pages.flatMap((page) => page.items) ?? [];
  // The empty state carries the way to create the first team.
  const none = teams.isSuccess && items.length === 0;

  function actionsOf(team: Team): readonly RowAction[] {
    return [
      {
        id: "edit",
        label: t("teams.action.edit"),
        onSelect: () => {
          setForm({ team });
        },
      },
      {
        id: "delete",
        label: t("teams.action.delete"),
        destructive: true,
        onSelect: () => {
          setDeleting(team);
        },
      },
    ];
  }

  const columns: readonly DataTableColumn<Team>[] = [
    { id: "name", header: t("teams.column.name"), cell: (team) => <span className="font-medium">{team.name}</span> },
    { id: "description", header: t("teams.column.description"), cell: (team) => <span className="text-muted-foreground">{team.description}</span> },
    { id: "members", header: t("teams.column.members"), cell: (team) => <TeamMembers team={team} /> },
    ...(editable
      ? [
          {
            id: "actions",
            header: t("teams.column.actions"),
            hideHeader: true,
            className: "text-end",
            cell: (team: Team) => <RowActions actions={actionsOf(team)} label={t("teams.actionsFor", { name: team.name })} />,
          },
        ]
      : []),
  ];

  const create = (
    <Button
      onClick={() => {
        setForm({ team: undefined });
      }}
    >
      <PlusIcon aria-hidden="true" />
      {t("teams.create")}
    </Button>
  );

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="font-semibold text-xl">{t("teams.title")}</h1>
          <p className="text-muted-foreground text-sm">{editable ? t("teams.description") : t("teams.descriptionReadOnly")}</p>
        </div>
        {editable && !none ? create : null}
      </div>
      {teams.isPending ? (
        <Loading className="p-0" label={t("teams.loading")}>
          <div className="flex flex-col gap-2">
            {SKELETON_ROWS.map((key) => (
              <Skeleton className="h-12 rounded-lg" key={key} />
            ))}
          </div>
        </Loading>
      ) : null}
      {teams.isError ? (
        <Banner
          action={
            <Button
              onClick={() => {
                void teams.refetch();
              }}
              size="sm"
              variant="outline"
            >
              {t("settings.account.loadFailed.retry")}
            </Button>
          }
          description={t("settings.account.loadFailed.description")}
          title={t("teams.loadFailed")}
          variant="error"
        />
      ) : null}
      {none ? (
        <EmptyState
          actions={editable ? create : undefined}
          description={editable ? t("teams.empty.description") : t("teams.empty.descriptionReadOnly")}
          title={t("teams.empty.title")}
        />
      ) : null}
      {items.length === 0 ? null : (
        <>
          <DataTable columns={columns} label={t("teams.title")} rowKey={(team) => team.id} rows={items} />
          {teams.hasNextPage ? (
            <div className="flex justify-center">
              <Button
                loading={teams.isFetchingNextPage}
                onClick={() => {
                  void teams.fetchNextPage();
                }}
                variant="outline"
              >
                {t("teams.loadMore")}
              </Button>
            </div>
          ) : null}
        </>
      )}
      {form === undefined ? null : (
        <TeamForm
          onClose={() => {
            setForm(undefined);
          }}
          team={form.team}
        />
      )}
      {deleting === undefined ? null : (
        <Confirm
          cancelLabel={t("teams.delete.cancel")}
          confirmLabel={t("teams.delete.confirm")}
          description={t("teams.delete.description", { name: deleting.name })}
          destructive
          loading={remove.isPending}
          onConfirm={() => {
            remove.mutate(deleting);
          }}
          onOpenChange={(open) => {
            if (!open) {
              setDeleting(undefined);
            }
          }}
          open
          title={t("teams.delete.title", { name: deleting.name })}
        />
      )}
    </div>
  );
}

/**
 * `/settings/workspace/teams` (doc 03 section 11.8, doc 02 section 4): the workspace's teams with their members, which every
 * member reads and an admin or owner creates, changes and deletes. The page is behind the `teams.manage` entitlement, so where
 * the workspace lacks it the upgrade slot stands in for it and no team is asked for.
 */
export function TeamsPage(): ReactElement {
  return (
    <EntitlementGate name="teams.manage">
      <TeamsContent />
    </EntitlementGate>
  );
}
