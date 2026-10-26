import { feedbackToast } from "@slugbase/ui/patterns";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { ApiProblemError, isSessionEnded, type ApiProblemCode } from "../api/client.ts";
import { isReauthCancelled } from "../auth/reauth.ts";
import { isEntitlementRequired } from "../entitlements/entitlements.ts";

/**
 * A refusal a form shows in place: the HTTP `status`, and the problem `code` when only that one answer of the status is
 * meant (without it every answer of the status is).
 */
export interface InPlaceRefusal {
  readonly status: number;
  readonly code?: ApiProblemCode;
}

/** The mutation `meta` that declares the refusals its form shows in place, for which the shared toast stays quiet. */
export function inPlaceRefusals(refusals: readonly InPlaceRefusal[]): { readonly inPlaceRefusals: readonly InPlaceRefusal[] } {
  return { inPlaceRefusals: refusals };
}

function isInPlaceRefusals(value: unknown): value is readonly InPlaceRefusal[] {
  return (
    Array.isArray(value) &&
    value.every(
      (entry: unknown) =>
        typeof entry === "object" && entry !== null && "status" in entry && typeof entry.status === "number",
    )
  );
}

function isShownInPlace(meta: Readonly<Record<string, unknown>> | undefined, error: unknown): boolean {
  if (!(error instanceof ApiProblemError) || meta === undefined) {
    return false;
  }
  if (meta["fieldErrors"] === true && error.status === 422) {
    return true;
  }
  const declared = meta["inPlaceRefusals"];
  return (
    isInPlaceRefusals(declared) &&
    declared.some((refusal) => refusal.status === error.status && (refusal.code === undefined || refusal.code === error.code))
  );
}

/**
 * Shows an error toast for every mutation that fails (doc 03, cross-cutting rules). It names the
 * request id of an API problem and nothing else of the cause. A mutation that failed because the
 * session ended is left to the session handler, which takes the member to sign in, and one the API refused with
 * `403 entitlement_required` has its own toast with the upgrade action. A request the
 * member gave up by closing the re-authentication prompt is no failure to report, and a mutation whose
 * `meta.fieldErrors` is set shows a `422` in its own form. A mutation whose `meta` is `inPlaceRefusals(…)` shows
 * the refusals it names in its own form; every other failure of it is reported here.
 */
export function MutationErrorToasts(): null {
  const queryClient = useQueryClient();
  const { t } = useTranslation();
  useEffect(
    () =>
      queryClient.getMutationCache().subscribe((event) => {
        if (event.type !== "updated" || event.action.type !== "error") {
          return;
        }
        const error: unknown = event.action.error;
        if (isSessionEnded(error) || isReauthCancelled(error)) {
          return;
        }
        if (isEntitlementRequired(error)) {
          return;
        }
        if (isShownInPlace(event.mutation.meta, error)) {
          return;
        }
        const reason = globalThis.navigator.onLine
          ? t("feedback.mutationFailed.description")
          : t("feedback.mutationFailed.offline");
        const description =
          error instanceof ApiProblemError
            ? `${reason} ${t("feedback.mutationFailed.requestId", { requestId: error.requestId })}`
            : reason;
        feedbackToast.error(t("feedback.mutationFailed.title"), description);
      }),
    [queryClient, t],
  );
  return null;
}
