import { Button, Input } from "@slugbase/ui";
import { Banner, FormField, FormOverlay, Loading, MultiPick, TextareaField, feedbackToast, type PickerOption } from "@slugbase/ui/patterns";
import { useIsMutating, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useState, type ReactElement, type SyntheticEvent } from "react";
import { useTranslation } from "react-i18next";
import { ApiProblemError } from "../api/client.ts";
import { inPlaceRefusals } from "../shell/mutation-error-toasts.tsx";
import { MEMBERS_QUERY_KEY } from "../shell/workspace-members.ts";
import {
  TEAMS_QUERY_KEY,
  TEAM_DESCRIPTION_MAX_LENGTH,
  TEAM_NAME_MAX_LENGTH,
  saveTeam,
  teamFailureOf,
  teamForEditQuery,
  type Team,
  type TeamFailure,
  type TeamWithMembers,
} from "./teams.ts";
import { useAllMembers } from "./use-all-members.ts";

const SECONDS_PER_MINUTE = 60;
const SAVE_KEY = ["teams", "save"] as const;

// The refusals `teamFailureOf` tells in the form, for which the shared error toast stays quiet; any other failure still raises it.
const SHOWN_IN_THE_FORM = inPlaceRefusals([
  { status: 409, code: "name_taken" },
  { status: 422 },
  { status: 412, code: "precondition_failed" },
  { status: 404, code: "not_found" },
  { status: 429, code: "rate_limited" },
]);

export interface TeamFormProps {
  /** The team to change, as listed; none for a new one. */
  readonly team?: Team | undefined;
  readonly onClose: () => void;
}

function sortedOptions(options: ReadonlyMap<string, PickerOption>): PickerOption[] {
  return [...options.values()].sort((a, b) => a.label.localeCompare(b.label) || a.value.localeCompare(b.value));
}

function TeamFormBody({ initial, onClose }: { initial: TeamWithMembers | undefined; onClose: () => void }): ReactElement {
  const { t } = useTranslation();
  const router = useRouter();
  const queryClient = useQueryClient();
  const api = router.options.context.api;
  const everyone = useAllMembers();
  // What the server holds of the team as far as this form knows: the team it opened with, moved on by every step that went through.
  const [base, setBase] = useState<TeamWithMembers | undefined>(initial);
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [memberIds, setMemberIds] = useState<readonly string[]>(initial?.members.map(({ accountId }) => accountId) ?? []);
  const [nameRequired, setNameRequired] = useState(false);
  const [failure, setFailure] = useState<TeamFailure | undefined>(undefined);

  const save = useMutation({
    mutationKey: SAVE_KEY,
    meta: SHOWN_IN_THE_FORM,
    mutationFn: (draft: { name: string; description: string; memberIds: readonly string[] }) => saveTeam(api, base, draft, setBase),
    onSuccess: () => {
      feedbackToast.success(initial === undefined ? t("teams.form.saved.created") : t("teams.form.saved.updated"));
      onClose();
    },
    onError: (error) => {
      const next = teamFailureOf(error);
      setFailure(next);
      if (next?.kind === "memberGone") {
        void queryClient.invalidateQueries({ queryKey: MEMBERS_QUERY_KEY });
      }
    },
    // A step that went through before a later one failed has changed the list, so it is read again whatever the end.
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: TEAMS_QUERY_KEY });
      // The members page shows each member's teams.
      void queryClient.invalidateQueries({ queryKey: MEMBERS_QUERY_KEY });
    },
  });

  const options = new Map<string, PickerOption>();
  for (const member of everyone.members) {
    options.set(member.accountId, { value: member.accountId, label: member.displayName, description: member.email });
  }
  // A member of the team has an option whether or not the list of the workspace's members has reached them, so a choice never drops them.
  for (const member of base?.members ?? []) {
    if (!options.has(member.accountId)) {
      options.set(member.accountId, { value: member.accountId, label: member.displayName, description: member.email });
    }
  }
  const optionList = sortedOptions(options);

  function submit(event: SyntheticEvent): void {
    event.preventDefault();
    if (save.isPending) {
      return;
    }
    const trimmed = name.trim();
    if (trimmed === "") {
      setNameRequired(true);
      return;
    }
    setFailure(undefined);
    save.mutate({ name: trimmed, description: description.trim(), memberIds });
  }

  function failureMessage(value: TeamFailure): string {
    switch (value.kind) {
      case "nameTaken":
        return t("teams.form.name.error.taken");
      case "invalidName":
        return t("teams.form.name.error.invalid", { max: TEAM_NAME_MAX_LENGTH });
      case "memberGone":
        return t("teams.form.error.memberGone");
      case "changedElsewhere":
        return t("teams.form.error.changedElsewhere");
      case "notFound":
        return t("teams.form.error.notFound");
      case "unavailable":
        return t("teams.form.error.unavailable");
      case "rateLimited":
        if (value.seconds === undefined) {
          return t("reauth.error.rateLimited.unknown");
        }
        return value.seconds < SECONDS_PER_MINUTE
          ? t("reauth.error.rateLimited.seconds", { count: value.seconds })
          : t("reauth.error.rateLimited.minutes", { count: Math.ceil(value.seconds / SECONDS_PER_MINUTE) });
    }
  }

  const nameFailure = failure?.kind === "nameTaken" || failure?.kind === "invalidName";
  // Some of the steps went through already: the team exists or has its new name, and the members are what is left.
  const partlySaved = failure !== undefined && !nameFailure && base !== initial;

  return (
    <form className="flex flex-col gap-4" noValidate onSubmit={submit}>
      {failure === undefined || nameFailure ? null : (
        <Banner
          description={partlySaved ? t("teams.form.error.partlySaved") : undefined}
          title={failureMessage(failure)}
          variant="error"
        />
      )}
      <FormField
        error={nameFailure ? failureMessage(failure) : nameRequired ? t("teams.form.name.error.required") : undefined}
        label={t("teams.form.name.label")}
        name="name"
      >
        <Input
          autoComplete="off"
          disabled={save.isPending}
          maxLength={TEAM_NAME_MAX_LENGTH}
          onChange={(event) => {
            setName(event.target.value);
            setNameRequired(false);
            if (nameFailure) {
              setFailure(undefined);
            }
          }}
          value={name}
        />
      </FormField>
      <TextareaField
        counter={t("teams.form.description.counter", { count: description.length, max: TEAM_DESCRIPTION_MAX_LENGTH })}
        disabled={save.isPending}
        label={t("teams.form.description.label")}
        maxLength={TEAM_DESCRIPTION_MAX_LENGTH}
        name="description"
        onChange={setDescription}
        value={description}
      />
      <MultiPick
        disabled={save.isPending}
        emptyLabel={t("teams.form.members.empty")}
        label={t("teams.form.members.label")}
        loadingLabel={everyone.status === "loading" ? t("teams.form.members.loading") : undefined}
        onValueChange={setMemberIds}
        options={optionList}
        placeholder={t("teams.form.members.placeholder")}
        removeLabel={(label) => t("teams.form.members.remove", { name: label })}
        unavailableLabel={everyone.status === "failed" ? t("teams.form.members.unavailable") : undefined}
        value={memberIds}
      />
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button disabled={save.isPending} onClick={onClose} type="button" variant="outline">
          {t("teams.form.cancel")}
        </Button>
        <Button loading={save.isPending} type="submit">
          {initial === undefined ? t("teams.form.submit.create") : t("teams.form.submit.update")}
        </Button>
      </div>
    </form>
  );
}

