import { Banner, CopyValue, FormField, ShownOnce, Totp, Wizard } from "@slugbase/ui/patterns";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { ME_QUERY_KEY } from "./me.ts";
import { confirmEnrollment, useMfaFailureMessage, useMfaRequest, type MfaEnrollment, type MfaFailure } from "./two-factor.ts";

const CODE_LENGTH = 6;
const STEP_COUNT = 3;

type Step = 1 | 2 | 3;

/**
 * The enrolment wizard of the Two-factor authentication card (doc 03 section 11.2). The enrolment has been
 * started by the time it opens: re-authentication was asked for by that request. It shows the QR code and the text
 * key, verifies a code, then shows the ten backup codes once. The secret, the code and the backup codes live in
 * this component's state alone, so closing it, which unmounts it, leaves none of them behind.
 */
export function MfaEnrollmentWizard({ enrollment, onClose }: { enrollment: MfaEnrollment; onClose: () => void }): ReactElement {
  const { t } = useTranslation();
  const router = useRouter();
  const queryClient = useQueryClient();
  const run = useMfaRequest();
  const failureMessage = useMfaFailureMessage();
  const [step, setStep] = useState<Step>(1);
  const [code, setCode] = useState("");
  const [codeRequired, setCodeRequired] = useState(false);
  const [failure, setFailure] = useState<MfaFailure | undefined>(undefined);
  const [pending, setPending] = useState(false);
  const [backupCodes, setBackupCodes] = useState<readonly string[]>([]);
  const [acknowledged, setAcknowledged] = useState(false);

  async function verify(entered: string): Promise<void> {
    if (entered.length < CODE_LENGTH) {
      setCodeRequired(true);
      return;
    }
    setFailure(undefined);
    setCodeRequired(false);
    setPending(true);
    const outcome = await run((signal) => confirmEnrollment(router.options.context.api, entered, signal));
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
    setStep(3);
    // The session continues under a new token and the account now has a second factor, so what `me` says changed.
    void queryClient.invalidateQueries({ queryKey: ME_QUERY_KEY });
  }

  function next(): void {
    if (step === 1) {
      setStep(2);
    } else if (step === 2) {
      void verify(code);
    } else {
      onClose();
    }
  }

  function back(): void {
    if (step === 1) {
      onClose();
    } else {
      setStep(1);
      setCode("");
      setCodeRequired(false);
      setFailure(undefined);
    }
  }

  const codeFailure = failure?.kind === "invalidCode";
  const stepTitle =
    step === 1 ? t("settings.security.mfa.enrol.scan.title") : step === 2 ? t("settings.security.mfa.enrol.verify.title") : t("settings.security.mfa.codes.title");
  const stepDescription =
    step === 1
      ? t("settings.security.mfa.enrol.scan.description")
      : step === 2
        ? t("settings.security.mfa.enrol.verify.description")
        : t("settings.security.mfa.codes.description");

  return (
    <Wizard
      backLabel={step === 1 ? t("settings.security.mfa.cancel") : t("settings.security.mfa.enrol.back")}
      description={t("settings.security.mfa.enrol.description")}
      nextDisabled={step === 3 && !acknowledged}
      nextLabel={step === 1 ? t("settings.security.mfa.enrol.next") : step === 2 ? t("settings.security.mfa.enrol.turnOn") : t("settings.security.mfa.done")}
      onBack={step === 3 ? undefined : back}
      onNext={next}
      pending={pending}
      step={step}
      stepCount={STEP_COUNT}
      stepDescription={stepDescription}
      stepLabel={t("settings.security.mfa.enrol.step", { step, count: STEP_COUNT })}
      stepTitle={stepTitle}
      title={t("settings.security.mfa.enrol.title")}
    >
      {step === 1 ? (
        <>
          <img
            alt={t("settings.security.mfa.enrol.qr.alt")}
            className="mx-auto size-48 rounded-lg border bg-white p-2"
            height={192}
            src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(enrollment.qrSvg)}`}
            width={192}
          />
          <div className="flex flex-col gap-1.5">
            <p className="text-muted-foreground text-sm">{t("settings.security.mfa.enrol.key.description")}</p>
            <CopyValue
              copiedLabel={t("settings.security.mfa.copied")}
              copyLabel={t("settings.security.mfa.enrol.key.copy")}
              label={t("settings.security.mfa.enrol.key.label")}
              value={enrollment.secret}
            />
          </div>
        </>
      ) : null}
      {step === 2 ? (
        <>
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
                void verify(complete);
              }}
              onValueChange={(value) => {
                setCode(value);
                setCodeRequired(false);
              }}
              slotLabel={(position, length) => t("settings.security.mfa.code.slot", { position, length })}
              value={code}
            />
          </FormField>
        </>
      ) : null}
      {step === 3 ? (
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
      ) : null}
    </Wizard>
  );
}
