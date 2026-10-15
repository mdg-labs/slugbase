import { Button } from "@slugbase/ui";
import { Banner, Confirm, DataTable, Loading, feedbackToast, type DataTableColumn } from "@slugbase/ui/patterns";
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useEffect, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { ApiProblemError } from "../api/client.ts";
import { useReauth } from "../auth/reauth-context.tsx";
import { oidcProvidersOf } from "../auth/oidc.ts";
import { useConfig } from "../config/config-context.tsx";
import { useFormat } from "../i18n/use-format.ts";
import { IDENTITIES_QUERY_KEY, identitiesQuery, isLastSignInMethod, startLink, type Identity } from "./identities.ts";

// `DELETE` carries no body, and the server refuses a mutation that does not say it is JSON (doc 04 section 5).
const JSON_HEADERS = { "Content-Type": "application/json" } as const;

/** Where the member lands after the handshake of a link: back on this page. */
const SECURITY_PATH = "/settings/account/security";

type UnlinkProblem = "lastMethod" | "refused";

/**
 * The Linked sign-in methods card of `/settings/account/security` (doc 03 section 11.2): the identities linked to the
 * account, Unlink behind a confirmation that states the rule that one way to sign in must remain, and a Link action
 * for every configured provider that is not linked yet. With no provider configured and nothing linked there is
 * nothing to manage, and the card is not shown.
 */
