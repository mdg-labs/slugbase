import type { ComponentTypes } from "@slugbase/contracts";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { ApiProblemError, isSessionEnded, type ApiClient } from "../api/client.ts";
import { isReauthCancelled } from "../auth/reauth.ts";

export type MfaEnrollment = ComponentTypes["schemas"]["MfaEnrollment"];
export type DisableRequest = ComponentTypes["schemas"]["DisableMfaRequest"];

const SECONDS_PER_MINUTE = 60;

function requireData<T>(result: { data?: T; response: Response; error?: unknown }, what: string): T {
  if (result.data === undefined) {
    throw new Error(`The ${what} did not answer with a document`, { cause: result.error });
  }
  return result.data;
}

/** Starts an enrolment: a new pending secret, which the server shows only in this answer. */
export async function startEnrollment(api: ApiClient, signal: AbortSignal): Promise<MfaEnrollment> {
  return requireData(await api.POST("/api/v1/me/mfa/enrollment", { signal }), "start of the enrolment");
}

/** Turns the second factor on with a code of the pending secret; the ten backup codes are in this answer only. */
export async function confirmEnrollment(api: ApiClient, code: string, signal: AbortSignal): Promise<readonly string[]> {
  const { backupCodes } = requireData(await api.POST("/api/v1/me/mfa/enrollment/confirm", { body: { code }, signal }), "confirmation of the enrolment");
  return backupCodes;
}

/** Replaces the backup codes; the new set is in this answer only. */
export async function regenerateBackupCodes(api: ApiClient, code: string, signal: AbortSignal): Promise<readonly string[]> {
  const { backupCodes } = requireData(await api.POST("/api/v1/me/mfa/backup-codes", { body: { code }, signal }), "backup code request");
  return backupCodes;
}

export async function disableTwoFactor(api: ApiClient, body: DisableRequest, signal: AbortSignal): Promise<void> {
  const { response, error } = await api.DELETE("/api/v1/me/mfa", { body, signal });
  if (!response.ok) {
    throw new Error("Turning the second factor off did not answer with a problem document", { cause: error });
  }
}

/** Why a request of the card did not go through, as far as the member is told. */
export type MfaFailure =
  | { readonly kind: "invalidCode" }
  | { readonly kind: "wrongPassword" }
  | { readonly kind: "reauthRequired" }
  | { readonly kind: "rateLimited"; readonly seconds: number | undefined }
  | { readonly kind: "unavailable" };

/** The failure to show for an error; undefined for an ended session, which the app answers as a whole. */
export function mfaFailureOf(error: unknown): MfaFailure | undefined {
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
    if (error.code === "invalid_code") {
      return { kind: "invalidCode" };
    }
    if (error.status === 422 && error.errors.some(({ path }) => path === "password")) {
      return { kind: "wrongPassword" };
    }
  }
  return { kind: "unavailable" };
}

/** The sentence for a failure, in the language of the page. */
export function useMfaFailureMessage(): (failure: MfaFailure) => string {
  const { t } = useTranslation();
  return (failure) => {
    switch (failure.kind) {
      case "invalidCode":
        return t("settings.security.mfa.error.invalidCode");
      case "wrongPassword":
        return t("settings.security.mfa.error.wrongPassword");
      case "reauthRequired":
        return t("settings.security.mfa.error.reauthRequired");
      case "unavailable":
        return t("settings.security.mfa.error.unavailable");
      case "rateLimited":
        if (failure.seconds === undefined) {
          return t("reauth.error.rateLimited.unknown");
        }
        return failure.seconds < SECONDS_PER_MINUTE
          ? t("reauth.error.rateLimited.seconds", { count: failure.seconds })
          : t("reauth.error.rateLimited.minutes", { count: Math.ceil(failure.seconds / SECONDS_PER_MINUTE) });
    }
  };
}

export type MfaOutcome<T> =
  | { readonly status: "done"; readonly value: T }
  | { readonly status: "failed"; readonly failure: MfaFailure | undefined }
  /** Nothing was sent, or the view went away while the request ran. */
  | { readonly status: "skipped" };

/**
 * Runs one request of a view at a time and aborts it when the view goes away, so a secret that arrives after
 * the view closed is never put into state. The answers stay out of the query cache: they are held by the
 * view that asked, which drops them when it closes.
 */
export function useMfaRequest(): <T>(call: (signal: AbortSignal) => Promise<T>) => Promise<MfaOutcome<T>> {
  const controller = useRef<AbortController | null>(null);
  const running = useRef(false);

  useEffect(
    () => () => {
      controller.current?.abort();
    },
    [],
  );

  return async (call) => {
    if (running.current) {
      return { status: "skipped" };
    }
    running.current = true;
    const own = new AbortController();
    controller.current = own;
    try {
      const value = await call(own.signal);
      return own.signal.aborted ? { status: "skipped" } : { status: "done", value };
    } catch (caught) {
      return own.signal.aborted ? { status: "skipped" } : { status: "failed", failure: mfaFailureOf(caught) };
    } finally {
      running.current = false;
    }
  };
}
