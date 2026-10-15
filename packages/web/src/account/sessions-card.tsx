import { Button } from "@slugbase/ui";
import { Banner, Confirm, DataTable, Loading, StatusBadge, feedbackToast, type DataTableColumn } from "@slugbase/ui/patterns";
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { useFormat } from "../i18n/use-format.ts";
import { SESSIONS_QUERY_KEY, sessionsQuery, type Session } from "./sessions.ts";

// `DELETE` carries no body, and the server refuses a mutation that does not say it is JSON (doc 04 section 5).
const JSON_HEADERS = { "Content-Type": "application/json" } as const;

type Pending = { readonly kind: "session"; readonly session: Session } | { readonly kind: "others" };

/** The Sessions card of `/settings/account/security` (doc 03 section 11.2): where the account is signed in, with Revoke and "Sign out everywhere else". */
export function SessionsCard(): ReactElement {
  const { t } = useTranslation();
  const format = useFormat();
  const router = useRouter();
  const queryClient = useQueryClient();
  const sessions = useInfiniteQuery(sessionsQuery(router.options.context.api));
  const [pending, setPending] = useState<Pending | undefined>(undefined);

  const revoke = useMutation({
    mutationKey: ["account", "sessions", "revoke"],
    mutationFn: async (session: Session): Promise<void> => {
      const { response, error } = await router.options.context.api.DELETE("/api/v1/me/sessions/{id}", {
        params: { path: { id: session.id } },
        headers: JSON_HEADERS,
      });
      if (!response.ok) {
        throw new Error("The session revocation did not answer with a problem document", { cause: error });
      }
    },
    onSuccess: (_result, session) => {
      if (session.current) {
        // The session this page is made with has ended, so nothing cached belongs to a signed-in member any more.
        router.history.replace("/login");
        queryClient.clear();
        return;
      }
      feedbackToast.success(t("settings.security.sessions.revoked"));
      void queryClient.invalidateQueries({ queryKey: SESSIONS_QUERY_KEY });
    },
    onError: () => {
      // The session may be gone already, so the list is asked again either way.
      void queryClient.invalidateQueries({ queryKey: SESSIONS_QUERY_KEY });
    },
    onSettled: () => {
      setPending(undefined);
    },
  });

  const revokeOthers = useMutation({
    mutationKey: ["account", "sessions", "revokeOthers"],
    mutationFn: async (): Promise<void> => {
      const { response, error } = await router.options.context.api.DELETE("/api/v1/me/sessions", { headers: JSON_HEADERS });
      if (!response.ok) {
        throw new Error("The sign-out of the other sessions did not answer with a problem document", { cause: error });
      }
    },
    onSuccess: () => {
      feedbackToast.success(t("settings.security.sessions.signedOutOthers"));
    },
    onSettled: () => {
      setPending(undefined);
      void queryClient.invalidateQueries({ queryKey: SESSIONS_QUERY_KEY });
    },
  });

  function askToRevoke(session: Session): void {
    if (session.current) {
      setPending({ kind: "session", session });
    } else {
      revoke.mutate(session);
    }
  }

  function askToSignOutOthers(): void {
    setPending({ kind: "others" });
  }

  const items = sessions.data?.pages.flatMap((page) => page.items) ?? [];
  // The session the page is made with is always one of the account's sessions, so an answer without any is not trusted.
  const answeredEmpty = sessions.data !== undefined && items.length === 0;
  const hasOthers = items.some((session) => !session.current) || sessions.hasNextPage;

  const columns: readonly DataTableColumn<Session>[] = [
    {
      id: "device",
      header: t("settings.security.sessions.column.device"),
      cell: (session) => (
        <span className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{session.userAgentFamily ?? t("settings.security.sessions.unknownDevice")}</span>
          {session.current ? <StatusBadge variant="info">{t("settings.security.sessions.thisDevice")}</StatusBadge> : null}
        </span>
      ),
    },
    {
      id: "network",
      header: t("settings.security.sessions.column.network"),
      cell: (session) => <span className="font-mono text-xs">{session.ipPrefix ?? t("settings.security.sessions.unknownNetwork")}</span>,
    },
    {
      id: "created",
      header: t("settings.security.sessions.column.created"),
      cell: (session) => format.date(new Date(session.createdAt), { dateStyle: "medium", timeStyle: "short" }),
    },
    {
      id: "lastSeen",
      header: t("settings.security.sessions.column.lastSeen"),
      cell: (session) => format.date(new Date(session.lastSeenAt), { dateStyle: "medium", timeStyle: "short" }),
    },
    {
      id: "actions",
      header: t("settings.security.sessions.column.actions"),
      hideHeader: true,
      className: "text-end",
      cell: (session) => (
        <Button
          aria-label={t("settings.security.sessions.revokeNamed", {
            device: session.userAgentFamily ?? t("settings.security.sessions.unknownDevice"),
          })}
          loading={revoke.isPending && revoke.variables.id === session.id}
          onClick={() => {
            askToRevoke(session);
          }}
          size="sm"
          variant="outline"
        >
          {t("settings.security.sessions.revoke")}
        </Button>
      ),
    },
  ];

  return (
    <section aria-labelledby="security-sessions-title" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h2 className="font-semibold text-lg leading-none" id="security-sessions-title">
            {t("settings.security.sessions.title")}
          </h2>
          <p className="text-muted-foreground text-sm">{t("settings.security.sessions.description")}</p>
        </div>
        <Button
          disabled={!hasOthers}
          onClick={askToSignOutOthers}
          variant="outline"
        >
          {t("settings.security.sessions.signOutOthers")}
        </Button>
      </div>
      {sessions.isPending ? <Loading label={t("shell.loading")} /> : null}
      {sessions.isError || answeredEmpty ? (
        <Banner
          action={
            <Button
              onClick={() => {
                void sessions.refetch();
              }}
              size="sm"
              variant="outline"
            >
              {t("settings.account.loadFailed.retry")}
            </Button>
          }
          description={t("settings.account.loadFailed.description")}
          title={t("settings.security.sessions.loadFailed.title")}
          variant="error"
        />
      ) : null}
      {items.length === 0 ? null : (
        <>
          <DataTable columns={columns} label={t("settings.security.sessions.title")} rowKey={(session) => session.id} rows={items} />
          {sessions.hasNextPage ? (
            <div className="flex justify-center">
              <Button
                loading={sessions.isFetchingNextPage}
                onClick={() => {
                  void sessions.fetchNextPage();
                }}
                variant="outline"
              >
                {t("settings.security.sessions.loadMore")}
              </Button>
            </div>
          ) : null}
        </>
      )}
      <Confirm
        cancelLabel={t("settings.security.sessions.confirm.cancel")}
        confirmLabel={
          pending?.kind === "session" ? t("settings.security.sessions.confirm.current.action") : t("settings.security.sessions.confirm.others.action")
        }
        description={
          pending?.kind === "session"
            ? t("settings.security.sessions.confirm.current.description")
            : t("settings.security.sessions.confirm.others.description")
        }
        destructive
        loading={revoke.isPending || revokeOthers.isPending}
        onConfirm={() => {
          if (pending?.kind === "session") {
            revoke.mutate(pending.session);
          } else {
            revokeOthers.mutate();
          }
        }}
        onOpenChange={(open) => {
          if (!open) {
            setPending(undefined);
          }
        }}
        open={pending !== undefined}
        title={
          pending?.kind === "session" ? t("settings.security.sessions.confirm.current.title") : t("settings.security.sessions.confirm.others.title")
        }
      />
    </section>
  );
}
