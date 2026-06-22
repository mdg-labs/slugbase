import { useTranslation } from "react-i18next";
import { getServerApiBaseUrl } from "../../lib/server-api-base-url.js";
import { useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import {
  Form,
  Link,
  useActionData,
  useLoaderData,
  useNavigation,
} from "react-router";
import {
  applyApiSessionCookie,
  redirectAfterFormPost,
} from "../../lib/api-session-cookie.js";
import { getSessionUser } from "../../lib/session-client.js";
import {
  AuthButton,
  AuthHeading,
  AuthInput,
  AuthShell,
  ErrorBanner,
  LockFieldIcon,
  MailFieldIcon,
  UserFieldIcon,
} from "./AuthShell.js";
import { createRouteMeta } from "../../lib/route-meta.js";

const API_BASE_URL = () => getServerApiBaseUrl();

interface InvitationMetadata {
  workspaceId: string;
  workspaceName: string;
  inviterName: string;
  invitedEmail: string;
  role: "ADMIN" | "MEMBER";
  expiresAt: string;
}

type LoaderData =
  | { status: "error"; errorKey: string }
  | {
      status: "ready";
      token: string;
      metadata: InvitationMetadata;
      sessionEmail: string | null;
      emailMismatch: boolean;
    };

type ActionResult = { error: string } | undefined;

function parseInvitationError(res: Response, body: { message?: string | string[] }): string {
  if (res.status === 404) {
    return "invitations.accept.error_not_found";
  }

  if (res.status === 410) {
    const message = Array.isArray(body.message) ? body.message.join(" ") : body.message ?? "";
    if (message.toLowerCase().includes("expired")) {
      return "invitations.accept.error_expired";
    }
    return "invitations.accept.error_already_accepted";
  }

  if (res.status === 409) {
    const message = Array.isArray(body.message) ? body.message.join(" ") : body.message ?? "";
    if (message.toLowerCase().includes("already a member")) {
      return "invitations.accept.error_already_member";
    }
    return "invitations.accept.error_already_accepted";
  }

  if (res.status === 422) {
    return "invitations.accept.error_registration_required";
  }

  return "invitations.accept.error_generic";
}

async function fetchInvitationMetadata(
  token: string,
): Promise<{ ok: true; metadata: InvitationMetadata } | { ok: false; errorKey: string }> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE_URL()}/invitations/${encodeURIComponent(token)}`);
  } catch {
    return { ok: false, errorKey: "invitations.accept.error_generic" };
  }

  if (res.ok) {
    return { ok: true, metadata: (await res.json()) as InvitationMetadata };
  }

  let body: { message?: string | string[] } = {};
  try {
    body = (await res.json()) as { message?: string | string[] };
  } catch {
    // ignore parse errors
  }

  return { ok: false, errorKey: parseInvitationError(res, body) };
}

export async function loader({ params, request }: LoaderFunctionArgs): Promise<LoaderData> {
  const token = params.token ?? "";
  if (!token) {
    return { status: "error", errorKey: "invitations.accept.error_not_found" };
  }

  const metadataResult = await fetchInvitationMetadata(token);
  if (!metadataResult.ok) {
    return { status: "error", errorKey: metadataResult.errorKey };
  }

  const user = await getSessionUser(request);
  const sessionEmail = user?.email ?? null;
  const emailMismatch =
    sessionEmail !== null &&
    sessionEmail.toLowerCase() !== metadataResult.metadata.invitedEmail.toLowerCase();

  return {
    status: "ready",
    token,
    metadata: metadataResult.metadata,
    sessionEmail,
    emailMismatch,
  };
}

export async function action({ request, params }: ActionFunctionArgs): Promise<ActionResult | Response> {
  const token = params.token ?? "";
  if (!token) {
    return { error: "invitations.accept.error_not_found" };
  }

  const formData = await request.formData();
  const intent = formData.get("_intent");

  const body: { name?: string; password?: string } = {};
  if (intent === "register") {
    const rawName = formData.get("name");
    const rawPassword = formData.get("password");
    const name = typeof rawName === "string" ? rawName.trim() : "";
    const password = typeof rawPassword === "string" ? rawPassword : "";

    if (!name) {
      return { error: "invitations.accept.error_name_required" };
    }
    if (password.length < 12) {
      return { error: "invitations.accept.error_password_too_short" };
    }

    body.name = name;
    body.password = password;
  }

  let res: Response;
  try {
    res = await fetch(`${API_BASE_URL()}/invitations/${encodeURIComponent(token)}/accept`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    return { error: "invitations.accept.error_generic" };
  }

  if (!res.ok) {
    let errorBody: { message?: string | string[] } = {};
    try {
      errorBody = (await res.json()) as { message?: string | string[] };
    } catch {
      // ignore parse errors
    }
    return { error: parseInvitationError(res, errorBody) };
  }

  const redirectResponse = redirectAfterFormPost("/");
  applyApiSessionCookie(redirectResponse, res);
  return redirectResponse;
}

export const meta = createRouteMeta("app.page.accept_invitation");

function roleLabelKey(role: InvitationMetadata["role"]): string {
  return role === "ADMIN"
    ? "invitations.accept.role_admin"
    : "invitations.accept.role_member";
}

export default function AcceptInvitationRoute() {
  const { t } = useTranslation();
  const loaderData = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  if (loaderData.status === "error") {
    return (
      <AuthShell>
        <ErrorState errorKey={loaderData.errorKey} t={t} />
      </AuthShell>
    );
  }

  const { metadata, token, sessionEmail, emailMismatch } = loaderData;
  const error = actionData && "error" in actionData ? actionData.error : undefined;
  const loginReturnTo = `/invitations/${token}`;

  if (emailMismatch) {
    return (
      <AuthShell>
        <AuthHeading
          title={t("invitations.accept.title")}
          subtitle={t("invitations.accept.subtitle", {
            workspace: metadata.workspaceName,
            inviter: metadata.inviterName,
          })}
        />
        <ErrorBanner message={t("invitations.accept.error_wrong_account")} />
        <p
          className="text-fg-muted"
          style={{ fontSize: "var(--text-small)", lineHeight: "var(--lh-small)" }}
        >
          {t("invitations.accept.wrong_account_hint")}
        </p>
        <Form method="post" action="/logout" className="mt-sp-6">
          <AuthButton>{t("invitations.accept.sign_out_button")}</AuthButton>
        </Form>
      </AuthShell>
    );
  }

  if (sessionEmail) {
    return (
      <AuthShell>
        <InvitationSummary metadata={metadata} t={t} />
        <Form method="post" className="flex flex-col" style={{ gap: "var(--sp-6)" }} noValidate>
          <input type="hidden" name="_intent" value="accept" />
          {error && <ErrorBanner message={t(error)} />}
          <AuthButton isSubmitting={isSubmitting}>
            {isSubmitting
              ? t("invitations.accept.accept_loading")
              : t("invitations.accept.accept_button")}
          </AuthButton>
        </Form>
      </AuthShell>
    );
  }

  return (
    <AuthShell>
      <InvitationSummary metadata={metadata} t={t} />
      <NewUserAcceptForm
        metadata={metadata}
        error={error}
        isSubmitting={isSubmitting}
        loginReturnTo={loginReturnTo}
        t={t}
      />
    </AuthShell>
  );
}

function InvitationSummary({
  metadata,
  t,
}: {
  metadata: InvitationMetadata;
  t: (key: string, options?: Record<string, string>) => string;
}) {
  return (
    <>
      <AuthHeading
        title={t("invitations.accept.title")}
        subtitle={t("invitations.accept.subtitle", {
          workspace: metadata.workspaceName,
          inviter: metadata.inviterName,
        })}
      />
      <div
        className="mb-sp-6 flex flex-col gap-sp-3 rounded-md border border-[color:var(--border)] bg-raised px-sp-4 py-sp-4"
        style={{ fontSize: "var(--text-small)", lineHeight: "var(--lh-small)" }}
      >
        <div className="flex justify-between gap-sp-4">
          <span className="text-fg-muted">{t("invitations.accept.workspace_label")}</span>
          <span className="font-medium text-fg">{metadata.workspaceName}</span>
        </div>
        <div className="flex justify-between gap-sp-4">
          <span className="text-fg-muted">{t("invitations.accept.email_label")}</span>
          <span className="text-fg" style={{ fontFamily: "var(--font-mono)" }}>
            {metadata.invitedEmail}
          </span>
        </div>
        <div className="flex justify-between gap-sp-4">
          <span className="text-fg-muted">{t("invitations.accept.role_label")}</span>
          <span className="text-fg">{t(roleLabelKey(metadata.role))}</span>
        </div>
      </div>
    </>
  );
}

function NewUserAcceptForm({
  metadata,
  error,
  isSubmitting,
  loginReturnTo,
  t,
}: {
  metadata: InvitationMetadata;
  error: string | undefined;
  isSubmitting: boolean;
  loginReturnTo: string;
  t: (key: string, options?: Record<string, string>) => string;
}) {
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const canSubmit = name.trim().length > 0 && password.length >= 12;

  return (
    <>
      <p
        className="mb-sp-6 text-fg-muted"
        style={{ fontSize: "var(--text-body)", lineHeight: "var(--lh-body)" }}
      >
        {t("invitations.accept.new_user_intro")}
      </p>

      <Form method="post" className="flex flex-col" noValidate style={{ gap: "var(--sp-6)" }}>
        <input type="hidden" name="_intent" value="register" />
        {error && <ErrorBanner message={t(error)} />}

        <div className="flex flex-col" style={{ gap: "var(--sp-3)" }}>
          <label
            htmlFor="invite-email"
            className="font-medium text-fg-muted"
            style={{ fontSize: "var(--text-small)", lineHeight: 1 }}
          >
            {t("invitations.accept.email_label")}
          </label>
          <AuthInput
            id="invite-email"
            name="email"
            type="email"
            value={metadata.invitedEmail}
            readOnly
            leadingIcon={<MailFieldIcon />}
          />
        </div>

        <div className="flex flex-col" style={{ gap: "var(--sp-3)" }}>
          <label
            htmlFor="invite-name"
            className="font-medium text-fg-muted"
            style={{ fontSize: "var(--text-small)", lineHeight: 1 }}
          >
            {t("invitations.accept.name_label")}
          </label>
          <AuthInput
            id="invite-name"
            name="name"
            type="text"
            autoComplete="name"
            required
            value={name}
            onChange={(e) => { setName(e.target.value); }}
            placeholder={t("invitations.accept.name_placeholder")}
            leadingIcon={<UserFieldIcon />}
          />
        </div>

        <div className="flex flex-col" style={{ gap: "var(--sp-3)" }}>
          <label
            htmlFor="invite-password"
            className="font-medium text-fg-muted"
            style={{ fontSize: "var(--text-small)", lineHeight: 1 }}
          >
            {t("invitations.accept.password_label")}
          </label>
          <AuthInput
            id="invite-password"
            name="password"
            type="password"
            autoComplete="new-password"
            required
            value={password}
            onChange={(e) => { setPassword(e.target.value); }}
            placeholder={t("invitations.accept.password_placeholder")}
            leadingIcon={<LockFieldIcon />}
          />
        </div>

        <AuthButton
          isSubmitting={isSubmitting}
          disabled={!canSubmit}
        >
          {isSubmitting
            ? t("invitations.accept.register_loading")
            : t("invitations.accept.register_button")}
        </AuthButton>
      </Form>

      <div
        className="mt-sp-6 border-t border-[color:var(--border-subtle)] pt-sp-6 text-center"
        style={{ fontSize: "var(--text-small)", lineHeight: "var(--lh-small)" }}
      >
        <p className="text-fg-muted">{t("invitations.accept.existing_user_prompt")}</p>
        <Link
          to={`/login?returnTo=${encodeURIComponent(loginReturnTo)}`}
          className="mt-sp-2 inline-block font-medium text-accent-text hover:underline"
        >
          {t("invitations.accept.sign_in_link")}
        </Link>
      </div>
    </>
  );
}

function ErrorState({
  errorKey,
  t,
}: {
  errorKey: string;
  t: (key: string) => string;
}) {
  return (
    <>
      <AuthHeading title={t("invitations.accept.error_title")} />
      <ErrorBanner message={t(errorKey)} />
      <Link
        to="/login"
        className="mt-sp-6 flex w-full items-center justify-center rounded-md border border-[color:var(--border)] bg-raised px-sp-6 py-sp-3 font-medium text-fg transition-colors hover:bg-raised-2"
        style={{ fontSize: "var(--text-body)", lineHeight: "var(--lh-body)" }}
      >
        {t("invitations.accept.back_to_sign_in")}
      </Link>
    </>
  );
}
