import { Button } from "@slugbase/ui";
import { Banner, FormField, FormOverlay, SecretInput, Totp } from "@slugbase/ui/patterns";
import { useRef, useState, useSyncExternalStore, type ReactElement, type SyntheticEvent } from "react";
import { useTranslation } from "react-i18next";
import { ApiProblemError, isSessionEnded, type ApiClient } from "../api/client.ts";
import { useCachedAccount } from "../account/use-cached-account.ts";
import { useConfig } from "../config/config-context.tsx";
import { REAUTH_INTENT, currentReturnTo, oidcProvidersOf } from "./oidc.ts";
import { ProviderButtons } from "./provider-buttons.tsx";
import type { Reauth } from "./reauth.ts";

const SECONDS_PER_MINUTE = 60;
const CODE_LENGTH = 6;

type Failure =
  | { readonly kind: "wrongPassword" }
  | { readonly kind: "invalidCode" }
  | { readonly kind: "codeUnavailable" }
  | { readonly kind: "required" }
  | { readonly kind: "rateLimited"; readonly seconds: number | undefined }
  | { readonly kind: "unavailable" };

function failureOf(error: unknown): Failure {
  if (error instanceof ApiProblemError) {
    if (error.status === 401 && error.code === "reauth_required") {
      return { kind: "wrongPassword" };
    }
    if (error.status === 429) {
      return { kind: "rateLimited", seconds: error.retryAfterSeconds };
    }
    if (error.status === 422) {
      return { kind: "wrongPassword" };
    }
  }
  return { kind: "unavailable" };
}

/**
 * What a code was answered with. The contract answers a wrong, expired, replayed or not-applicable code as
 * `422 invalid_code`, counted against the same limit as the password; a `401` is an ended session, which the
 * caller handles before this.
 */
function codeFailureOf(error: unknown): Failure {
  if (error instanceof ApiProblemError) {
    if (error.status === 429) {
      return { kind: "rateLimited", seconds: error.retryAfterSeconds };
    }
    if (error.status === 422) {
      return { kind: "invalidCode" };
    }
  }
  return { kind: "codeUnavailable" };
}

/** The sentence for a failure of either step, in the language of the page. */
function useFailureMessage(): (failure: Failure) => string {
  const { t } = useTranslation();
  return (value) => {
    switch (value.kind) {
      case "wrongPassword":
        return t("reauth.error.wrongPassword");
      case "invalidCode":
        return t("reauth.error.invalidCode");
      case "codeUnavailable":
        return t("reauth.error.codeUnavailable");
      case "required":
        return t("reauth.error.required");
      case "unavailable":
        return t("reauth.error.unavailable");
      case "rateLimited":
        if (value.seconds === undefined) {
          return t("reauth.error.rateLimited.unknown");
        }
        return value.seconds < SECONDS_PER_MINUTE
          ? t("reauth.error.rateLimited.seconds", { count: value.seconds })
          : t("reauth.error.rateLimited.minutes", { count: Math.ceil(value.seconds / SECONDS_PER_MINUTE) });
    }
  };
}

