import { Button, Separator } from "@slugbase/ui";
import { Banner, Loading, StatusBadge } from "@slugbase/ui/patterns";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useRouter } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState, type ReactElement, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  acceptAsAccount,
  acceptWithNewAccount,
  inspectInvitation,
  invitationPath,
  lookUpViewer,
  sameAddress,
  type AcceptOutcome,
  type AcceptRefusal,
  type InspectOutcome,
  type InvitationPreview,
  type Viewer,
} from "../auth/accept-invitation.ts";
import { AuthPage } from "../auth/auth-page.tsx";
import { InvitationSignUpForm, type SignUpSettled } from "../auth/invitation-sign-up-form.tsx";
import { LoginForm } from "../auth/login-form.tsx";
import { mfaPath } from "../auth/mfa.ts";
import { HOME_PATH } from "../auth/next-path.ts";
import { LOGIN_INTENT, oidcProvidersOf } from "../auth/oidc.ts";
import { useNoReferrer } from "../auth/no-referrer.ts";
import { ProviderButtons } from "../auth/provider-buttons.tsx";
import { useSignOut } from "../auth/sign-out.ts";
import { useConfig } from "../config/config-context.tsx";

const SECONDS_PER_MINUTE = 60;

type PreviewState = { readonly status: "loading" } | InspectOutcome;
type ViewerState = { readonly status: "loading" } | { readonly status: "unavailable" } | Viewer;

const LOADING = { status: "loading" } as const;
const EXPIRED = { status: "expired" } as const;

function found(preview: InvitationPreview): PreviewState {
  return { status: "found", preview };
}


/** Links of the page never carry the page's address, which holds the token, to the place they lead to. */
const NO_REFERRER = { referrerPolicy: "no-referrer", rel: "noreferrer" } as const;

function useRoleLabel(): (role: InvitationPreview["role"]) => string {
  const { t } = useTranslation();
  return (role) => {
    switch (role) {
      case "owner":
        return t("settings.members.role.owner");
      case "admin":
        return t("settings.members.role.admin");
      case "member":
        return t("settings.members.role.member");
    }
  };
}

function useRateLimitMessage(): (seconds: number | undefined) => string {
  const { t } = useTranslation();
  return (seconds) => {
    if (seconds === undefined) {
      return t("invite.error.rateLimited.unknown");
    }
    return seconds < SECONDS_PER_MINUTE
      ? t("invite.error.rateLimited.seconds", { count: seconds })
      : t("invite.error.rateLimited.minutes", { count: Math.ceil(seconds / SECONDS_PER_MINUTE) });
  };
}

function Page({ title, description, children }: { title: string; description?: string; children: ReactNode }): ReactElement {
  const { product } = useConfig();
  return (
    <AuthPage description={description} productName={product.name} title={title}>
      {children}
    </AuthPage>
  );
}

/** What the invitation is: the workspace, who invited and the role (doc 03 section 1.5). The names are text, never markup. */
function Summary({ preview }: { preview: InvitationPreview }): ReactElement {
  const { t } = useTranslation();
  const roleLabel = useRoleLabel();
  return (
    <dl className="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-2 text-sm">
      <dt className="text-muted-foreground">{t("invite.summary.workspace")}</dt>
      <dd className="min-w-0 break-words font-medium">{preview.workspaceName}</dd>
      {preview.inviterName === null ? null : (
        <>
          <dt className="text-muted-foreground">{t("invite.summary.invitedBy")}</dt>
          <dd className="min-w-0 break-words">{preview.inviterName}</dd>
        </>
      )}
      <dt className="text-muted-foreground">{t("invite.summary.role")}</dt>
      <dd>
        <StatusBadge variant={preview.role === "member" ? "neutral" : "info"}>{roleLabel(preview.role)}</StatusBadge>
      </dd>
    </dl>
  );
}

