import { Button, Skeleton } from "@slugbase/ui";
import { AccountAvatar, AvatarStack, Banner, FormOverlay, InlineNote, Picker, UsersIcon, XIcon, feedbackToast, type PickerOption } from "@slugbase/ui/patterns";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import type { TFunction } from "i18next";
import { useMemo, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { meQuery } from "../account/me.ts";
import { ApiProblemError } from "../api/client.ts";
import { FOLDERS_QUERY_KEY } from "../folders/folders.ts";
import { rateLimitMessage } from "../bookmarks/rate-limit-message.ts";
import { inPlaceRefusals } from "../shell/mutation-error-toasts.tsx";
import { teamQuery } from "../teams/teams.ts";
import {
  SHARES_QUERY_KEY,
  addShare,
  removeShare,
  shareFailureOf,
  shareTargetKey,
  shareTargetsQuery,
  sharesQuery,
  targetKey,
  type Share,
  type ShareFailure,
  type ShareSubject,
  type ShareTarget,
} from "./shares.ts";
import { SharingGate } from "./sharing-gate.tsx";
import { useDebounced } from "./use-debounced.ts";

const SEARCH_DELAY_MS = 200;
const SKELETON_ROWS = ["a", "b"] as const;

// The refusals `shareFailureOf` tells in a toast of the dialog, for which the shared error toast stays quiet; any other failure still raises it.
const SHOWN_BY_THE_DIALOG = inPlaceRefusals([
  { status: 404, code: "not_found" },
  { status: 422 },
  { status: 429, code: "rate_limited" },
]);

/** The toast for a refusal the dialog tells itself; any other failure is reported by the shared error toast. */
function failureMessage(t: TFunction, kind: ShareSubject["kind"], failure: ShareFailure, name: string): string | undefined {
  switch (failure.kind) {
    case "notFound":
      return kind === "bookmark" ? t("sharing.dialog.toast.gone.bookmark") : t("sharing.dialog.toast.gone.folder");
    case "targetGone":
      return t("sharing.dialog.toast.targetGone", { name });
    case "rateLimited":
      return rateLimitMessage(t, failure.seconds);
    case "unavailable":
      return undefined;
  }
}

function GrantRow({ subject, share }: { subject: ShareSubject; share: Share }): ReactElement {
  const { t } = useTranslation();
  const router = useRouter();
  const queryClient = useQueryClient();
  const api = router.options.context.api;
  const remove = useMutation({
    mutationKey: ["shares", "remove"],
    meta: SHOWN_BY_THE_DIALOG,
    mutationFn: () => removeShare(api, subject, share.id),
    onSuccess: () => {
      feedbackToast.success(t("sharing.dialog.toast.removed", { name: share.name }));
    },
    onError: (error) => {
      const failure = shareFailureOf(error);
      if (failure === undefined) {
        return;
      }
      // A share that is gone already is gone from the list too once it is read again.
      if (failure.kind === "notFound") {
        feedbackToast.info(t("sharing.dialog.toast.removeGone", { name: share.name }));
        return;
      }
      const message = failureMessage(t, subject.kind, failure, share.name);
      if (message !== undefined) {
        feedbackToast.error(message);
      }
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: SHARES_QUERY_KEY });
      if (subject.kind === "folder") {
        // The Folders page says how each folder is shared (its share summary), which this change has just moved.
        void queryClient.invalidateQueries({ queryKey: FOLDERS_QUERY_KEY });
      }
    },
  });
  return (
    <li className="flex items-center gap-3 py-2">
      {share.kind === "member" ? (
        <AccountAvatar name={share.name} seed={share.accountId ?? share.id} />
      ) : (
        <span aria-hidden="true" className="inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <UsersIcon className="size-3.5" />
        </span>
      )}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="wrap-anywhere font-medium text-sm">{share.name}</span>
        {share.kind === "member" && share.email !== null ? <span className="wrap-anywhere text-muted-foreground text-xs">{share.email}</span> : null}
      </span>
      <span className="text-muted-foreground text-xs">{share.kind === "member" ? t("sharing.dialog.row.member") : t("sharing.dialog.row.team")}</span>
      <Button
        aria-label={t("sharing.dialog.row.remove", { name: share.name })}
        loading={remove.isPending}
        onClick={() => {
          remove.mutate();
        }}
        size="icon-sm"
        variant="ghost"
      >
        <XIcon aria-hidden="true" />
      </Button>
    </li>
  );
}

