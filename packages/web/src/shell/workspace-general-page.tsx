import { Button, Input } from "@slugbase/ui";
import { AccountAvatar, Banner, FormField, Loading, SettingsSection, feedbackToast } from "@slugbase/ui/patterns";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useState, type ReactElement, type SyntheticEvent } from "react";
import { useTranslation } from "react-i18next";
import { ME_QUERY_KEY, type Me } from "../account/me.ts";
import { ApiProblemError } from "../api/client.ts";
import { WORKSPACES_QUERY_KEY } from "./workspaces.ts";
import { WORKSPACE_QUERY_KEY, canAdminister, renameWorkspace, workspaceQuery, type Workspace } from "./workspace.ts";

const NAME_MAX_LENGTH = 64;

type NameError = "required" | "tooLong";

function GeneralForm({ workspace, onReload, reloading }: { workspace: Workspace; onReload: () => void; reloading: boolean }): ReactElement {
  const { t } = useTranslation();
  const router = useRouter();
  const queryClient = useQueryClient();
  const editable = canAdminister(workspace.role);
  const [name, setName] = useState(workspace.name);
  const [clientError, setClientError] = useState<NameError | undefined>(undefined);

  const save = useMutation({
    // A `422` is shown beside the field; every other failure is reported by the shared error toast and by the banner below.
    meta: { fieldErrors: true },
    mutationFn: (next: string) => renameWorkspace(router.options.context.api, next, workspace.version),
    onSuccess: (saved) => {
      queryClient.setQueryData<Workspace>(WORKSPACE_QUERY_KEY, saved);
      queryClient.setQueryData<Me>(ME_QUERY_KEY, (me) =>
        me === undefined
          ? me
          : { ...me, memberships: me.memberships.map((membership) => (membership.workspaceId === saved.id ? { ...membership, name: saved.name } : membership)) },
      );
      void queryClient.invalidateQueries({ queryKey: WORKSPACES_QUERY_KEY });
      feedbackToast.success(t("settings.workspace.saved"));
    },
  });

  const trimmed = name.trim();
  const dirty = trimmed !== workspace.name;
  const failure = save.error instanceof ApiProblemError ? save.error : undefined;
  const stale = failure?.status === 412;
  const refused = failure?.status === 422;
  const forbidden = failure?.status === 403;
  const unsaved = save.isError && !stale && !refused && !forbidden;

  function nameMessage(): string | undefined {
    if (clientError === "required") {
      return t("settings.workspace.name.error.required");
    }
    if (clientError === "tooLong") {
      return t("settings.workspace.name.error.tooLong");
    }
    return refused ? t("settings.workspace.name.error.invalid") : undefined;
  }

  function submit(event: SyntheticEvent): void {
    event.preventDefault();
    if (!editable || save.isPending || !dirty) {
      return;
    }
    if (trimmed === "") {
      setClientError("required");
      return;
    }
    if (Array.from(trimmed).length > NAME_MAX_LENGTH) {
      setClientError("tooLong");
      return;
    }
    setClientError(undefined);
    save.mutate(trimmed);
  }

  return (
    <form noValidate onSubmit={submit}>
      <SettingsSection
        description={t("settings.workspace.section.description")}
        footer={
          editable ? (
            <Button disabled={!dirty || stale} loading={save.isPending} type="submit">
              {t("settings.workspace.save")}
            </Button>
          ) : undefined
        }
        title={t("settings.workspace.section.title")}
      >
        <div className="flex flex-col gap-5">
          <div className="flex items-center gap-4">
            <AccountAvatar name={trimmed === "" ? workspace.name : trimmed} seed={workspace.id} size="lg" />
            <p className="text-muted-foreground text-sm">{t("settings.workspace.monogram.caption")}</p>
          </div>
          <FormField
            description={editable ? undefined : t("settings.workspace.name.readOnly")}
            error={nameMessage()}
            label={t("settings.workspace.name.label")}
            name="name"
          >
            <Input
              autoComplete="off"
              disabled={save.isPending}
              onChange={(event) => {
                setName(event.target.value);
                setClientError(undefined);
                if (!stale) {
                  save.reset();
                }
              }}
              readOnly={!editable}
              value={name}
            />
          </FormField>
          {stale ? (
            <Banner
              action={
                <Button loading={reloading} onClick={onReload} size="sm" variant="outline">
                  {t("settings.workspace.stale.reload")}
                </Button>
              }
              description={t("settings.workspace.stale.description")}
              title={t("settings.workspace.stale.title")}
              variant="warning"
            />
          ) : null}
          {forbidden ? <Banner title={t("settings.workspace.forbidden")} variant="error" /> : null}
          {unsaved ? <Banner title={t("settings.workspace.saveFailed")} variant="error" /> : null}
        </div>
      </SettingsSection>
    </form>
  );
}

/** `/settings/workspace` (doc 03 section 11.6): the workspace's name, which admins and owners can change, and its monogram. */
export function WorkspaceGeneralPage(): ReactElement {
  const { t } = useTranslation();
  const router = useRouter();
  const workspace = useQuery(workspaceQuery(router.options.context.api));

  return (
    <div className="flex flex-col gap-4">
      <h1 className="font-semibold text-xl">{t("settings.workspace.title")}</h1>
      {workspace.data === undefined ? null : (
        // A new version means the name came from the server again, so the form starts from it.
        <GeneralForm
          key={workspace.data.version}
          onReload={() => {
            void workspace.refetch();
          }}
          reloading={workspace.isFetching}
          workspace={workspace.data}
        />
      )}
      {workspace.isPending ? <Loading label={t("shell.loading")} /> : null}
      {workspace.isError ? (
        <Banner
          action={
            <Button
              onClick={() => {
                void workspace.refetch();
              }}
              size="sm"
              variant="outline"
            >
              {t("settings.account.loadFailed.retry")}
            </Button>
          }
          description={t("settings.account.loadFailed.description")}
          title={t("settings.workspace.loadFailed.title")}
          variant="error"
        />
      ) : null}
    </div>
  );
}
