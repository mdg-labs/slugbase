import { Button } from "@slugbase/ui";
import { Confirm, FormOverlay, ShownOnce, feedbackToast } from "@slugbase/ui/patterns";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { ME_QUERY_KEY } from "../account/me.ts";
import {
  ADMIN_ACCOUNTS_QUERY_KEY,
  resetInstanceAccountMfa,
  updateInstanceAccount,
  type AccountOutcome,
  type AccountRefusal,
  type InstanceAccount,
} from "./admin-accounts.ts";
import { useRateLimitMessage } from "./admin-rate-limit.ts";

/** The sentence for a refusal of an action on an account, in the language of the page. */
export function useAccountRefusalMessage(): (refusal: AccountRefusal) => string {
  const { t } = useTranslation();
  const rateLimitMessage = useRateLimitMessage();
  return (refusal) => {
    switch (refusal.kind) {
      case "reauthRequired":
        return t("admin.accounts.error.reauthCancelled");
      case "forbidden":
        return t("admin.accounts.error.forbidden");
      case "gone":
        return t("admin.accounts.error.gone");
      case "lastInstanceAdmin":
        return t("admin.accounts.error.lastInstanceAdmin");
      case "accountDisabled":
        return t("admin.accounts.error.accountDisabled");
      case "emailUnverified":
        return t("admin.accounts.error.emailUnverified");
      case "noPassword":
        return t("admin.accounts.error.noPassword");
      case "alreadyVerified":
        return t("admin.accounts.error.alreadyVerified");
      case "mailUnavailable":
        return t("admin.accounts.error.mailUnavailable");
      case "self":
        return t("admin.accounts.error.self");
      case "invalid":
        return t("admin.accounts.error.invalid");
      case "rateLimited":
        return rateLimitMessage(refusal.seconds);
      case "lastOwner":
        return t("admin.accounts.error.lastOwner");
      case "guard":
        return refusal.code === "billing_active" ? t("admin.accounts.error.billingActive") : t("admin.accounts.error.guard");
    }
  };
}

/** What a refusal changes about what the page knows: the account's standing, or the list it showed. */
export function useRefreshAfterRefusal(): (refusal: AccountRefusal) => void {
  const queryClient = useQueryClient();
  return (refusal) => {
    if (refusal.kind === "forbidden") {
      void queryClient.invalidateQueries({ queryKey: ME_QUERY_KEY });
    } else if (refusal.kind === "gone") {
      void queryClient.invalidateQueries({ queryKey: ADMIN_ACCOUNTS_QUERY_KEY });
    }
  };
}

/** The actions that ask for a `confirm` before they change an account. */
export type ConfirmedAction = "markVerified" | "resetMfa" | "disable" | "enable" | "promote" | "demote";

/**
 * Asks the admin to confirm an action on an account (doc 03 section 12, `confirm`), says what it does to the account, and runs it. The
 * actions that need a fresh re-authentication ask for it with the shared prompt; an admin who closes it stays in the dialog, told that
 * nothing was changed. A refusal, such as the last instance admin, is explained in the dialog, which stays open; an account that is
 * gone closes it. The admin's own account is told it ends their session where the action does.
 */
