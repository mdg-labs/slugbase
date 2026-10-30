import { Button } from "@slugbase/ui";
import { FormOverlay, Picker, UsersIcon, type PickerOption } from "@slugbase/ui/patterns";
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useMemo, useState, type ReactElement, type SyntheticEvent } from "react";
import { useTranslation } from "react-i18next";
import { shareTargetsQuery, targetKey, useDebounced, type ShareTarget } from "../sharing/index.ts";
import { BOOKMARKS_QUERY_KEY, previewShare, type BulkShareTarget } from "./bookmarks.ts";

const SEARCH_DELAY_MS = 200;

export interface BulkShareOverlayProps {
  /** The bookmarks the action is for; the count in the title is the count it acts on. */
  readonly ids: readonly string[];
  /** Called with the member or team chosen; the caller runs the action and closes the overlay. */
  readonly onSubmit: (target: BulkShareTarget) => void;
  readonly onClose: () => void;
}

/**
 * What the member chooses for a bulk share (doc 03 section 3.4, doc 02 section 5.8): a member or a team of the workspace, with the
 * preview of who the bookmarks will be shared with. The button waits for the preview of this choice, and is off when it says no
 * bookmark of the selection can be shared.
 */
export function BulkShareOverlay({ ids, onSubmit, onClose }: BulkShareOverlayProps): ReactElement {
  const { t } = useTranslation();
  const router = useRouter();
  const api = router.options.context.api;
  const count = ids.length;
  const [search, setSearch] = useState("");
  const [chosen, setChosen] = useState<ShareTarget | undefined>(undefined);
  const targets = useQuery(shareTargetsQuery(api, useDebounced(search, SEARCH_DELAY_MS)));
  const members = t("bookmarks.bulk.share.members");
  const teams = t("bookmarks.bulk.share.teams");
  // The picker keeps what the member typed only while the options it is given stay the same objects between renders.
  const options = useMemo(() => {
    const found = targets.data ?? [];
    const listed = chosen === undefined || found.some((target) => targetKey(target) === targetKey(chosen)) ? found : [chosen, ...found];
    const option = (target: ShareTarget): PickerOption => ({
      value: targetKey(target),
      label: target.name,
      ...(target.email === null ? {} : { description: target.email }),
      ...(target.kind === "team" ? { icon: <UsersIcon className="size-4" /> } : {}),
      group: target.kind === "member" ? members : teams,
    });
    return [...listed.filter(({ kind }) => kind === "member"), ...listed.filter(({ kind }) => kind === "team")].map(option);
  }, [targets.data, chosen, members, teams]);
  const choice: BulkShareTarget | undefined = chosen === undefined ? undefined : { kind: chosen.kind, id: chosen.id, name: chosen.name };
  // The preview is for the bookmarks selected when the overlay was opened and the target chosen now.
  const preview = useQuery({
    queryKey: [...BOOKMARKS_QUERY_KEY, "bulk-share-preview", ids, choice === undefined ? "" : targetKey(choice)],
    queryFn: ({ signal }) => {
      if (choice === undefined) {
        throw new Error("There is no target to preview");
      }
      return previewShare(api, ids, choice, signal);
    },
    enabled: choice !== undefined,
    retry: false,
    staleTime: 0,
    gcTime: 0,
  });
  const previewed = preview.data;
  const submit = (event: SyntheticEvent): void => {
    event.preventDefault();
    if (choice !== undefined && previewed !== undefined && previewed.affected > 0) {
      onSubmit(choice);
    }
  };
  return (
    <FormOverlay
      closeLabel={t("bookmarks.bulk.share.close")}
      description={t("bookmarks.bulk.share.description")}
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
      open
      title={t("bookmarks.bulk.share.title", { count })}
    >
      <form className="flex flex-col gap-4" noValidate onSubmit={submit}>
        <Picker
          emptyLabel={t("bookmarks.bulk.share.empty")}
          label={t("bookmarks.bulk.share.label")}
          loadingLabel={targets.isPending ? t("bookmarks.bulk.share.loading") : undefined}
          onSearchChange={setSearch}
          onValueChange={(value) => {
            setChosen([...(targets.data ?? []), ...(chosen === undefined ? [] : [chosen])].find((target) => targetKey(target) === value));
          }}
          options={options}
          placeholder={t("bookmarks.bulk.share.placeholder")}
          unavailableLabel={targets.isError && targets.data === undefined ? t("bookmarks.bulk.share.loadFailed") : undefined}
          value={chosen === undefined ? undefined : targetKey(chosen)}
        />
        {choice === undefined ? null : (
          <section aria-label={t("bookmarks.bulk.share.preview.title")} className="flex flex-col gap-2 rounded-lg border bg-muted/48 p-3 text-sm" data-slot="bulk-share-preview">
            <h3 className="font-medium">{t("bookmarks.bulk.share.preview.title")}</h3>
            {preview.isError ? (
              <div className="flex flex-wrap items-center gap-x-2 text-destructive-text" role="alert">
                {t("bookmarks.bulk.share.preview.error")}
                <Button loading={preview.isFetching} onClick={() => void preview.refetch()} size="xs" type="button" variant="outline">
                  {t("bookmarks.bulk.share.retry")}
                </Button>
              </div>
            ) : previewed === undefined ? (
              <p className="text-muted-foreground" role="status">
                {t("bookmarks.bulk.share.preview.loading")}
              </p>
            ) : previewed.affected === 0 ? (
              <p>{t("bookmarks.bulk.share.preview.none")}</p>
            ) : (
              <>
                <p>{t("bookmarks.bulk.share.preview.summary", { count: previewed.affected, name: previewed.audience.name })}</p>
                <p className="text-muted-foreground">{t("bookmarks.bulk.share.preview.added", { added: previewed.audience.added })}</p>
                <p className="text-muted-foreground">{t("bookmarks.bulk.share.preview.audience", { count: previewed.audience.memberCount })}</p>
              </>
            )}
            {previewed === undefined || previewed.skipped === 0 ? null : <p className="text-muted-foreground">{t("bookmarks.bulk.share.preview.skipped", { count: previewed.skipped })}</p>}
          </section>
        )}
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button onClick={onClose} type="button" variant="outline">
            {t("bookmarks.bulk.share.cancel")}
          </Button>
          <Button disabled={previewed === undefined || previewed.affected === 0} type="submit">
            {t("bookmarks.bulk.share.action")}
          </Button>
        </div>
      </form>
    </FormOverlay>
  );
}
