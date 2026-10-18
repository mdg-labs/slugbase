import { Button, Input } from "@slugbase/ui";
import { Banner, FormField, FormOverlay, StatusBadge, feedbackToast } from "@slugbase/ui/patterns";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useState, type ReactElement, type SyntheticEvent } from "react";
import { useTranslation } from "react-i18next";
import {
  cancelPendingEmailChange,
  emailChangeFailureOf,
  requestEmailChange,
  useEmailChangeFailureMessage,
} from "./email-change.ts";
import { ME_QUERY_KEY, withAccount, type Account, type Me } from "./me.ts";

/**
 * The form over the profile that asks for a new address (doc 03 section 11.1). The member's password is asked for by
 * the shared re-authentication prompt when the server wants it. The answer is alike for every address, so the form
 * never says anything about the address beyond what the member typed.
 */
function ChangeEmailForm({ account, onClose }: { account: Account; onClose: () => void }): ReactElement {
  const { t } = useTranslation();
  const router = useRouter();
  const queryClient = useQueryClient();
  const failureMessage = useEmailChangeFailureMessage();
  const [email, setEmail] = useState("");
  const [local, setLocal] = useState<"required" | "same" | undefined>(undefined);

  const request = useMutation({
    mutationKey: ["account", "email", "request"],
    mutationFn: (address: string) => requestEmailChange(router.options.context.api, address),
    onSuccess: (_result, address) => {
      void queryClient.invalidateQueries({ queryKey: ME_QUERY_KEY });
      feedbackToast.success(t("settings.account.email.requested", { email: address }));
      onClose();
    },
  });

  const failure = request.isError ? emailChangeFailureOf(request.error) : undefined;
  const fieldError =
    local === "required"
      ? t("settings.account.email.error.required")
      : local === "same"
        ? t("settings.account.email.error.same")
        : failure?.kind === "invalid"
          ? failureMessage(failure)
          : undefined;

  function submit(event: SyntheticEvent): void {
    event.preventDefault();
    // The overlay is rendered in a portal, but a React event still reaches the profile form it is declared in.
    event.stopPropagation();
    if (request.isPending) {
      return;
    }
    const trimmed = email.trim();
    if (trimmed === "") {
      setLocal("required");
      return;
    }
    if (trimmed.toLowerCase() === account.email.toLowerCase()) {
      setLocal("same");
      return;
    }
    setLocal(undefined);
    request.mutate(trimmed);
  }

  return (
    <FormOverlay
      closeLabel={t("settings.account.email.form.close")}
      description={t("settings.account.email.form.description")}
      onOpenChange={(open) => {
        if (!open && !request.isPending) {
          onClose();
        }
      }}
      open
      title={t("settings.account.email.form.title")}
    >
      <form className="flex flex-col gap-4" noValidate onSubmit={submit}>
        {failure === undefined || failure.kind === "invalid" ? null : <Banner title={failureMessage(failure)} variant="error" />}
        <FormField error={fieldError} label={t("settings.account.email.form.label")} name="newEmail">
          <Input
            autoComplete="email"
            disabled={request.isPending}
            onChange={(event) => {
              setEmail(event.target.value);
              setLocal(undefined);
              request.reset();
            }}
            type="email"
            value={email}
          />
        </FormField>
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button disabled={request.isPending} onClick={onClose} type="button" variant="outline">
            {t("settings.account.email.form.cancel")}
          </Button>
          <Button loading={request.isPending} type="submit">
            {t("settings.account.email.form.submit")}
          </Button>
        </div>
      </form>
    </FormOverlay>
  );
}

/**
 * The email row of the profile (doc 03 section 11.1): the current address, a button that opens the change form and,
 * while a change is pending, the "Pending verification" badge with Resend and Cancel. Resend asks for the pending
 * address again, which replaces the earlier request and its links (doc 02 section 2.6).
 */
export function EmailRow({ account }: { account: Account }): ReactElement {
  const { t } = useTranslation();
  const router = useRouter();
  const queryClient = useQueryClient();
  const failureMessage = useEmailChangeFailureMessage();
  const [changing, setChanging] = useState(false);
  const pendingEmail = account.pendingEmail;

  function report(error: unknown): void {
    const failure = emailChangeFailureOf(error);
    if (failure !== undefined) {
      feedbackToast.error(failureMessage(failure));
    }
  }

  const resend = useMutation({
    mutationKey: ["account", "email", "resend"],
    mutationFn: (address: string) => requestEmailChange(router.options.context.api, address),
    onSuccess: (_result, address) => {
      feedbackToast.success(t("settings.account.email.requested", { email: address }));
    },
    onError: report,
  });

  const cancel = useMutation({
    mutationKey: ["account", "email", "cancel"],
    mutationFn: () => cancelPendingEmailChange(router.options.context.api),
    onSuccess: () => {
      queryClient.setQueryData<Me>(ME_QUERY_KEY, (current) => withAccount(current, { ...account, pendingEmail: null }));
      feedbackToast.success(t("settings.account.email.pending.cancelled"));
    },
    onError: report,
  });

  return (
    <div className="flex flex-col gap-3">
      <FormField description={t("settings.account.email.description")} label={t("settings.account.email.label")} name="email">
        <Input readOnly type="email" value={account.email} />
      </FormField>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          onClick={() => {
            setChanging(true);
          }}
          size="sm"
          type="button"
          variant="outline"
        >
          {t("settings.account.email.change")}
        </Button>
      </div>
      {pendingEmail === null ? null : (
        <div className="flex flex-col gap-2">
          <div>
            <StatusBadge variant="warning">{t("settings.account.email.pending.badge")}</StatusBadge>
          </div>
          <p className="text-muted-foreground text-sm">{t("settings.account.email.pending.description", { email: pendingEmail })}</p>
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={cancel.isPending}
              loading={resend.isPending}
              onClick={() => {
                resend.mutate(pendingEmail);
              }}
              size="sm"
              type="button"
              variant="outline"
            >
              {t("settings.account.email.pending.resend")}
            </Button>
            <Button
              disabled={resend.isPending}
              loading={cancel.isPending}
              onClick={() => {
                cancel.mutate();
              }}
              size="sm"
              type="button"
              variant="outline"
            >
              {t("settings.account.email.pending.cancel")}
            </Button>
          </div>
        </div>
      )}
      {changing ? (
        <ChangeEmailForm
          account={account}
          onClose={() => {
            setChanging(false);
          }}
        />
      ) : null}
    </div>
  );
}
