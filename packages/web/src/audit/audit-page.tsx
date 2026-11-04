import { Button, Skeleton, Tooltip, TooltipPopup, TooltipTrigger } from "@slugbase/ui";
import { Banner, DataTable, EmptyState, LoadMore, Loading, StatusBadge, type DataTableColumn } from "@slugbase/ui/patterns";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useMemo, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { ApiProblemError } from "../api/client.ts";
import { EntitlementGate, entitlementsQuery, isEntitlementRequired } from "../entitlements/index.ts";
import { Slot } from "../extensions/index.ts";
import { useFormat } from "../i18n/use-format.ts";
import { useAllMembers } from "../teams/use-all-members.ts";
import { WorkspaceAdminOnly } from "../shell/workspace-admin-only.tsx";
import { useActiveWorkspaceId } from "../shell/workspace-members.ts";
import { auditEventsQuery, type AuditEvent } from "./audit.ts";
import type { AuditRange } from "./audit-range.ts";
import { AuditEventPanel } from "./audit-event-panel.tsx";
import { EventActor } from "./audit-actor.tsx";
import { AuditFilters } from "./audit-filters.tsx";
import { actionLabel, categoryLabel, entityLabel, targetNameOf } from "./audit-labels.ts";
import { hasActiveFilters, useAuditSearch, useAuditSearchControls } from "./audit-search.ts";

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

/** The action opens the event's panel; the button is the table's way into it, as a row has no link of its own. */
function EventAction({ event, onOpen }: { event: AuditEvent; onOpen: () => void }): ReactElement {
  const { t } = useTranslation();
  return (
    <span className="flex flex-wrap items-center gap-2">
      <Button className="h-auto px-0 text-start whitespace-normal" onClick={onOpen} size="sm" variant="link">
        {actionLabel(t, event.action)}
      </Button>
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
  const search = useAuditSearch();
  const controls = useAuditSearchControls();
  const members = useAllMembers();
  const filtered = hasActiveFilters(search);
  // A custom range with no day yet is not in the address, so the bar remembers that it was chosen.
  const [customRange, setCustomRange] = useState(false);
  const range: AuditRange = {
    ...(search.range === undefined ? {} : { preset: search.range }),
    ...(search.from === undefined ? {} : { firstDay: search.from }),
    ...(search.to === undefined ? {} : { lastDay: search.to }),
  };
  const clearFilters = (): void => {
    setCustomRange(false);
    controls.clearFilters();
  };
  // The filters are part of the query's key, so a change of them starts the list again from its first page.
  const events = useInfiniteQuery(
    auditEventsQuery(api, workspaceId, {
      ...(search.actor === undefined ? {} : { actorAccountId: search.actor }),
      ...(search.category === undefined ? {} : { category: search.category }),
      range,
    }),
  );
  const items = events.data?.pages.flatMap((page) => page.items) ?? [];
  // The event is kept while the panel closes, so that its content does not empty out under the closing animation.
  const [opened, setOpened] = useState<{ readonly event: AuditEvent; readonly open: boolean } | undefined>(undefined);

  // Stable between renders: the table makes a component of each cell, so a new list would remount the cells, and the button that opened the panel would be gone when the panel returns focus.
  const columns = useMemo<readonly DataTableColumn<AuditEvent>[]>(
    () => [
      { id: "time", header: t("audit.column.time"), cell: (event) => <EventTime createdAt={event.createdAt} /> },
      { id: "actor", header: t("audit.column.actor"), cell: (event) => <EventActor actor={event.actor} /> },
      {
        id: "action",
        header: t("audit.column.action"),
        cell: (event) => (
          <EventAction
            event={event}
            onOpen={() => {
              setOpened({ event, open: true });
            }}
          />
        ),
      },
      { id: "target", header: t("audit.column.target"), cell: (event) => <EventTarget event={event} /> },
    ],
    [t],
  );

  // A workspace without the entitlement is refused by the server, which is the gate's answer and not a failure.
  if (events.isError && events.data === undefined && isEntitlementRequired(events.error)) {
    return <Slot name="entitlement.upgradeAction" />;
  }
  // A refused range is said beside the range, which can be changed, and not by the table's banner nor by a list that looks empty.
  // Only days the viewer chose have fields to say it beside; any other refusal is the banner's, so the page never goes blank.
  const hasDays = search.from !== undefined || search.to !== undefined;
  const rangeRefused = hasDays && events.isError && events.data === undefined && events.error instanceof ApiProblemError && events.error.status === 422;
  // The filter bar stays through every state of the list, so that a filter that leaves nothing, or fails, can be changed or taken off.
  let body: ReactElement | null;
  if (rangeRefused) {
    body = null;
  } else if (events.isError && events.data === undefined) {
    body = (
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
  } else if (events.isPending) {
    body = (
      <Loading className="p-0" label={t("audit.loading")}>
        <div className="flex flex-col gap-2">
          {SKELETON_ROWS.map((key) => (
            <Skeleton className="h-12 rounded-lg" key={key} />
          ))}
        </div>
      </Loading>
    );
  } else if (items.length === 0) {
    body = filtered ? (
      <EmptyState
        actions={
          <Button onClick={clearFilters} variant="outline">
            {t("audit.filters.clear")}
          </Button>
        }
        description={t("audit.filters.noMatch.description")}
        title={t("audit.filters.noMatch.title")}
      />
    ) : (
      <EmptyState description={t("audit.empty.description")} title={t("audit.empty.title")} />
    );
  } else {
    body = (
      <div className="flex flex-col gap-4">
        <DataTable columns={columns} label={t("audit.title")} rowKey={(event) => event.id} rows={items} />
        {opened === undefined ? null : (
          <AuditEventPanel
            event={opened.event}
            onOpenChange={(open) => {
              setOpened({ event: opened.event, open });
            }}
            open={opened.open}
          />
        )}
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
  return (
    <div className="flex flex-col gap-4">
      <AuditFilters controls={controls} customRange={customRange} members={members} onCustomRangeChange={setCustomRange} rangeRefused={rangeRefused} search={search} />
      {body}
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
