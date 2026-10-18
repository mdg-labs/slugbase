import { Button, Input } from "@slugbase/ui";
import { Banner, CheckboxField, FormField, SecretInput } from "@slugbase/ui/patterns";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useRouter } from "@tanstack/react-router";
import { useEffect, useRef, useState, type ReactElement, type SyntheticEvent } from "react";
import { useTranslation } from "react-i18next";
import { ApiProblemError } from "../api/client.ts";
import { mfaPath } from "./mfa.ts";
import { safeNextPath } from "./next-path.ts";
import { ResendButton, ResendStatus, useResendVerification } from "./resend-verification.tsx";

type FieldName = "email" | "password";
type FieldErrors = Partial<Record<FieldName, "required" | "invalid">>;

/** Why a sign-in did not go through, as far as the form tells the visitor. */
type Failure =
  | { readonly kind: "credentials" }
  | { readonly kind: "unverified" }
  | { readonly kind: "rateLimited"; readonly seconds: number | undefined }
  | { readonly kind: "invalid" }
  | { readonly kind: "unavailable" };

const SECONDS_PER_MINUTE = 60;

function fieldErrorsOf(error: ApiProblemError): FieldErrors {
  const fields: FieldErrors = {};
  for (const { path } of error.errors) {
    if (path === "email" || path === "password") {
      fields[path] = "invalid";
    }
  }
  return fields;
}

/** What a sign-in answered with, as the visitor is told it: every wrong credential answers alike (doc 04 section 3.2). */
function failureOf(error: unknown): { failure: Failure; fields: FieldErrors } {
  if (error instanceof ApiProblemError) {
    if (error.status === 401 && error.code === "unauthenticated") {
      return { failure: { kind: "credentials" }, fields: {} };
    }
    if (error.status === 403 && error.code === "email_unverified") {
      return { failure: { kind: "unverified" }, fields: {} };
    }
    if (error.status === 429) {
      return { failure: { kind: "rateLimited", seconds: error.retryAfterSeconds }, fields: {} };
    }
    if (error.status === 422) {
      return { failure: { kind: "invalid" }, fields: fieldErrorsOf(error) };
    }
  }
  return { failure: { kind: "unavailable" }, fields: {} };
}

/** What an account that has not verified its address is told at sign-in (doc 03 section 1.2): to verify, with the way to get the link again. */
function UnverifiedBanner({ email }: { email: string }): ReactElement {
  const { t } = useTranslation();
  const resend = useResendVerification();
  return (
    <Banner
      action={<ResendButton email={email} resend={resend} />}
      description={
        <>
          <p>{t("login.unverified.description")}</p>
          <ResendStatus resend={resend} />
        </>
      }
      title={t("login.unverified.title")}
      variant="warning"
    />
  );
}

/** The sign-in form: email, password and "Remember me". On success it goes to `next` when that is a path of this origin, otherwise home. */
export function LoginForm({ next }: { next: string | undefined }): ReactElement {
  const { t } = useTranslation();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [failure, setFailure] = useState<Failure | undefined>(undefined);
  // The address the failed sign-in was made with, which the verification link is sent to again.
  const [attempted, setAttempted] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const emailInput = useRef<HTMLInputElement>(null);
  const passwordInput = useRef<HTMLInputElement>(null);
  const request = useRef<AbortController | null>(null);

  useEffect(
    () => () => {
      request.current?.abort();
    },
    [],
  );

  function fieldMessage(field: FieldName): string | undefined {
    const error = fieldErrors[field];
    if (error === undefined) {
      return undefined;
    }
    if (field === "email") {
      return error === "required" ? t("login.field.email.required") : t("login.field.email.invalid");
    }
    return error === "required" ? t("login.field.password.required") : t("login.field.password.invalid");
  }

  function failureMessage(value: Failure): string {
    switch (value.kind) {
      case "credentials":
        return t("login.error.credentials");
      case "unverified":
        return t("login.unverified.title");
      case "invalid":
        return t("login.error.invalid");
      case "unavailable":
        return t("login.error.unavailable");
      case "rateLimited":
        if (value.seconds === undefined) {
          return t("login.error.rateLimited.unknown");
        }
        return value.seconds < SECONDS_PER_MINUTE
          ? t("login.error.rateLimited.seconds", { count: value.seconds })
          : t("login.error.rateLimited.minutes", { count: Math.ceil(value.seconds / SECONDS_PER_MINUTE) });
    }
  }

  async function submit(event: SyntheticEvent): Promise<void> {
    event.preventDefault();
    if (submitting) {
      return;
    }
    const address = email.trim();
    const missing: FieldErrors = {
      ...(address === "" ? { email: "required" as const } : {}),
      ...(password === "" ? { password: "required" as const } : {}),
    };
    setFailure(undefined);
    setFieldErrors(missing);
    if (missing.email !== undefined || missing.password !== undefined) {
      (missing.email === undefined ? passwordInput : emailInput).current?.focus();
      return;
    }
    const controller = new AbortController();
    request.current = controller;
    setSubmitting(true);
    let secondFactor = false;
    try {
      const { data, error } = await router.options.context.api.POST("/api/v1/auth/login", {
        body: { email: address, password, remember },
        signal: controller.signal,
      });
      if (error !== undefined) {
        throw new Error("The sign-in did not answer with a problem document", { cause: error });
      }
      secondFactor = data.next === "mfa";
    } catch (caught) {
      if (controller.signal.aborted) {
        return;
      }
      const { failure: reason, fields } = failureOf(caught);
      setAttempted(address);
      setFailure(reason);
      setFieldErrors(fields);
      setSubmitting(false);
      return;
    }
    // What the previous visitor of this browser left in the cache is not for the next one.
    queryClient.clear();
    // A password is right but the account has a second factor: the session is only half signed in until the code is given.
    router.history.replace(secondFactor ? mfaPath(next) : safeNextPath(next));
  }

  const emailError = fieldMessage("email");
  const passwordError = fieldMessage("password");
  return (
    <form
      className="flex flex-col gap-4"
      noValidate
      onSubmit={(event) => {
        void submit(event);
      }}
    >
      {failure === undefined ? null : failure.kind === "unverified" ? (
        <UnverifiedBanner email={attempted} />
      ) : (
        <Banner title={failureMessage(failure)} variant="error" />
      )}
      <FormField error={emailError} label={t("login.email.label")} name="email">
        <Input
          autoComplete="username"
          onChange={(event) => {
            setEmail(event.target.value);
          }}
          ref={emailInput}
          type="email"
          value={email}
        />
      </FormField>
      <FormField error={passwordError} label={t("login.password.label")} name="password">
        <SecretInput
          autoComplete="current-password"
          hideLabel={t("login.password.hide")}
          onChange={(event) => {
            setPassword(event.target.value);
          }}
          ref={passwordInput}
          showLabel={t("login.password.show")}
          value={password}
        />
      </FormField>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <CheckboxField checked={remember} label={t("login.remember")} name="remember" onCheckedChange={setRemember} />
        <Link className="text-muted-foreground text-sm underline underline-offset-4" to="/forgot-password">
          {t("login.forgot")}
        </Link>
      </div>
      <Button loading={submitting} type="submit">
        {t("login.submit")}
      </Button>
    </form>
  );
}
