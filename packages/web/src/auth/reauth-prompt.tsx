import { Button } from "@slugbase/ui";
import { Banner, FormField, FormOverlay, SecretInput } from "@slugbase/ui/patterns";
import { useState, useSyncExternalStore, type ReactElement, type SyntheticEvent } from "react";
import { useTranslation } from "react-i18next";
import { ApiProblemError, isSessionEnded, type ApiClient } from "../api/client.ts";
import type { Reauth } from "./reauth.ts";

const SECONDS_PER_MINUTE = 60;

type Failure =
  | { readonly kind: "wrongPassword" }
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

function PasswordStep({ reauth, api }: { reauth: Reauth; api: ApiClient }): ReactElement {
  const { t } = useTranslation();
  const [password, setPassword] = useState("");
  const [failure, setFailure] = useState<Failure | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);

  function message(value: Failure): string {
    switch (value.kind) {
      case "wrongPassword":
        return t("reauth.error.wrongPassword");
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
  }

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
 * The shared re-authentication prompt (doc 04 section 4.4, doc 03 section 11.2): a dialog that asks for the
 * account's password and confirms it with `POST /me/reauth`. It opens when a request answers `401
 * reauth_required` (see `reauthMiddleware`); the request is sent again once the password is accepted. The second-factor
 * and provider variants are further steps of this prompt.
 */
export function ReauthPrompt({ reauth, api }: { reauth: Reauth; api: ApiClient }): ReactElement {
  const { t } = useTranslation();
  const open = useSyncExternalStore(
    (listener) => reauth.subscribe(listener),
    () => reauth.isOpen(),
  );
  return (
    <FormOverlay
      closeLabel={t("reauth.close")}
      description={t("reauth.description")}
      onOpenChange={(next) => {
        if (!next) {
          reauth.settle(false);
        }
      }}
      open={open}
      title={t("reauth.title")}
    >
      <PasswordStep api={api} reauth={reauth} />
    </FormOverlay>
  );
}
