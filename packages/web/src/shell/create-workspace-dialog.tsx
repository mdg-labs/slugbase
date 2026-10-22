import { Button, Input } from "@slugbase/ui";
import { Banner, FormField, FormOverlay } from "@slugbase/ui/patterns";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useEffect, useRef, useState, type ReactElement, type SyntheticEvent } from "react";
import { useTranslation } from "react-i18next";
import { ApiProblemError, isSessionEnded } from "../api/client.ts";
import { ENTITLEMENTS_QUERY_KEY, WorkspaceLimitContent } from "../entitlements/index.ts";
import {
  addMembership,
  createWorkspace,
  useSwitchFailureMessage,
  useWorkspaceSwitch,
  type SwitchFailure,
  type WorkspaceSummary,
} from "./workspaces.ts";

const NAME_MAX_LENGTH = 64;
const SECONDS_PER_MINUTE = 60;

/** Why a creation did not go through, as far as the member is told. */
type CreateFailure =
  | { readonly kind: "invalidName" | "unverified" | "notAllowed" | "limitReached" | "unavailable" }
  | { readonly kind: "rateLimited"; readonly seconds: number | undefined };

/** The failure to show for an error; undefined for an ended session, which the app answers as a whole. */
function createFailureOf(error: unknown): CreateFailure | undefined {
  if (isSessionEnded(error)) {
    return undefined;
  }
  if (error instanceof ApiProblemError) {
    if (error.status === 429) {
      return { kind: "rateLimited", seconds: error.retryAfterSeconds };
    }
    // The limit is reached between reading the entitlements and submitting, or in another tab; it comes as a 422 too.
    if (error.code === "workspace_limit_reached") {
      return { kind: "limitReached" };
    }
    if (error.status === 422) {
      return { kind: "invalidName" };
    }
    if (error.code === "email_unverified") {
      return { kind: "unverified" };
    }
    if (error.code === "forbidden") {
      return { kind: "notAllowed" };
    }
  }
  return { kind: "unavailable" };
}

/**
 * Creates a workspace and opens it (doc 03 `form-overlay`, doc 02 section 3.2): the name in a form over the page, then
 * the switch to the new workspace, which is a request of its own. When the creation went through and the switch did
 * not, the workspace exists and the overlay says so and offers the switch again; the account is never shown in a
 * workspace the server did not switch it to. `onCreated` runs once the new workspace is the active one.
 */
export function CreateWorkspaceDialog({ onClose, onCreated }: { onClose: () => void; onCreated?: () => void }): ReactElement {
  const { t } = useTranslation();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { switchTo } = useWorkspaceSwitch();
  const switchFailureMessage = useSwitchFailureMessage();
  const controller = useRef<AbortController | null>(null);
  const [name, setName] = useState("");
  const [nameRequired, setNameRequired] = useState(false);
  const [failure, setFailure] = useState<CreateFailure | undefined>(undefined);
  const [pending, setPending] = useState(false);
  const [created, setCreated] = useState<WorkspaceSummary | undefined>(undefined);
  const [switchFailure, setSwitchFailure] = useState<SwitchFailure | undefined>(undefined);
  const [switchFailed, setSwitchFailed] = useState(false);

  useEffect(
    () => () => {
      controller.current?.abort();
    },
    [],
  );

  async function openCreated(workspace: WorkspaceSummary): Promise<void> {
    setSwitchFailed(false);
    setPending(true);
    const outcome = await switchTo(workspace.id);
    setPending(false);
    if (outcome.status === "skipped") {
      return;
    }
    if (outcome.status === "failed") {
      setSwitchFailure(outcome.failure);
      setSwitchFailed(true);
      return;
    }
    onClose();
    onCreated?.();
  }

  async function create(): Promise<void> {
    const trimmed = name.trim();
    if (trimmed === "") {
      setNameRequired(true);
      return;
    }
    setNameRequired(false);
    setFailure(undefined);
    setPending(true);
    const own = new AbortController();
    controller.current = own;
    let workspace: WorkspaceSummary;
    try {
      workspace = await createWorkspace(router.options.context.api, trimmed, own.signal);
    } catch (caught) {
      if (!own.signal.aborted) {
        setPending(false);
        const next = createFailureOf(caught);
        if (next?.kind === "limitReached") {
          // The entitlements read earlier did not show the limit; the switcher's next open must.
          void queryClient.invalidateQueries({ queryKey: ENTITLEMENTS_QUERY_KEY });
        }
        setFailure(next);
      }
      return;
    }
    addMembership(queryClient, workspace);
    if (own.signal.aborted) {
      return;
    }
    setCreated(workspace);
    await openCreated(workspace);
  }

  function submit(event: SyntheticEvent): void {
    event.preventDefault();
    if (!pending) {
      void create();
    }
  }

  function failureMessage(value: CreateFailure): string {
    switch (value.kind) {
      case "invalidName":
        return t("workspaces.create.error.invalidName");
      case "unverified":
        return t("workspaces.create.error.unverified");
      case "notAllowed":
        return t("workspaces.create.error.notAllowed");
      case "limitReached":
        return t("workspaces.create.error.limitReached");
      case "unavailable":
        return t("workspaces.create.error.unavailable");
      case "rateLimited":
        if (value.seconds === undefined) {
          return t("reauth.error.rateLimited.unknown");
        }
        return value.seconds < SECONDS_PER_MINUTE
          ? t("reauth.error.rateLimited.seconds", { count: value.seconds })
          : t("reauth.error.rateLimited.minutes", { count: Math.ceil(value.seconds / SECONDS_PER_MINUTE) });
    }
  }

  const nameFailure = failure?.kind === "invalidName";
  const limitReached = failure?.kind === "limitReached";
  return (
    <FormOverlay
      closeLabel={t("workspaces.create.close")}
      description={switchFailed || limitReached ? undefined : t("workspaces.create.description")}
      onOpenChange={(open) => {
        if (!open && !pending) {
          onClose();
        }
      }}
      open
      title={t("workspaces.create.title")}
    >
      {limitReached ? (
        <WorkspaceLimitContent onClose={onClose} />
      ) : created !== undefined && switchFailed ? (
        <div className="flex flex-col gap-4">
          <Banner
            description={
              <>
                {t("workspaces.create.created", { name: created.name })}
                {switchFailure === undefined ? null : ` ${switchFailureMessage(switchFailure)}`}
              </>
            }
            title={t("workspaces.create.notOpened")}
            variant="error"
          />
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button disabled={pending} onClick={onClose} type="button" variant="outline">
              {t("workspaces.create.dismiss")}
            </Button>
            <Button
              loading={pending}
              onClick={() => {
                void openCreated(created);
              }}
              type="button"
            >
              {t("workspaces.create.retry")}
            </Button>
          </div>
        </div>
      ) : (
        <form className="flex flex-col gap-4" noValidate onSubmit={submit}>
          {failure === undefined || nameFailure ? null : <Banner title={failureMessage(failure)} variant="error" />}
          <FormField
            error={nameFailure ? failureMessage(failure) : nameRequired ? t("workspaces.create.name.required") : undefined}
            label={t("workspaces.create.name.label")}
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
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button disabled={pending} onClick={onClose} type="button" variant="outline">
              {t("workspaces.create.cancel")}
            </Button>
            <Button loading={pending} type="submit">
              {t("workspaces.create.submit")}
            </Button>
          </div>
        </form>
      )}
    </FormOverlay>
  );
}
