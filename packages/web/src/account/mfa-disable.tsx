import { Button, Input } from "@slugbase/ui";
import { Banner, Confirm, FormField, FormOverlay, SecretInput, Totp, feedbackToast } from "@slugbase/ui/patterns";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useState, type ReactElement, type SyntheticEvent } from "react";
import { useTranslation } from "react-i18next";
import { ME_QUERY_KEY } from "./me.ts";
import { disableTwoFactor, useMfaFailureMessage, useMfaRequest, type DisableRequest, type MfaFailure } from "./two-factor.ts";

const CODE_LENGTH = 6;

type Mode = "code" | "backup";

/**
 * Turns the second factor off: a code of the authenticator app (or a backup code) and the password, then a
 * confirmation. Nothing is sent before the member confirms, and a refusal is shown in the form behind the dialog.
 */
export function DisableTwoFactor({ onClose }: { onClose: () => void }): ReactElement {
  const { t } = useTranslation();
  const router = useRouter();
  const queryClient = useQueryClient();
  const run = useMfaRequest();
  const failureMessage = useMfaFailureMessage();
  const [mode, setMode] = useState<Mode>("code");
  const [code, setCode] = useState("");
  const [backupCode, setBackupCode] = useState("");
  const [password, setPassword] = useState("");
  const [required, setRequired] = useState<{ readonly code: boolean; readonly password: boolean }>({ code: false, password: false });
  const [failure, setFailure] = useState<MfaFailure | undefined>(undefined);
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);

  const given = mode === "code" ? code : backupCode.trim();
  const complete = mode === "code" ? code.length === CODE_LENGTH : given !== "";

  function submit(event: SyntheticEvent): void {
    event.preventDefault();
    const missing = { code: !complete, password: password === "" };
    setRequired(missing);
    if (!missing.code && !missing.password) {
      setFailure(undefined);
      setConfirming(true);
    }
  }

  async function disable(): Promise<void> {
    const body: DisableRequest = mode === "code" ? { code, password } : { backupCode: given, password };
    setPending(true);
    const outcome = await run((signal) => disableTwoFactor(router.options.context.api, body, signal));
    if (outcome.status === "skipped") {
      return;
    }
    setPending(false);
    setConfirming(false);
    if (outcome.status === "failed") {
      setFailure(outcome.failure);
      return;
    }
    // The session continues under a new token and the account signs in with its password alone.
    void queryClient.invalidateQueries({ queryKey: ME_QUERY_KEY });
    feedbackToast.success(t("settings.security.mfa.disable.done"));
    onClose();
  }

  function switchMode(): void {
    setMode(mode === "code" ? "backup" : "code");
    setCode("");
    setBackupCode("");
    setRequired({ code: false, password: false });
    setFailure(undefined);
  }

  const codeFailure = failure?.kind === "invalidCode";
  const passwordFailure = failure?.kind === "wrongPassword";
  const codeError = codeFailure
    ? failureMessage(failure)
    : required.code
      ? mode === "code"
        ? t("settings.security.mfa.code.required")
        : t("settings.security.mfa.backupCode.required")
      : undefined;
  return (
    <>
      <FormOverlay
        closeLabel={t("settings.security.mfa.close")}
        description={t("settings.security.mfa.disable.description")}
        onOpenChange={(open) => {
          if (!open && !pending) {
            onClose();
          }
        }}
        open
        title={t("settings.security.mfa.disable.title")}
      >
        <form className="flex flex-col gap-4" noValidate onSubmit={submit}>
          {failure === undefined || codeFailure || passwordFailure ? null : <Banner title={failureMessage(failure)} variant="error" />}
          {mode === "code" ? (
            <FormField error={codeError} label={t("settings.security.mfa.code.label")} name="code">
              <Totp
                disabled={pending}
                length={CODE_LENGTH}
                onValueChange={(value) => {
                  setCode(value);
                  setRequired((current) => ({ ...current, code: false }));
                }}
                slotLabel={(position, length) => t("settings.security.mfa.code.slot", { position, length })}
                value={code}
              />
            </FormField>
          ) : (
            <FormField error={codeError} label={t("settings.security.mfa.backupCode.label")} name="backupCode">
              <Input
                autoComplete="off"
                disabled={pending}
                onChange={(event) => {
                  setBackupCode(event.target.value);
                  setRequired((current) => ({ ...current, code: false }));
                }}
                spellCheck={false}
                type="text"
                value={backupCode}
              />
            </FormField>
          )}
          <Button className="self-start" disabled={pending} onClick={switchMode} type="button" variant="link">
            {mode === "code" ? t("settings.security.mfa.useBackup") : t("settings.security.mfa.useCode")}
          </Button>
          <FormField
            error={passwordFailure ? failureMessage(failure) : required.password ? t("settings.security.mfa.password.required") : undefined}
            label={t("settings.security.mfa.password.label")}
            name="password"
          >
            <SecretInput
              autoComplete="current-password"
              disabled={pending}
              hideLabel={t("settings.security.password.hide")}
              onChange={(event) => {
                setPassword(event.target.value);
                setRequired((current) => ({ ...current, password: false }));
              }}
              showLabel={t("settings.security.password.show")}
              value={password}
            />
          </FormField>
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button disabled={pending} onClick={onClose} type="button" variant="outline">
              {t("settings.security.mfa.cancel")}
            </Button>
            <Button type="submit" variant="destructive">
              {t("settings.security.mfa.disable.submit")}
            </Button>
          </div>
        </form>
      </FormOverlay>
      <Confirm
        cancelLabel={t("settings.security.mfa.cancel")}
        confirmLabel={t("settings.security.mfa.disable.confirm")}
        description={t("settings.security.mfa.disable.confirmDescription")}
        destructive
        loading={pending}
        onConfirm={() => {
          void disable();
        }}
        onOpenChange={setConfirming}
        open={confirming}
        title={t("settings.security.mfa.disable.confirmTitle")}
      />
    </>
  );
}
