import { Button, Input } from "@slugbase/ui";
import { Banner, FormField, FormOverlay, ShownOnce, feedbackToast } from "@slugbase/ui/patterns";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useEffect, useRef, useState, type ReactElement, type SyntheticEvent } from "react";
import { useTranslation } from "react-i18next";
import { ME_QUERY_KEY } from "../account/me.ts";
import { isSessionEnded } from "../api/client.ts";
import { useFormat } from "../i18n/use-format.ts";
import { ADMIN_WORKSPACES_QUERY_KEY, issueOwnerInvitation, type InstanceOwnerInvitation, type InstanceWorkspace, type InvitationRefusal } from "./admin-workspaces.ts";
import { useRateLimitMessage } from "./admin-rate-limit.ts";

const EMAIL_MAX_LENGTH = 320;

/** The link of an owner invitation that no email carried: shown once, with the address it is for. */
export function OwnerInvitationLink({ workspaceName, invitation, onDone }: { workspaceName: string; invitation: InstanceOwnerInvitation; onDone: () => void }): ReactElement {
  const { t } = useTranslation();
  const format = useFormat();
  const [acknowledged, setAcknowledged] = useState(false);
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm">{t("admin.workspaces.invitation.link.description", { name: workspaceName, email: invitation.email })}</p>
      <ShownOnce
        acknowledgeLabel={t("admin.workspaces.invitation.link.acknowledge")}
        acknowledged={acknowledged}
        copiedLabel={t("admin.workspaces.invitation.link.copied")}
        copyLabel={t("admin.workspaces.invitation.link.copy")}
        label={t("admin.workspaces.invitation.link.label")}
        note={t("admin.workspaces.invitation.link.note", { date: format.date(new Date(invitation.expiresAt), { dateStyle: "medium", timeStyle: "short" }) })}
        onAcknowledgedChange={setAcknowledged}
        values={invitation.link === null ? [] : [invitation.link]}
      />
      <div className="flex justify-end">
        <Button disabled={!acknowledged} onClick={onDone}>
          {t("admin.workspaces.invitation.link.done")}
        </Button>
      </div>
    </div>
  );
}

/**
 * Issues a new owner invitation for a workspace that waits for its first owner (doc 04 section 10.10): the address is optional and
 * defaults to the one of the previous invitation. The call needs a fresh re-authentication, which the API client asks for with the
 * shared prompt; an admin who closes it stays in the dialog, told that nothing was sent. Where mail is configured the link is mailed
 * and a toast says so; otherwise the link is shown once. A workspace that has an owner by now, or an address that is needed
 * and missing, is explained in place.
 */
export function OwnerInvitationDialog({ workspace, onClose }: { workspace: InstanceWorkspace; onClose: () => void }): ReactElement {
  const { t } = useTranslation();
  const router = useRouter();
  const queryClient = useQueryClient();
  const rateLimitMessage = useRateLimitMessage();
  const controller = useRef<AbortController | null>(null);
  const [email, setEmail] = useState("");
  const [refusal, setRefusal] = useState<InvitationRefusal | "unavailable" | undefined>(undefined);
  const [pending, setPending] = useState(false);
  const [issued, setIssued] = useState<InstanceOwnerInvitation | undefined>(undefined);

  useEffect(
    () => () => {
      controller.current?.abort();
    },
    [],
  );

  async function issue(): Promise<void> {
    setRefusal(undefined);
    setPending(true);
    const own = new AbortController();
    controller.current = own;
    const trimmed = email.trim();
    let outcome: Awaited<ReturnType<typeof issueOwnerInvitation>>;
    try {
      outcome = await issueOwnerInvitation(router.options.context.api, workspace.id, trimmed === "" ? undefined : trimmed, own.signal);
    } catch (caught) {
      if (!own.signal.aborted) {
        setPending(false);
        setRefusal(isSessionEnded(caught) ? undefined : "unavailable");
      }
      return;
    }
    if (own.signal.aborted) {
      return;
    }
    setPending(false);
    if (outcome.status === "refused") {
      setRefusal(outcome.refusal);
      if (outcome.refusal.kind === "forbidden") {
        void queryClient.invalidateQueries({ queryKey: ME_QUERY_KEY });
      } else if (outcome.refusal.kind === "hasOwner" || outcome.refusal.kind === "gone") {
        void queryClient.invalidateQueries({ queryKey: ADMIN_WORKSPACES_QUERY_KEY });
      }
      return;
    }
    if (outcome.invitation.link === null) {
      feedbackToast.success(t("admin.workspaces.invitation.mailed", { email: outcome.invitation.email }));
      onClose();
      return;
    }
    setIssued(outcome.invitation);
  }

  function submit(event: SyntheticEvent): void {
    event.preventDefault();
    if (!pending) {
      void issue();
    }
  }

  function refusalMessage(value: InvitationRefusal | "unavailable"): string {
    if (value === "unavailable") {
      return t("admin.workspaces.invitation.error.unavailable");
    }
    switch (value.kind) {
      case "reauthRequired":
        return t("admin.workspaces.invitation.error.reauthCancelled");
      case "forbidden":
        return t("admin.workspaces.invitation.error.forbidden");
      case "gone":
        return t("admin.workspaces.invitation.error.gone");
      case "hasOwner":
        return t("admin.workspaces.invitation.error.hasOwner");
      case "emailRequired":
        return t("admin.workspaces.invitation.error.emailRequired");
      case "invalidEmail":
        return t("admin.workspaces.invitation.error.invalidEmail");
      case "rateLimited":
        return rateLimitMessage(value.seconds);
    }
  }

  const emailFailure = refusal !== undefined && refusal !== "unavailable" && (refusal.kind === "emailRequired" || refusal.kind === "invalidEmail");
  return (
    <FormOverlay
      closeLabel={t("admin.workspaces.invitation.close")}
      description={issued === undefined ? t("admin.workspaces.invitation.description", { name: workspace.name }) : undefined}
      onOpenChange={(open) => {
        if (!open && !pending) {
          onClose();
        }
      }}
      open
      title={t("admin.workspaces.invitation.title", { name: workspace.name })}
    >
      {issued === undefined ? (
        <form className="flex flex-col gap-4" noValidate onSubmit={submit}>
          {refusal === undefined || emailFailure ? null : <Banner title={refusalMessage(refusal)} variant="error" />}
          <FormField
            description={t("admin.workspaces.invitation.email.description")}
            error={emailFailure ? refusalMessage(refusal) : undefined}
            label={t("admin.workspaces.invitation.email.label")}
            name="ownerEmail"
          >
            <Input
              autoComplete="off"
              disabled={pending}
              maxLength={EMAIL_MAX_LENGTH}
              onChange={(event) => {
                setEmail(event.target.value);
                if (emailFailure) {
                  setRefusal(undefined);
                }
              }}
              type="email"
              value={email}
            />
          </FormField>
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button disabled={pending} onClick={onClose} type="button" variant="outline">
              {t("admin.workspaces.invitation.cancel")}
            </Button>
            <Button loading={pending} type="submit">
              {t("admin.workspaces.invitation.submit")}
            </Button>
          </div>
        </form>
      ) : (
        <OwnerInvitationLink invitation={issued} onDone={onClose} workspaceName={workspace.name} />
      )}
    </FormOverlay>
  );
}
