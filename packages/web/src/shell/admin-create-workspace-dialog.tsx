import { Button, Input } from "@slugbase/ui";
import { Banner, FormField, FormOverlay, Picker, SegmentedChoice, feedbackToast, type PickerOption } from "@slugbase/ui/patterns";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useEffect, useRef, useState, type ReactElement, type SyntheticEvent } from "react";
import { useTranslation } from "react-i18next";
import { ME_QUERY_KEY, type Me } from "../account/me.ts";
import { isSessionEnded } from "../api/client.ts";
import { ADMIN_ACCOUNTS_QUERY_KEY, instanceAccountsQuery } from "./admin-accounts.ts";
import { OwnerInvitationLink } from "./admin-owner-invitation-dialog.tsx";
import { useRateLimitMessage } from "./admin-rate-limit.ts";
import { ADMIN_WORKSPACES_QUERY_KEY, createInstanceWorkspace, type CreationRefusal, type InstanceWorkspaceCreated, type OwnerChoice } from "./admin-workspaces.ts";
import { INSTANCE_STATUS_QUERY_KEY } from "./instance-status.ts";
import { WORKSPACES_QUERY_KEY } from "./workspaces.ts";

const NAME_MAX_LENGTH = 64;
const EMAIL_MAX_LENGTH = 320;

const OWNER_MODES = ["account", "invitation"] as const;
type OwnerMode = (typeof OWNER_MODES)[number];
const [ACCOUNT_MODE, INVITATION_MODE] = OWNER_MODES;

/**
 * Creates a workspace for an owner (doc 03 section 12, `form-overlay`): the name, and the owner chosen from the existing accounts with a
 * `picker` or an address that an owner invitation is sent to. The admin does not become a member. Where mail is configured the
 * invitation is mailed and a toast says so; otherwise its link is shown once. The accounts that can be chosen are read when the dialog
 * opens, and a failed read is told in place without closing off the invitation by address.
 */