export function LinkedSignInCard(): ReactElement | null {
  const { t } = useTranslation();
  const format = useFormat();
  const router = useRouter();
  const queryClient = useQueryClient();
  const reauth = useReauth();
  const providers = oidcProvidersOf(useConfig());
  const identities = useInfiniteQuery(identitiesQuery(router.options.context.api));
  const [pending, setPending] = useState<Identity | undefined>(undefined);
  const [problem, setProblem] = useState<UnlinkProblem | undefined>(undefined);

  const { hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage } = identities;
  // Which providers are free to link is known only once every identity has been read.
  useEffect(() => {
    if (hasNextPage && !isFetchingNextPage && !isFetchNextPageError) {
      void fetchNextPage();
    }
  }, [hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage]);

  const unlink = useMutation({
    mutationKey: ["account", "identities", "unlink"],
    // A refusal of the rule that one way to sign in must remain is shown in the card, not as a toast.
    meta: { fieldErrors: true },
    mutationFn: async (identity: Identity): Promise<void> => {
      const { response, error } = await router.options.context.api.DELETE("/api/v1/me/identities/{id}", {
        params: { path: { id: identity.id } },
        headers: JSON_HEADERS,
      });
      if (!response.ok) {
        throw new Error("The unlinking did not answer with a problem document", { cause: error });
      }
    },
    onSuccess: () => {
      setProblem(undefined);
      feedbackToast.success(t("settings.security.identities.unlinked"));
    },
    onError: (error) => {
      if (error instanceof ApiProblemError && error.status === 422) {
        setProblem(isLastSignInMethod(error) ? "lastMethod" : "refused");
      }
    },
    onSettled: () => {
      setPending(undefined);
      void queryClient.invalidateQueries({ queryKey: IDENTITIES_QUERY_KEY });
    },
  });

  const link = useMutation({
    mutationKey: ["account", "identities", "link"],
    mutationFn: (provider: string): Promise<void> => startLink(router.options.context.api, reauth, provider, SECURITY_PATH),
  });

  function nameOf(slug: string): string {
    // A provider the operator has since removed is still listed by its slug.
    return providers.find((provider) => provider.slug === slug)?.name ?? slug;
  }

  const items = identities.data?.pages.flatMap((page) => page.items) ?? [];
  const everythingRead = identities.data !== undefined && !identities.hasNextPage && !identities.isError;
  if (providers.length === 0 && !identities.isError && (identities.isPending || items.length === 0)) {
    return null;
  }
  const linked = new Set(items.map((identity) => identity.provider));
  const unlinked = providers.filter((provider) => !linked.has(provider.slug));

  const columns: readonly DataTableColumn<Identity>[] = [
    {
      id: "provider",
      header: t("settings.security.identities.column.provider"),
      cell: (identity) => <span className="font-medium">{nameOf(identity.provider)}</span>,
    },
    {
      id: "email",
      header: t("settings.security.identities.column.email"),
      cell: (identity) => (identity.emailAtLink === "" ? t("settings.security.identities.noEmail") : identity.emailAtLink),
    },
    {
      id: "lastUsed",
      header: t("settings.security.identities.column.lastUsed"),
      cell: (identity) =>
        identity.lastUsedAt === null
          ? t("settings.security.identities.neverUsed")
          : format.date(new Date(identity.lastUsedAt), { dateStyle: "medium", timeStyle: "short" }),
    },
    {
      id: "actions",
      header: t("settings.security.identities.column.actions"),
      hideHeader: true,
      className: "text-end",
      cell: (identity) => (
        <Button
          aria-label={t("settings.security.identities.unlinkNamed", { provider: nameOf(identity.provider) })}
          onClick={() => {
            setProblem(undefined);
            setPending(identity);
          }}
          size="sm"
          variant="outline"
        >
          {t("settings.security.identities.unlink")}
        </Button>
      ),
    },
  ];

  return (
    <section aria-labelledby="security-identities-title" className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h2 className="font-semibold text-lg leading-none" id="security-identities-title">
          {t("settings.security.identities.title")}
        </h2>
        <p className="text-muted-foreground text-sm">{t("settings.security.identities.description")}</p>
      </div>
      {identities.isPending ? <Loading label={t("shell.loading")} /> : null}
      {identities.isError ? (
        <Banner
          action={
            <Button
              onClick={() => {
                void identities.refetch();
              }}
              size="sm"
              variant="outline"
            >
              {t("settings.account.loadFailed.retry")}
            </Button>
          }
          description={t("settings.account.loadFailed.description")}
          title={t("settings.security.identities.loadFailed.title")}
          variant="error"
        />
      ) : null}
      {problem === undefined ? null : (
        <Banner
          description={
            problem === "lastMethod" ? t("settings.security.identities.error.lastMethod.description") : undefined
          }
          title={
            problem === "lastMethod"
              ? t("settings.security.identities.error.lastMethod.title")
              : t("settings.security.identities.error.refused")
          }
          variant="error"
        />
      )}
      {identities.isError ? null : items.length === 0 ? (
        everythingRead ? <p className="text-muted-foreground text-sm">{t("settings.security.identities.none")}</p> : null
      ) : (
        <DataTable columns={columns} label={t("settings.security.identities.title")} rowKey={(identity) => identity.id} rows={items} />
      )}
      {everythingRead && unlinked.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {unlinked.map((provider) => (
            <li className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2" key={provider.slug}>
              <span className="font-medium text-sm">{provider.name}</span>
              <Button
                aria-label={t("settings.security.identities.linkNamed", { provider: provider.name })}
                loading={link.isPending && link.variables === provider.slug}
                onClick={() => {
                  link.mutate(provider.slug);
                }}
                size="sm"
                variant="outline"
              >
                {t("settings.security.identities.link")}
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      <Confirm
        cancelLabel={t("settings.security.identities.confirm.cancel")}
        confirmLabel={t("settings.security.identities.confirm.action")}
        description={t("settings.security.identities.confirm.description", { provider: pending === undefined ? "" : nameOf(pending.provider) })}
        destructive
        loading={unlink.isPending}
        onConfirm={() => {
          if (pending !== undefined) {
            unlink.mutate(pending);
          }
        }}
        onOpenChange={(open) => {
          if (!open) {
            setPending(undefined);
          }
        }}
        open={pending !== undefined}
        title={t("settings.security.identities.confirm.title", { provider: pending === undefined ? "" : nameOf(pending.provider) })}
      />
    </section>
  );
}
