import { Button } from "@slugbase/ui";
import { Banner, Confirm, FormOverlay, Loading, Picker } from "@slugbase/ui/patterns";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { formerContentSummary } from "./former-content-summary.ts";
import { reassignFormerContent, type FormerContentReassigned } from "./former-content.ts";
import { useAllMembers } from "./use-all-members.ts";
import { MEMBERS_QUERY_KEY } from "./workspace-members.ts";

export interface FormerContentReassignDialogProps {
  /** The rows the admin selected, which the dialog gives to the member they pick. */
  readonly bookmarkIds: readonly string[];
  readonly folderIds: readonly string[];
  /** Reads both lists of former members' content again; resolves when they are in. */
  readonly readAgain: () => Promise<void>;
  /** The dialog is dismissed, or a failed request is over; the selection is kept. */
  readonly onClose: () => void;
  /** The content went to `recipientName`; the section clears its selection and says what happened. */
  readonly onReassigned: (reassigned: FormerContentReassigned, recipientName: string) => void;
}

/**
 * Reassigns selected former members' content to a member (doc 03 sections 11.7, doc 02 sections 2.10 and 3.6): a `picker` of the workspace's current members, then a `confirm`
 * that says what the move does. The confirmation stays open, with its wait, until the request and the reading of both lists are done: the mutation's `onSuccess` returns the
 * promise of that reading, and TanStack Query ends the mutation only when it settles. A recipient who has left the workspace meanwhile (the server answers 404 naming `transferTo`) is
 * told in the picker, by name, and the selection is kept; any other failure is reported by the shared toast, and the dialog closes with the selection kept.
 */
export function FormerContentReassignDialog({ bookmarkIds, folderIds, readAgain, onClose, onReassigned }: FormerContentReassignDialogProps): ReactElement {
  const { t } = useTranslation();
  const router = useRouter();
  const queryClient = useQueryClient();
  const api = router.options.context.api;
  const all = useAllMembers();
  const [chosen, setChosen] = useState<string | undefined>(undefined);
  const [confirming, setConfirming] = useState(false);
  // The name of the member the server found gone, shown in the picker until another member is chosen.
  const [gone, setGone] = useState<string | undefined>(undefined);
  const recipient = all.members.find((member) => member.accountId === chosen);
  const summary = formerContentSummary(t, bookmarkIds.length, folderIds.length);

  const reassign = useMutation({
    mutationKey: ["workspace", "former-content", "reassign"],
    mutationFn: (request: { readonly transferTo: string; readonly name: string }) => {
      return reassignFormerContent(api, { bookmarkIds, folderIds, transferTo: request.transferTo });
    },
    // Whatever the outcome, the lists are read again before anything else happens: TanStack Query waits for the promise an `onSuccess` or an `onError` returns before it
    // ends the mutation, so the confirmation keeps showing its wait (`reassign.isPending`) until the request and the reading of both lists are done.
    onSuccess: async (outcome, request) => {
      await readAgain();
      if (outcome.status === "recipientGone") {
        await queryClient.invalidateQueries({ queryKey: MEMBERS_QUERY_KEY });
        setGone(request.name);
        setChosen(undefined);
        setConfirming(false);
        return;
      }
      onReassigned(outcome.reassigned, request.name);
    },
    onError: async () => {
      // The shared toast reports the failure; the selection stays.
      await readAgain();
      onClose();
    },
  });

  function submit(): void {
    if (!reassign.isPending && recipient !== undefined) {
      reassign.mutate({ transferTo: recipient.accountId, name: recipient.displayName });
    }
  }

  if (confirming && recipient !== undefined) {
    return (
      <Confirm
        cancelLabel={t("settings.members.former.reassign.cancel")}
        confirmLabel={t("settings.members.former.reassign.confirm")}
        description={t("settings.members.former.reassign.description", { summary, recipient: recipient.displayName })}
        loading={reassign.isPending}
        onConfirm={submit}
        onOpenChange={(open) => {
          if (!open) {
            onClose();
          }
        }}
        open
        title={t("settings.members.former.reassign.title")}
      />
    );
  }

  return (
    <FormOverlay
      closeLabel={t("settings.members.former.reassign.close")}
      description={t("settings.members.former.reassign.dialog.description", { summary })}
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
      open
      title={t("settings.members.former.reassign.dialog.title")}
    >
      <form
        className="flex flex-col gap-4"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          if (recipient !== undefined) {
            setConfirming(true);
          }
        }}
      >
        {all.failed ? (
          <Banner
            action={
              <Button onClick={all.retry} size="sm" variant="outline">
                {t("settings.account.loadFailed.retry")}
              </Button>
            }
            description={t("settings.account.loadFailed.description")}
            title={t("settings.members.loadFailed.title")}
            variant="error"
          />
        ) : null}
        {all.complete ? (
          <Picker
            emptyLabel={t("settings.members.former.reassign.recipient.empty")}
            error={gone === undefined || recipient !== undefined ? undefined : t("settings.members.former.reassign.recipientGone", { name: gone })}
            label={t("settings.members.former.reassign.recipient.label")}
            onValueChange={(value) => {
              setChosen(value);
              setGone(undefined);
            }}
            options={all.members.map((member) => ({ value: member.accountId, label: member.displayName, description: member.email }))}
            placeholder={t("settings.members.former.reassign.recipient.placeholder")}
            value={recipient?.accountId}
          />
        ) : all.failed ? null : (
          <Loading label={t("shell.loading")} />
        )}
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button onClick={onClose} type="button" variant="outline">
            {t("settings.members.former.reassign.cancel")}
          </Button>
          <Button disabled={recipient === undefined} type="submit">
            {t("settings.members.former.reassign.continue")}
          </Button>
        </div>
      </form>
    </FormOverlay>
  );
}
