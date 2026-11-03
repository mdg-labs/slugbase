import { Button, Skeleton, Tooltip, TooltipPopup, TooltipTrigger } from "@slugbase/ui";
import { AccountAvatar, Banner, DataTable, EmptyState, LoadMore, Loading, StatusBadge, type DataTableColumn } from "@slugbase/ui/patterns";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { EntitlementGate, entitlementsQuery, isEntitlementRequired } from "../entitlements/index.ts";
import { Slot } from "../extensions/index.ts";
import { useFormat } from "../i18n/use-format.ts";
import { WorkspaceAdminOnly } from "../shell/workspace-admin-only.tsx";
import { useActiveWorkspaceId } from "../shell/workspace-members.ts";
import { auditEventsQuery, type AuditEvent } from "./audit.ts";
import { actionLabel, categoryLabel, entityLabel, targetNameOf } from "./audit-labels.ts";

const SKELETON_ROWS = ["a", "b", "c", "d", "e"] as const;

/** When the change was made: how long ago, with the date and time in full in a tooltip and in the element's `datetime`. */
function EventTime({ createdAt }: { createdAt: string }): ReactElement {
  const format = useFormat();
  const when = new Date(createdAt);
  const absolute = format.date(when, { dateStyle: "medium", timeStyle: "medium" });
  return (
    <Tooltip>
      <TooltipTrigger render={<time className="whitespace-nowrap text-muted-foreground" dateTime={createdAt} tabIndex={0} />}>{format.relativeTime(when)}</TooltipTrigger>
      <TooltipPopup>{absolute}</TooltipPopup>
    </Tooltip>
  );
}

/** The actor with the name it had at the time, and what it was when that is not an account that still exists. */
function EventActor({ actor }: { actor: AuditEvent["actor"] }): ReactElement {
  const { t } = useTranslation();
  let note: string | undefined;
  if (actor.type === "system") {
    note = t("audit.actor.system");
  } else if (actor.type === "api_token") {
    note = t("audit.actor.apiToken");
  } else if (actor.accountId === null) {
    note = t("audit.actor.deleted");
  }
  return (
    <span className="flex items-center gap-2">
      <AccountAvatar name={actor.label} seed={actor.accountId ?? `${actor.type}:${actor.label}`} />
      <span className="flex min-w-0 flex-col">
        <span className="break-words font-medium">{actor.label}</span>
        {note === undefined ? null : <span className="text-muted-foreground text-xs">{note}</span>}
      </span>
    </span>
  );
}

function EventAction({ event }: { event: AuditEvent }): ReactElement {
  const { t } = useTranslation();
  return (
    <span className="flex flex-wrap items-center gap-2">
      <span>{actionLabel(t, event.action)}</span>
      {event.category === null ? (
        <StatusBadge variant="neutral">{t("audit.categories.other")}</StatusBadge>
      ) : (
        <StatusBadge variant="info">{categoryLabel(t, event.category)}</StatusBadge>
      )}
    </span>
  );
}

/** The kind of thing the change is about and, where the event records one, its name; both as text, never a link to the thing (an administrator has no implicit access to a member's content). */
function EventTarget({ event }: { event: AuditEvent }): ReactElement {
  const { t } = useTranslation();
  if (event.entity === null) {
    return (
      <span className="text-muted-foreground">
        <span aria-hidden="true">–</span>
        <span className="sr-only">{t("audit.target.none")}</span>
      </span>
    );
  }
  const name = targetNameOf(event);
  return (
    <span className="flex min-w-0 flex-col">
      <span>{entityLabel(t, event.entity.type)}</span>
      {name === undefined ? null : (
        <span className="break-words text-muted-foreground text-xs">{event.category === "share" ? t("audit.target.sharedWith", { name }) : name}</span>
      )}
    </span>
  );
}

