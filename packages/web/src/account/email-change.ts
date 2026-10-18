import { useTranslation } from "react-i18next";
import { ApiProblemError, isSessionEnded, type ApiClient } from "../api/client.ts";
import { isReauthCancelled } from "../auth/reauth.ts";

// `DELETE` carries no body, and the server refuses a mutation that does not say it is JSON (doc 04 section 5).
const JSON_HEADERS = { "Content-Type": "application/json" } as const;
const SECONDS_PER_MINUTE = 60;

/** Asks for the account's email to move to `email`: the answer is alike for every address, so it says nothing about the address. */
export async function requestEmailChange(api: ApiClient, email: string): Promise<void> {
  const { response, error } = await api.POST("/api/v1/me/email", { body: { email } });
  if (!response.ok) {
    throw new Error("The email change request did not answer with a problem document", { cause: error });
  }
}

/** Drops the account's pending email change and the links that belong to it. */
export async function cancelPendingEmailChange(api: ApiClient): Promise<void> {
  const { response, error } = await api.DELETE("/api/v1/me/email/pending", { headers: JSON_HEADERS });
  if (!response.ok) {
    throw new Error("The cancellation of the email change did not answer with a problem document", { cause: error });
  }
}

/** Why an email-change call did not go through, as far as the member is told. */
export type EmailChangeFailure =
  | { readonly kind: "invalid" }
  | { readonly kind: "reauthRequired" }
  | { readonly kind: "rateLimited"; readonly seconds: number | undefined }
  | { readonly kind: "unavailable" };

/** The failure to show for an error; undefined for an ended session, which the app answers as a whole. */
export function emailChangeFailureOf(error: unknown): EmailChangeFailure | undefined {
  if (isReauthCancelled(error)) {
    return { kind: "reauthRequired" };
  }
  if (isSessionEnded(error)) {
    return undefined;
  }
  if (error instanceof ApiProblemError) {
    if (error.code === "reauth_required") {
      return { kind: "reauthRequired" };
    }
    if (error.status === 429) {
      return { kind: "rateLimited", seconds: error.retryAfterSeconds };
    }
    if (error.status === 422) {
      return { kind: "invalid" };
    }
  }
  return { kind: "unavailable" };
}

/** The sentence for a failure, in the language of the page. */
export function useEmailChangeFailureMessage(): (failure: EmailChangeFailure) => string {
  const { t } = useTranslation();
  return (failure) => {
    switch (failure.kind) {
      case "invalid":
        return t("settings.account.email.error.invalid");
      case "reauthRequired":
        return t("settings.account.email.error.reauthRequired");
      case "unavailable":
        return t("settings.account.email.error.unavailable");
      case "rateLimited":
        if (failure.seconds === undefined) {
          return t("settings.account.email.error.rateLimited.unknown");
        }
        return failure.seconds < SECONDS_PER_MINUTE
          ? t("settings.account.email.error.rateLimited.seconds", { count: failure.seconds })
          : t("settings.account.email.error.rateLimited.minutes", { count: Math.ceil(failure.seconds / SECONDS_PER_MINUTE) });
    }
  };
}
