import { Button, Input } from "@slugbase/ui";
import { Banner, FormField } from "@slugbase/ui/patterns";
import { useEffect, useRef, useState, type ReactElement, type SyntheticEvent } from "react";
import { useTranslation } from "react-i18next";
import type { AcceptOutcome, AcceptRefusal } from "./accept-invitation.ts";
import { NewPasswordField, type PasswordProblem } from "./new-password-field.tsx";

const SECONDS_PER_MINUTE = 60;
const DISPLAY_NAME_MAX_LENGTH = 100;

/** The outcomes the form leaves to the page: the account is made, the link is dead, or an account holds the address. */
export type SignUpSettled = Extract<AcceptOutcome, { status: "joined" | "expired" | "emailTaken" }>;

export interface InvitationSignUpFormProps {
  /** The invited address; the account has this one and the visitor cannot change it. */
  email: string;
  /** Creates the account and accepts the invitation; the form does not know the token. */
  accept: (displayName: string, password: string, signal: AbortSignal) => Promise<AcceptOutcome>;
  /** Called with the outcome when it is not something the form itself explains: the account exists, or the link is dead. */
  onSettled: (outcome: SignUpSettled) => void;
}

/** The short sign-up an invitation to an address without an account leads to: a name and a password, with the address fixed (doc 03 section 1.5). */
export function InvitationSignUpForm({ email, accept, onSettled }: InvitationSignUpFormProps): ReactElement {
  const { t } = useTranslation();
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [nameMissing, setNameMissing] = useState(false);
  const [passwordProblem, setPasswordProblem] = useState<PasswordProblem | undefined>(undefined);
  const [refusal, setRefusal] = useState<AcceptRefusal | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);
  const nameInput = useRef<HTMLInputElement>(null);
  const passwordInput = useRef<HTMLInputElement>(null);
  const request = useRef<AbortController | null>(null);

  useEffect(
    () => () => {
      request.current?.abort();
    },
    [],
  );

  function refusalMessage(value: AcceptRefusal): string {
    switch (value.status) {
      case "refused":
        return t("invite.signUp.error.refused");
      case "seatLimit":
        return t("invite.error.seatLimit");
      case "invalid":
        return t("invite.signUp.error.invalid");
      case "rateLimited":
        if (value.seconds === undefined) {
          return t("invite.error.rateLimited.unknown");
        }
        return value.seconds < SECONDS_PER_MINUTE
          ? t("invite.error.rateLimited.seconds", { count: value.seconds })
          : t("invite.error.rateLimited.minutes", { count: Math.ceil(value.seconds / SECONDS_PER_MINUTE) });
      default:
        return t("invite.signUp.error.unavailable");
    }
  }

  async function submit(event: SyntheticEvent): Promise<void> {
    event.preventDefault();
    if (submitting) {
      return;
    }
    const name = displayName.trim();
    setRefusal(undefined);
    setNameMissing(name === "");
    setPasswordProblem(password === "" ? "required" : undefined);
    if (name === "" || password === "") {
      (name === "" ? nameInput : passwordInput).current?.focus();
      return;
    }
    const controller = new AbortController();
    request.current = controller;
    setSubmitting(true);
    const outcome = await accept(name, password, controller.signal);
    if (controller.signal.aborted) {
      return;
    }
    if (outcome.status === "joined" || outcome.status === "expired" || outcome.status === "emailTaken") {
      onSettled(outcome);
      return;
    }
    setSubmitting(false);
    if (outcome.status === "weakPassword") {
      setPasswordProblem(outcome.problem);
      passwordInput.current?.focus();
      return;
    }
    setRefusal(outcome);
  }

  return (
    <form
      className="flex flex-col gap-4"
      noValidate
      onSubmit={(event) => {
        void submit(event);
      }}
    >
      {refusal === undefined ? null : <Banner title={refusalMessage(refusal)} variant="error" />}
      <FormField error={nameMissing ? t("invite.signUp.name.required") : undefined} label={t("invite.signUp.name.label")} name="displayName">
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
      <FormField description={t("invite.signUp.email.description")} label={t("invite.signUp.email.label")} name="email">
        <Input autoComplete="email" readOnly type="email" value={email} />
      </FormField>
      <NewPasswordField inputRef={passwordInput} onChange={setPassword} problem={passwordProblem} value={password} />
      <Button loading={submitting} type="submit">
        {t("invite.signUp.submit")}
      </Button>
    </form>
  );
}