function EditTeamBody({ team, onClose }: { team: Team; onClose: () => void }): ReactElement {
  const { t } = useTranslation();
  const router = useRouter();
  const queryClient = useQueryClient();
  const read = useQuery(teamForEditQuery(router.options.context.api, team.id));
  if (read.data !== undefined) {
    return <TeamFormBody initial={read.data} onClose={onClose} />;
  }
  if (read.isError) {
    const gone = read.error instanceof ApiProblemError && read.error.status === 404;
    return (
      <Banner
        action={
          gone ? (
            <Button
              onClick={() => {
                void queryClient.invalidateQueries({ queryKey: TEAMS_QUERY_KEY });
                onClose();
              }}
              size="sm"
              variant="outline"
            >
              {t("teams.form.close")}
            </Button>
          ) : (
            <Button
              onClick={() => {
                void read.refetch();
              }}
              size="sm"
              variant="outline"
            >
              {t("settings.account.loadFailed.retry")}
            </Button>
          )
        }
        title={gone ? t("teams.form.error.notFound") : t("teams.form.loadFailed")}
        variant="error"
      />
    );
  }
  return <Loading className="p-0" label={t("teams.form.loading")} />;
}

/**
 * The form that creates a team and, with the same fields, changes one (doc 03 section 11.8, `form-overlay`): the name, the
 * description and the members in a `multi-pick` over the workspace's members. Changing a team starts from the team as the server
 * holds it with its members and is made against its version, so a team changed elsewhere is refused instead of overwritten. The
 * name, the description and the members are separate requests; when a later one fails the earlier ones stand, the form says so
 * and a second try sends what is left. The overlay stays open on a failure.
 */
export function TeamForm({ team, onClose }: TeamFormProps): ReactElement {
  const { t } = useTranslation();
  const saving = useIsMutating({ mutationKey: SAVE_KEY }) > 0;
  return (
    <FormOverlay
      closeLabel={t("teams.form.close")}
      description={t("teams.form.intro")}
      onOpenChange={(open) => {
        if (!open && !saving) {
          onClose();
        }
      }}
      open
      title={team === undefined ? t("teams.form.title.create") : t("teams.form.title.update", { name: team.name })}
    >
      {team === undefined ? <TeamFormBody initial={undefined} onClose={onClose} /> : <EditTeamBody onClose={onClose} team={team} />}
    </FormOverlay>
  );
}
