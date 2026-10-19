import { Button } from "@slugbase/ui";
import { Banner, ChoiceCards, type ChoiceCardOption, Confirm, FormOverlay, Loading, Picker, feedbackToast } from "@slugbase/ui/patterns";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { useAllMembers } from "./use-all-members.ts";
import {
  MEMBERS_QUERY_KEY,
  defaultRecipient,
  leaveWorkspace,
  recipientsFor,
  removeMember,
  type ContentChoice,
  type EndRefusal,
  type Member,
} from "./workspace-members.ts";
import { leaveWorkspaceView } from "./workspace-departure.ts";
import { WORKSPACE_QUERY_KEY } from "./workspace.ts";
import { WORKSPACES_QUERY_KEY } from "./workspaces.ts";

/** Who departs: a member an admin or owner removes, or the viewer, who leaves. */
export type EndMembershipTarget =
  | { readonly kind: "remove"; readonly member: Member; readonly viewerId: string }
  | { readonly kind: "leave"; readonly viewerId: string; readonly workspaceName: string };

type Content = "transfer" | "delete";

function isContent(value: string): value is Content {
  return value === "transfer" || value === "delete";
}

/**
 * Ends a membership with the content choice (doc 03 sections 11.6 and 11.7, doc 02 section 3.6): `choice-cards` for
 * what happens to the member's bookmarks and folders, a recipient `picker` when they are transferred, then a
 * `confirm` that says in plain words what the member loses. After a removal the lists are loaded again. After the
 * viewer leaves, the account is read again and the app moves to the workspace the server now has them in, or to
 * the page of an account with none.
 */