function AuditContent({ workspaceId }: { workspaceId: string }): ReactElement {
  const { t } = useTranslation();
  const api = useRouter().options.context.api;
  const events = useInfiniteQuery(auditEventsQuery(api, workspaceId));
  const items = events.data?.pages.flatMap((page) => page.items) ?? [];

  const columns: readonly DataTableColumn<AuditEvent>[] = [
    { id: "time", header: t("audit.column.time"), cell: (event) => <EventTime createdAt={event.createdAt} /> },
    { id: "actor", header: t("audit.column.actor"), cell: (event) => <EventActor actor={event.actor} /> },
    { id: "action", header: t("audit.column.action"), cell: (event) => <EventAction event={event} /> },
    { id: "target", header: t("audit.column.target"), cell: (event) => <EventTarget event={event} /> },
  ];

  // A workspace without the entitlement is refused by the server, which is the gate's answer and not a failure.
  if (events.isError && events.data === undefined) {
    if (isEntitlementRequired(events.error)) {
      return <Slot name="entitlement.upgradeAction" />;
    }
    return (
      <Banner
        action={
          <Button
            loading={events.isFetching}
            onClick={() => {
              void events.refetch();
            }}
            size="sm"
            variant="outline"
          >
            {t("settings.account.loadFailed.retry")}
          </Button>
        }
        description={t("settings.account.loadFailed.description")}
        title={t("audit.loadFailed")}
        variant="error"
      />
    );
  }
  if (events.isPending) {
    return (
      <Loading className="p-0" label={t("audit.loading")}>
        <div className="flex flex-col gap-2">
          {SKELETON_ROWS.map((key) => (
            <Skeleton className="h-12 rounded-lg" key={key} />
          ))}
        </div>
      </Loading>
    );
  }
  if (items.length === 0) {
    return <EmptyState description={t("audit.empty.description")} title={t("audit.empty.title")} />;
  }
  return (
    <div className="flex flex-col gap-4">
      <DataTable columns={columns} label={t("audit.title")} rowKey={(event) => event.id} rows={items} />
      {events.isFetchNextPageError ? (
        <Banner
          action={
            <Button
              loading={events.isFetchingNextPage}
              onClick={() => {
                void events.fetchNextPage();
              }}
              size="sm"
              variant="outline"
            >
              {t("settings.account.loadFailed.retry")}
            </Button>
          }
          title={t("audit.loadMoreFailed")}
          variant="error"
        />
      ) : null}
      <LoadMore
        count={t("audit.count", { count: items.length })}
        hasMore={events.hasNextPage && !events.isFetchNextPageError}
        loading={events.isFetchingNextPage}
        loadMoreLabel={t("audit.loadMore")}
        onLoadMore={() => {
          void events.fetchNextPage();
        }}
      />
    </div>
  );
}

/**
 * Holds the log back until the workspace's entitlements are known, so that a workspace without `audit.log` is never asked for it; where they cannot be read, the page asks and the
 * server decides.
 */
function AuditGate({ workspaceId }: { workspaceId: string }): ReactElement {
  const { t } = useTranslation();
  const api = useRouter().options.context.api;
  const entitlements = useQuery(entitlementsQuery(api, workspaceId));
  if (entitlements.isPending) {
    return <Loading className="p-0" label={t("audit.loading")} />;
  }
  return (
    <EntitlementGate name="audit.log">
      <AuditContent workspaceId={workspaceId} />
    </EntitlementGate>
  );
}

/**
 * `/settings/workspace/audit` (doc 03 section 11.9, doc 02 section 10): the workspace's audit log, newest first, which admins and owners read. The page is behind the
 * `audit.log` entitlement, so where the workspace lacks it the upgrade slot stands in for the table and no event is asked for.
 */
export function AuditPage(): ReactElement {
  const { t } = useTranslation();
  const workspaceId = useActiveWorkspaceId();
  return (
    <WorkspaceAdminOnly>
      <div className="flex flex-col gap-6">
        <div className="flex flex-col gap-1">
          <h1 className="font-semibold text-xl">{t("audit.title")}</h1>
          <p className="text-muted-foreground text-sm">{t("audit.description")}</p>
        </div>
        {/* Keyed by the workspace, so that the rows of the previous workspace do not carry over. */}
        {workspaceId === undefined ? <Loading className="p-0" label={t("audit.loading")} /> : <AuditGate key={workspaceId} workspaceId={workspaceId} />}
      </div>
    </WorkspaceAdminOnly>
  );
}
