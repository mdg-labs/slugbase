import { Button, Input } from "@slugbase/ui";
import { Banner, FormField, feedbackToast, Totp } from "@slugbase/ui/patterns";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useEffect, useRef, useState, type ReactElement, type SyntheticEvent } from "react";
import { useTranslation } from "react-i18next";
import { ApiProblemError } from "../api/client.ts";
import { continueTo } from "./continue-to.ts";
import { loginPath } from "./mfa.ts";

const CODE_LENGTH = 6;
const SECONDS_PER_MINUTE = 60;

type Mode = "code" | "backup";

/** What the visitor is doing: giving a code, or leaving the second step. */
type Pending = "verify" | "back";

/** Why a code or the way back did not go through, as far as the form tells the visitor. */
type Failure =
  | { readonly kind: "invalidCode" }
  | { readonly kind: "rejected" }
  | { readonly kind: "rateLimited"; readonly seconds: number | undefined }
  | { readonly kind: "unavailable" }
  | { readonly kind: "backUnavailable" };

function isEnded(error: unknown): boolean {
  return error instanceof ApiProblemError && error.status === 401;
}

/** What a verification answered with, as the visitor is told it: a wrong, replayed or used code answers alike (doc 04 section 4.3). */
function failureOf(error: unknown): Failure {
  if (error instanceof ApiProblemError) {
    if (error.status === 422) {
      return error.code === "invalid_code" ? { kind: "invalidCode" } : { kind: "rejected" };
    }
    if (error.status === 429) {
      return { kind: "rateLimited", seconds: error.retryAfterSeconds };
    }
  }
  return { kind: "unavailable" };
}

/**
 * The second step of the sign-in: the six-digit code of the authenticator app, which is sent as soon as
 * the sixth digit is in, or a backup code. On success it goes to `next` when that is a path of this origin,
 * otherwise home. A pending session that has ended takes the visitor back to sign in.
 */
