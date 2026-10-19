import { Button } from "@slugbase/ui";
import { EmptyState, feedbackToast, InboxIcon, Loading, TriangleAlertIcon } from "@slugbase/ui/patterns";
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useState, type ReactElement, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { AccountPreferences } from "../account/account-preferences.tsx";
import { meQuery } from "../account/me.ts";
import { useSignOut } from "../auth/sign-out.ts";
import { CreateWorkspaceDialog } from "./create-workspace-dialog.tsx";
import { useSwitchFailureMessage, useWorkspaceSwitch, workspacesQuery } from "./workspaces.ts";

function Frame({ children }: { children: ReactNode }): ReactElement {
  return (
    <AccountPreferences>
      <main className="mx-auto flex min-h-svh max-w-lg flex-col justify-center p-6">{children}</main>
    </AccountPreferences>
  );
}

/**
 * `/no-workspace` (doc 03 section 1.6): the page of an account that acts in no workspace. Where the account can
 * create one it offers to; otherwise it says the account is waiting for an invitation. The account's email and the
 * way to sign out are always there. An account that is a member of workspaces and has none open, which is what a
 * creation whose switch failed leaves behind, is offered those to open.
 */
export function NoWorkspacePage(): ReactElement {
  const { t } = useTranslation();
  const router = useRouter();
  const api = router.options.context.api;
  const me = useQuery({ ...meQuery(api), staleTime: Number.POSITIVE_INFINITY });
  const list = useQuery(workspacesQuery(api));
  const signOut = useSignOut();
  const { pending, switchTo } = useWorkspaceSwitch();
  const switchFailureMessage = useSwitchFailureMessage();
  const [creating, setCreating] = useState(false);

  if (me.isError || list.isError) {
    return (
      <Frame>
        <EmptyState
          actions={
            <>
              <Button
                onClick={() => {
                  void me.refetch();
                  void list.refetch();
                }}
              >
                {t("noWorkspace.retry")}
              </Button>
              <Button onClick={signOut} variant="link">
                {t("shell.signOut")}
              </Button>
            </>
          }
          description={t("noWorkspace.loadFailed.description")}
          headingLevel={1}
          icon={<TriangleAlertIcon aria-hidden="true" />}
          title={t("noWorkspace.loadFailed.title")}
        />
      </Frame>
    );
  }
  if (me.data === undefined || list.data === undefined) {
    return (
      <Frame>
        <Loading label={t("shell.loading")} />
      </Frame>
    );
  }

  const { email } = me.data.account;
  const memberships = me.data.memberships;
  const goHome = (): void => {
    void router.navigate({ to: "/", replace: true });
  };
  const signedInAs = <span className="text-muted-foreground text-sm">{t("noWorkspace.signedInAs", { email })}</span>;
  const signOutLink = (
    <Button onClick={signOut} variant="link">
      {t("shell.signOut")}
    </Button>
  );

  let content: ReactElement;
  if (memberships.length > 0) {
    content = (
      <EmptyState
        actions={
          <>
            {memberships.map(({ workspaceId, name }) => (
              <Button
                disabled={pending}
                key={workspaceId}
                onClick={() => {
                  void switchTo(workspaceId).then((outcome) => {
                    if (outcome.status === "switched") {
                      goHome();
                    } else if (outcome.status === "failed" && outcome.failure !== undefined) {
                      feedbackToast.error(t("workspaces.switch.failed.title"), switchFailureMessage(outcome.failure));
                    }
                  });
                }}
                variant="outline"
              >
                {t("noWorkspace.open", { name })}
              </Button>
            ))}
            {signedInAs}
            {signOutLink}
          </>
        }
        description={t("noWorkspace.choose.description")}
        headingLevel={1}
        icon={<InboxIcon aria-hidden="true" />}
        title={t("noWorkspace.choose.title")}
      />
    );
  } else if (list.data.canCreate) {
    content = (
      <EmptyState
        actions={
          <>
            <Button
              onClick={() => {
                setCreating(true);
              }}
            >
              {t("noWorkspace.create.action")}
            </Button>
            {signedInAs}
            {signOutLink}
          </>
        }
        description={t("noWorkspace.create.description")}
        headingLevel={1}
        icon={<InboxIcon aria-hidden="true" />}
        title={t("noWorkspace.create.title")}
      />
    );
  } else {
    content = (
      <EmptyState
        actions={
          <>
            {signedInAs}
            {signOutLink}
          </>
        }
        description={t("noWorkspace.waiting.description")}
        headingLevel={1}
        icon={<InboxIcon aria-hidden="true" />}
        title={t("noWorkspace.waiting.title")}
      />
    );
  }

  // The dialog stays whatever the page behind it shows: a creation changes the account's workspaces under it.
  return (
    <Frame>
      {content}
      {creating ? (
        <CreateWorkspaceDialog
          onClose={() => {
            setCreating(false);
          }}
          onCreated={goHome}
        />
      ) : null}
    </Frame>
  );
}
