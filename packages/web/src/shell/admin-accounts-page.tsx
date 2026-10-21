import { Button, Input } from "@slugbase/ui";
import { Banner, DataTable, EmptyState, Loading, RowActions, ShieldCheckIcon, StatusBadge, feedbackToast, type DataTableColumn, type RowAction } from "@slugbase/ui/patterns";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { meQuery } from "../account/me.ts";
import { useFormat } from "../i18n/use-format.ts";
import { AccountActionConfirm, ResetLinkDialog, useAccountRefusalMessage, useRefreshAfterRefusal, type ConfirmedAction } from "./admin-account-dialogs.tsx";
import { useAdminActionsEnabled, useRefreshStandingOnForbidden } from "./admin-access.ts";
import { AdminDeleteAccountDialog } from "./admin-delete-account-dialog.tsx";
import { instanceAccountsQuery, issueInstanceAccountResetLink, resendInstanceAccountVerification, type InstanceAccount } from "./admin-accounts.ts";

type Pending =
  | { readonly kind: ConfirmedAction | "delete"; readonly account: InstanceAccount }
  | { readonly kind: "resetLink"; readonly account: InstanceAccount; readonly link: string };

function matches(account: InstanceAccount, query: string): boolean {
  const needle = query.trim().toLowerCase();
  return needle === "" || account.displayName.toLowerCase().includes(needle) || account.email.toLowerCase().includes(needle);
}

function AccountsTable({
  accounts,
  viewerId,
  busy,
  onAction,
  onResend,
  onResetLink,
}: {
  accounts: readonly InstanceAccount[];
  viewerId: string | undefined;
  busy: boolean;
  onAction: (action: Pending) => void;
  onResend: (account: InstanceAccount) => void;
  onResetLink: (account: InstanceAccount) => void;
}): ReactElement {
  const { t } = useTranslation();
  const format = useFormat();

  function actionsOf(account: InstanceAccount): readonly RowAction[] {
    const own = account.id === viewerId;
    const ask = (kind: ConfirmedAction | "delete") => () => {
      onAction({ kind, account });
    };
    const actions: RowAction[] = [];
    if (!account.emailVerified) {
      actions.push(
        { id: "resend", label: t("admin.accounts.action.resend.label"), disabled: busy, onSelect: () => { onResend(account); } },
        { id: "markVerified", label: t("admin.accounts.action.markVerified.label"), onSelect: ask("markVerified") },
      );
    }
    actions.push({ id: "resetLink", label: t("admin.accounts.action.resetLink.label"), disabled: busy, onSelect: () => { onResetLink(account); } });
    if (account.mfaEnabled && !own) {
      actions.push({ id: "resetMfa", label: t("admin.accounts.action.resetMfa.label"), onSelect: ask("resetMfa") });
    }
    actions.push(
      account.disabled
        ? { id: "enable", label: t("admin.accounts.action.enable.label"), onSelect: ask("enable") }
        : { id: "disable", label: t("admin.accounts.action.disable.label"), onSelect: ask("disable") },
      account.isInstanceAdmin
        ? { id: "demote", label: t("admin.accounts.action.demote.label"), onSelect: ask("demote") }
        : { id: "promote", label: t("admin.accounts.action.promote.label"), onSelect: ask("promote") },
    );
    if (!own) {
      actions.push({ id: "delete", label: t("admin.accounts.action.delete.label"), destructive: true, onSelect: ask("delete") });
    }
    return actions;
  }

  const columns: readonly DataTableColumn<InstanceAccount>[] = [
    {
      id: "name",
      header: t("admin.accounts.column.name"),
      cell: (account) => (
        <span className="flex flex-wrap items-center gap-2">
          <span className="font-medium wrap-anywhere">{account.displayName}</span>
          {account.id === viewerId ? <StatusBadge variant="info">{t("admin.accounts.you")}</StatusBadge> : null}
        </span>
      ),
    },
    { id: "email", header: t("admin.accounts.column.email"), cell: (account) => <span className="wrap-anywhere">{account.email}</span> },
    {
      id: "verified",
      header: t("admin.accounts.column.verified"),
      cell: (account) =>
        account.emailVerified ? <StatusBadge variant="success">{t("admin.accounts.verified")}</StatusBadge> : <StatusBadge variant="warning">{t("admin.accounts.notVerified")}</StatusBadge>,
    },
    {
      id: "mfa",
      header: t("admin.accounts.column.mfa"),
      cell: (account) => <StatusBadge variant={account.mfaEnabled ? "success" : "neutral"}>{account.mfaEnabled ? t("admin.accounts.on") : t("admin.accounts.off")}</StatusBadge>,
    },
    {
      id: "admin",
      header: t("admin.accounts.column.admin"),
      cell: (account) => <StatusBadge variant={account.isInstanceAdmin ? "info" : "neutral"}>{account.isInstanceAdmin ? t("admin.accounts.yes") : t("admin.accounts.no")}</StatusBadge>,
    },
    {
      id: "lastSignIn",
      header: t("admin.accounts.column.lastSignIn"),
      cell: (account) => (account.lastSignInAt === null ? t("admin.accounts.never") : format.date(new Date(account.lastSignInAt), { dateStyle: "medium", timeStyle: "short" })),
    },
    { id: "workspaces", header: t("admin.accounts.column.workspaces"), cell: (account) => format.number(account.workspaceCount) },
    {
      id: "status",
      header: t("admin.accounts.column.status"),
      cell: (account) => <StatusBadge variant={account.disabled ? "error" : "success"}>{account.disabled ? t("admin.accounts.disabled") : t("admin.accounts.active")}</StatusBadge>,
    },
    {
      id: "actions",
      header: t("admin.accounts.column.actions"),
      hideHeader: true,
      className: "text-end",
      cell: (account) => <RowActions actions={actionsOf(account)} label={t("admin.accounts.actionsFor", { name: account.displayName })} />,
    },
  ];

  return <DataTable columns={columns} label={t("admin.accounts.table.label")} rowKey={(account) => account.id} rows={accounts} />;
}

