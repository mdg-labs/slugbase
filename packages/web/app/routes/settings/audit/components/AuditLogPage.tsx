import { useTranslate } from "@tolgee/react";
import { useCallback, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";

import type {
  AuditActor,
  AuditEvent,
  AuditEventType,
  AuditEventsPage,
} from "../audit.types.js";
import { AUDIT_EVENT_TYPES, AUDIT_PAGE_SIZE } from "../audit.types.js";

const TYPE_LABEL_KEYS: Record<AuditEventType, string> = {
  bookmark: "settings.audit.type.bookmark",
  folder: "settings.audit.type.folder",
  tag: "settings.audit.type.tag",
  member: "settings.audit.type.member",
  team: "settings.audit.type.team",
  settings: "settings.audit.type.settings",
  auth: "settings.audit.type.auth",
};

function TypeBadge({ type }: { type: AuditEventType }) {
  const { t } = useTranslate();
  return (
    <span
      className="shrink-0 rounded px-sp-2 py-sp-1 font-mono font-medium text-fg-muted"
      style={{
        fontSize: "10px",
        background: "var(--raised-2)",
        border: "1px solid var(--border-subtle)",
      }}
    >
      {t(TYPE_LABEL_KEYS[type])}
    </span>
  );
}

function ActorAvatar({ initials, name }: { initials: string; name: string }) {
  return (
    <div
      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full font-medium text-white"
      style={{
        background: "var(--accent)",
        fontSize: "10px",
      }}
      title={name}
      aria-label={name}
    >
      {initials}
    </div>
  );
}

function SkeletonRow() {
  return (
    <div
      className="flex items-center gap-sp-5 border-b border-[color:var(--border-subtle)] px-sp-4 py-sp-4"
      aria-hidden
    >
      <div className="h-3 w-24 animate-pulse rounded bg-raised-2" />
      <div className="h-7 w-7 animate-pulse rounded-full bg-raised-2" />
      <div className="flex-1">
        <div className="h-3 w-48 animate-pulse rounded bg-raised-2" />
      </div>
      <div className="h-4 w-16 animate-pulse rounded bg-raised-2" />
    </div>
  );
}

function EventRow({ event }: { event: AuditEvent }) {
  const dateStr = new Date(event.timestamp).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  return (
    <div className="flex flex-wrap items-center gap-sp-4 border-b border-[color:var(--border-subtle)] px-sp-4 py-sp-4">
      <span
        className="w-36 shrink-0 font-mono text-fg-subtle"
        style={{ fontSize: "var(--text-small)" }}
      >
        {dateStr}
      </span>
      <div className="flex shrink-0 items-center gap-sp-3">
        <ActorAvatar initials={event.actorInitials} name={event.actorName} />
        <span
          className="text-fg-muted"
          style={{ fontSize: "var(--text-small)" }}
        >
          {event.actorName}
        </span>
      </div>
      <span
        className="min-w-0 flex-1 text-fg"
        style={{ fontSize: "var(--text-small)" }}
      >
        {event.action}{" "}
        <span className="font-medium text-accent-text">{event.entity}</span>
        {event.entitySuffix ? ` ${event.entitySuffix}` : ""}
      </span>
      <TypeBadge type={event.type} />
    </div>
  );
}

interface AuditLogPageProps {
  events: AuditEventsPage;
}

export function AuditLogPage({ events }: AuditLogPageProps) {
  const { t } = useTranslate();
  const [, setSearchParams] = useSearchParams();
  const navigate = useNavigate();

  const [search, setSearch] = useState("");
  const [actorId, setActorId] = useState("all");
  const [type, setType] = useState<AuditEventType | "all">("all");

  const applyFilters = useCallback(
    (
      nextSearch: string,
      nextActor: string,
      nextType: AuditEventType | "all",
      nextPage: number,
    ) => {
      const params = new URLSearchParams();
      if (nextSearch) params.set("search", nextSearch);
      if (nextActor !== "all") params.set("actor", nextActor);
      if (nextType !== "all") params.set("type", nextType);
      if (nextPage > 0) params.set("page", String(nextPage));
      void navigate(`?${params.toString()}`, { replace: true });
    },
    [navigate],
  );

  const actors: AuditActor[] = [
    { id: "all", name: t("settings.audit.filter.actor_all") },
    ...events.actors,
  ];

  const currentPage = events.page;
  const totalPages = Math.max(1, Math.ceil(events.total / AUDIT_PAGE_SIZE));
  const hasFilters = search || actorId !== "all" || type !== "all";

  const handleSearch = (value: string) => {
    setSearch(value);
    applyFilters(value, actorId, type, 0);
  };

  const handleActor = (value: string) => {
    setActorId(value);
    applyFilters(search, value, type, 0);
  };

  const handleType = (value: AuditEventType | "all") => {
    setType(value);
    applyFilters(search, actorId, value, 0);
  };

  const handleClearFilters = () => {
    setSearch("");
    setActorId("all");
    setType("all");
    setSearchParams({});
  };

  return (
    <div className="mx-auto max-w-[720px] px-sp-6 py-sp-8" data-testid="audit-log-page">
      <header className="mb-sp-7">
        <h1
          className="m-0 text-fg font-semibold"
          style={{ fontSize: "var(--text-h2)", lineHeight: "var(--lh-h2)" }}
        >
          {t("settings.audit.page_title")}
        </h1>
        <p
          className="mt-sp-2 m-0 text-fg-muted"
          style={{ fontSize: "var(--text-body)", lineHeight: "var(--lh-body)" }}
        >
          {t("settings.audit.page_subtitle")}
        </p>
      </header>

      {/* Filter bar */}
      <div className="mb-sp-5 flex flex-wrap items-center gap-sp-3">
        <div className="relative flex items-center">
          <svg
            className="pointer-events-none absolute left-sp-3 h-4 w-4 text-fg-subtle"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            viewBox="0 0 24 24"
            aria-hidden
          >
            <circle cx="11" cy="11" r="8" />
            <path d="m21 21-4.35-4.35" />
          </svg>
          <input
            type="search"
            value={search}
            onChange={(e) => { handleSearch(e.target.value); }}
            placeholder={t("settings.audit.filter.search_placeholder")}
            className="h-8 rounded-md border border-[color:var(--border)] bg-raised pl-9 pr-sp-4 text-fg placeholder:text-fg-subtle focus:outline-none focus:ring-1 focus:ring-[color:var(--accent)]"
            style={{ fontSize: "var(--text-small)", width: 220 }}
          />
        </div>

        <select
          value={actorId}
          onChange={(e) => { handleActor(e.target.value); }}
          className="h-8 rounded-md border border-[color:var(--border)] bg-raised px-sp-3 text-fg focus:outline-none focus:ring-1 focus:ring-[color:var(--accent)]"
          style={{ fontSize: "var(--text-small)", minWidth: 150 }}
        >
          {actors.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>

        <select
          value={type}
          onChange={(e) => { handleType(e.target.value as AuditEventType | "all"); }}
          className="h-8 rounded-md border border-[color:var(--border)] bg-raised px-sp-3 text-fg focus:outline-none focus:ring-1 focus:ring-[color:var(--accent)]"
          style={{ fontSize: "var(--text-small)", minWidth: 130 }}
        >
          <option value="all">{t("settings.audit.filter.type_all")}</option>
          {AUDIT_EVENT_TYPES.map((et) => (
            <option key={et} value={et}>
              {t(TYPE_LABEL_KEYS[et])}
            </option>
          ))}
        </select>

        {hasFilters ? (
          <button
            type="button"
            onClick={handleClearFilters}
            className="h-8 rounded-md border border-[color:var(--border)] bg-raised px-sp-3 text-danger-text transition-colors hover:bg-raised-2"
            style={{ fontSize: "var(--text-small)" }}
          >
            {t("settings.audit.filter.clear")}
          </button>
        ) : null}

        <span
          className="ml-auto font-mono text-fg-subtle"
          style={{ fontSize: "var(--text-small)" }}
        >
          {events.total === 1
            ? t("settings.audit.count_one", { count: String(events.total) })
            : t("settings.audit.count_other", { count: String(events.total) })}
        </span>
      </div>

      {/* Log rows */}
      <div className="rounded-lg border border-[color:var(--border-subtle)] bg-base">
        {events.items.length === 0 ? (
          <div className="flex flex-col items-center px-sp-6 py-sp-12 text-center">
            <svg
              className="mb-sp-5 h-8 w-8 text-fg-faint"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.25"
              viewBox="0 0 24 24"
              aria-hidden
            >
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
              <line x1="16" y1="13" x2="8" y2="13" />
              <line x1="16" y1="17" x2="8" y2="17" />
              <polyline points="10 9 9 9 8 9" />
            </svg>
            <p className="m-0 text-fg-subtle" style={{ fontSize: "var(--text-body)" }}>
              {hasFilters
                ? t("settings.audit.empty.filtered")
                : t("settings.audit.empty.no_events")}
            </p>
            {hasFilters ? (
              <button
                type="button"
                onClick={handleClearFilters}
                className="mt-sp-5 rounded-md border border-[color:var(--border)] bg-raised px-sp-4 py-sp-2 text-fg-muted transition-colors hover:text-fg"
                style={{ fontSize: "var(--text-small)" }}
              >
                {t("settings.audit.empty.clear_filters")}
              </button>
            ) : null}
          </div>
        ) : (
          <>
            {events.items.map((event) => (
              <EventRow key={event.id} event={event} />
            ))}

            {totalPages > 1 ? (
              <div className="flex items-center justify-between px-sp-4 py-sp-4">
                <span
                  className="text-fg-subtle"
                  style={{ fontSize: "var(--text-small)" }}
                >
                  {t("settings.audit.pagination.showing", {
                    from: String(currentPage * AUDIT_PAGE_SIZE + 1),
                    to: String(
                      Math.min((currentPage + 1) * AUDIT_PAGE_SIZE, events.total),
                    ),
                    total: String(events.total),
                  })}
                </span>
                <div className="flex items-center gap-sp-2">
                  <button
                    type="button"
                    disabled={currentPage === 0}
                    onClick={() => {
                      applyFilters(search, actorId, type, currentPage - 1);
                    }}
                    className="flex h-8 w-8 items-center justify-center rounded border border-[color:var(--border)] bg-raised text-fg-muted transition-colors hover:bg-raised-2 disabled:cursor-not-allowed disabled:opacity-40"
                    aria-label={t("settings.audit.pagination.prev")}
                  >
                    <svg
                      className="h-3.5 w-3.5"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      viewBox="0 0 24 24"
                      aria-hidden
                    >
                      <polyline points="15 18 9 12 15 6" />
                    </svg>
                  </button>
                  {Array.from({ length: totalPages }, (_, i) => (
                    <button
                      key={i}
                      type="button"
                      onClick={() => {
                        applyFilters(search, actorId, type, i);
                      }}
                      className={`flex h-8 w-8 items-center justify-center rounded border text-fg transition-colors ${
                        i === currentPage
                          ? "border-[color:var(--accent)] bg-accent text-accent-fg"
                          : "border-[color:var(--border)] bg-raised hover:bg-raised-2"
                      }`}
                      style={{ fontSize: "var(--text-small)" }}
                      aria-current={i === currentPage ? "page" : undefined}
                    >
                      {i + 1}
                    </button>
                  ))}
                  <button
                    type="button"
                    disabled={currentPage >= totalPages - 1}
                    onClick={() => {
                      applyFilters(search, actorId, type, currentPage + 1);
                    }}
                    className="flex h-8 w-8 items-center justify-center rounded border border-[color:var(--border)] bg-raised text-fg-muted transition-colors hover:bg-raised-2 disabled:cursor-not-allowed disabled:opacity-40"
                    aria-label={t("settings.audit.pagination.next")}
                  >
                    <svg
                      className="h-3.5 w-3.5"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      viewBox="0 0 24 24"
                      aria-hidden
                    >
                      <polyline points="9 18 15 12 9 6" />
                    </svg>
                  </button>
                </div>
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

export { SkeletonRow };