export function MfaForm({ next }: { next: string | undefined }): ReactElement {
  const { t } = useTranslation();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<Mode>("code");
  const [code, setCode] = useState("");
  const [backupCode, setBackupCode] = useState("");
  const [fieldRequired, setFieldRequired] = useState(false);
  const [failure, setFailure] = useState<Failure | undefined>(undefined);
  const [pending, setPending] = useState<Pending | undefined>(undefined);
  const codeInput = useRef<HTMLInputElement>(null);
  const backupInput = useRef<HTMLInputElement>(null);
  const request = useRef<AbortController | null>(null);
  const running = useRef(false);

  useEffect(
    () => () => {
      request.current?.abort();
    },
    [],
  );

  // The field of the chosen way is ready for typing when the page opens, when the way changes and
  // when a request has ended without leaving the page.
  useEffect(() => {
    if (pending === undefined) {
      (mode === "code" ? codeInput : backupInput).current?.focus();
    }
  }, [mode, pending]);

  function failureMessage(value: Failure): string {
    switch (value.kind) {
      case "invalidCode":
        return t("loginMfa.error.invalidCode");
      case "rejected":
        return t("login.error.invalid");
      case "unavailable":
        return t("loginMfa.error.unavailable");
      case "backUnavailable":
        return t("loginMfa.error.backUnavailable");
      case "rateLimited":
        if (value.seconds === undefined) {
          return t("login.error.rateLimited.unknown");
        }
        return value.seconds < SECONDS_PER_MINUTE
          ? t("login.error.rateLimited.seconds", { count: value.seconds })
          : t("login.error.rateLimited.minutes", { count: Math.ceil(value.seconds / SECONDS_PER_MINUTE) });
    }
  }

  function backToSignIn(): void {
    // Nothing cached belongs to a sign-in that did not finish.
    queryClient.clear();
    router.history.replace(loginPath(next));
  }

  /** Runs one request at a time; `call` answers with a problem document or throws. */
  async function run(kind: Pending, call: (signal: AbortSignal) => Promise<{ error?: unknown }>): Promise<boolean> {
    if (running.current) {
      return false;
    }
    running.current = true;
    const controller = new AbortController();
    request.current = controller;
    setFailure(undefined);
    setFieldRequired(false);
    setPending(kind);
    try {
      const { error } = await call(controller.signal);
      if (error !== undefined) {
        throw new Error("The request did not answer with a problem document", { cause: error });
      }
      return true;
    } catch (caught) {
      if (controller.signal.aborted) {
        return false;
      }
      if (isEnded(caught)) {
        if (kind === "verify") {
          feedbackToast.info(t("loginMfa.expired.title"), t("loginMfa.expired.description"));
        }
        backToSignIn();
        return false;
      }
      setFailure(kind === "back" ? { kind: "backUnavailable" } : failureOf(caught));
      setCode("");
      setPending(undefined);
      return false;
    } finally {
      running.current = false;
    }
  }

  async function verify(body: { code: string } | { backupCode: string }): Promise<void> {
    const done = await run("verify", async (signal) => router.options.context.api.POST("/api/v1/auth/mfa/verify", { body, signal }));
    if (done) {
      // What the previous visitor of this browser left in the cache is not for the next one.
      queryClient.clear();
      continueTo(router.history, next);
    }
  }

  async function back(): Promise<void> {
    if (await run("back", async (signal) => router.options.context.api.POST("/api/v1/auth/logout", { signal }))) {
      backToSignIn();
    }
  }

  async function submit(event: SyntheticEvent): Promise<void> {
    event.preventDefault();
    if (mode === "code") {
      if (code.length < CODE_LENGTH) {
        setFieldRequired(true);
        codeInput.current?.focus();
        return;
      }
      await verify({ code });
      return;
    }
    const entered = backupCode.trim();
    if (entered === "") {
      setFieldRequired(true);
      backupInput.current?.focus();
      return;
    }
    await verify({ backupCode: entered });
  }

  function switchMode(): void {
    setMode(mode === "code" ? "backup" : "code");
    setCode("");
    setBackupCode("");
    setFailure(undefined);
    setFieldRequired(false);
  }

  const busy = pending !== undefined;
  return (
    <form
      className="flex flex-col gap-4"
      noValidate
      onSubmit={(event) => {
        void submit(event);
      }}
    >
      {failure === undefined ? null : <Banner title={failureMessage(failure)} variant="error" />}
      {mode === "code" ? (
        <FormField error={fieldRequired ? t("loginMfa.code.required") : undefined} label={t("loginMfa.code.label")} name="code">
          <Totp
            disabled={busy}
            inputRef={codeInput}
            length={CODE_LENGTH}
            onComplete={(complete) => {
              void verify({ code: complete });
            }}
            onValueChange={(value) => {
              setCode(value);
              setFieldRequired(false);
            }}
            slotLabel={(position, length) => t("loginMfa.code.slot", { position, length })}
            value={code}
          />
        </FormField>
      ) : (
        <FormField error={fieldRequired ? t("loginMfa.backupCode.required") : undefined} label={t("loginMfa.backupCode.label")} name="backupCode">
          <Input
            autoComplete="off"
            disabled={busy}
            onChange={(event) => {
              setBackupCode(event.target.value);
              setFieldRequired(false);
            }}
            ref={backupInput}
            spellCheck={false}
            type="text"
            value={backupCode}
          />
        </FormField>
      )}
      <Button loading={pending === "verify"} type="submit">
        {t("loginMfa.submit")}
      </Button>
      <div className="flex flex-col items-center gap-1">
        <Button disabled={busy} onClick={switchMode} type="button" variant="link">
          {mode === "code" ? t("loginMfa.useBackup") : t("loginMfa.useCode")}
        </Button>
        <Button
          disabled={pending === "verify"}
          loading={pending === "back"}
          onClick={() => {
            void back();
          }}
          type="button"
          variant="link"
        >
          {t("loginMfa.back")}
        </Button>
      </div>
    </form>
  );
}