export function CreateInstanceWorkspaceDialog({ onClose }: { onClose: () => void }): ReactElement {
  const { t } = useTranslation();
  const router = useRouter();
  const queryClient = useQueryClient();
  const api = router.options.context.api;
  const rateLimitMessage = useRateLimitMessage();
  const accounts = useQuery({ ...instanceAccountsQuery(api), staleTime: 0 });
  const controller = useRef<AbortController | null>(null);
  const [name, setName] = useState("");
  const [mode, setMode] = useState<OwnerMode>(ACCOUNT_MODE);
  const [accountId, setAccountId] = useState<string | undefined>(undefined);
  const [email, setEmail] = useState("");
  const [missing, setMissing] = useState<"name" | "owner" | undefined>(undefined);
  const [failure, setFailure] = useState<CreationRefusal | "unavailable" | undefined>(undefined);
  const [pending, setPending] = useState(false);
  const [created, setCreated] = useState<InstanceWorkspaceCreated | undefined>(undefined);

  useEffect(
    () => () => {
      controller.current?.abort();
    },
    [],
  );

  const options: readonly PickerOption[] = (accounts.data ?? [])
    .filter((account) => !account.disabled)
    .map((account) => ({ value: account.id, label: account.displayName, description: account.email }));

  async function create(): Promise<void> {
    const trimmed = name.trim();
    const owner: OwnerChoice | undefined =
      mode === ACCOUNT_MODE
        ? accountId === undefined
          ? undefined
          : { kind: "account", accountId }
        : email.trim() === ""
          ? undefined
          : { kind: "invitation", email: email.trim() };
    if (trimmed === "") {
      setMissing("name");
      return;
    }
    if (owner === undefined) {
      setMissing("owner");
      return;
    }
    setMissing(undefined);
    setFailure(undefined);
    setPending(true);
    const own = new AbortController();
    controller.current = own;
    let outcome: Awaited<ReturnType<typeof createInstanceWorkspace>>;
    try {
      outcome = await createInstanceWorkspace(api, trimmed, owner, own.signal);
    } catch (caught) {
      if (!own.signal.aborted) {
        setPending(false);
        setFailure(isSessionEnded(caught) ? undefined : "unavailable");
      }
      return;
    }
    if (own.signal.aborted) {
      return;
    }
    setPending(false);
    if (outcome.status === "refused") {
      setFailure(outcome.refusal);
      if (outcome.refusal.kind === "forbidden") {
        void queryClient.invalidateQueries({ queryKey: ME_QUERY_KEY });
      } else if (outcome.refusal.kind === "unknownAccount") {
        void queryClient.invalidateQueries({ queryKey: ADMIN_ACCOUNTS_QUERY_KEY });
      }
      return;
    }
    const { workspace } = outcome;
    void queryClient.invalidateQueries({ queryKey: ADMIN_WORKSPACES_QUERY_KEY });
    void queryClient.invalidateQueries({ queryKey: INSTANCE_STATUS_QUERY_KEY });
    if (owner.kind === "account" && owner.accountId === queryClient.getQueryData<Me>(ME_QUERY_KEY)?.account.id) {
      void queryClient.invalidateQueries({ queryKey: ME_QUERY_KEY });
      void queryClient.invalidateQueries({ queryKey: WORKSPACES_QUERY_KEY });
    }
    if (workspace.ownerInvitation === null) {
      feedbackToast.success(t("admin.workspaces.create.done", { name: workspace.name }));
      onClose();
    } else if (workspace.ownerInvitation.link === null) {
      feedbackToast.success(t("admin.workspaces.create.doneMailed", { name: workspace.name, email: workspace.ownerInvitation.email }));
      onClose();
    } else {
      setCreated(workspace);
    }
  }

  function submit(event: SyntheticEvent): void {
    event.preventDefault();
    if (!pending) {
      void create();
    }
  }

  function failureMessage(value: CreationRefusal | "unavailable"): string {
    if (value === "unavailable") {
      return t("admin.workspaces.create.error.unavailable");
    }
    switch (value.kind) {
      case "invalidName":
        return t("admin.workspaces.create.error.invalidName");
      case "invalidEmail":
        return t("admin.workspaces.create.error.invalidEmail");
      case "unknownAccount":
        return t("admin.workspaces.create.error.unknownAccount");
      case "invalid":
        return t("admin.workspaces.create.error.invalid");
      case "forbidden":
        return t("admin.workspaces.create.error.forbidden");
      case "rateLimited":
        return rateLimitMessage(value.seconds);
    }
  }

  const fieldFailure = failure !== undefined && failure !== "unavailable" ? failure.kind : undefined;
  const nameError = fieldFailure === "invalidName" ? t("admin.workspaces.create.error.invalidName") : missing === "name" ? t("admin.workspaces.create.name.required") : undefined;
  const ownerError =
    fieldFailure === "unknownAccount"
      ? t("admin.workspaces.create.error.unknownAccount")
      : missing === "owner"
        ? mode === ACCOUNT_MODE
          ? t("admin.workspaces.create.owner.account.required")
          : t("admin.workspaces.create.owner.email.required")
        : undefined;
  const emailError = fieldFailure === "invalidEmail" ? t("admin.workspaces.create.error.invalidEmail") : mode === INVITATION_MODE ? ownerError : undefined;
  const showBanner = failure !== undefined && fieldFailure !== "invalidName" && fieldFailure !== "invalidEmail" && fieldFailure !== "unknownAccount";

  return (
    <FormOverlay
      closeLabel={t("admin.workspaces.create.close")}
      description={created === undefined ? t("admin.workspaces.create.description") : undefined}
      onOpenChange={(open) => {
        if (!open && !pending) {
          onClose();
        }
      }}
      open
      title={t("admin.workspaces.create.title")}
    >
      {created !== undefined && created.ownerInvitation !== null ? (
        <OwnerInvitationLink invitation={created.ownerInvitation} onDone={onClose} workspaceName={created.name} />
      ) : (
        <form className="flex flex-col gap-4" noValidate onSubmit={submit}>
          {showBanner ? <Banner title={failureMessage(failure)} variant="error" /> : null}
          <FormField error={nameError} label={t("admin.workspaces.create.name.label")} name="name">
            <Input
              autoComplete="off"
              disabled={pending}
              maxLength={NAME_MAX_LENGTH}
              onChange={(event) => {
                setName(event.target.value);
                setMissing(undefined);
                if (fieldFailure === "invalidName") {
                  setFailure(undefined);
                }
              }}
              value={name}
            />
          </FormField>
          <SegmentedChoice
            disabled={pending}
            label={t("admin.workspaces.create.owner.label")}
            name="ownerMode"
            onValueChange={(next) => {
              setMode(OWNER_MODES.find((candidate) => candidate === next) ?? ACCOUNT_MODE);
              setMissing(undefined);
              setFailure(undefined);
            }}
            options={[
              { value: ACCOUNT_MODE, label: t("admin.workspaces.create.owner.account.option") },
              { value: INVITATION_MODE, label: t("admin.workspaces.create.owner.email.option") },
            ]}
            value={mode}
          />
          {mode === ACCOUNT_MODE ? (
            accounts.isError ? (
              <Banner
                action={
                  <Button
                    onClick={() => {
                      void accounts.refetch();
                    }}
                    size="sm"
                    type="button"
                    variant="outline"
                  >
                    {t("admin.workspaces.create.owner.account.retry")}
                  </Button>
                }
                description={t("admin.workspaces.create.owner.account.loadFailed.description")}
                title={t("admin.workspaces.create.owner.account.loadFailed.title")}
                variant="error"
              />
            ) : (
              <Picker
                disabled={pending || accounts.data === undefined}
                emptyLabel={t("admin.workspaces.create.owner.account.empty")}
                error={ownerError}
                label={t("admin.workspaces.create.owner.account.label")}
                onValueChange={(next) => {
                  setAccountId(next);
                  setMissing(undefined);
                  if (fieldFailure === "unknownAccount") {
                    setFailure(undefined);
                  }
                }}
                options={options}
                placeholder={accounts.data === undefined ? t("shell.loading") : t("admin.workspaces.create.owner.account.placeholder")}
                value={accountId}
              />
            )
          ) : (
            <FormField description={t("admin.workspaces.create.owner.email.description")} error={emailError} label={t("admin.workspaces.create.owner.email.label")} name="ownerEmail">
              <Input
                autoComplete="off"
                disabled={pending}
                maxLength={EMAIL_MAX_LENGTH}
                onChange={(event) => {
                  setEmail(event.target.value);
                  setMissing(undefined);
                  if (fieldFailure === "invalidEmail") {
                    setFailure(undefined);
                  }
                }}
                type="email"
                value={email}
              />
            </FormField>
          )}
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button disabled={pending} onClick={onClose} type="button" variant="outline">
              {t("admin.workspaces.create.cancel")}
            </Button>
            <Button loading={pending} type="submit">
              {t("admin.workspaces.create.submit")}
            </Button>
          </div>
        </form>
      )}
    </FormOverlay>
  );
}
