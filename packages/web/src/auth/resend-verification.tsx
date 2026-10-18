import { Button, Input } from "@slugbase/ui";
import { FormField } from "@slugbase/ui/patterns";
import { useRouter } from "@tanstack/react-router";
import { useEffect, useRef, useState, type ReactElement, type SyntheticEvent } from "react";
import { useTranslation } from "react-i18next";
import { ApiProblemError } from "../api/client.ts";

const MILLISECONDS = 1000;
const SECONDS_PER_MINUTE = 60;

type ResendState =
  | { readonly kind: "idle" }
  | { readonly kind: "sending" }
  | { readonly kind: "sent" }
  | { readonly kind: "invalid" }
  | { readonly kind: "failed" }
  | { readonly kind: "rateLimited"; readonly until: number | undefined };

export interface Resend {
  readonly state: ResendState;
  /** Seconds until the server accepts another request, counted down from its `Retry-After`; 0 when nothing is being waited for. */
  readonly secondsLeft: number;
  readonly send: (email: string) => Promise<void>;
}

/**
 * Asks for the verification link to be sent again (`POST /auth/verify-email/resend`). The answer is alike for every
 * address, so a success says no more than that the request was made. A `429` starts a countdown from its `Retry-After`
 * in which no further request is made.
 */
export function useResendVerification(): Resend {
  const router = useRouter();
  const [state, setState] = useState<ResendState>({ kind: "idle" });
  const [now, setNow] = useState(() => Date.now());
  const request = useRef<AbortController | null>(null);
  const until = state.kind === "rateLimited" ? state.until : undefined;

  useEffect(
    () => () => {
      request.current?.abort();
    },
    [],
  );

  useEffect(() => {
    if (until === undefined) {
      return undefined;
    }
    setNow(Date.now());
    const timer = setInterval(() => {
      const current = Date.now();
      setNow(current);
      if (current >= until) {
        clearInterval(timer);
      }
    }, MILLISECONDS);
    return () => {
      clearInterval(timer);
    };
  }, [until]);

  const secondsLeft = until === undefined ? 0 : Math.max(0, Math.ceil((until - now) / MILLISECONDS));

  async function send(email: string): Promise<void> {
    if (state.kind === "sending" || secondsLeft > 0) {
      return;
    }
    const controller = new AbortController();
    request.current = controller;
    setState({ kind: "sending" });
    try {
      const { error } = await router.options.context.api.POST("/api/v1/auth/verify-email/resend", {
        body: { email },
        signal: controller.signal,
      });
      if (error !== undefined) {
        throw new Error("The resend did not answer with a problem document", { cause: error });
      }
      setState({ kind: "sent" });
    } catch (caught) {
      if (controller.signal.aborted) {
        return;
      }
      if (caught instanceof ApiProblemError && caught.status === 429) {
        setNow(Date.now());
        setState({
          kind: "rateLimited",
          until: caught.retryAfterSeconds === undefined ? undefined : Date.now() + caught.retryAfterSeconds * MILLISECONDS,
        });
      } else if (caught instanceof ApiProblemError && caught.status === 422) {
        setState({ kind: "invalid" });
      } else {
        setState({ kind: "failed" });
      }
    }
  }

  return { state, secondsLeft, send };
}

function clock(seconds: number): string {
  const minutes = Math.floor(seconds / SECONDS_PER_MINUTE);
  return `${String(minutes)}:${String(seconds % SECONDS_PER_MINUTE).padStart(2, "0")}`;
}

export interface ResendButtonProps {
  resend: Resend;
  /** The address the link is sent to when the button is pressed; a submit button leaves the sending to its form. */
  email?: string;
  size?: "sm" | "default";
  variant?: "outline" | "default";
}

/** The button that asks for the link again; while the server's rate limit is being waited out it is disabled and counts down. */
export function ResendButton({ resend, email, size = "sm", variant = "outline" }: ResendButtonProps): ReactElement {
  const { t } = useTranslation();
  const { state, secondsLeft } = resend;
  return (
    <Button
      disabled={secondsLeft > 0}
      loading={state.kind === "sending"}
      onClick={
        email === undefined
          ? undefined
          : () => {
              void resend.send(email);
            }
      }
      size={size}
      type={email === undefined ? "submit" : "button"}
      variant={variant}
    >
      {secondsLeft > 0 ? t("resend.wait", { time: clock(secondsLeft) }) : t("resend.action")}
    </Button>
  );
}

/** What became of the last request, in words; nothing while none was made. */
export function ResendStatus({ resend }: { resend: Resend }): ReactElement | null {
  const { t } = useTranslation();
  const { state, secondsLeft } = resend;
  switch (state.kind) {
    case "sent":
      return <p role="status">{t("resend.sent")}</p>;
    case "invalid":
      return <p role="alert">{t("resend.invalid")}</p>;
    case "failed":
      return <p role="alert">{t("resend.failed")}</p>;
    case "rateLimited":
      return state.until === undefined || secondsLeft > 0 ? <p role="alert">{t("resend.rateLimited")}</p> : null;
    case "idle":
    case "sending":
      return null;
  }
}

/** For a visitor whose address is not known: asks for it, then sends the link again. */
export function ResendForm(): ReactElement {
  const { t } = useTranslation();
  const resend = useResendVerification();
  const [email, setEmail] = useState("");
  const [missing, setMissing] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  function submit(event: SyntheticEvent): void {
    event.preventDefault();
    const address = email.trim();
    setMissing(address === "");
    if (address === "") {
      input.current?.focus();
      return;
    }
    void resend.send(address);
  }

  return (
    <form className="flex flex-col gap-4" noValidate onSubmit={submit}>
      <FormField error={missing ? t("resend.email.required") : undefined} label={t("resend.email.label")} name="email">
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
      <ResendStatus resend={resend} />
      <ResendButton resend={resend} size="default" variant="default" />
    </form>
  );
}
