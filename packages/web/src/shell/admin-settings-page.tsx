import { Button, Input } from "@slugbase/ui";
import {
  Banner,
  DataTable,
  EmptyState,
  FormField,
  Loading,
  SettingSwitch,
  SettingsSection,
  ShieldCheckIcon,
  StatusBadge,
  feedbackToast,
  type DataTableColumn,
} from "@slugbase/ui/patterns";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useState, type ReactElement, type ReactNode, type SyntheticEvent } from "react";
import { useTranslation } from "react-i18next";
import { ME_QUERY_KEY } from "../account/me.ts";
import { useCachedAccount } from "../account/use-cached-account.ts";
import { useAdminActionsEnabled, useRefreshStandingOnForbidden } from "./admin-access.ts";
import { useRateLimitMessage } from "./admin-rate-limit.ts";
import {
  ADMIN_SETTINGS_QUERY_KEY,
  instanceSettingsQuery,
  sendTestMail,
  updateInstanceSettings,
  type InstanceSettings,
  type InstanceSettingsChanges,
  type SettingsRefusal,
} from "./admin-settings.ts";
import { instanceStatusQuery, type InstanceStatus } from "./instance-status.ts";
import { workspacesQuery } from "./workspaces.ts";

const DISPLAY_NAME_MAX_LENGTH = 100;
const SIGN_IN_NOTICE_MAX_LENGTH = 500;

function useRefusalMessage(): (refusal: SettingsRefusal) => string {
  const { t } = useTranslation();
  const rateLimitMessage = useRateLimitMessage();
  return (refusal) => {
    switch (refusal.kind) {
      case "forbidden":
        return t("admin.settings.error.forbidden");
      case "mailUnavailable":
        return t("admin.settings.test.error.mailUnavailable");
      case "invalid":
        return t("admin.settings.error.invalid");
      case "rateLimited":
        return rateLimitMessage(refusal.seconds);
    }
  };
}

function LoadFailed({ title, onRetry }: { title: string; onRetry: () => void }): ReactElement {
  const { t } = useTranslation();
  return (
    <Banner
      action={
        <Button onClick={onRetry} size="sm" variant="outline">
          {t("admin.settings.loadFailed.retry")}
        </Button>
      }
      description={t("admin.settings.loadFailed.description")}
      title={title}
      variant="error"
    />
  );
}

/** Saves a change to the settings, shows the refusal beside the control that made it, and keeps the answer as the stored settings. */
function useSaveSettings(onSaved: (saved: boolean) => void): {
  save: (changes: InstanceSettingsChanges) => void;
  pending: boolean;
  refusal: SettingsRefusal | undefined;
  clear: () => void;
} {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [refusal, setRefusal] = useState<SettingsRefusal | undefined>(undefined);
  const mutation = useMutation({
    mutationKey: ["admin", "settings", "save"],
    mutationFn: (changes: InstanceSettingsChanges) => updateInstanceSettings(router.options.context.api, changes),
    onSuccess: (outcome) => {
      if (outcome.status === "saved") {
        setRefusal(undefined);
        queryClient.setQueryData(ADMIN_SETTINGS_QUERY_KEY, outcome.settings);
        onSaved(true);
        return;
      }
      setRefusal(outcome.refusal);
      if (outcome.refusal.kind === "forbidden") {
        void queryClient.invalidateQueries({ queryKey: ME_QUERY_KEY });
      }
    },
  });
  return {
    save: (changes) => {
      setRefusal(undefined);
      onSaved(false);
      mutation.mutate(changes);
    },
    pending: mutation.isPending,
    refusal,
    clear: () => {
      setRefusal(undefined);
    },
  };
}

function WorkspaceCreationSection({ settings, onSaved }: { settings: InstanceSettings; onSaved: (saved: boolean) => void }): ReactElement {
  const { t } = useTranslation();
  const router = useRouter();
  const refusalMessage = useRefusalMessage();
  const { save, pending, refusal } = useSaveSettings(onSaved);
  // A setting that is not set leaves the deployment's default in force; the account's own ability to create tells what that is.
  const fallback = useQuery({ ...workspacesQuery(router.options.context.api), enabled: settings.allowWorkspaceCreation === null });
  const checked = settings.allowWorkspaceCreation ?? fallback.data?.canCreate ?? false;
  const notSet = settings.allowWorkspaceCreation === null;
  return (
    <SettingsSection description={t("admin.settings.creation.description")} title={t("admin.settings.creation.title")}>
      <SettingSwitch
        checked={checked}
        description={notSet ? t("admin.settings.creation.switch.notSet") : t("admin.settings.creation.switch.description")}
        disabled={pending || (notSet && fallback.data === undefined)}
        error={refusal === undefined ? undefined : refusal.kind === "invalid" ? t("admin.settings.creation.error.saveFailed") : refusalMessage(refusal)}
        label={t("admin.settings.creation.switch.label")}
        name="allowWorkspaceCreation"
        onCheckedChange={(allowWorkspaceCreation) => {
          save({ allowWorkspaceCreation });
        }}
      />
    </SettingsSection>
  );
}