function PasswordStep({ reauth, api, onUseCode }: { reauth: Reauth; api: ApiClient; onUseCode: (() => void) | undefined }): ReactElement {
  const { t } = useTranslation();
  const message = useFailureMessage();
  const [password, setPassword] = useState("");
  const [failure, setFailure] = useState<Failure | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: SyntheticEvent): Promise<void> {
    event.preventDefault();
    if (submitting) {
      return;
    }
    if (password === "") {
      setFailure({ kind: "required" });
      return;
    }
    setFailure(undefined);
    setSubmitting(true);
    try {
      const { response, error } = await api.POST("/api/v1/me/reauth", { body: { password } });
      if (!response.ok) {
        throw new Error("The re-authentication did not answer with a problem document", { cause: error });
      }
      reauth.settle(true);
    } catch (caught) {
      if (isSessionEnded(caught)) {
        reauth.settle(false);
        return;
      }
      setFailure(failureOf(caught));
      setSubmitting(false);
    }
  }

  const fieldError = failure?.kind === "wrongPassword" || failure?.kind === "required" ? message(failure) : undefined;
  return (
    <form
      className="flex flex-col gap-4"
      noValidate
      onSubmit={(event) => {
        void submit(event);
      }}
    >
      {failure === undefined || fieldError !== undefined ? null : (
        <Banner title={message(failure)} variant="error" />
      )}
      <FormField error={fieldError} label={t("reauth.password.label")} name="password">
        <SecretInput
          autoComplete="current-password"
          disabled={submitting}
          hideLabel={t("reauth.password.hide")}
          onChange={(event) => {
            setPassword(event.target.value);
            setFailure(undefined);
          }}
          showLabel={t("reauth.password.show")}
          value={password}
        />
      </FormField>
      {onUseCode === undefined ? null : (
        <div className="flex justify-center">
          <Button disabled={submitting} onClick={onUseCode} type="button" variant="link">
            {t("reauth.useCode")}
          </Button>
        </div>
      )}
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button
          disabled={submitting}
          onClick={() => {
            reauth.settle(false);
          }}
          variant="outline"
        >
          {t("reauth.cancel")}
        </Button>
        <Button loading={submitting} type="submit">
          {t("reauth.submit")}
        </Button>
      </div>
    </form>
  );
}

/**
 * The step for an account whose two-factor authentication is on: the six-digit code of its authenticator app,
 * which `POST /me/reauth` accepts instead of the password. The code is sent as soon as the sixth digit is in; it
 * lives only in this step's state, which is dropped when the prompt closes or the member goes back. A backup code
 * is not accepted by the contract and not offered. `onUseOther` goes back to the password or provider step.
 */
function CodeStep({ reauth, api, onUseOther, otherLabel }: { reauth: Reauth; api: ApiClient; onUseOther: () => void; otherLabel: string }): ReactElement {
  const { t } = useTranslation();
  const message = useFailureMessage();
  const [code, setCode] = useState("");
  const [failure, setFailure] = useState<Failure | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);
  const running = useRef(false);

  async function submit(entered: string): Promise<void> {
    if (running.current) {
      return;
    }
    if (entered.length < CODE_LENGTH) {
      setFailure({ kind: "required" });
      return;
    }
    running.current = true;
    setFailure(undefined);
    setSubmitting(true);
    try {
      const { response, error } = await api.POST("/api/v1/me/reauth", { body: { code: entered } });
      if (!response.ok) {
        throw new Error("The re-authentication did not answer with a problem document", { cause: error });
      }
      reauth.settle(true);
    } catch (caught) {
      if (isSessionEnded(caught)) {
        reauth.settle(false);
        return;
      }
      setFailure(codeFailureOf(caught));
      // A code is used once, so the next try starts from an empty field.
      setCode("");
      setSubmitting(false);
    } finally {
      running.current = false;
    }
  }

  const fieldError = failure?.kind === "required" ? t("reauth.code.required") : failure?.kind === "invalidCode" ? message(failure) : undefined;
  return (
    <form
      className="flex flex-col gap-4"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void submit(code);
      }}
    >
      {failure === undefined || fieldError !== undefined ? null : <Banner title={message(failure)} variant="error" />}
      <FormField error={fieldError} label={t("reauth.code.label")} name="code">
        <Totp
          disabled={submitting}
          length={CODE_LENGTH}
          onComplete={(complete) => {
            void submit(complete);
          }}
          onValueChange={(value) => {
            setCode(value);
            setFailure(undefined);
          }}
          slotLabel={(position, length) => t("reauth.code.slot", { position, length })}
          value={code}
        />
      </FormField>
      <div className="flex justify-center">
        <Button disabled={submitting} onClick={onUseOther} type="button" variant="link">
          {otherLabel}
        </Button>
      </div>
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button
          disabled={submitting}
          onClick={() => {
            reauth.settle(false);
          }}
          type="button"
          variant="outline"
        >
          {t("reauth.cancel")}
        </Button>
        <Button loading={submitting} type="submit">
          {t("reauth.submit")}
        </Button>
      </div>
    </form>
  );
}

