import { Button, Input } from "@slugbase/ui";
import { Banner, CopyValue, FormField, FormOverlay, SegmentedChoice, SelectField, ShownOnce } from "@slugbase/ui/patterns";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useState, type ReactElement, type SyntheticEvent } from "react";
import { useTranslation } from "react-i18next";
import { useConfig } from "../config/config-context.tsx";
import {
  API_TOKENS_QUERY_KEY,
  createApiToken,
  useTokenFailureMessage,
  useTokenRequest,
  type CreatedApiToken,
  type TokenFailure,
} from "./api-tokens.ts";
import type { Me } from "./me.ts";

const NAME_MAX_LENGTH = 64;
const DEFAULT_EXPIRY = "90";
const TOKEN_PLACEHOLDER = "<your API token>";
const EXPIRIES = { "30": 30, "90": 90, "365": 365, none: null } as const;

type Expiry = keyof typeof EXPIRIES;

/**
 * Creates an API token (doc 03 section 11.3): a form over the page, then the secret in a card that says it is shown
 * once. The member's password is asked for by the shared re-authentication prompt when the server wants it. The
 * secret is held here and nowhere else (never in the query cache) and goes when the overlay is unmounted, which is
 * only possible once the member has said they saved it.
 */
export function CreateApiToken({ me, onClose }: { me: Me; onClose: () => void }): ReactElement {
  const { t } = useTranslation();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { origin } = useConfig();
  const run = useTokenRequest();
  const failureMessage = useTokenFailureMessage();
  const [name, setName] = useState("");
  const [nameRequired, setNameRequired] = useState(false);
  const preselected = me.memberships.find((membership) => membership.workspaceId === me.activeWorkspaceId) ?? me.memberships[0];
  const [workspaceId, setWorkspaceId] = useState(preselected?.workspaceId ?? "");
  const [scope, setScope] = useState<"read" | "read-write">("read");
  const [expiry, setExpiry] = useState<Expiry>(DEFAULT_EXPIRY);
  const [failure, setFailure] = useState<TokenFailure | undefined>(undefined);
  const [pending, setPending] = useState(false);
  const [created, setCreated] = useState<CreatedApiToken | undefined>(undefined);
  const [acknowledged, setAcknowledged] = useState(false);

  async function create(): Promise<void> {
    const trimmed = name.trim();
    if (trimmed === "") {
      setNameRequired(true);
      return;
    }
    setNameRequired(false);
    setFailure(undefined);
    setPending(true);
    const outcome = await run((signal) =>
      createApiToken(
        router.options.context.api,
        { name: trimmed, scope, expiresInDays: EXPIRIES[expiry], ...(workspaceId === "" ? {} : { workspaceId }) },
        signal,
      ),
    );
    if (outcome.status === "skipped") {
      return;
    }
    setPending(false);
    if (outcome.status === "failed") {
      setFailure(outcome.failure);
      return;
    }
    setCreated(outcome.value);
    void queryClient.invalidateQueries({ queryKey: API_TOKENS_QUERY_KEY });
  }

  function submit(event: SyntheticEvent): void {
    event.preventDefault();
    if (!pending) {
      void create();
    }
  }

  const scopeOptions = [
    { value: "read", label: t("settings.tokens.scope.read") },
    { value: "read-write", label: t("settings.tokens.scope.readWrite") },
  ];
  const expiryOptions = [
    { value: "30", label: t("settings.tokens.expiry.days", { count: 30 }) },
    { value: "90", label: t("settings.tokens.expiry.days", { count: 90 }) },
    { value: "365", label: t("settings.tokens.expiry.days", { count: 365 }) },
    { value: "none", label: t("settings.tokens.expiry.none") },
  ];

  function chooseScope(value: string): void {
    setScope(value === "read-write" ? "read-write" : "read");
  }

  function chooseExpiry(value: string): void {
    if (value in EXPIRIES) {
      setExpiry(value as Expiry);
    }
  }

  const nameFailure = failure?.kind === "limitReached" || failure?.kind === "nameTaken";
  return (
    <FormOverlay
      closeLabel={t("settings.tokens.close")}
      description={created === undefined ? t("settings.tokens.create.description") : t("settings.tokens.result.description")}
      onOpenChange={(open) => {
        // The secret is not shown again, so it stays until the member has said they saved it.
        if (!open && !pending && (created === undefined || acknowledged)) {
          onClose();
        }
      }}
      open
      title={created === undefined ? t("settings.tokens.create.title") : t("settings.tokens.result.title")}
    >
      {created === undefined ? (
        <form className="flex flex-col gap-4" noValidate onSubmit={submit}>
          {failure === undefined || nameFailure ? null : <Banner title={failureMessage(failure)} variant="error" />}
          <FormField
            description={t("settings.tokens.name.description")}
            error={nameFailure ? failureMessage(failure) : nameRequired ? t("settings.tokens.name.required") : undefined}
            label={t("settings.tokens.name.label")}
            name="name"
          >
            <Input
              autoComplete="off"
              disabled={pending}
              maxLength={NAME_MAX_LENGTH}
              onChange={(event) => {
                setName(event.target.value);
                setNameRequired(false);
                if (nameFailure) {
                  setFailure(undefined);
                }
              }}
              value={name}
            />
          </FormField>
          <SelectField
            disabled={pending}
            label={t("settings.tokens.workspace.label")}
            name="workspace"
            onValueChange={setWorkspaceId}
            options={me.memberships.map((membership) => ({ value: membership.workspaceId, label: membership.name }))}
            value={workspaceId}
          />
          <SegmentedChoice
            description={t("settings.tokens.scope.description")}
            disabled={pending}
            label={t("settings.tokens.scope.label")}
            name="scope"
            onValueChange={chooseScope}
            options={scopeOptions}
            value={scope}
          />
          <SelectField
            disabled={pending}
            label={t("settings.tokens.expiry.label")}
            name="expiry"
            onValueChange={chooseExpiry}
            options={expiryOptions}
            value={expiry}
          />
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button disabled={pending} onClick={onClose} type="button" variant="outline">
              {t("settings.tokens.cancel")}
            </Button>
            <Button loading={pending} type="submit">
              {t("settings.tokens.create.submit")}
            </Button>
          </div>
        </form>
      ) : (
        <div className="flex flex-col gap-4">
          <ShownOnce
            acknowledgeLabel={t("settings.tokens.result.acknowledge")}
            acknowledged={acknowledged}
            copiedLabel={t("settings.tokens.copied")}
            copyLabel={t("settings.tokens.result.copy")}
            label={t("settings.tokens.result.label")}
            note={t("settings.tokens.result.note")}
            onAcknowledgedChange={setAcknowledged}
            values={[created.token]}
          />
          <div className="flex flex-col gap-1.5">
            <p className="font-medium text-sm">{t("settings.tokens.result.example.title")}</p>
            <CopyValue
              copiedLabel={t("settings.tokens.copied")}
              copyLabel={t("settings.tokens.result.example.copy")}
              label={t("settings.tokens.result.example.label")}
              value={`curl -H "Authorization: Bearer ${TOKEN_PLACEHOLDER}" ${origin}/api/v1/me`}
            />
          </div>
          <div className="flex justify-end">
            <Button disabled={!acknowledged} onClick={onClose}>
              {t("settings.tokens.done")}
            </Button>
          </div>
        </div>
      )}
    </FormOverlay>
  );
}
