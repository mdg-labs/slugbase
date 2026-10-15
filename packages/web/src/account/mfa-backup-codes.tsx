import { Button } from "@slugbase/ui";
import { Banner, FormField, FormOverlay, ShownOnce, Totp } from "@slugbase/ui/patterns";
import { useRouter } from "@tanstack/react-router";
import { useState, type ReactElement, type SyntheticEvent } from "react";
import { useTranslation } from "react-i18next";
import { regenerateBackupCodes, useMfaFailureMessage, useMfaRequest, type MfaFailure } from "./two-factor.ts";

const CODE_LENGTH = 6;

/**
 * Replaces the backup codes: asks for a code of the authenticator app, then shows the new set once. It is shown
 * while the member regenerates and unmounted when they are done, which drops the codes from its state.
 */
export function RegenerateBackupCodes({ onClose }: { onClose: () => void }): ReactElement {
  const { t } = useTranslation();
  const router = useRouter();
  const run = useMfaRequest();
  const failureMessage = useMfaFailureMessage();
  const [code, setCode] = useState("");
  const [codeRequired, setCodeRequired] = useState(false);
  const [failure, setFailure] = useState<MfaFailure | undefined>(undefined);
  const [pending, setPending] = useState(false);
  const [backupCodes, setBackupCodes] = useState<readonly string[] | undefined>(undefined);
  const [acknowledged, setAcknowledged] = useState(false);

  async function regenerate(entered: string): Promise<void> {
    if (entered.length < CODE_LENGTH) {
      setCodeRequired(true);
      return;
    }
    setFailure(undefined);
    setCodeRequired(false);
    setPending(true);
    const outcome = await run((signal) => regenerateBackupCodes(router.options.context.api, entered, signal));
    if (outcome.status === "skipped") {
      return;
    }
    setPending(false);
    if (outcome.status === "failed") {
      setFailure(outcome.failure);
      setCode("");
      return;
    }
    setBackupCodes(outcome.value);
  }

  function submit(event: SyntheticEvent): void {
    event.preventDefault();
    if (!pending) {
      void regenerate(code);
    }
  }

  const codeFailure = failure?.kind === "invalidCode";
  return (
    <FormOverlay
      closeLabel={t("settings.security.mfa.close")}
      description={backupCodes === undefined ? t("settings.security.mfa.regenerate.description") : t("settings.security.mfa.codes.description")}
      onOpenChange={(open) => {
        // The old codes stop working with the answer, so the new ones stay until they are acknowledged.
        if (!open && !pending && (backupCodes === undefined || acknowledged)) {
          onClose();
        }
      }}
      open
      title={t("settings.security.mfa.regenerate.title")}
    >
      {backupCodes === undefined ? (
        <form className="flex flex-col gap-4" noValidate onSubmit={submit}>
          {failure === undefined || codeFailure ? null : <Banner title={failureMessage(failure)} variant="error" />}
          <FormField
            error={codeFailure ? failureMessage(failure) : codeRequired ? t("settings.security.mfa.code.required") : undefined}
            label={t("settings.security.mfa.code.label")}
            name="code"
          >
            <Totp
              disabled={pending}
              length={CODE_LENGTH}
              onComplete={(complete) => {
                void regenerate(complete);
              }}
              onValueChange={(value) => {
                setCode(value);
                setCodeRequired(false);
              }}
              slotLabel={(position, length) => t("settings.security.mfa.code.slot", { position, length })}
              value={code}
            />
          </FormField>
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button disabled={pending} onClick={onClose} type="button" variant="outline">
              {t("settings.security.mfa.cancel")}
            </Button>
            <Button loading={pending} type="submit">
              {t("settings.security.mfa.regenerate.submit")}
            </Button>
          </div>
        </form>
      ) : (
        <div className="flex flex-col gap-4">
          <ShownOnce
            acknowledgeLabel={t("settings.security.mfa.codes.acknowledge")}
            acknowledged={acknowledged}
            copiedLabel={t("settings.security.mfa.copied")}
            copyLabel={t("settings.security.mfa.codes.copy")}
            label={t("settings.security.mfa.codes.label")}
            note={t("settings.security.mfa.codes.note")}
            onAcknowledgedChange={setAcknowledged}
            values={backupCodes}
          />
          <div className="flex justify-end">
            <Button disabled={!acknowledged} onClick={onClose}>
              {t("settings.security.mfa.done")}
            </Button>
          </div>
        </div>
      )}
    </FormOverlay>
  );
}
