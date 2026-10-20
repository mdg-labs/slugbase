import { Button, Input } from "@slugbase/ui";
import { ChoiceCards, FormField, FormOverlay, InlineNote, StatusBadge, type ChoiceCardOption, type StatusBadgeVariant } from "@slugbase/ui/patterns";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useRef, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { useConfig } from "../../../../config/config-context.tsx";
import {
  INVITATIONS_QUERY_KEY,
  inviteByEmail,
  looksLikeEmail,
  newIdempotencyKey,
  splitAddresses,
  type InvitationRole,
  type InviteOutcome,
  type InviteRefusal,
} from "./-invitations.ts";

interface Result {
  readonly email: string;
  readonly outcome: InviteOutcome;
}

function isRole(value: string): value is InvitationRole {
  return value === "admin" || value === "member";
}

/** Adds the pieces of `text` to `current`: the new, valid ones are accepted without regard to case, the others are returned. */
function take(current: readonly string[], text: string): { readonly accepted: readonly string[]; readonly invalid: readonly string[] } {
  const accepted = [...current];
  const invalid: string[] = [];
  for (const piece of splitAddresses(text)) {
    if (!looksLikeEmail(piece)) {
      invalid.push(piece);
    } else if (!accepted.some((address) => address.toLowerCase() === piece.toLowerCase())) {
      accepted.push(piece);
    }
  }
  return { accepted, invalid };
}

const SEPARATED = /[\s,;]/;

/**
 * Invites people (doc 03 section 11.7): a `form-overlay` with the addresses (several, separated by a comma or Enter),
 * the role as `choice-cards`, and one `POST /invitations` per address, each under its own idempotency key. The answer
 * lists what became of every address, so a part of them that failed is told apart from the rest and can be sent again.
 */
