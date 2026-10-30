import { Button, Skeleton } from "@slugbase/ui";
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import type { TFunction } from "i18next";
import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { DEFAULT_LOCALE } from "../i18n/locales.ts";
import { sharesQuery, type Share, type ShareSubject } from "./shares.ts";
import { SharingGate } from "./sharing-gate.tsx";

/** The sentence for what something is shared with: "Private", or "Shared with Platform team and 2 members", the teams by name, then the members by number. */
export function summaryOfParts(t: TFunction, language: string, parts: { readonly teams: readonly string[]; readonly members: number }): string {
  if (parts.teams.length === 0 && parts.members === 0) {
    return t("sharing.summary.private");
  }
  const teams = parts.teams.map((name) => t("sharing.summary.team", { name }));
  const named = parts.members === 0 ? teams : [...teams, t("sharing.summary.members", { count: parts.members })];
  return t("sharing.summary.shared", { with: new Intl.ListFormat(language, { style: "long", type: "conjunction" }).format(named) });
}

/** "Private", or "Shared with Platform team and 2 members": the teams by name, then the members by number. */
export function summaryOf(t: TFunction, language: string, shares: readonly Share[]): string {
  return summaryOfParts(t, language, {
    teams: shares.filter(({ kind }) => kind === "team").map(({ name }) => name),
    members: shares.filter(({ kind }) => kind === "member").length,
  });
}

function SharingSummaryContent({ subject, onManage }: { subject: Pick<ShareSubject, "kind" | "id">; onManage: () => void }): ReactElement {
  const { t, i18n } = useTranslation();
  const router = useRouter();
  const shares = useQuery(sharesQuery(router.options.context.api, subject));
  let line: ReactElement;
  if (shares.data !== undefined) {
    line = <span className="wrap-anywhere text-muted-foreground">{summaryOf(t, i18n.resolvedLanguage ?? DEFAULT_LOCALE, shares.data.items)}</span>;
  } else if (shares.isError) {
    line = (
      <span className="flex items-center gap-2 text-destructive-text" role="alert">
        {t("sharing.summary.loadFailed")}
        <Button
          loading={shares.isFetching}
          onClick={() => {
            void shares.refetch();
          }}
          size="xs"
          type="button"
          variant="outline"
        >
          {t("sharing.summary.retry")}
        </Button>
      </span>
    );
  } else {
    line = <Skeleton aria-label={t("sharing.summary.loading")} className="h-4 w-48" role="status" />;
  }
  return (
    <div aria-label={t("sharing.summary.label")} className="flex items-center justify-between gap-3 text-sm" role="group">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="font-medium">{t("sharing.summary.label")}</span>
        {line}
      </div>
      <Button onClick={onManage} size="sm" type="button" variant="outline">
        {t("sharing.summary.manage")}
      </Button>
    </div>
  );
}

export interface SharingSummaryProps {
  readonly bookmarkId: string;
  /** Opens the share dialog. */
  readonly onManage: () => void;
}

/**
 * The sharing line of the bookmark modal (doc 03 section 4, field 9): who the bookmark is shared with in a sentence, with "Manage"
 * opening the share dialog. It stands inside the sharing entitlement gate, and is for the owner's existing bookmarks.
 */
export function SharingSummary({ bookmarkId, onManage }: SharingSummaryProps): ReactElement {
  const subject: Pick<ShareSubject, "kind" | "id"> = { kind: "bookmark", id: bookmarkId };
  return (
    <SharingGate>
      <SharingSummaryContent onManage={onManage} subject={subject} />
    </SharingGate>
  );
}