/**
 * `/admin/accounts`, the accounts of the instance (doc 03 section 12): their verification, second factor, admin flag, last sign-in,
 * workspaces and status, filtered by a search box, with every recovery and administration action in the row's menu. The actions that
 * change an account ask first; the ones that need a fresh re-authentication use the shared prompt. The server refuses all of it to an
 * admin without a second factor, so the page asks for nothing and offers no action then; it says what is missing instead.
 */
export function AdminAccountsPage(): ReactElement {
  const { t } = useTranslation();
  const router = useRouter();
  const api = router.options.context.api;
  const enabled = useAdminActionsEnabled();
  const me = useQuery(meQuery(api));
  const list = useQuery({ ...instanceAccountsQuery(api), enabled });
  const refusalMessage = useAccountRefusalMessage();
  const refreshAfter = useRefreshAfterRefusal();
  const [search, setSearch] = useState("");
  const [pending, setPending] = useState<Pending | undefined>(undefined);
  useRefreshStandingOnForbidden(list.error);

  const resend = useMutation({
    mutationKey: ["admin", "accounts", "resend"],
    mutationFn: (account: InstanceAccount) => resendInstanceAccountVerification(api, account.id),
    onSuccess: (outcome, account) => {
      if (outcome.status === "done") {
        feedbackToast.success(t("admin.accounts.action.resend.done", { email: account.email }));
      } else {
        refreshAfter(outcome.refusal);
        feedbackToast.error(t("admin.accounts.action.resend.failed", { email: account.email }), refusalMessage(outcome.refusal));
      }
    },
  });
  const resetLink = useMutation({
    mutationKey: ["admin", "accounts", "resetLink"],
    mutationFn: (account: InstanceAccount) => issueInstanceAccountResetLink(api, account.id),
    onSuccess: (outcome, account) => {
      if (outcome.status === "refused") {
        refreshAfter(outcome.refusal);
        feedbackToast.error(t("admin.accounts.action.resetLink.failed", { name: account.displayName }), refusalMessage(outcome.refusal));
      } else if (outcome.delivery === "link") {
        setPending({ kind: "resetLink", account, link: outcome.link });
      } else {
        feedbackToast.success(t("admin.accounts.action.resetLink.mailed", { email: account.email }));
      }
    },
  });

  const close = (): void => {
    setPending(undefined);
  };
  const accounts = list.data;
  const visible = accounts?.filter((account) => matches(account, search)) ?? [];

  let body: ReactElement;
  if (!enabled) {
    body = (
      <EmptyState
        description={t("admin.accounts.mfaRequired.description")}
        icon={<ShieldCheckIcon aria-hidden="true" />}
        title={t("admin.accounts.mfaRequired.title")}
      />
    );
  } else if (accounts !== undefined) {
    body =
      accounts.length === 0 ? (
        <EmptyState description={t("admin.accounts.empty.description")} title={t("admin.accounts.empty.title")} />
      ) : (
        <>
          <Input
            aria-label={t("admin.accounts.search.label")}
            autoComplete="off"
            onChange={(event) => {
              setSearch(event.target.value);
            }}
            placeholder={t("admin.accounts.search.placeholder")}
            type="search"
            value={search}
          />
          {visible.length === 0 ? (
            <EmptyState
              actions={
                <Button
                  onClick={() => {
                    setSearch("");
                  }}
                  variant="outline"
                >
                  {t("admin.accounts.search.clear")}
                </Button>
              }
              description={t("admin.accounts.search.none.description", { query: search.trim() })}
              title={t("admin.accounts.search.none.title")}
            />
          ) : (
            <AccountsTable
              accounts={visible}
              busy={resend.isPending || resetLink.isPending}
              onAction={setPending}
              onResend={(account) => {
                resend.mutate(account);
              }}
              onResetLink={(account) => {
                resetLink.mutate(account);
              }}
              viewerId={me.data?.account.id}
            />
          )}
        </>
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
            {t("admin.accounts.loadFailed.retry")}
          </Button>
        }
        description={t("admin.accounts.loadFailed.description")}
        title={t("admin.accounts.loadFailed.title")}
        variant="error"
      />
    );
  } else {
    body = <Loading label={t("shell.loading")} />;
  }

  return (
    <>
      <h1 className="font-semibold text-2xl leading-none">{t("admin.accounts.title")}</h1>
      {body}
      {pending === undefined || pending.kind === "delete" || pending.kind === "resetLink" ? null : (
        <AccountActionConfirm account={pending.account} action={pending.kind} onClose={close} own={pending.account.id === me.data?.account.id} />
      )}
      {pending?.kind === "delete" ? <AdminDeleteAccountDialog account={pending.account} onClose={close} /> : null}
      {pending?.kind === "resetLink" ? <ResetLinkDialog account={pending.account} link={pending.link} onClose={close} /> : null}
    </>
  );
}
