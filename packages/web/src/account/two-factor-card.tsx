import { Button } from "@slugbase/ui";
import { Banner, SettingsSection, StatusBadge } from "@slugbase/ui/patterns";
import { useRouter } from "@tanstack/react-router";
import { useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { DisableTwoFactor } from "./mfa-disable.tsx";
import { RegenerateBackupCodes } from "./mfa-backup-codes.tsx";
import { MfaEnrollmentWizard } from "./mfa-enrollment.tsx";
import { startEnrollment, useMfaFailureMessage, useMfaRequest, type MfaEnrollment, type MfaFailure } from "./two-factor.ts";

/**
 * The Two-factor authentication card of `/settings/account/security` (doc 03 section 11.2): whether the second factor is on,
 * and how to turn it on, replace its backup codes or turn it off. `enabled` is what `GET /me` says. The secret
 * of a running enrolment is held here and dropped when the wizard closes.
 */
export function TwoFactorCard({ enabled }: { enabled: boolean }): ReactElement {
  const { t } = useTranslation();
  const router = useRouter();
  const run = useMfaRequest();
  const failureMessage = useMfaFailureMessage();
  const [enrollment, setEnrollment] = useState<MfaEnrollment | undefined>(undefined);
  const [starting, setStarting] = useState(false);
  const [failure, setFailure] = useState<MfaFailure | undefined>(undefined);
  const [regenerating, setRegenerating] = useState(false);
  const [disabling, setDisabling] = useState(false);

  async function start(): Promise<void> {
    setFailure(undefined);
    setStarting(true);
    const outcome = await run((signal) => startEnrollment(router.options.context.api, signal));
    if (outcome.status === "skipped") {
      return;
    }
    setStarting(false);
    if (outcome.status === "failed") {
      setFailure(outcome.failure);
      return;
    }
    setEnrollment(outcome.value);
  }

  if (enrollment !== undefined) {
    return (
      <MfaEnrollmentWizard
        enrollment={enrollment}
        onClose={() => {
          setEnrollment(undefined);
        }}
      />
    );
  }

  return (
    <>
      <SettingsSection
        description={enabled ? t("settings.security.mfa.description.on") : t("settings.security.mfa.description.off")}
        footer={
          enabled ? (
            <>
              <Button
                onClick={() => {
                  setRegenerating(true);
                }}
                variant="outline"
              >
                {t("settings.security.mfa.regenerate.open")}
              </Button>
              <Button
                onClick={() => {
                  setDisabling(true);
                }}
                variant="destructive-outline"
              >
                {t("settings.security.mfa.disable.open")}
              </Button>
            </>
          ) : (
            <Button
              loading={starting}
              onClick={() => {
                void start();
              }}
            >
              {t("settings.security.mfa.enrol.open")}
            </Button>
          )
        }
        title={t("settings.security.mfa.title")}
      >
        <div className="flex flex-col gap-4">
          <p className="flex items-center gap-2 text-sm">
            {t("settings.security.mfa.status.label")}
            <StatusBadge variant={enabled ? "success" : "neutral"}>
              {enabled ? t("settings.security.mfa.status.on") : t("settings.security.mfa.status.off")}
            </StatusBadge>
          </p>
          {failure === undefined ? null : <Banner title={failureMessage(failure)} variant="error" />}
        </div>
      </SettingsSection>
      {regenerating ? (
        <RegenerateBackupCodes
          onClose={() => {
            setRegenerating(false);
          }}
        />
      ) : null}
      {disabling ? (
        <DisableTwoFactor
          onClose={() => {
            setDisabling(false);
          }}
        />
      ) : null}
    </>
  );
}
