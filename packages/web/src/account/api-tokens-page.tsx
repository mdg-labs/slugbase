import { Button } from "@slugbase/ui";
import { Banner, Confirm, DataTable, EmptyState, Loading, StatusBadge, feedbackToast, type DataTableColumn } from "@slugbase/ui/patterns";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { useFormat } from "../i18n/use-format.ts";
import { CreateApiToken } from "./api-token-create.tsx";
import { API_TOKENS_QUERY_KEY, apiTokensQuery, revokeApiToken, type ApiToken } from "./api-tokens.ts";
import { meQuery } from "./me.ts";

/** `/settings/account/tokens` (doc 03 section 11.3): the account's API tokens, with Revoke and "New token". */
export function AccountTokensPage(): ReactElement {
  const { t } = useTranslation();
  const format = useFormat();
  const router = useRouter();
  const queryClient = useQueryClient();
  const api = router.options.context.api;
  const me = useQuery(meQuery(api));
  const tokens = useInfiniteQuery(apiTokensQuery(api));
  const [creating, setCreating] = useState(false);
  const [pending, setPending] = useState<ApiToken | undefined>(undefined);

  const revoke = useMutation({
    mutationKey: ["account", "api-tokens", "revoke"],
    mutationFn: (token: ApiToken) => revokeApiToken(api, token.id),
    onSuccess: () => {
      feedbackToast.success(t("settings.tokens.revoked"));
    },
    onSettled: () => {
      // The token may be gone already, so the list is asked again either way.
      setPending(undefined);
      void queryClient.invalidateQueries({ queryKey: API_TOKENS_QUERY_KEY });
    },
  });

  const items = tokens.data?.pages.flatMap((page) => page.items) ?? [];
  const empty = tokens.data !== undefined && items.length === 0;
  const canCreate = me.data !== undefined && me.data.memberships.length > 0;

  const dateTime = (value: string): string => format.date(new Date(value), { dateStyle: "medium", timeStyle: "short" });
  const columns: readonly DataTableColumn<ApiToken>[] = [
    {
      id: "name",
      header: t("settings.tokens.column.name"),
      cell: (token) => <span className="font-medium">{token.name}</span>,
    },
    {
      id: "workspace",
      header: t("settings.tokens.column.workspace"),
      cell: (token) => token.workspaceName,
    },
    {
      id: "scope",
      header: t("settings.tokens.column.scope"),
      cell: (token) => (
        <StatusBadge variant={token.scope === "read-write" ? "warning" : "neutral"}>
          {token.scope === "read-write" ? t("settings.tokens.scope.readWrite") : t("settings.tokens.scope.read")}
        </StatusBadge>
      ),
    },
    {
      id: "prefix",
      header: t("settings.tokens.column.prefix"),
      cell: (token) => {
        const shown = `slb_${token.prefix}`;
        return <span className="font-mono text-xs">{shown}</span>;
      },
    },
    {
      id: "created",
      header: t("settings.tokens.column.created"),
      cell: (token) => dateTime(token.createdAt),
    },
    {
      id: "lastUsed",
      header: t("settings.tokens.column.lastUsed"),
      cell: (token) => (token.lastUsedAt === null ? t("settings.tokens.never") : dateTime(token.lastUsedAt)),
    },
    {
      id: "expires",
      header: t("settings.tokens.column.expires"),
      cell: (token) => (token.expiresAt === null ? t("settings.tokens.noExpiry") : dateTime(token.expiresAt)),
    },
    {
      id: "actions",
      header: t("settings.tokens.column.actions"),
      hideHeader: true,
      className: "text-end",
      cell: (token) => (
        <Button
          aria-label={t("settings.tokens.revokeNamed", { name: token.name })}
          loading={revoke.isPending && revoke.variables.id === token.id}
          onClick={() => {
            setPending(token);
          }}
          size="sm"
          variant="outline"
        >
          {t("settings.tokens.revoke")}
        </Button>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="font-semibold text-xl">{t("settings.tokens.title")}</h1>
          <p className="text-muted-foreground text-sm">{t("settings.tokens.description")}</p>
        </div>
        <Button
          disabled={!canCreate}
          onClick={() => {
            setCreating(true);
          }}
        >
          {t("settings.tokens.new")}
        </Button>
      </div>
      {tokens.isPending ? <Loading label={t("shell.loading")} /> : null}
      {tokens.isError ? (
        <Banner
          action={
            <Button
              onClick={() => {
                void tokens.refetch();
              }}
              size="sm"
              variant="outline"
            >
              {t("settings.account.loadFailed.retry")}
            </Button>
          }
          description={t("settings.account.loadFailed.description")}
          title={t("settings.tokens.loadFailed.title")}
          variant="error"
        />
      ) : null}
      {empty ? <EmptyState description={t("settings.tokens.empty.description")} title={t("settings.tokens.empty.title")} /> : null}
      {items.length === 0 ? null : (
        <>
          <DataTable columns={columns} label={t("settings.tokens.title")} rowKey={(token) => token.id} rows={items} />
          {tokens.hasNextPage ? (
            <div className="flex justify-center">
              <Button
                loading={tokens.isFetchingNextPage}
                onClick={() => {
                  void tokens.fetchNextPage();
                }}
                variant="outline"
              >
                {t("settings.tokens.loadMore")}
              </Button>
            </div>
          ) : null}
        </>
      )}
      {creating && me.data !== undefined ? (
        <CreateApiToken
          me={me.data}
          onClose={() => {
            setCreating(false);
          }}
        />
      ) : null}
      <Confirm
        cancelLabel={t("settings.tokens.confirm.cancel")}
        confirmLabel={t("settings.tokens.confirm.action")}
        description={t("settings.tokens.confirm.description", { name: pending?.name ?? "" })}
        destructive
        loading={revoke.isPending}
        onConfirm={() => {
          if (pending !== undefined) {
            revoke.mutate(pending);
          }
        }}
        onOpenChange={(open) => {
          if (!open) {
            setPending(undefined);
          }
        }}
        open={pending !== undefined}
        title={t("settings.tokens.confirm.title", { name: pending?.name ?? "" })}
      />
    </div>
  );
}
