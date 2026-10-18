import { Button, Input } from "@slugbase/ui";
import { Banner, FormField } from "@slugbase/ui/patterns";
import { Link, useRouter } from "@tanstack/react-router";
import { useEffect, useRef, useState, type ReactElement, type SyntheticEvent } from "react";
import { useTranslation } from "react-i18next";
import { ApiProblemError } from "../api/client.ts";
import { Slot, useSlotFilled } from "../extensions/index.ts";
import { NewPasswordField, passwordProblemOf, type PasswordProblem } from "./new-password-field.tsx";

const SECONDS_PER_MINUTE = 60;
const DISPLAY_NAME_MAX_LENGTH = 100;

type FieldName = "displayName" | "email" | "password";
type FieldProblem = "required" | "invalid";
type Problems = { displayName?: FieldProblem; email?: FieldProblem; password?: PasswordProblem };

/** Why a registration did not go through, as far as the form tells the visitor. */
type Failure =
  | { readonly kind: "refused" }
  | { readonly kind: "mailUnavailable" }
  | { readonly kind: "rateLimited"; readonly seconds: number | undefined }
  | { readonly kind: "invalid" }
  | { readonly kind: "unavailable" };

interface Outcome {
  readonly failure: Failure | undefined;
  readonly problems: Problems;
  /** The server says registration is closed: the page shows the card for it instead of the form. */
  readonly closed: boolean;
}

function isField(path: string): path is FieldName {
  return path === "displayName" || path === "email" || path === "password";
}

/** What a registration that failed means for the form (doc 04 section 10.2). */
function outcomeOf(error: unknown): Outcome {
  if (error instanceof ApiProblemError) {
    if (error.status === 403 && error.code === "registration_closed") {
      return { failure: undefined, problems: {}, closed: true };
    }
    if (error.status === 403 && error.code === "registration_refused") {
      return { failure: { kind: "refused" }, problems: {}, closed: false };
    }
    if (error.status === 503 && error.code === "mail_unavailable") {
      return { failure: { kind: "mailUnavailable" }, problems: {}, closed: false };
    }
    if (error.status === 429) {
      return { failure: { kind: "rateLimited", seconds: error.retryAfterSeconds }, problems: {}, closed: false };
    }
    if (error.status === 422) {
      const problems: Problems = {};
      const password = passwordProblemOf(error);
      if (password !== undefined) {
        problems.password = password;
      }
      for (const { path } of error.errors) {
        if (isField(path) && path !== "password") {
          problems[path] = "invalid";
        }
      }
      return Object.keys(problems).length === 0
        ? { failure: { kind: "invalid" }, problems, closed: false }
        : { failure: undefined, problems, closed: false };
    }
  }
  return { failure: { kind: "unavailable" }, problems: {}, closed: false };
}

export interface RegisterFormProps {
  /** Called with the address when the server accepted the registration. */
  onRegistered: (email: string) => void;
  /** Called when the server says that registration is closed, whatever the configuration said. */
  onClosed: () => void;
}

/** The registration form: name, email and password with its strength meter, and the slot `auth.register.footer` under it. */
export function RegisterForm({ onRegistered, onClosed }: RegisterFormProps): ReactElement {
  const { t } = useTranslation();
  const router = useRouter();
  const hasFooter = useSlotFilled("auth.register.footer");
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [problems, setProblems] = useState<Problems>({});
  const [failure, setFailure] = useState<Failure | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);
  const nameInput = useRef<HTMLInputElement>(null);
  const emailInput = useRef<HTMLInputElement>(null);
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
      case "refused":
        return t("register.error.refused");
      case "mailUnavailable":
        return t("register.error.mailUnavailable");
      case "invalid":
        return t("register.error.invalid");
      case "unavailable":
        return t("register.error.unavailable");
      case "rateLimited":
        if (value.seconds === undefined) {
          return t("register.error.rateLimited.unknown");
        }
        return value.seconds < SECONDS_PER_MINUTE
          ? t("register.error.rateLimited.seconds", { count: value.seconds })
          : t("register.error.rateLimited.minutes", { count: Math.ceil(value.seconds / SECONDS_PER_MINUTE) });
    }
  }

  function fieldMessage(field: "displayName" | "email"): string | undefined {
    const problem = problems[field];
    if (problem === undefined) {
      return undefined;
    }
    if (field === "displayName") {
      return problem === "required" ? t("register.name.required") : t("register.name.invalid");
    }
    return problem === "required" ? t("register.email.required") : t("register.email.invalid");
  }

  async function submit(event: SyntheticEvent): Promise<void> {
    event.preventDefault();
    if (submitting) {
      return;
    }
    const name = displayName.trim();
    const address = email.trim();
    const missing: Problems = {
      ...(name === "" ? { displayName: "required" as const } : {}),
      ...(address === "" ? { email: "required" as const } : {}),
      ...(password === "" ? { password: "required" as const } : {}),
    };
    setFailure(undefined);
    setProblems(missing);
    if (Object.keys(missing).length > 0) {
      (missing.displayName === undefined ? (missing.email === undefined ? passwordInput : emailInput) : nameInput).current?.focus();
      return;
    }
    const controller = new AbortController();
    request.current = controller;
    setSubmitting(true);
    try {
      const { error } = await router.options.context.api.POST("/api/v1/auth/register", {
        body: { displayName: name, email: address, password },
        signal: controller.signal,
      });
      if (error !== undefined) {
        throw new Error("The registration did not answer with a problem document", { cause: error });
      }
    } catch (caught) {
      if (controller.signal.aborted) {
        return;
      }
      const outcome = outcomeOf(caught);
      if (outcome.closed) {
        onClosed();
        return;
      }
      setFailure(outcome.failure);
      setProblems(outcome.problems);
      setSubmitting(false);
      return;
    }
    onRegistered(address);
  }

  const nameError = fieldMessage("displayName");
  const emailError = fieldMessage("email");
  return (
    <form
      className="flex flex-col gap-4"
      noValidate
      onSubmit={(event) => {
        void submit(event);
      }}
    >
      {failure === undefined ? null : <Banner title={failureMessage(failure)} variant="error" />}
      <FormField error={nameError} label={t("register.name.label")} name="displayName">
        <Input
          autoComplete="name"
          maxLength={DISPLAY_NAME_MAX_LENGTH}
          onChange={(event) => {
            setDisplayName(event.target.value);
          }}
          ref={nameInput}
          value={displayName}
        />
      </FormField>
      <FormField error={emailError} label={t("register.email.label")} name="email">
        <Input
          autoComplete="email"
          onChange={(event) => {
            setEmail(event.target.value);
          }}
          ref={emailInput}
          type="email"
          value={email}
        />
      </FormField>
      <NewPasswordField inputRef={passwordInput} onChange={setPassword} problem={problems.password} value={password} />
      {hasFooter ? <Slot name="auth.register.footer" /> : null}
      <Button loading={submitting} type="submit">
        {t("register.submit")}
      </Button>
      <p className="text-center text-muted-foreground text-sm">
        <Link className="underline underline-offset-4" to="/login">
          {t("register.signIn")}
        </Link>
      </p>
    </form>
  );
}