function RefusalBanner({ refusal, email }: { refusal: AcceptRefusal; email: string }): ReactElement | null {
  const { t } = useTranslation();
  const rateLimitMessage = useRateLimitMessage();
  switch (refusal.status) {
    case "alreadyMember":
      return (
        <Banner
          action={
            <Button render={<Link to={HOME_PATH} {...NO_REFERRER} />} size="sm" variant="outline">
              {t("invite.join.alreadyMember.action")}
            </Button>
          }
          title={t("invite.join.alreadyMember.title")}
          variant="info"
        />
      );
    case "mismatch":
      return <Banner description={t("invite.join.error.mismatch.description", { email })} title={t("invite.join.error.mismatch.title")} variant="error" />;
    case "seatLimit":
      return <Banner title={t("invite.error.seatLimit")} variant="error" />;
    case "rateLimited":
      return <Banner title={rateLimitMessage(refusal.seconds)} variant="error" />;
    case "sessionEnded":
      // The app is taking the visitor to sign in or to the second step.
      return null;
    default:
      return <Banner title={t("invite.join.error.unavailable")} variant="error" />;
  }
}

/** The signed-in account holds the invited address: one button joins. */
function JoinCard({
  preview,
  viewerEmail,
  onJoin,
}: {
  preview: InvitationPreview;
  viewerEmail: string;
  onJoin: () => Promise<AcceptOutcome>;
}): ReactElement {
  const { t } = useTranslation();
  const [joining, setJoining] = useState(false);
  const [refusal, setRefusal] = useState<AcceptRefusal | undefined>(undefined);
  const running = useRef(false);

  async function join(): Promise<void> {
    if (running.current) {
      return;
    }
    running.current = true;
    setRefusal(undefined);
    setJoining(true);
    const outcome = await onJoin();
    running.current = false;
    // A joined or an expired link moves the page on; anything else is told and can be tried again.
    if (outcome.status !== "joined" && outcome.status !== "expired") {
      setJoining(false);
      setRefusal(outcome);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {refusal === undefined ? null : <RefusalBanner email={preview.email} refusal={refusal} />}
      <p className="text-muted-foreground text-sm">{t("invite.join.signedInAs", { email: viewerEmail })}</p>
      <Button
        loading={joining}
        onClick={() => {
          void join();
        }}
      >
        {t("invite.join.action", { workspace: preview.workspaceName })}
      </Button>
    </div>
  );
}

/** The signed-in account is someone else's: say so, and offer to sign out and carry on. */
function MismatchCard({ preview, viewerEmail, onSignOut }: { preview: InvitationPreview; viewerEmail: string; onSignOut: () => void }): ReactElement {
  const { t } = useTranslation();
  return (
    <Banner
      action={
        <Button onClick={onSignOut} size="sm" variant="outline">
          {t("invite.mismatch.action")}
        </Button>
      }
      description={t("invite.mismatch.description", { current: viewerEmail, invited: preview.email })}
      title={t("invite.mismatch.title")}
      variant="warning"
    />
  );
}

/**
 * `/invite/$token` (doc 03 section 1.5, doc 02 section 3.4). The link is read once when the page opens, and so is who
 * is looking; the token goes to the two invitation operations and nowhere else, and the page sends no `Referer`.
 * A dead link, whatever the reason, is one explanation.
 */
export function InvitePage({ token }: { token: string }): ReactElement {
  useNoReferrer();
  const { t } = useTranslation();
  const router = useRouter();
  const queryClient = useQueryClient();
  const config = useConfig();
  const api = router.options.context.api;
  const rateLimitMessage = useRateLimitMessage();
  const [preview, setPreview] = useState<PreviewState>(LOADING);
  const [viewer, setViewer] = useState<ViewerState>(LOADING);
  const alive = useRef(false);
  const started = useRef(false);

  const readPreview = useCallback(async (): Promise<void> => {
    setPreview(LOADING);
    const outcome = await inspectInvitation(api, token);
    if (alive.current) {
      setPreview(outcome);
    }
  }, [api, token]);

  const readViewer = useCallback(async (): Promise<void> => {
    setViewer(LOADING);
    let next: ViewerState;
    try {
      next = await lookUpViewer();
    } catch {
      next = { status: "unavailable" };
    }
    if (alive.current) {
      setViewer(next);
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    // The effect runs twice in development; the token is redeemed against a rate limit, so it is read once.
    if (!started.current) {
      started.current = true;
      void readPreview();
      void readViewer();
    }
    return () => {
      alive.current = false;
    };
  }, [readPreview, readViewer]);

  const secondFactor = viewer.status === "secondFactor";
  useEffect(() => {
    if (secondFactor) {
      // The session passed the password only; the second step returns here.
      router.history.replace(mfaPath(invitationPath(token)));
    }
  }, [router, secondFactor, token]);

  const signOut = useSignOut(
    useCallback(() => {
      setViewer({ status: "anonymous" });
    }, []),
  );

  /** The account is a member now, and the session acts in the workspace: what the cache held is from before. */
  function finish(): void {
    queryClient.clear();
    router.history.replace(HOME_PATH);
  }

  async function joinAsAccount(): Promise<AcceptOutcome> {
    const outcome = await acceptAsAccount(api, token);
    if (!alive.current) {
      return outcome;
    }
    if (outcome.status === "joined") {
      finish();
    } else if (outcome.status === "expired") {
      setPreview(EXPIRED);
    }
    return outcome;
  }

  function settleSignUp(outcome: SignUpSettled, invitation: InvitationPreview): void {
    if (outcome.status === "joined") {
      finish();
    } else if (outcome.status === "expired") {
      setPreview(EXPIRED);
    } else {
      // An account holds the address after all; the sign-in form takes over.
      setPreview(found({ ...invitation, accountExists: true }));
    }
  }

  async function signUp(displayName: string, password: string, signal: AbortSignal): Promise<AcceptOutcome> {
    return acceptWithNewAccount(api, token, displayName, password, signal);
  }

  const title = t("invite.title");

  if (preview.status === "expired") {
    return (
      <Page title={title}>
        <Banner
          action={
            <Button render={<Link to="/login" {...NO_REFERRER} />} size="sm" variant="outline">
              {t("invite.expired.action")}
            </Button>
          }
          description={t("invite.expired.description")}
          title={t("invite.expired.title")}
          variant="warning"
        />
      </Page>
    );
  }
  if (preview.status === "rateLimited" || preview.status === "unavailable" || viewer.status === "unavailable") {
    return (
      <Page title={title}>
        <Banner
          action={
            <Button
              onClick={() => {
                if (preview.status === "rateLimited" || preview.status === "unavailable") {
                  void readPreview();
                }
                if (viewer.status === "unavailable") {
                  void readViewer();
                }
              }}
              size="sm"
              variant="outline"
            >
              {t("invite.error.retry")}
            </Button>
          }
          title={preview.status === "rateLimited" ? rateLimitMessage(preview.seconds) : t("invite.error.unavailable")}
          variant="error"
        />
      </Page>
    );
  }
  if (preview.status === "loading" || viewer.status === "loading" || viewer.status === "secondFactor") {
    return (
      <Page title={title}>
        <Loading label={t("shell.loading")} />
      </Page>
    );
  }

  const invitation = preview.preview;
  const providers = oidcProvidersOf(config);
  let branch: ReactElement;
  if (viewer.status === "account") {
    branch = sameAddress(viewer.email, invitation.email) ? (
      <JoinCard onJoin={joinAsAccount} preview={invitation} viewerEmail={viewer.email} />
    ) : (
      <MismatchCard onSignOut={signOut} preview={invitation} viewerEmail={viewer.email} />
    );
  } else if (invitation.accountExists) {
    branch = (
      <div className="flex flex-col gap-4">
        <p className="text-muted-foreground text-sm">{t("invite.signIn.description", { email: invitation.email })}</p>
        <LoginForm
          initialEmail={invitation.email}
          next={invitationPath(token)}
          onSignedIn={() => {
            void readViewer();
          }}
        />
      </div>
    );
  } else {
    branch = (
      <div className="flex flex-col gap-4">
        <p className="text-muted-foreground text-sm">{t("invite.signUp.description")}</p>
        <InvitationSignUpForm
          accept={signUp}
          email={invitation.email}
          onSettled={(outcome) => {
            settleSignUp(outcome, invitation);
          }}
        />
        {providers.length === 0 ? null : (
          <>
            <div className="flex items-center gap-3 text-muted-foreground text-sm">
              <Separator className="flex-1" />
              <span>{t("login.or")}</span>
              <Separator className="flex-1" />
            </div>
            {/* A provider sign-in starts the ordinary handshake and returns home: the token is not sent along, and joining with a provider is not wired yet. */}
            <ProviderButtons intent={LOGIN_INTENT} label={(name) => t("login.provider", { name })} providers={providers} returnTo={HOME_PATH} />
          </>
        )}
      </div>
    );
  }

  return (
    <Page description={t("invite.description", { product: config.product.name })} title={title}>
      <div className="flex flex-col gap-6">
        <Summary preview={invitation} />
        {branch}
      </div>
    </Page>
  );
}