function SignInForm({ settings, onSaved }: { settings: InstanceSettings; onSaved: (saved: boolean) => void }): ReactElement {
  const { t } = useTranslation();
  const refusalMessage = useRefusalMessage();
  const [displayName, setDisplayName] = useState(settings.displayName ?? "");
  const [signInNotice, setSignInNotice] = useState(settings.signInNotice ?? "");
  const { save, pending, refusal, clear } = useSaveSettings(onSaved);
  const trimmedName = displayName.trim();
  const trimmedNotice = signInNotice.trim();
  const nameChanged = trimmedName !== (settings.displayName ?? "");
  const noticeChanged = trimmedNotice !== (settings.signInNotice ?? "");
  const refusedFields = refusal?.kind === "invalid" ? refusal.fields : [];
  const nameError = refusedFields.includes("displayName") ? t("admin.settings.signIn.displayName.invalid") : undefined;
  const noticeError = refusedFields.includes("signInNotice") ? t("admin.settings.signIn.notice.invalid") : undefined;
  const generalError = refusal !== undefined && (refusal.kind !== "invalid" || (nameError === undefined && noticeError === undefined));

  function submit(event: SyntheticEvent): void {
    event.preventDefault();
    if (pending || (!nameChanged && !noticeChanged)) {
      return;
    }
    save({
      ...(nameChanged ? { displayName: trimmedName === "" ? null : trimmedName } : {}),
      ...(noticeChanged ? { signInNotice: trimmedNotice === "" ? null : trimmedNotice } : {}),
    });
  }

  return (
    <form noValidate onSubmit={submit}>
      <SettingsSection
        description={t("admin.settings.signIn.description")}
        footer={
          <Button disabled={!nameChanged && !noticeChanged} loading={pending} type="submit">
            {t("admin.settings.signIn.save")}
          </Button>
        }
        title={t("admin.settings.signIn.title")}
      >
        <div className="flex flex-col gap-4">
          {generalError ? <Banner title={refusal.kind === "invalid" ? t("admin.settings.error.invalid") : refusalMessage(refusal)} variant="error" /> : null}
          <FormField description={t("admin.settings.signIn.displayName.description")} error={nameError} label={t("admin.settings.signIn.displayName.label")} name="displayName">
            <Input
              autoComplete="off"
              disabled={pending}
              maxLength={DISPLAY_NAME_MAX_LENGTH}
              onChange={(event) => {
                setDisplayName(event.target.value);
                clear();
                onSaved(false);
              }}
              value={displayName}
            />
          </FormField>
          <FormField description={t("admin.settings.signIn.notice.description")} error={noticeError} label={t("admin.settings.signIn.notice.label")} name="signInNotice">
            <Input
              autoComplete="off"
              disabled={pending}
              maxLength={SIGN_IN_NOTICE_MAX_LENGTH}
              onChange={(event) => {
                setSignInNotice(event.target.value);
                clear();
                onSaved(false);
              }}
              value={signInNotice}
            />
          </FormField>
        </div>
      </SettingsSection>
    </form>
  );
}

function TestMailSection(): ReactElement {
  const { t } = useTranslation();
  const router = useRouter();
  const queryClient = useQueryClient();
  const account = useCachedAccount();
  const refusalMessage = useRefusalMessage();
  const send = useMutation({
    mutationKey: ["admin", "settings", "test-mail"],
    mutationFn: () => sendTestMail(router.options.context.api),
    onSuccess: (outcome) => {
      if (outcome.status === "queued") {
        feedbackToast.success(t("admin.settings.test.done", { email: account?.email ?? "" }));
        return;
      }
      feedbackToast.error(t("admin.settings.test.error.title"), refusalMessage(outcome.refusal));
      if (outcome.refusal.kind === "forbidden") {
        void queryClient.invalidateQueries({ queryKey: ME_QUERY_KEY });
      }
    },
  });
  return (
    <SettingsSection
      description={t("admin.settings.test.description", { email: account?.email ?? "" })}
      footer={
        <Button
          loading={send.isPending}
          onClick={() => {
            send.mutate();
          }}
          variant="outline"
        >
          {t("admin.settings.test.send")}
        </Button>
      }
      title={t("admin.settings.test.title")}
    >
      <p className="text-muted-foreground text-sm">{t("admin.settings.test.note")}</p>
    </SettingsSection>
  );
}

interface ConfigurationRow {
  readonly id: string;
  readonly label: string;
  readonly value: ReactNode;
}