export function AccountActionConfirm({
  action,
  account,
  own,
  onClose,
}: {
  action: ConfirmedAction;
  account: InstanceAccount;
  /** Whether the account is the signed-in admin's own. */
  own: boolean;
  onClose: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const router = useRouter();
  const queryClient = useQueryClient();
  const api = router.options.context.api;
  const refusalMessage = useAccountRefusalMessage();
  const refreshAfter = useRefreshAfterRefusal();
  const [refusal, setRefusal] = useState<AccountRefusal | undefined>(undefined);
  const name = account.displayName;

  const run = useMutation({
    mutationKey: ["admin", "accounts", action],
    mutationFn: (): Promise<AccountOutcome> => {
      switch (action) {
        case "markVerified":
          return updateInstanceAccount(api, account.id, { emailVerified: true });
        case "resetMfa":
          return resetInstanceAccountMfa(api, account.id);
        case "disable":
          return updateInstanceAccount(api, account.id, { disabled: true });
        case "enable":
          return updateInstanceAccount(api, account.id, { disabled: false });
        case "promote":
          return updateInstanceAccount(api, account.id, { isInstanceAdmin: true });
        case "demote":
          return updateInstanceAccount(api, account.id, { isInstanceAdmin: false });
      }
    },
    onSuccess: (outcome) => {
      if (outcome.status === "refused") {
        refreshAfter(outcome.refusal);
        if (outcome.refusal.kind === "gone") {
          feedbackToast.error(t("admin.accounts.error.title"), refusalMessage(outcome.refusal));
          onClose();
          return;
        }
        setRefusal(outcome.refusal);
        return;
      }
      feedbackToast.success(doneMessage());
      void queryClient.invalidateQueries({ queryKey: ADMIN_ACCOUNTS_QUERY_KEY });
      if (own) {
        // A change to the admin's own flag or sessions ends their session: the account is read again to see where that leaves them.
        void queryClient.invalidateQueries({ queryKey: ME_QUERY_KEY });
      }
      onClose();
    },
  });

  function doneMessage(): string {
    switch (action) {
      case "markVerified":
        return t("admin.accounts.action.markVerified.done", { email: account.email });
      case "resetMfa":
        return t("admin.accounts.action.resetMfa.done", { name });
      case "disable":
        return t("admin.accounts.action.disable.done", { name });
      case "enable":
        return t("admin.accounts.action.enable.done", { name });
      case "promote":
        return t("admin.accounts.action.promote.done", { name });
      case "demote":
        return t("admin.accounts.action.demote.done", { name });
    }
  }

  function copy(): { title: string; description: string; confirm: string } {
    switch (action) {
      case "markVerified":
        return {
          title: t("admin.accounts.action.markVerified.title", { email: account.email }),
          description: own ? t("admin.accounts.action.markVerified.descriptionOwn") : t("admin.accounts.action.markVerified.description", { email: account.email }),
          confirm: t("admin.accounts.action.markVerified.label"),
        };
      case "resetMfa":
        return {
          title: t("admin.accounts.action.resetMfa.title", { name }),
          description: t("admin.accounts.action.resetMfa.description", { name }),
          confirm: t("admin.accounts.action.resetMfa.label"),
        };
      case "disable":
        return {
          title: t("admin.accounts.action.disable.title", { name }),
          description: own ? t("admin.accounts.action.disable.descriptionOwn") : t("admin.accounts.action.disable.description", { name }),
          confirm: t("admin.accounts.action.disable.label"),
        };
      case "enable":
        return {
          title: t("admin.accounts.action.enable.title", { name }),
          description: t("admin.accounts.action.enable.description", { name }),
          confirm: t("admin.accounts.action.enable.label"),
        };
      case "promote":
        return {
          title: t("admin.accounts.action.promote.title", { name }),
          description: t("admin.accounts.action.promote.description", { name }),
          confirm: t("admin.accounts.action.promote.label"),
        };
      case "demote":
        return {
          title: t("admin.accounts.action.demote.title", { name }),
          description: own ? t("admin.accounts.action.demote.descriptionOwn") : t("admin.accounts.action.demote.description", { name }),
          confirm: t("admin.accounts.action.demote.label"),
        };
    }
  }

  const text = copy();
  return (
    <Confirm
      cancelLabel={t("admin.accounts.cancel")}
      confirmLabel={text.confirm}
      description={
        <>
          {text.description}
          {refusal === undefined ? null : (
            <span className="mt-3 block text-destructive-text" role="alert">
              {refusalMessage(refusal)}
            </span>
          )}
        </>
      }
      destructive={(action === "markVerified" && !own) || action === "resetMfa" || action === "disable" || action === "demote"}
      loading={run.isPending}
      onConfirm={() => {
        setRefusal(undefined);
        run.mutate();
      }}
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
      open
      title={text.title}
    />
  );
}

/** The password-reset link of an account, shown once because no email carried it: the server has no mail configured, or the account has no password for an email to reach. */
export function ResetLinkDialog({ account, link, onClose }: { account: InstanceAccount; link: string; onClose: () => void }): ReactElement {
  const { t } = useTranslation();
  const [acknowledged, setAcknowledged] = useState(false);
  return (
    <FormOverlay
      closeLabel={t("admin.accounts.resetLink.close")}
      description={t("admin.accounts.resetLink.description", { name: account.displayName })}
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
      open
      title={t("admin.accounts.resetLink.title", { name: account.displayName })}
    >
      <div className="flex flex-col gap-4">
        <ShownOnce
          acknowledgeLabel={t("admin.accounts.resetLink.acknowledge")}
          acknowledged={acknowledged}
          copiedLabel={t("admin.accounts.resetLink.copied")}
          copyLabel={t("admin.accounts.resetLink.copy")}
          label={t("admin.accounts.resetLink.label")}
          note={t("admin.accounts.resetLink.note", { name: account.displayName })}
          onAcknowledgedChange={setAcknowledged}
          values={[link]}
        />
        <div className="flex justify-end">
          <Button disabled={!acknowledged} onClick={onClose}>
            {t("admin.accounts.resetLink.done")}
          </Button>
        </div>
      </div>
    </FormOverlay>
  );
}
