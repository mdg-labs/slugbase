import { Button } from "@slugbase/ui";
import {
  Banner,
  Confirm,
  CopyValue,
  DataTable,
  EmptyState,
  FormOverlay,
  Loading,
  RowActions,
  StatusBadge,
  feedbackToast,
  type DataTableColumn,
  type RowAction,
} from "@slugbase/ui/patterns";
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { useConfig } from "../../../../config/config-context.tsx";
import { Slot } from "../../../../extensions/index.ts";
import { useFormat } from "../../../../i18n/use-format.ts";
import { membersQuery } from "../../../../shell/workspace-members.ts";
import { InviteDialog } from "./-invite-dialog.tsx";
import {
  INVITATIONS_QUERY_KEY,
  createInvitationLink,
  invitationsQuery,
  resendInvitation,
  revokeInvitation,
  type InvitationListItem,
} from "./-invitations.ts";

interface IssuedLink {
  readonly email: string;
  readonly link: string;
}

/**
 * The pending invitations of the workspace and the way to invite (doc 03 section 11.7, doc 02 section 3.4): the `invite`
 * form-overlay, the `settings.workspace.members.seats` slot above the table, and per invitation Resend (where the server
 * can send mail), a copyable link and Revoke after a `confirm`. An expired invitation is marked and can be resent or given
 * a link, which renews it.
 */
