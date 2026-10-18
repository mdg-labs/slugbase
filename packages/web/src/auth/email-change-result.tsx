import { Button } from "@slugbase/ui";
import { Banner, EmptyState, Loading } from "@slugbase/ui/patterns";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useRouter } from "@tanstack/react-router";
import { useEffect, useRef, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { ME_QUERY_KEY } from "../account/me.ts";
import { ApiProblemError, type ApiClient } from "../api/client.ts";
import { HOME_PATH } from "./next-path.ts";
import { tokenFromFragment } from "./verify-token.ts";

const SECONDS_PER_MINUTE = 60;

export type EmailChangeLink = "confirm" | "cancel";

type Outcome =
  | { readonly status: "working" }
  | { readonly status: "done" }
  | { readonly status: "expired" }
  | { readonly status: "rateLimited"; readonly seconds: number | undefined }
  | { readonly status: "unavailable" };

const WORKING: Outcome = { status: "working" };

async function redeem(api: ApiClient, link: EmailChangeLink, token: string): Promise<void> {
  const { response, error } =
    link === "confirm"
      ? await api.POST("/api/v1/me/email/confirm", { body: { token } })
      : await api.POST("/api/v1/me/email/cancel", { body: { token } });
  if (!response.ok) {
    throw new Error("The email-change link did not answer with a problem document", { cause: error });
  }
}

/** What a failed redemption means for the page (doc 04 section 10.3): an unknown, used, replaced or expired token is one answer, whatever the reason. */
function outcomeOf(error: unknown): Outcome {
  if (error instanceof ApiProblemError) {
    if (error.status === 410) {
      return { status: "expired" };
    }
    if (error.status === 429) {
      return { status: "rateLimited", seconds: error.retryAfterSeconds };
    }
  }
  return { status: "unavailable" };
}

/**
 * The result card of the two links in the emails of an email change (doc 03 section 1.7): the link's token comes from
 * the fragment of the address and is redeemed once when the page opens. The visitor may be signed in or not. Confirming
 * changes the address and ends no session. The "this wasn't me" link ends every session, this browser's included, so
 * what the cache holds of the account is dropped and the card leads to the sign-in page.
 */
export function EmailChangeResult({ link }: { link: EmailChangeLink }): ReactElement {
  const { t } = useTranslation();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [token] = useState(() => tokenFromFragment(globalThis.location.hash));
  const [attempt, setAttempt] = useState(0);
  const [outcome, setOutcome] = useState<Outcome>(token === undefined ? { status: "expired" } : WORKING);
  const started = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (token === undefined || started.current === attempt) {
      return;
    }
    started.current = attempt;
    void (async () => {
      try {
        await redeem(router.options.context.api, link, token);
      } catch (caught) {
        setOutcome(outcomeOf(caught));
        return;
      }
      if (link === "confirm") {
        // The address in the cached account is the old one.
        queryClient.removeQueries({ queryKey: ME_QUERY_KEY });
      } else {
        // Every session of the account has ended: nothing cached belongs to a signed-in member any more.
        queryClient.clear();
      }
      setOutcome({ status: "done" });
    })();
  }, [attempt, link, queryClient, router, token]);

  function tryAgain(): void {
    setOutcome(WORKING);
    setAttempt((current) => current + 1);
  }

  function rateLimitMessage(seconds: number | undefined): string {
    if (seconds === undefined) {
      return t("emailChange.error.rateLimited.unknown");
    }
    return seconds < SECONDS_PER_MINUTE
      ? t("emailChange.error.rateLimited.seconds", { count: seconds })
      : t("emailChange.error.rateLimited.minutes", { count: Math.ceil(seconds / SECONDS_PER_MINUTE) });
  }

  switch (outcome.status) {
    case "working":
      return <Loading label={t("emailChange.working")} />;
    case "done":
      return link === "confirm" ? (
        <EmptyState
          actions={
            <Button render={<Link to={HOME_PATH} />} size="sm">
              {t("emailChange.confirm.success.action")}
            </Button>
          }
          description={t("emailChange.confirm.success.description")}
          title={t("emailChange.confirm.success.title")}
        />
      ) : (
        <EmptyState
          actions={
            <Button render={<Link to="/login" />} size="sm">
              {t("emailChange.cancel.success.action")}
            </Button>
          }
          description={t("emailChange.cancel.success.description")}
          title={t("emailChange.cancel.success.title")}
        />
      );
    case "expired":
      return (
        <Banner
          action={
            <Button render={<Link to="/login" />} size="sm" variant="outline">
              {t("emailChange.expired.action")}
            </Button>
          }
          description={t("emailChange.expired.description")}
          title={t("emailChange.expired.title")}
          variant="warning"
        />
      );
    case "rateLimited":
    case "unavailable":
      return (
        <Banner
          action={
            <Button
              onClick={tryAgain}
              size="sm"
              variant="outline"
            >
              {t("emailChange.error.retry")}
            </Button>
          }
          title={outcome.status === "rateLimited" ? rateLimitMessage(outcome.seconds) : t("emailChange.error.unavailable")}
          variant="error"
        />
      );
  }
}
