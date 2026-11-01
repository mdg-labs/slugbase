import { Button } from "@slugbase/ui";
import { Banner, InlineNote, Loading, SettingSwitch, SettingsSection } from "@slugbase/ui/patterns";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Navigate, useRouter } from "@tanstack/react-router";
import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { ME_QUERY_KEY, meQuery } from "../account/me.ts";
import { ApiProblemError } from "../api/client.ts";
import { useConfig } from "../config/config-context.tsx";
import { EntitlementGate } from "../entitlements/index.ts";
import { WorkspaceAdminOnly } from "./workspace-admin-only.tsx";
import { updateWorkspaceSettings, workspaceSettingsKey, workspaceSettingsQuery, type WorkspaceSettings } from "./workspace-settings.ts";
import { WORKSPACE_QUERY_KEY } from "./workspace.ts";

function AiSwitch({ workspaceId, settings }: { workspaceId: string; settings: WorkspaceSettings }): ReactElement {
  const { t } = useTranslation();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { features } = useConfig();
  const key = workspaceSettingsKey(workspaceId);

  const save = useMutation({
    mutationKey: ["workspace", "settings", "ai"],
    mutationFn: (aiEnabled: boolean) => updateWorkspaceSettings(router.options.context.api, { aiEnabled }),
    // The change goes to the cache of the workspace the save started in, whichever workspace the session acts in by the time it answers.
    onMutate: async (aiEnabled) => {
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<WorkspaceSettings>(key);
      queryClient.setQueryData<WorkspaceSettings>(key, { ...settings, aiEnabled });
      return { previous };
    },
    onError: (error, _aiEnabled, context) => {
      queryClient.setQueryData<WorkspaceSettings>(key, context?.previous ?? settings);
      // A failed save may still have been applied, and a second change may have been made from the first one's optimistic value: read the stored value again.
      void queryClient.invalidateQueries({ queryKey: key, exact: true });
      if (error instanceof ApiProblemError && error.status === 403) {
        // The role was withdrawn meanwhile: read it again, so the page closes instead of offering a change the server refuses.
        void queryClient.invalidateQueries({ queryKey: WORKSPACE_QUERY_KEY, exact: true });
        void queryClient.invalidateQueries({ queryKey: ME_QUERY_KEY });
      }
    },
    onSuccess: (saved) => {
      queryClient.setQueryData<WorkspaceSettings>(key, saved);
    },
  });

  const provider = features.aiProvider;
  return (
    <SettingsSection description={t("settings.workspace.ai.section.description")} title={t("settings.workspace.ai.section.title")}>
      <div className="flex flex-col gap-4">
        <SettingSwitch
          checked={settings.aiEnabled}
          description={t("settings.workspace.ai.switch.description")}
          disabled={save.isPending}
          label={t("settings.workspace.ai.switch.label")}
          name="aiEnabled"
          onCheckedChange={(aiEnabled) => {
            save.mutate(aiEnabled);
          }}
        />
        <InlineNote>{provider === undefined ? t("settings.workspace.ai.note.unnamed") : t("settings.workspace.ai.note.named", { provider })}</InlineNote>
      </div>
    </SettingsSection>
  );
}

function AiSettings(): ReactElement | null {
  const { t } = useTranslation();
  const router = useRouter();
  const api = router.options.context.api;
  // The workspace is the one the session acts in, as the account has it. The key follows a switch once the account confirms it; a read that overlaps the switch can land under the old key, and the read on return replaces it.
  const me = useQuery({ ...meQuery(api), staleTime: Number.POSITIVE_INFINITY });
  const workspaceId = me.data?.activeWorkspaceId ?? undefined;
  const settings = useQuery({ ...workspaceSettingsQuery(api, workspaceId ?? ""), enabled: workspaceId !== undefined });

  // An account that now acts in no workspace has no setting to show: this page sends it to the page the route guard and /go use, while the setting would be shown.
  if (me.data?.activeWorkspaceId === null) {
    return <Navigate replace to="/no-workspace" />;
  }
  if (workspaceId !== undefined && settings.data !== undefined) {
    return <AiSwitch key={workspaceId} settings={settings.data} workspaceId={workspaceId} />;
  }
  const failed = workspaceId === undefined ? me : settings;
  if (failed.isError) {
    return (
      <Banner
        action={
          <Button
            loading={failed.isFetching}
            onClick={() => {
              void failed.refetch();
            }}
            size="sm"
            variant="outline"
          >
            {t("settings.account.loadFailed.retry")}
          </Button>
        }
        description={t("settings.account.loadFailed.description")}
        title={t("settings.workspace.ai.loadFailed.title")}
        variant="error"
      />
    );
  }
  return <Loading label={t("shell.loading")} />;
}

function AiSection(): ReactElement {
  const { t } = useTranslation();
  const { features } = useConfig();
  if (!features.ai) {
    return (
      <SettingsSection description={t("settings.workspace.ai.section.description")} title={t("settings.workspace.ai.section.title")}>
        <InlineNote>{t("settings.workspace.ai.unavailable")}</InlineNote>
      </SettingsSection>
    );
  }
  return <AiSettings />;
}

/**
 * `/settings/workspace/ai` (doc 03 section 11.10): the workspace's switch for AI suggestions, which admins and owners can change, gated by `ai.suggestions`.
 * A server without an AI port gets the note that it is not available and no controls; the provider and the credentials are the operator's (D22).
 */
export function WorkspaceAiPage(): ReactElement {
  const { t } = useTranslation();
  return (
    <WorkspaceAdminOnly>
      <div className="flex flex-col gap-4">
        <h1 className="font-semibold text-xl">{t("settings.workspace.ai.title")}</h1>
        <EntitlementGate name="ai.suggestions">
          <AiSection />
        </EntitlementGate>
      </div>
    </WorkspaceAdminOnly>
  );
}