export function InvitationsSection(): ReactElement {
  const { t } = useTranslation();
  const format = useFormat();
  const router = useRouter();
  const queryClient = useQueryClient();
  const api = router.options.context.api;
  const { features } = useConfig();
  const invitations = useInfiniteQuery(invitationsQuery(api));
  // Only the pages of members the members table has loaded: the names of inviters are not worth a request for every page.
  const members = useInfiniteQuery(membersQuery(api));
  const [inviting, setInviting] = useState(false);
  const [revoking, setRevoking] = useState<InvitationListItem | undefined>(undefined);
  const [issued, setIssued] = useState<IssuedLink | undefined>(undefined);

  function reload(): void {
    void queryClient.invalidateQueries({ queryKey: INVITATIONS_QUERY_KEY });
  }

  const resend = useMutation({
    mutationKey: ["workspace", "invitations", "resend"],
    mutationFn: (invitation: InvitationListItem) => resendInvitation(api, invitation.id),
    onSuccess: (outcome, invitation) => {
      switch (outcome.status) {
        case "sent":
          feedbackToast.success(t("settings.members.invitations.resend.done", { email: invitation.email }));
          break;
        case "gone":
          feedbackToast.info(t("settings.members.invitations.gone"));
          break;
        case "mailUnavailable":
          feedbackToast.error(t("settings.members.invitations.resend.noMail"));
          break;
      }
      reload();
    },
  });

  const makeLink = useMutation({
    mutationKey: ["workspace", "invitations", "link"],
    mutationFn: (invitation: InvitationListItem) => createInvitationLink(api, invitation.id),
    onSuccess: (outcome, invitation) => {
      if (outcome.status === "created") {
        setIssued({ email: invitation.email, link: outcome.link });
      } else {
        feedbackToast.info(t("settings.members.invitations.gone"));
      }
      reload();
    },
  });

  const revoke = useMutation({
    mutationKey: ["workspace", "invitations", "revoke"],
    mutationFn: (invitation: InvitationListItem) => revokeInvitation(api, invitation.id),
    onSuccess: (outcome, invitation) => {
      if (outcome.status === "revoked") {
        feedbackToast.success(t("settings.members.invitations.revoke.done", { email: invitation.email }));
      } else {
        feedbackToast.info(t("settings.members.invitations.gone"));
      }
      setRevoking(undefined);
      reload();
    },
  });

  const items = invitations.data?.pages.flatMap((page) => page.items) ?? [];
  const dateTime = (value: string): string => format.date(new Date(value), { dateStyle: "medium", timeStyle: "short" });

  function invitedBy(invitation: InvitationListItem): string {
    if (invitation.invitedBy === null) {
      return t("settings.members.invitations.invitedBy.deleted");
    }
    const member = members.data?.pages.flatMap((page) => page.items).find(({ accountId }) => accountId === invitation.invitedBy);
    if (member !== undefined) {
      return member.displayName;
    }
    return members.isSuccess && !members.hasNextPage ? t("settings.members.invitations.invitedBy.former") : t("settings.members.invitations.invitedBy.unknown");
  }

  function actionsOf(invitation: InvitationListItem): readonly RowAction[] {
    const resendAction: readonly RowAction[] = features.mail
      ? [
          {
            id: "resend",
            label: t("settings.members.invitations.action.resend"),
            disabled: resend.isPending,
            onSelect: () => {
              resend.mutate(invitation);
            },
          },
        ]
      : [];
    return [
      ...resendAction,
      {
        id: "link",
        label: t("settings.members.invitations.action.link"),
        disabled: makeLink.isPending,
        onSelect: () => {
          makeLink.mutate(invitation);
        },
      },
      {
        id: "revoke",
        label: t("settings.members.invitations.action.revoke"),
        destructive: true,
        onSelect: () => {
          setRevoking(invitation);
        },
      },
    ];
  }

  const columns: readonly DataTableColumn<InvitationListItem>[] = [
    { id: "email", header: t("settings.members.invitations.column.email"), cell: (invitation) => <span className="font-medium">{invitation.email}</span> },
    {
      id: "role",
      header: t("settings.members.invitations.column.role"),
      cell: (invitation) => (
        <StatusBadge variant={invitation.role === "member" ? "neutral" : "info"}>
          {invitation.role === "admin" ? t("settings.members.role.admin") : invitation.role === "owner" ? t("settings.members.role.owner") : t("settings.members.role.member")}
        </StatusBadge>
      ),
    },
    { id: "invitedBy", header: t("settings.members.invitations.column.invitedBy"), cell: invitedBy },
    {
      id: "status",
      header: t("settings.members.invitations.column.status"),
      cell: (invitation) =>
        invitation.expired ? (
          <StatusBadge variant="warning">{t("settings.members.invitations.expired")}</StatusBadge>
        ) : (
          <StatusBadge variant="info">{t("settings.members.invitations.pending")}</StatusBadge>
        ),
    },
    { id: "expires", header: t("settings.members.invitations.column.expires"), cell: (invitation) => dateTime(invitation.expiresAt) },
    {
      id: "actions",
      header: t("settings.members.invitations.column.actions"),
      hideHeader: true,
      className: "text-end",
      cell: (invitation) => <RowActions actions={actionsOf(invitation)} label={t("settings.members.invitations.actionsFor", { email: invitation.email })} />,
    },
  ];

  return (
    <section aria-labelledby="invitations-heading" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h2 className="font-semibold text-lg" id="invitations-heading">
            {t("settings.members.invitations.title")}
          </h2>
          <p className="text-muted-foreground text-sm">{t("settings.members.invitations.description")}</p>
        </div>
        <Button
          onClick={() => {
            setInviting(true);
          }}
        >
          {t("settings.members.invitations.invite")}
        </Button>
      </div>
      <Slot name="settings.workspace.members.seats" />
      {invitations.isPending ? <Loading label={t("settings.members.invitations.loading")} /> : null}
      {invitations.isError ? (
        <Banner
          action={
            <Button
              onClick={() => {
                void invitations.refetch();
              }}
              size="sm"
              variant="outline"
            >
              {t("settings.account.loadFailed.retry")}
            </Button>
          }
          description={t("settings.account.loadFailed.description")}
          title={t("settings.members.invitations.loadFailed.title")}
          variant="error"
        />
      ) : null}
      {invitations.isSuccess && items.length === 0 ? (
        <EmptyState
          description={t("settings.members.invitations.empty.description")}
          headingLevel={3}
          title={t("settings.members.invitations.empty.title")}
        />
      ) : null}
      {items.length === 0 ? null : (
        <>
          <DataTable columns={columns} label={t("settings.members.invitations.title")} rowKey={(invitation) => invitation.id} rows={items} />
          {invitations.hasNextPage ? (
            <div className="flex justify-center">
              <Button
                loading={invitations.isFetchingNextPage}
                onClick={() => {
                  void invitations.fetchNextPage();
                }}
                variant="outline"
              >
                {t("settings.members.loadMore")}
              </Button>
            </div>
          ) : null}
        </>
      )}
      {inviting ? (
        <InviteDialog
          onClose={() => {
            setInviting(false);
          }}
        />
      ) : null}
      {revoking === undefined ? null : (
        <Confirm
          cancelLabel={t("settings.members.invitations.revoke.cancel")}
          confirmLabel={t("settings.members.invitations.revoke.action")}
          description={t("settings.members.invitations.revoke.description", { email: revoking.email })}
          destructive
          loading={revoke.isPending}
          onConfirm={() => {
            revoke.mutate(revoking);
          }}
          onOpenChange={(open) => {
            if (!open) {
              setRevoking(undefined);
            }
          }}
          open
          title={t("settings.members.invitations.revoke.title", { email: revoking.email })}
        />
      )}
      {issued === undefined ? null : (
        <FormOverlay
          closeLabel={t("settings.members.invitations.link.close")}
          description={t("settings.members.invitations.link.description", { email: issued.email })}
          onOpenChange={(open) => {
            if (!open) {
              setIssued(undefined);
            }
          }}
          open
          title={t("settings.members.invitations.link.title")}
        >
          <div className="flex flex-col gap-4">
            <CopyValue
              copiedLabel={t("settings.members.invitations.link.copied")}
              copyLabel={t("settings.members.invitations.link.copy")}
              label={t("settings.members.invitations.link.label")}
              value={issued.link}
            />
            <p className="text-muted-foreground text-sm">{t("settings.members.invitations.link.note")}</p>
            <div className="flex justify-end">
              <Button
                onClick={() => {
                  setIssued(undefined);
                }}
              >
                {t("settings.members.invitations.link.done")}
              </Button>
            </div>
          </div>
        </FormOverlay>
      )}
    </section>
  );
}
