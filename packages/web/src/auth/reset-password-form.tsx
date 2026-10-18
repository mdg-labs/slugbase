import { Button } from "@slugbase/ui";
import { Banner } from "@slugbase/ui/patterns";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useRouter } from "@tanstack/react-router";
import { useEffect, useRef, useState, type ReactElement, type SyntheticEvent } from "react";
import { useTranslation } from "react-i18next";
import { ApiProblemError } from "../api/client.ts";
import { mfaPath } from "./mfa.ts";
import { NewPasswordField, passwordProblemOf, type PasswordProblem } from "./new-password-field.tsx";
import { HOME_PATH } from "./next-path.ts";
import { tokenFromFragment } from "./verify-token.ts";

const SECONDS_PER_MINUTE = 60;

/** Why the password was not reset, as far as the page tells the visitor. */
type Failure =
  | { readonly kind: "rateLimited"; readonly seconds: number | undefined }
  | { readonly kind: "invalid" }
  | { readonly kind: "unavailable" };

interface Outcome {
  readonly expired: boolean;
  readonly failure: Failure | undefined;
  readonly problem: PasswordProblem | undefined;
}

/** What a reset that failed means for the page (doc 04 section 10.2): an unknown, used, replaced or expired token is one answer. */
function outcomeOf(error: unknown): Outcome {
  if (error instanceof ApiProblemError) {
    if (error.status === 410) {
      return { expired: true, failure: undefined, problem: undefined };
    }
    if (error.status === 429) {
      return { expired: false, failure: { kind: "rateLimited", seconds: error.retryAfterSeconds }, problem: undefined };
    }
    if (error.status === 422) {
      const problem = passwordProblemOf(error, "newPassword");
      return { expired: false, failure: problem === undefined ? { kind: "invalid" } : undefined, problem };
    }
  }
  return { expired: false, failure: { kind: "unavailable" }, problem: undefined };
}

function ExpiredLink(): ReactElement {
  const { t } = useTranslation();
  return (
    <Banner
      action={
        <Button render={<Link to="/forgot-password" />} size="sm" variant="outline">
          {t("resetPassword.expired.action")}
        </Button>
      }
      description={t("resetPassword.expired.description")}
      title={t("resetPassword.expired.title")}
      variant="warning"
    />
  );
}

/**
 * The page the reset link opens: the link's token comes from the fragment of the address. The server refuses a weak
 * password before the token is used. On success every earlier session of the account is gone and this browser is
 * signed in, or continues at the second step of the sign-in when the account has a second factor.
 */
export function ResetPasswordForm(): ReactElement {
  const { t } = useTranslation();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [token] = useState(() => tokenFromFragment(globalThis.location.hash));
  const [password, setPassword] = useState("");
  const [problem, setProblem] = useState<PasswordProblem | undefined>(undefined);
  const [failure, setFailure] = useState<Failure | undefined>(undefined);
  const [expired, setExpired] = useState(token === undefined);
  const [submitting, setSubmitting] = useState(false);
  const passwordInput = useRef<HTMLInputElement>(null);
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
        return t("resetPassword.error.invalid");
      case "unavailable":
        return t("resetPassword.error.unavailable");
      case "rateLimited":
        if (value.seconds === undefined) {
          return t("resetPassword.error.rateLimited.unknown");
        }
        return value.seconds < SECONDS_PER_MINUTE
          ? t("resetPassword.error.rateLimited.seconds", { count: value.seconds })
          : t("resetPassword.error.rateLimited.minutes", { count: Math.ceil(value.seconds / SECONDS_PER_MINUTE) });
    }
  }

  async function submit(event: SyntheticEvent): Promise<void> {
    event.preventDefault();
    if (submitting || token === undefined) {
      return;
    }
    setFailure(undefined);
    if (password === "") {
      setProblem("required");
      passwordInput.current?.focus();
      return;
    }
    setProblem(undefined);
    const controller = new AbortController();
    request.current = controller;
    setSubmitting(true);
    let secondFactor = false;
    try {
      const { data, error } = await router.options.context.api.POST("/api/v1/auth/password/reset", {
        body: { token, newPassword: password },
        signal: controller.signal,
      });
      if (data === undefined) {
        throw new Error("The password reset did not answer with a result", { cause: error });
      }
      secondFactor = data.next === "mfa";
    } catch (caught) {
      if (controller.signal.aborted) {
        return;
      }
      const outcome = outcomeOf(caught);
      setExpired(outcome.expired);
      setFailure(outcome.failure);
      setProblem(outcome.problem);
      setSubmitting(false);
      return;
    }
    // What the previous visitor of this browser left in the cache is not for the next one.
    queryClient.clear();
    // The account has a second factor: the session is only half signed in until the code is given.
    router.history.replace(secondFactor ? mfaPath(undefined) : HOME_PATH);
  }

  if (expired) {
    return <ExpiredLink />;
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
      <NewPasswordField
        inputRef={passwordInput}
        onChange={(value) => {
          setPassword(value);
          setProblem(undefined);
        }}
        problem={problem}
        value={password}
      />
      <p className="text-muted-foreground text-sm">{t("resetPassword.sessions")}</p>
      <Button loading={submitting} type="submit">
        {t("resetPassword.submit")}
      </Button>
    </form>
  );
}
