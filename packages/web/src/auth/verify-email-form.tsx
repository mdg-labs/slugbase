import { Button } from "@slugbase/ui";
import { Banner } from "@slugbase/ui/patterns";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useEffect, useRef, useState, type ReactElement, type SyntheticEvent } from "react";
import { useTranslation } from "react-i18next";
import { ApiProblemError } from "../api/client.ts";
import { mfaPath } from "./mfa.ts";
import { NewPasswordField, passwordProblemOf, type PasswordProblem } from "./new-password-field.tsx";
import { HOME_PATH } from "./next-path.ts";
import { ResendForm } from "./resend-verification.tsx";
import { tokenFromFragment } from "./verify-token.ts";

const SECONDS_PER_MINUTE = 60;

/** Why the address was not verified, as far as the page tells the visitor. */
type Failure =
  | { readonly kind: "rateLimited"; readonly seconds: number | undefined }
  | { readonly kind: "invalid" }
  | { readonly kind: "unavailable" };

interface Outcome {
  readonly expired: boolean;
  readonly failure: Failure | undefined;
  readonly problem: PasswordProblem | undefined;
}

/** What a verification that failed means for the page (doc 04 section 10.2): an unknown, used or expired token is one answer. */
function outcomeOf(error: unknown): Outcome {
  if (error instanceof ApiProblemError) {
    if (error.status === 410) {
      return { expired: true, failure: undefined, problem: undefined };
    }
    if (error.status === 429) {
      return { expired: false, failure: { kind: "rateLimited", seconds: error.retryAfterSeconds }, problem: undefined };
    }
    if (error.status === 422) {
      const problem = passwordProblemOf(error);
      return { expired: false, failure: problem === undefined ? { kind: "invalid" } : undefined, problem };
    }
  }
  return { expired: false, failure: { kind: "unavailable" }, problem: undefined };
}

function ExpiredLink(): ReactElement {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-4">
      <Banner description={t("verifyEmail.expired.description")} title={t("verifyEmail.expired.title")} variant="warning" />
      <ResendForm />
    </div>
  );
}

/**
 * The page the verification link opens: the link's token comes from the fragment of the address. The visitor chooses
 * the password the account signs in with, because whoever registered an address is not necessarily its owner; the
 * server refuses a weak one before the token is used. On success the account is signed in.
 */
export function VerifyEmailForm(): ReactElement {
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
        return t("verifyEmail.error.invalid");
      case "unavailable":
        return t("verifyEmail.error.unavailable");
      case "rateLimited":
        if (value.seconds === undefined) {
          return t("verifyEmail.error.rateLimited.unknown");
        }
        return value.seconds < SECONDS_PER_MINUTE
          ? t("verifyEmail.error.rateLimited.seconds", { count: value.seconds })
          : t("verifyEmail.error.rateLimited.minutes", { count: Math.ceil(value.seconds / SECONDS_PER_MINUTE) });
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
      const { data, error } = await router.options.context.api.POST("/api/v1/auth/verify-email", {
        body: { token, password },
        signal: controller.signal,
      });
      if (data === undefined) {
        throw new Error("The verification did not answer with a result", { cause: error });
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
      <Button loading={submitting} type="submit">
        {t("verifyEmail.submit")}
      </Button>
    </form>
  );
}
