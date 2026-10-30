import { Button } from "@slugbase/ui";
import { Banner, FormOverlay, MultiPick, feedbackToast, type PickerOption } from "@slugbase/ui/patterns";
import { useIsMutating, useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useState, type ReactElement, type SyntheticEvent } from "react";
import { useTranslation } from "react-i18next";
import { inPlaceRefusals } from "../shell/mutation-error-toasts.tsx";
import { MEMBERS_QUERY_KEY, type Member } from "../shell/workspace-members.ts";
import { TEAMS_QUERY_KEY, saveMemberTeams, teamFailureOf, type TeamFailure } from "./teams.ts";
import { useAllTeams } from "./use-all-teams.ts";

const SECONDS_PER_MINUTE = 60;
const SAVE_KEY = ["teams", "member"] as const;

// The refusals `teamFailureOf` tells in the dialog, for which the shared error toast stays quiet; any other failure still raises it.
const SHOWN_IN_THE_DIALOG = inPlaceRefusals([
  { status: 404, code: "not_found" },
  { status: 412, code: "precondition_failed" },
  { status: 422 },
  { status: 429, code: "rate_limited" },
]);

function sortedOptions(options: ReadonlyMap<string, PickerOption>): PickerOption[] {
  return [...options.values()].sort((a, b) => a.label.localeCompare(b.label) || a.value.localeCompare(b.value));
}

/**
 * The teams of one member (doc 03 section 11.7, `Manage teams`, a `form-overlay` with a `multi-pick` over the workspace's teams).
 * Each team that changes is a separate request, read again before it is replaced and replaced against the version of that read, so when a later one fails the earlier ones stand:
 * the dialog stays open, says some changes were saved, and a second try sends what is left. The member list and the team lists are
 * read again whatever the end, since a step that went through has changed them.
 */
export function ManageTeamsDialog({ member, onClose }: { member: Member; onClose: () => void }): ReactElement {
  const { t } = useTranslation();
  const router = useRouter();
  const queryClient = useQueryClient();
  const api = router.options.context.api;
  const everyone = useAllTeams();
  const saving = useIsMutating({ mutationKey: SAVE_KEY }) > 0;
  const initial = member.teams.map(({ id }) => id);
  // The teams the member is in as far as this dialog knows: those it opened with, moved on by every step that went through.
  const [held, setHeld] = useState<readonly string[]>(initial);
  const [chosen, setChosen] = useState<readonly string[]>(initial);
  const [failure, setFailure] = useState<TeamFailure | undefined>(undefined);
  // A chosen team keeps its option whether or not the list of teams has it (a team deleted meanwhile, or not yet read).
  const [names, setNames] = useState<ReadonlyMap<string, string>>(new Map(member.teams.map(({ id, name }) => [id, name])));

  const save = useMutation({
    mutationKey: SAVE_KEY,
    meta: SHOWN_IN_THE_DIALOG,
    mutationFn: (wanted: readonly string[]) => saveMemberTeams(api, member.accountId, held, wanted, setHeld),
    onSuccess: () => {
      feedbackToast.success(t("settings.members.teams.saved", { name: member.displayName }));
      onClose();
    },
    onError: (error) => {
      setFailure(teamFailureOf(error) ?? { kind: "unavailable" });
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: MEMBERS_QUERY_KEY });
      void queryClient.invalidateQueries({ queryKey: TEAMS_QUERY_KEY });
    },
  });

  const options = new Map<string, PickerOption>();
  for (const team of everyone.teams) {
    options.set(team.id, { value: team.id, label: team.name });
  }
  for (const id of chosen) {
    const name = names.get(id);
    if (!options.has(id) && name !== undefined) {
      options.set(id, { value: id, label: name });
    }
  }
  const optionList = sortedOptions(options);

  function choose(next: string[]): void {
    setNames((current) => {
      const known = new Map(current);
      for (const team of everyone.teams) {
        known.set(team.id, team.name);
      }
      return known;
    });
    setChosen(next);
    setFailure(undefined);
  }

  function submit(event: SyntheticEvent): void {
    event.preventDefault();
    if (saving) {
      return;
    }
    setFailure(undefined);
    save.mutate(chosen);
  }

  function failureMessage(value: TeamFailure): string {
    switch (value.kind) {
      case "notFound":
        return t("settings.members.teams.error.teamGone");
      case "memberGone":
        return t("settings.members.teams.error.memberGone");
      case "changedElsewhere":
        return t("settings.members.teams.error.changedElsewhere");
      case "rateLimited":
        if (value.seconds === undefined) {
          return t("reauth.error.rateLimited.unknown");
        }
        return value.seconds < SECONDS_PER_MINUTE
          ? t("reauth.error.rateLimited.seconds", { count: value.seconds })
          : t("reauth.error.rateLimited.minutes", { count: Math.ceil(value.seconds / SECONDS_PER_MINUTE) });
      case "nameTaken":
      case "invalidName":
      case "unavailable":
        return t("settings.members.teams.error.unavailable");
    }
  }

  const partlySaved = failure !== undefined && (held.length !== initial.length || held.some((id) => !initial.includes(id)));

  return (
    <FormOverlay
      closeLabel={t("settings.members.teams.close")}
      description={t("settings.members.teams.description")}
      onOpenChange={(open) => {
        if (!open && !saving) {
          onClose();
        }
      }}
      open
      title={t("settings.members.teams.title", { name: member.displayName })}
    >
      <form className="flex flex-col gap-4" noValidate onSubmit={submit}>
        {failure === undefined ? null : (
          <Banner description={partlySaved ? t("settings.members.teams.error.partlySaved") : undefined} title={failureMessage(failure)} variant="error" />
        )}
        <MultiPick
          disabled={saving}
          emptyLabel={t("settings.members.teams.empty")}
          label={t("settings.members.teams.label")}
          loadingLabel={everyone.status === "loading" ? t("settings.members.teams.loading") : undefined}
          onValueChange={choose}
          options={optionList}
          placeholder={t("settings.members.teams.placeholder")}
          removeLabel={(label) => t("settings.members.teams.remove", { name: label })}
          unavailableLabel={everyone.status === "failed" ? t("settings.members.teams.unavailable") : undefined}
          value={chosen}
        />
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button disabled={saving} onClick={onClose} type="button" variant="outline">
            {t("settings.members.teams.cancel")}
          </Button>
          <Button loading={saving} type="submit">
            {t("settings.members.teams.submit")}
          </Button>
        </div>
      </form>
    </FormOverlay>
  );
}