export function InviteDialog({ onClose }: { onClose: () => void }): ReactElement {
  const { t } = useTranslation();
  const router = useRouter();
  const queryClient = useQueryClient();
  const api = router.options.context.api;
  const { features } = useConfig();
  const [addresses, setAddresses] = useState<readonly string[]>([]);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | undefined>(undefined);
  const [role, setRole] = useState<InvitationRole>("member");
  const [results, setResults] = useState<readonly Result[] | undefined>(undefined);
  // A key stands for one address with one role, so sending it again after a lost answer is a replay, not a second invitation.
  const keys = useRef(new Map<string, string>());

  const send = useMutation({
    mutationKey: ["workspace", "invitations", "invite"],
    mutationFn: async ({ emails, as }: { emails: readonly string[]; as: InvitationRole }): Promise<readonly Result[]> => {
      const collected: Result[] = [];
      for (const email of emails) {
        const id = `${as}:${email.toLowerCase()}`;
        const key = keys.current.get(id) ?? newIdempotencyKey();
        keys.current.set(id, key);
        const outcome = await inviteByEmail(api, email, as, key);
        if (outcome.status === "invited") {
          keys.current.delete(id);
        }
        collected.push({ email, outcome });
      }
      return collected;
    },
    onSuccess: (collected) => {
      setResults(collected);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: INVITATIONS_QUERY_KEY });
    },
  });

  function commit(text: string): readonly string[] | undefined {
    const { accepted, invalid } = take(addresses, text);
    setAddresses(accepted);
    if (invalid.length > 0) {
      setDraft(invalid.join(", "));
      setError(t("settings.members.invite.error.invalid", { address: invalid[0] ?? "" }));
      return undefined;
    }
    setDraft("");
    setError(undefined);
    return accepted;
  }

  function submit(): void {
    const accepted = commit(draft);
    if (accepted === undefined) {
      return;
    }
    if (accepted.length === 0) {
      setError(t("settings.members.invite.error.required"));
      return;
    }
    send.mutate({ emails: accepted, as: role });
  }

  function retryable(result: Result): boolean {
    return result.outcome.status === "refused" && result.outcome.refusal !== "alreadyMember";
  }

  function close(): void {
    if (!send.isPending) {
      onClose();
    }
  }

  function refusalMessage(refusal: InviteRefusal): string {
    switch (refusal) {
      case "alreadyMember":
        return t("settings.members.invite.result.alreadyMember");
      case "invalid":
        return t("settings.members.invite.result.invalid");
      case "rateLimited":
        return t("settings.members.invite.result.rateLimited");
      case "unavailable":
        return t("settings.members.invite.result.unavailable");
      case "failed":
        return t("settings.members.invite.result.failed");
    }
  }

  function badgeOf(outcome: InviteOutcome): { readonly variant: StatusBadgeVariant; readonly label: string } {
    if (outcome.status === "invited") {
      return { variant: "success", label: t("settings.members.invite.result.invitedBadge") };
    }
    return outcome.refusal === "alreadyMember"
      ? { variant: "neutral", label: t("settings.members.invite.result.skippedBadge") }
      : { variant: "error", label: t("settings.members.invite.result.failedBadge") };
  }

  const roleOptions: readonly ChoiceCardOption[] = [
    { value: "admin", label: t("settings.members.role.admin"), description: t("settings.members.invite.role.admin") },
    { value: "member", label: t("settings.members.role.member"), description: t("settings.members.invite.role.member") },
  ];

  if (results !== undefined) {
    const invited = results.filter(({ outcome }) => outcome.status === "invited").length;
    const again = results.filter(retryable);
    return (
      <FormOverlay
        closeLabel={t("settings.members.invite.close")}
        description={t("settings.members.invite.result.summary", { invited, total: results.length })}
        onOpenChange={(open) => {
          if (!open) {
            close();
          }
        }}
        open
        title={t("settings.members.invite.result.title")}
      >
        <div className="flex flex-col gap-4">
          <ul aria-label={t("settings.members.invite.result.list")} className="flex flex-col gap-2">
            {results.map((result) => {
              const badge = badgeOf(result.outcome);
              return (
                <li className="flex flex-col gap-1 rounded-lg border p-3" key={result.email}>
                  <span className="flex items-center justify-between gap-2">
                    <span className="min-w-0 break-all font-medium text-sm">{result.email}</span>
                    <StatusBadge variant={badge.variant}>{badge.label}</StatusBadge>
                  </span>
                  <span className="text-muted-foreground text-sm">
                    {result.outcome.status === "invited"
                      ? features.mail
                        ? t("settings.members.invite.result.sent")
                        : t("settings.members.invite.result.created")
                      : refusalMessage(result.outcome.refusal)}
                    {result.outcome.status === "refused" && result.outcome.requestId !== undefined
                      ? ` ${t("settings.members.invite.result.requestId", { requestId: result.outcome.requestId })}`
                      : ""}
                  </span>
                </li>
              );
            })}
          </ul>
          <div className="flex justify-end gap-2">
            {again.length === 0 ? null : (
              <Button
                onClick={() => {
                  setAddresses(again.map(({ email }) => email));
                  setResults(undefined);
                }}
                variant="outline"
              >
                {t("settings.members.invite.result.tryAgain")}
              </Button>
            )}
            <Button onClick={close}>{t("settings.members.invite.result.done")}</Button>
          </div>
        </div>
      </FormOverlay>
    );
  }

  return (
    <FormOverlay
      closeLabel={t("settings.members.invite.close")}
      description={t("settings.members.invite.description")}
      onOpenChange={(open) => {
        if (!open) {
          close();
        }
      }}
      open
      title={t("settings.members.invite.title")}
    >
      <form
        className="flex flex-col gap-4"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        {features.mail ? null : <InlineNote>{t("settings.members.invite.noMail")}</InlineNote>}
        <FormField description={t("settings.members.invite.emails.description")} error={error} label={t("settings.members.invite.emails.label")}>
          <Input
            autoComplete="off"
            disabled={send.isPending}
            onBlur={() => {
              if (draft.trim() !== "") {
                commit(draft);
              }
            }}
            onChange={(event) => {
              const value = event.target.value;
              if (SEPARATED.test(value.trim())) {
                commit(value);
              } else {
                setDraft(value);
                setError(undefined);
              }
            }}
            onKeyDown={(event) => {
              if ((event.key === "Enter" || event.key === ",") && draft.trim() !== "") {
                event.preventDefault();
                commit(draft);
              }
            }}
            placeholder={t("settings.members.invite.emails.placeholder")}
            type="text"
            value={draft}
          />
        </FormField>
        {addresses.length === 0 ? null : (
          <ul aria-label={t("settings.members.invite.addresses")} className="flex flex-wrap gap-2">
            {addresses.map((address) => (
              <li className="flex items-center gap-1 rounded-lg border ps-2" key={address.toLowerCase()}>
                <span className="break-all text-sm">{address}</span>
                <Button
                  aria-label={t("settings.members.invite.removeAddress", { address })}
                  disabled={send.isPending}
                  onClick={() => {
                    setAddresses((current) => current.filter((candidate) => candidate !== address));
                  }}
                  size="xs"
                  variant="ghost"
                >
                  {t("settings.members.invite.remove")}
                </Button>
              </li>
            ))}
          </ul>
        )}
        <ChoiceCards
          disabled={send.isPending}
          label={t("settings.members.invite.role.label")}
          onValueChange={(next) => {
            if (isRole(next)) {
              setRole(next);
            }
          }}
          options={roleOptions}
          value={role}
        />
        <div className="flex justify-end gap-2">
          <Button disabled={send.isPending} onClick={close} type="button" variant="outline">
            {t("settings.members.invite.cancel")}
          </Button>
          <Button loading={send.isPending} type="submit">
            {t("settings.members.invite.submit")}
          </Button>
        </div>
      </form>
    </FormOverlay>
  );
}
