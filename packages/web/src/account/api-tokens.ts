import type { ComponentTypes } from "@slugbase/contracts";
import { infiniteQueryOptions } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { ApiProblemError, isSessionEnded, type ApiClient } from "../api/client.ts";
import { isReauthCancelled } from "../auth/reauth.ts";

export type ApiToken = ComponentTypes["schemas"]["ApiToken"];
export type CreatedApiToken = ComponentTypes["schemas"]["CreatedApiToken"];
export type CreateApiTokenRequest = ComponentTypes["schemas"]["CreateApiTokenRequest"];

export const API_TOKENS_QUERY_KEY = ["account", "api-tokens"] as const;

const PAGE_SIZE = 50;
const SECONDS_PER_MINUTE = 60;

/** The account's tokens that are not revoked, newest first, a page at a time. */
export function apiTokensQuery(api: ApiClient) {
  return infiniteQueryOptions({
    queryKey: API_TOKENS_QUERY_KEY,
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }) => {
      const { data, error } = await api.GET("/api/v1/me/api-tokens", {
        params: { query: { limit: PAGE_SIZE, ...(pageParam === undefined ? {} : { cursor: pageParam }) } },
      });
      if (data === undefined) {
        throw new Error("The API tokens request did not answer with a document", { cause: error });
      }
      return data;
    },
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

/** Creates a token; the secret is in this answer only. */
export async function createApiToken(api: ApiClient, body: CreateApiTokenRequest, signal: AbortSignal): Promise<CreatedApiToken> {
  const { data, error } = await api.POST("/api/v1/me/api-tokens", { body, signal });
  if (data === undefined) {
    throw new Error("The API token creation did not answer with a document", { cause: error });
  }
  return data;
}

export async function revokeApiToken(api: ApiClient, id: string): Promise<void> {
  const { response, error } = await api.DELETE("/api/v1/me/api-tokens/{id}", { params: { path: { id } } });
  if (!response.ok) {
    throw new Error("The API token revocation did not answer with a problem document", { cause: error });
  }
}

/** Why a creation did not go through, as far as the member is told. */
export type TokenFailure =
  | { readonly kind: "limitReached" }
  | { readonly kind: "nameTaken" }
  | { readonly kind: "reauthRequired" }
  | { readonly kind: "rateLimited"; readonly seconds: number | undefined }
  | { readonly kind: "unavailable" };

/** The failure to show for an error; undefined for an ended session, which the app answers as a whole. */
export function tokenFailureOf(error: unknown): TokenFailure | undefined {
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
    if (error.code === "name_taken") {
      return { kind: "nameTaken" };
    }
    if (error.status === 422 && error.errors.some(({ path, code }) => path === "name" && code === "api_token_limit_reached")) {
      return { kind: "limitReached" };
    }
  }
  return { kind: "unavailable" };
}

/** The sentence for a failure that is not shown in a field, in the language of the page. */
export function useTokenFailureMessage(): (failure: TokenFailure) => string {
  const { t } = useTranslation();
  return (failure) => {
    switch (failure.kind) {
      case "limitReached":
        return t("settings.tokens.error.limitReached");
      case "nameTaken":
        return t("settings.tokens.error.nameTaken");
      case "reauthRequired":
        return t("settings.tokens.error.reauthRequired");
      case "unavailable":
        return t("settings.tokens.error.unavailable");
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

export type TokenOutcome<T> =
  | { readonly status: "done"; readonly value: T }
  | { readonly status: "failed"; readonly failure: TokenFailure | undefined }
  /** Nothing was sent, or the view went away while the request ran. */
  | { readonly status: "skipped" };

/**
 * Runs one request of a view at a time and aborts it when the view goes away, so a secret that arrives after
 * the view closed is never put into state. The answer stays out of the query cache: the view that asked holds
 * it and drops it when it closes.
 */
export function useTokenRequest(): <T>(call: (signal: AbortSignal) => Promise<T>) => Promise<TokenOutcome<T>> {
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
      return own.signal.aborted ? { status: "skipped" } : { status: "failed", failure: tokenFailureOf(caught) };
    } finally {
      running.current = false;
    }
  };
}
