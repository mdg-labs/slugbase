import { Button, Input } from "@slugbase/ui";
import { Banner, FormField } from "@slugbase/ui/patterns";
import { Link, useRouter } from "@tanstack/react-router";
import { useEffect, useRef, useState, type ReactElement, type SyntheticEvent } from "react";
import { useTranslation } from "react-i18next";
import { ApiProblemError } from "../api/client.ts";
import { useConfig } from "../config/config-context.tsx";

const SECONDS_PER_MINUTE = 60;

/** Why the request for a link was not made, as far as the form tells the visitor. */
type Failure =
  | { readonly kind: "invalid" }
  | { readonly kind: "rateLimited"; readonly seconds: number | undefined }
  | { readonly kind: "unavailable" };

/** What a request that failed means for the form (doc 04 section 10.2). */
function failureOf(error: unknown): Failure {
  if (error instanceof ApiProblemError) {
    if (error.status === 422) {
      return { kind: "invalid" };
    }
    if (error.status === 429) {
      return { kind: "rateLimited", seconds: error.retryAfterSeconds };
    }
  }
  return { kind: "unavailable" };
}

function BackToSignIn(): ReactElement {
  const { t } = useTranslation();
  return (
    <p className="text-center text-muted-foreground text-sm">
      <Link className="underline underline-offset-4" to="/login">
        {t("forgotPassword.signIn")}
      </Link>
    </p>
  );
}

/**
 * Asks for a link to reset the password. The answer is alike for every address, so a success says no more than that
 * the request was made. Without mail the server sends nothing, so the page says to ask the instance admin instead of
 * offering the form (doc 02 section 2.5).
 */
export function ForgotPasswordForm(): ReactElement {
  const { t } = useTranslation();
  const router = useRouter();
  const { features } = useConfig();
  const [email, setEmail] = useState("");
  const [missing, setMissing] = useState(false);
  const [failure, setFailure] = useState<Failure | undefined>(undefined);
  const [sent, setSent] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const request = useRef<AbortController | null>(null);

  useEffect(
    () => () => {
      request.current?.abort();
    },
    [],
  );

  function failureMessage(value: Failure): string {
    switch (value.kind) {
      case "invalid":
        return t("forgotPassword.error.invalid");
      case "unavailable":
        return t("forgotPassword.error.unavailable");
      case "rateLimited":
        if (value.seconds === undefined) {
          return t("forgotPassword.error.rateLimited.unknown");
        }
        return value.seconds < SECONDS_PER_MINUTE
          ? t("forgotPassword.error.rateLimited.seconds", { count: value.seconds })
          : t("forgotPassword.error.rateLimited.minutes", { count: Math.ceil(value.seconds / SECONDS_PER_MINUTE) });
    }
  }

  async function submit(event: SyntheticEvent): Promise<void> {
    event.preventDefault();
    if (submitting) {
      return;
    }
    const address = email.trim();
    setFailure(undefined);
    setMissing(address === "");
    if (address === "") {
      input.current?.focus();
      return;
    }
    const controller = new AbortController();
    request.current = controller;
    setSubmitting(true);
    try {
      const { error } = await router.options.context.api.POST("/api/v1/auth/password/forgot", {
        body: { email: address },
        signal: controller.signal,
      });
      if (error !== undefined) {
        throw new Error("The request for a reset link did not answer with a problem document", { cause: error });
      }
    } catch (caught) {
      if (controller.signal.aborted) {
        return;
      }
      setFailure(failureOf(caught));
      setSubmitting(false);
      return;
    }
    setSent(true);
    setSubmitting(false);
  }

  if (!features.mail) {
    return (
      <div className="flex flex-col gap-4">
        <Banner description={t("forgotPassword.noMail.description")} title={t("forgotPassword.noMail.title")} variant="info" />
        <BackToSignIn />
      </div>
    );
  }
  if (sent) {
    return (
      <div className="flex flex-col gap-4">
        <p role="status">{t("forgotPassword.sent")}</p>
        <p className="text-muted-foreground text-sm">{t("forgotPassword.sentHint")}</p>
        <BackToSignIn />
      </div>
    );
  }
  return (
    <form
      className="flex flex-col gap-4"
      noValidate
      onSubmit={(event) => {
        void submit(event);
      }}
    >
      {failure === undefined ? null : <Banner title={failureMessage(failure)} variant="error" />}
      <FormField error={missing ? t("forgotPassword.email.required") : undefined} label={t("forgotPassword.email.label")} name="email">
        <Input
          autoComplete="email"
          onChange={(event) => {
            setEmail(event.target.value);
            setMissing(false);
          }}
          ref={input}
          type="email"
          value={email}
        />
      </FormField>
      <Button loading={submitting} type="submit">
        {t("forgotPassword.submit")}
      </Button>
      <BackToSignIn />
    </form>
  );
}