/**
 * The step for an account without a password: it confirms the member at a sign-in provider, which is a
 * top-level navigation that comes back to the page the member is on (doc 04 section 4.5, `intent=reauth`).
 * The request that asked for it is not sent again; the member repeats the action once they are back.
 */
function ProviderStep({ reauth, onUseCode }: { reauth: Reauth; onUseCode: (() => void) | undefined }): ReactElement {
  const { t } = useTranslation();
  const providers = oidcProvidersOf(useConfig());
  return (
    <div className="flex flex-col gap-4">
      {providers.length === 0 ? (
        <Banner title={t("reauth.provider.none")} variant="error" />
      ) : (
        <ProviderButtons
          intent={REAUTH_INTENT}
          label={(name) => t("reauth.provider.confirm", { name })}
          providers={providers}
          returnTo={currentReturnTo()}
        />
      )}
      {onUseCode === undefined ? null : (
        <div className="flex justify-center">
          <Button onClick={onUseCode} type="button" variant="link">
            {t("reauth.useCode")}
          </Button>
        </div>
      )}
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button
          onClick={() => {
            reauth.settle(false);
          }}
          variant="outline"
        >
          {t("reauth.cancel")}
        </Button>
      </div>
    </div>
  );
}

/**
 * The shared re-authentication prompt (doc 04 section 4.4, doc 03 section 11.2): a dialog that asks for the
 * account's password and confirms it with `POST /me/reauth`, or, for an account without a password, sends the
 * member through their sign-in provider. An account whose two-factor authentication is on may give a code of its
 * authenticator app instead, with either; the server checks it and stays the authority, the prompt only offers it
 * when the account the app holds says the factor is on. It opens when a request answers `401 reauth_required` (see
 * `reauthMiddleware`); the request is sent again once the password or the code is accepted.
 */
export function ReauthPrompt({ reauth, api }: { reauth: Reauth; api: ApiClient }): ReactElement {
  const { t } = useTranslation();
  const open = useSyncExternalStore(
    (listener) => reauth.subscribe(listener),
    () => reauth.isOpen(),
  );
  const account = useCachedAccount();
  // Only an account the app knows has no password gets the provider step; with no account in the cache the password asks.
  const viaProvider = account?.hasPassword === false;
  // Only an account the app knows has the second factor on is offered the code.
  const codeOffered = account?.mfaEnabled === true;
  const [wantsCode, setWantsCode] = useState(false);
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (!open) {
      // The next time it opens it starts at the password or the provider again.
      setWantsCode(false);
    }
  }
  const step = codeOffered && wantsCode ? "code" : viaProvider ? "provider" : "password";
  const description = step === "code" ? t("reauth.code.description") : step === "provider" ? t("reauth.provider.description") : t("reauth.description");
  const useCode = codeOffered
    ? () => {
        setWantsCode(true);
      }
    : undefined;
  return (
    <FormOverlay
      closeLabel={t("reauth.close")}
      description={description}
      onOpenChange={(next) => {
        if (!next) {
          reauth.settle(false);
        }
      }}
      open={open}
      title={t("reauth.title")}
    >
      {step === "code" ? (
        <CodeStep
          api={api}
          onUseOther={() => {
            setWantsCode(false);
          }}
          otherLabel={viaProvider ? t("reauth.useProvider") : t("reauth.usePassword")}
          reauth={reauth}
        />
      ) : step === "provider" ? (
        <ProviderStep onUseCode={useCode} reauth={reauth} />
      ) : (
        <PasswordStep api={api} onUseCode={useCode} reauth={reauth} />
      )}
    </FormOverlay>
  );
}
