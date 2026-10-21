import { Button } from "@slugbase/ui";
import { Banner, EmptyState, Loading, MetricTile, SettingsSection, ShieldCheckIcon, StatusBadge } from "@slugbase/ui/patterns";
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import type { ReactElement, ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useFormat } from "../i18n/use-format.ts";
import { useAdminActionsEnabled, useRefreshStandingOnForbidden } from "./admin-access.ts";
import { instanceStatusQuery, type InstanceStatus } from "./instance-status.ts";

function Row({ label, children }: { label: string; children: ReactNode }): ReactElement {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="flex flex-wrap items-center justify-end gap-2">{children}</dd>
    </div>
  );
}

function Rows({ children }: { children: ReactNode }): ReactElement {
  return <dl className="flex flex-col divide-y">{children}</dl>;
}

function Overview({ status }: { status: InstanceStatus }): ReactElement {
  const { t } = useTranslation();
  const format = useFormat();
  const { counts, migrations, jobs, ports, signIn, oidcProviders } = status;
  const upToDate = migrations.applied === migrations.expected;
  return (
    <>
      <section aria-label={t("admin.overview.counts.label")} className="grid gap-4 sm:grid-cols-3">
        <MetricTile label={t("admin.overview.counts.accounts")} value={format.number(counts.accounts)} />
        <MetricTile label={t("admin.overview.counts.workspaces")} value={format.number(counts.workspaces)} />
        <MetricTile label={t("admin.overview.counts.activeSessions")} value={format.number(counts.activeSessions)} />
      </section>
      <SettingsSection title={t("admin.overview.build.title")}>
        <Rows>
          <Row label={t("admin.overview.build.version")}>
            <span className="font-mono">{status.version}</span>
          </Row>
          <Row label={t("admin.overview.build.migrations")}>
            <span>{t("admin.overview.build.applied", { applied: migrations.applied, expected: migrations.expected })}</span>
            <StatusBadge variant={upToDate ? "success" : "warning"}>
              {upToDate ? t("admin.overview.build.upToDate") : t("admin.overview.build.outOfDate")}
            </StatusBadge>
          </Row>
        </Rows>
      </SettingsSection>
      <SettingsSection title={t("admin.overview.jobs.title")}>
        <Rows>
          <Row label={t("admin.overview.jobs.failed")}>
            <StatusBadge variant={jobs.failed > 0 ? "error" : "success"}>
              {jobs.failed > 0 ? t("admin.overview.jobs.some", { count: jobs.failed }) : t("admin.overview.jobs.none")}
            </StatusBadge>
          </Row>
          <Row label={t("admin.overview.jobs.queue")}>
            <StatusBadge>{t("admin.overview.jobs.waiting", { count: jobs.queueDepth })}</StatusBadge>
          </Row>
        </Rows>
      </SettingsSection>
      <SettingsSection description={t("admin.overview.configuration.description")} title={t("admin.overview.configuration.title")}>
        <Rows>
          <Row label={t("admin.overview.configuration.registration")}>
            <StatusBadge variant={signIn.publicRegistration ? "success" : "neutral"}>
              {signIn.publicRegistration ? t("admin.overview.configuration.on") : t("admin.overview.configuration.off")}
            </StatusBadge>
          </Row>
          <Row label={t("admin.overview.configuration.verification")}>
            <StatusBadge variant={signIn.emailVerificationRequired ? "success" : "neutral"}>
              {signIn.emailVerificationRequired ? t("admin.overview.configuration.on") : t("admin.overview.configuration.off")}
            </StatusBadge>
          </Row>
          <Row label={t("admin.overview.configuration.mail")}>
            <StatusBadge variant={ports.mail ? "success" : "neutral"}>
              {ports.mail ? t("admin.overview.configuration.configured") : t("admin.overview.configuration.notConfigured")}
            </StatusBadge>
          </Row>
          <Row label={t("admin.overview.configuration.ai")}>
            <StatusBadge variant={ports.ai ? "success" : "neutral"}>
              {ports.ai ? t("admin.overview.configuration.configured") : t("admin.overview.configuration.notConfigured")}
            </StatusBadge>
          </Row>
          <Row label={t("admin.overview.configuration.oidc")}>
            {oidcProviders.length === 0 ? (
              <StatusBadge>{t("admin.overview.configuration.noProviders")}</StatusBadge>
            ) : (
              oidcProviders.map((provider) => (
                <StatusBadge key={provider.slug} variant="success">
                  {provider.name}
                </StatusBadge>
              ))
            )}
          </Row>
          <Row label={t("admin.overview.configuration.errorReporting")}>
            <StatusBadge variant={ports.errorReporting ? "success" : "neutral"}>
              {ports.errorReporting ? t("admin.overview.configuration.configured") : t("admin.overview.configuration.notConfigured")}
            </StatusBadge>
          </Row>
        </Rows>
      </SettingsSection>
    </>
  );
}

/**
 * `/admin`, the instance overview (doc 03 section 12): the counts, the version and migration level, the health of
 * the background jobs and what the operator has configured, from the instance status. The server refuses the status
 * to an admin without a second factor, so the page does not ask for it then; it says what is missing instead.
 */
export function AdminOverviewPage(): ReactElement {
  const { t } = useTranslation();
  const router = useRouter();
  const enabled = useAdminActionsEnabled();
  const status = useQuery({ ...instanceStatusQuery(router.options.context.api), enabled });
  useRefreshStandingOnForbidden(status.error);

  let body: ReactElement;
  if (!enabled) {
    body = (
      <EmptyState
        description={t("admin.overview.mfaRequired.description")}
        icon={<ShieldCheckIcon aria-hidden="true" />}
        title={t("admin.overview.mfaRequired.title")}
      />
    );
  } else if (status.data !== undefined) {
    body = <Overview status={status.data} />;
  } else if (status.isError) {
    body = (
      <Banner
        action={
          <Button
            onClick={() => {
              void status.refetch();
            }}
            size="sm"
            variant="outline"
          >
            {t("admin.overview.loadFailed.retry")}
          </Button>
        }
        description={t("admin.overview.loadFailed.description")}
        title={t("admin.overview.loadFailed.title")}
        variant="error"
      />
    );
  } else {
    body = <Loading label={t("shell.loading")} />;
  }

  return (
    <>
      <h1 className="font-semibold text-2xl leading-none">{t("admin.overview.title")}</h1>
      {body}
    </>
  );
}
