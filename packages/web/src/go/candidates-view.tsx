import { Button } from "@slugbase/ui";
import { Banner, CheckboxField } from "@slugbase/ui/patterns";
import { Link } from "@tanstack/react-router";
import { useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import type { GoCandidate } from "./go.ts";
import { useGoChoose } from "./use-go-choose.ts";

function useHowShared(): (candidate: GoCandidate) => string {
  const { t } = useTranslation();
  return ({ owner, sharedVia }) => {
    if (owner === null && sharedVia === null) {
      return t("go.choose.yours");
    }
    const who = owner === null ? t("go.choose.shared") : t("go.choose.sharedBy", { owner: owner.displayName });
    if (sharedVia === null) {
      return who;
    }
    const via = { direct: t("go.choose.via.direct"), team: t("go.choose.via.team"), folder: t("go.choose.via.folder") }[sharedVia];
    return `${who} · ${via}`;
  };
}

export interface CandidatesViewProps {
  readonly slug: string;
  readonly candidates: readonly GoCandidate[];
  /** Reads the candidates again, after a choice the server refused. */
  readonly onRefresh: () => void;
}

/**
 * Several bookmarks shared with the member have the slug and none is their own (doc 02 section 6.3, doc 03 section 10): each is a
 * card that is also the button to go there. "Always use this" remembers the choice for the slug (doc 02 section 6.4).
 */
export function CandidatesView({ slug, candidates, onRefresh }: CandidatesViewProps): ReactElement {
  const { t } = useTranslation();
  const choose = useGoChoose();
  const howShared = useHowShared();
  const [remember, setRemember] = useState(false);
  const [picked, setPicked] = useState<string | undefined>(undefined);
  const busy = choose.isPending || choose.isSuccess;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h1 className="font-semibold text-xl">{t("go.choose.title", { slug, count: candidates.length })}</h1>
        <p className="text-muted-foreground text-sm">{t("go.choose.description")}</p>
      </div>
      {choose.isError ? (
        <Banner
          action={
            <Button
              onClick={() => {
                choose.reset();
                onRefresh();
              }}
              size="sm"
              variant="outline"
            >
              {t("go.retry")}
            </Button>
          }
          description={t("go.choose.failed.description")}
          title={t("go.choose.failed.title")}
          variant="error"
        />
      ) : null}
      <div aria-label={t("go.choose.label")} className="flex flex-col gap-2" role="group">
        {candidates.map((candidate) => (
          <Button
            className="h-auto w-full justify-start py-3 text-start"
            disabled={busy && picked !== candidate.id}
            key={candidate.id}
            loading={busy && picked === candidate.id}
            onClick={() => {
              setPicked(candidate.id);
              choose.mutate({ slug, bookmarkId: candidate.id, remember });
            }}
            variant="outline"
          >
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="truncate font-medium text-sm" translate="no">
                {candidate.title}
              </span>
              <span className="truncate font-mono text-muted-foreground text-xs" translate="no">
                {candidate.host}
              </span>
              <span className="truncate font-normal text-muted-foreground text-xs">{howShared(candidate)}</span>
            </span>
          </Button>
        ))}
      </div>
      <CheckboxField checked={remember} disabled={busy} label={t("go.choose.always", { slug })} onCheckedChange={setRemember} />
      <div>
        <Button render={<Link to="/forwarding" />} size="sm" variant="link">
          {t("go.choose.manage")}
        </Button>
      </div>
    </div>
  );
}