/** The people who can read the subject through its shares, as far as they are known: the members it is shared with, and the members of the teams it is shared with once those are read. */
function useAudience(shares: readonly Share[]): { readonly id: string; readonly name: string }[] {
  const router = useRouter();
  const api = router.options.context.api;
  const me = useQuery({ ...meQuery(api), staleTime: Number.POSITIVE_INFINITY });
  const teams = useQueries({
    queries: shares.flatMap((share) => (share.kind === "team" && share.teamId !== null ? [teamQuery(api, share.teamId)] : [])),
  });
  const people = new Map<string, string>();
  for (const share of shares) {
    if (share.kind === "member" && share.accountId !== null) {
      people.set(share.accountId, share.name);
    }
  }
  for (const team of teams) {
    for (const member of team.data?.members ?? []) {
      people.set(member.accountId, member.displayName);
    }
  }
  if (me.data !== undefined) {
    people.delete(me.data.account.id);
  }
  return [...people].map(([id, name]) => ({ id, name }));
}

function ShareDialogContent({ subject, onClose }: { subject: ShareSubject; onClose: () => void }): ReactElement {
  const { t } = useTranslation();
  const router = useRouter();
  const queryClient = useQueryClient();
  const api = router.options.context.api;
  const shares = useQuery(sharesQuery(api, subject));
  const [search, setSearch] = useState("");
  const targets = useQuery(shareTargetsQuery(api, useDebounced(search, SEARCH_DELAY_MS)));
  const granted = useMemo(() => shares.data?.items ?? [], [shares.data]);
  const audience = useAudience(granted);

  const add = useMutation({
    mutationKey: ["shares", "add"],
    meta: SHOWN_BY_THE_DIALOG,
    mutationFn: (target: ShareTarget) => addShare(api, subject, target),
    onSuccess: (_share, target) => {
      feedbackToast.success(t("sharing.dialog.toast.added", { name: target.name }));
    },
    onError: (error, target) => {
      const failure = shareFailureOf(error);
      const message = failure === undefined ? undefined : failureMessage(t, subject.kind, failure, target.name);
      if (message !== undefined) {
        feedbackToast.error(message);
      }
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: SHARES_QUERY_KEY });
      if (subject.kind === "folder") {
        // The Folders page says how each folder is shared (its share summary), which this change has just moved.
        void queryClient.invalidateQueries({ queryKey: FOLDERS_QUERY_KEY });
      }
    },
  });

  const members = t("sharing.dialog.picker.members");
  const teams = t("sharing.dialog.picker.teams");
  // The picker keeps what the member typed only while the options it is given stay the same objects between renders.
  const options = useMemo(() => {
    const taken = new Set(granted.map(shareTargetKey));
    const free = (targets.data ?? []).filter((target) => !taken.has(targetKey(target)));
    const option = (target: ShareTarget): PickerOption => ({
      value: targetKey(target),
      label: target.name,
      ...(target.email === null ? {} : { description: target.email }),
      ...(target.kind === "team" ? { icon: <UsersIcon className="size-4" /> } : {}),
      group: target.kind === "member" ? members : teams,
    });
    return [...free.filter(({ kind }) => kind === "member"), ...free.filter(({ kind }) => kind === "team")].map(option);
  }, [granted, targets.data, members, teams]);

  const gone = shares.error instanceof ApiProblemError && shares.error.status === 404;
  const count = shares.data?.audienceSize ?? 0;

  let list: ReactElement;
  if (shares.isPending) {
    list = (
      <div aria-busy="true" aria-label={t("sharing.dialog.list.loading")} className="flex flex-col gap-2" role="status">
        {SKELETON_ROWS.map((key) => (
          <Skeleton className="h-9 rounded-lg" key={key} />
        ))}
      </div>
    );
  } else if (shares.isError && shares.data === undefined) {
    list = (
      <Banner
        action={
          gone ? undefined : (
            <Button
              loading={shares.isFetching}
              onClick={() => {
                void shares.refetch();
              }}
              size="sm"
              variant="outline"
            >
              {t("sharing.dialog.retry")}
            </Button>
          )
        }
        title={gone ? (subject.kind === "bookmark" ? t("sharing.dialog.toast.gone.bookmark") : t("sharing.dialog.toast.gone.folder")) : t("sharing.dialog.list.loadFailed")}
        variant="error"
      />
    );
  } else if (granted.length === 0) {
    list = <p className="text-muted-foreground text-sm">{t("sharing.dialog.list.empty")}</p>;
  } else {
    list = (
      <ul aria-label={t("sharing.dialog.list.label")} className="divide-y">
        {granted.map((share) => (
          <GrantRow key={share.id} share={share} subject={subject} />
        ))}
      </ul>
    );
  }

  return (
    <FormOverlay
      closeLabel={t("sharing.dialog.close")}
      description={subject.kind === "bookmark" ? t("sharing.dialog.description.bookmark") : t("sharing.dialog.description.folder")}
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
      open
      title={subject.kind === "bookmark" ? t("sharing.dialog.title.bookmark", { name: subject.name }) : t("sharing.dialog.title.folder", { name: subject.name })}
    >
      <div className="flex flex-col gap-4">
        <Picker
          disabled={shares.data === undefined || add.isPending}
          emptyLabel={t("sharing.dialog.picker.empty")}
          label={t("sharing.dialog.picker.label")}
          loadingLabel={targets.isPending ? t("sharing.dialog.picker.loading") : undefined}
          onSearchChange={setSearch}
          onValueChange={(value) => {
            const chosen = targets.data?.find((target) => targetKey(target) === value);
            if (chosen !== undefined) {
              add.mutate(chosen);
            }
          }}
          options={options}
          placeholder={t("sharing.dialog.picker.placeholder")}
          unavailableLabel={targets.isError && targets.data === undefined ? t("sharing.dialog.picker.unavailable") : undefined}
          value={undefined}
        />
        {list}
        <InlineNote>{subject.kind === "bookmark" ? t("sharing.dialog.note.bookmark") : t("sharing.dialog.note.folder")}</InlineNote>
        <div className="flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-2 text-sm">
            {audience.length > 0 ? <AvatarStack label={t("sharing.dialog.audience.stack", { names: audience.map(({ name }) => name).join(", ") })} people={audience} /> : null}
            {shares.data === undefined ? null : (
              <span aria-live="polite" className="text-muted-foreground">
                {count === 0 ? t("sharing.dialog.audience.none") : t("sharing.dialog.audience.some", { count })}
              </span>
            )}
          </div>
          <Button onClick={onClose} type="button" variant="outline">
            {t("sharing.dialog.done")}
          </Button>
        </div>
      </div>
    </FormOverlay>
  );
}

export interface ShareDialogProps {
  /** What is shared, which the caller owns: only the owner manages shares. */
  readonly subject: ShareSubject;
  readonly onClose: () => void;
}

/**
 * The share dialog of a bookmark or a folder (doc 03 section 5): a grouped, searchable `picker` over the members and teams the
 * workspace may share with adds a grant, each grant is a row that removes it, and every change is a request of its own that
 * applies at once and says so in a toast. The footer says how many members can read what is shared, with their avatars, and an
 * `inline-note` says that sharing is read-only (Q22). It renders inside the sharing entitlement gate.
 */
export function ShareDialog({ subject, onClose }: ShareDialogProps): ReactElement {
  return (
    <SharingGate>
      <ShareDialogContent onClose={onClose} subject={subject} />
    </SharingGate>
  );
}