function ConfigurationTable({ status }: { status: InstanceStatus }): ReactElement {
  const { t } = useTranslation();
  const flag = (on: boolean, on_: string, off: string): ReactElement => <StatusBadge variant={on ? "success" : "neutral"}>{on ? on_ : off}</StatusBadge>;
  const rows: readonly ConfigurationRow[] = [
    { id: "registration", label: t("admin.overview.configuration.registration"), value: flag(status.signIn.publicRegistration, t("admin.overview.configuration.on"), t("admin.overview.configuration.off")) },
    {
      id: "verification",
      label: t("admin.overview.configuration.verification"),
      value: flag(status.signIn.emailVerificationRequired, t("admin.overview.configuration.on"), t("admin.overview.configuration.off")),
    },
    { id: "mail", label: t("admin.overview.configuration.mail"), value: flag(status.ports.mail, t("admin.overview.configuration.configured"), t("admin.overview.configuration.notConfigured")) },
    { id: "ai", label: t("admin.overview.configuration.ai"), value: flag(status.ports.ai, t("admin.overview.configuration.configured"), t("admin.overview.configuration.notConfigured")) },
    {
      id: "errorReporting",
      label: t("admin.overview.configuration.errorReporting"),
      value: flag(status.ports.errorReporting, t("admin.overview.configuration.configured"), t("admin.overview.configuration.notConfigured")),
    },
    {
      id: "oidc",
      label: t("admin.overview.configuration.oidc"),
      value:
        status.oidcProviders.length === 0 ? (
          <StatusBadge>{t("admin.overview.configuration.noProviders")}</StatusBadge>
        ) : (
          <span className="flex flex-wrap gap-2">
            {status.oidcProviders.map((provider) => (
              <StatusBadge key={provider.slug} variant="success">
                {provider.name}
              </StatusBadge>
            ))}
          </span>
        ),
    },
  ];
  const columns: readonly DataTableColumn<ConfigurationRow>[] = [
    { id: "setting", header: t("admin.settings.configuration.column.setting"), cell: (row) => row.label },
    { id: "value", header: t("admin.settings.configuration.column.value"), cell: (row) => row.value },
  ];
  return <DataTable columns={columns} label={t("admin.settings.configuration.label")} rowKey={(row) => row.id} rows={rows} />;
}

/**
 * `/admin/settings`, the settings and status of the instance (doc 03 section 12): whether members may create workspaces, the name and
 * the notice the sign-in page shows, a test email to the admin, and what the operator has configured, read-only. The server refuses all
 * of it to an admin without a second factor, so the page asks for nothing and offers no action then; it says what is missing instead.
 */
export function AdminSettingsPage(): ReactElement {
  const { t } = useTranslation();
  const router = useRouter();
  const api = router.options.context.api;
  const enabled = useAdminActionsEnabled();
  const settings = useQuery({ ...instanceSettingsQuery(api), enabled });
  const status = useQuery({ ...instanceStatusQuery(api), enabled });
  const [saved, setSaved] = useState(false);
  useRefreshStandingOnForbidden(settings.error);
  useRefreshStandingOnForbidden(status.error);

  if (!enabled) {
    return (
      <>
        <h1 className="font-semibold text-2xl leading-none">{t("admin.settings.title")}</h1>
        <EmptyState
          description={t("admin.settings.mfaRequired.description")}
          icon={<ShieldCheckIcon aria-hidden="true" />}
          title={t("admin.settings.mfaRequired.title")}
        />
      </>
    );
  }

  let stored: ReactElement;
  if (settings.data !== undefined) {
    stored = (
      <>
        <WorkspaceCreationSection onSaved={setSaved} settings={settings.data} />
        <SignInForm onSaved={setSaved} settings={settings.data} />
      </>
    );
  } else if (settings.isError) {
    stored = (
      <LoadFailed
        onRetry={() => {
          void settings.refetch();
        }}
        title={t("admin.settings.loadFailed.title")}
      />
    );
  } else {
    stored = <Loading label={t("shell.loading")} />;
  }

  let configuration: ReactElement;
  if (status.data !== undefined) {
    configuration = <ConfigurationTable status={status.data} />;
  } else if (status.isError) {
    configuration = (
      <LoadFailed
        onRetry={() => {
          void status.refetch();
        }}
        title={t("admin.settings.configuration.loadFailed")}
      />
    );
  } else {
    configuration = <Loading label={t("shell.loading")} />;
  }

  return (
    <>
      <h1 className="font-semibold text-2xl leading-none">{t("admin.settings.title")}</h1>
      <p aria-live="polite" className="text-muted-foreground text-sm empty:hidden" role="status">
        {saved ? t("admin.settings.saved") : null}
      </p>
      {stored}
      <TestMailSection />
      <SettingsSection description={t("admin.settings.configuration.description")} title={t("admin.settings.configuration.title")}>
        <div className="flex flex-col gap-4">
          {configuration}
          <p className="text-muted-foreground text-sm">{t("admin.settings.configuration.envOnly")}</p>
        </div>
      </SettingsSection>
    </>
  );
}