export function EndMembershipDialog({ target, onClose }: { target: EndMembershipTarget; onClose: () => void }): ReactElement {
  const { t } = useTranslation();
  const router = useRouter();
  const queryClient = useQueryClient();
  const api = router.options.context.api;
  const all = useAllMembers();
  const [content, setContent] = useState<Content>("transfer");
  const [chosenRecipient, setChosenRecipient] = useState<string | undefined>(undefined);
  const [confirming, setConfirming] = useState(false);

  const leaving = target.kind === "leave";
  const departingId = leaving ? target.viewerId : target.member.accountId;
  const candidates = recipientsFor(all.members, departingId);
  const nobodyElse = all.complete && candidates.length === 0;
  const effectiveContent: Content = nobodyElse ? "delete" : content;
  const recipient =
    candidates.find((member) => member.accountId === chosenRecipient) ?? (all.complete ? defaultRecipient(candidates, departingId, target.viewerId) : undefined);
  const ready = effectiveContent === "delete" || recipient !== undefined;

  function refusalMessage(refusal: EndRefusal): string {
    switch (refusal) {
      case "lastOwner":
        return leaving ? t("membership.end.error.lastOwner.leave") : t("membership.end.error.lastOwner.remove");
      case "forbidden":
        return t("membership.end.error.forbidden");
      case "notAMember":
        return t("membership.end.error.notAMember");
      case "recipientGone":
        return t("membership.end.error.recipientGone");
    }
  }

  const end = useMutation({
    mutationKey: ["workspace", "members", "end"],
    mutationFn: (choice: ContentChoice) => (target.kind === "remove" ? removeMember(api, target.member.accountId, choice) : leaveWorkspace(api, choice)),
    onSuccess: async (outcome) => {
      if (outcome.status === "refused") {
        // What the page lists is out of date, or the viewer's standing changed meanwhile.
        void queryClient.invalidateQueries({ queryKey: MEMBERS_QUERY_KEY });
        void queryClient.invalidateQueries({ queryKey: WORKSPACE_QUERY_KEY });
        feedbackToast.error(t("membership.end.error.title"), refusalMessage(outcome.refusal));
        onClose();
        return;
      }
      if (target.kind === "leave") {
        feedbackToast.success(t("settings.workspace.leave.done", { name: target.workspaceName }));
        await leaveWorkspaceView(api, queryClient, router);
        onClose();
        return;
      }
      void queryClient.invalidateQueries({ queryKey: MEMBERS_QUERY_KEY });
      void queryClient.invalidateQueries({ queryKey: WORKSPACE_QUERY_KEY });
      void queryClient.invalidateQueries({ queryKey: WORKSPACES_QUERY_KEY });
      feedbackToast.success(t("settings.members.remove.done", { name: target.member.displayName }));
      onClose();
    },
  });

  function submit(): void {
    if (end.isPending) {
      return;
    }
    if (effectiveContent === "delete") {
      end.mutate({ content: "delete" });
    } else if (recipient !== undefined) {
      end.mutate({ content: "transfer", transferTo: recipient.accountId });
    }
  }

  const name = leaving ? "" : target.member.displayName;
  const consequence = (): string => {
    if (leaving) {
      return effectiveContent === "transfer"
        ? t("settings.workspace.leave.confirm.transfer", { recipient: recipient?.displayName ?? "" })
        : t("settings.workspace.leave.confirm.delete");
    }
    return effectiveContent === "transfer"
      ? t("settings.members.remove.confirm.transfer", { name, recipient: recipient?.displayName ?? "" })
      : t("settings.members.remove.confirm.delete", { name });
  };

  const contentOptions: readonly ChoiceCardOption[] = [
    {
      value: "transfer",
      label: t("membership.end.content.transfer.label"),
      description: nobodyElse ? t("membership.end.content.transfer.nobody") : t("membership.end.content.transfer.description"),
      disabled: nobodyElse,
    },
    { value: "delete", label: t("membership.end.content.delete.label"), description: t("membership.end.content.delete.description") },
  ];

  if (confirming) {
    return (
      <Confirm
        cancelLabel={t("membership.end.cancel")}
        confirmLabel={leaving ? t("settings.workspace.leave.confirm.action") : t("settings.members.remove.confirm.action")}
        description={consequence()}
        destructive
        loading={end.isPending}
        onConfirm={submit}
        onOpenChange={(open) => {
          if (!open) {
            onClose();
          }
        }}
        open
        title={leaving ? t("settings.workspace.leave.confirm.title", { name: target.workspaceName }) : t("settings.members.remove.confirm.title", { name })}
      />
    );
  }

  return (
    <FormOverlay
      closeLabel={t("membership.end.close")}
      description={leaving ? t("settings.workspace.leave.dialog.description") : t("settings.members.remove.dialog.description", { name })}
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
      open
      title={leaving ? t("settings.workspace.leave.dialog.title", { name: target.workspaceName }) : t("settings.members.remove.dialog.title", { name })}
    >
      <form
        className="flex flex-col gap-4"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          if (ready) {
            setConfirming(true);
          }
        }}
      >
        <ChoiceCards
          description={t("membership.end.content.note")}
          label={t("membership.end.content.label")}
          onValueChange={(next) => {
            if (isContent(next)) {
              setContent(next);
            }
          }}
          options={contentOptions}
          value={effectiveContent}
        />
        {effectiveContent === "transfer" ? (
          <>
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
                emptyLabel={t("membership.end.recipient.empty")}
                label={t("membership.end.recipient.label")}
                onValueChange={setChosenRecipient}
                options={candidates.map((member) => ({ value: member.accountId, label: member.displayName, description: member.email }))}
                placeholder={t("membership.end.recipient.placeholder")}
                value={recipient?.accountId}
              />
            ) : all.failed ? null : (
              <Loading label={t("shell.loading")} />
            )}
          </>
        ) : null}
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button onClick={onClose} type="button" variant="outline">
            {t("membership.end.cancel")}
          </Button>
          <Button disabled={!ready} type="submit">
            {t("membership.end.continue")}
          </Button>
        </div>
      </form>
    </FormOverlay>
  );
}
