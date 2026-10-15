import { Button, Input } from "@slugbase/ui";
import { Banner, FormField, InlineNote, PasswordStrength, SecretInput, Wizard } from "@slugbase/ui/patterns";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useRouter } from "@tanstack/react-router";
import { useEffect, useRef, useState, type ChangeEvent, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { AuthWizardPage } from "../auth/auth-page.tsx";
import { passwordScore } from "../auth/password-strength.ts";
import { useConfig } from "../config/config-context.tsx";
import { rememberSetupRequired } from "../config/setup-state.ts";
import { setupFailureOf, type FieldProblem, type Failure, type SetupField } from "./setup-failure.ts";

const STEP_COUNT = 3;
const SECONDS_PER_MINUTE = 60;
const TOKEN_MAX_LENGTH = 256;
const DISPLAY_NAME_MAX_LENGTH = 100;
const WORKSPACE_NAME_MAX_LENGTH = 64;

type Step = 1 | 2 | 3;
type Problems = Partial<Record<SetupField, FieldProblem>>;

/** The checks made before a step is left; what only the server can judge (the token, the password's policy) is left to it. */
function missingFields(step: Step, values: Record<SetupField, string>): Problems {
  const missing: Problems = {};
  if (step === 1 && values.setupToken.trim() === "") {
    missing.setupToken = "required";
  }
  if (step === 2) {
    if (values.displayName.trim() === "") {
      missing.displayName = "required";
    }
    if (values.email.trim() === "") {
      missing.email = "required";
    }
    if (values.password === "") {
      missing.password = "required";
    }
  }
  if (step === 3 && values.workspaceName.trim() === "") {
    missing.workspaceName = "required";
  }
  return missing;
}

/**
 * The first-run wizard (doc 03 section 1.1): the setup token when the server requires one, the first account,
 * the first workspace, and a closing step with the note on two-factor authentication.
 */
export function SetupPage(): ReactElement {
  const { t } = useTranslation();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { product, setupTokenRequired } = useConfig();
  // The token step exists only while the server requires a token; without it the wizard starts at the account.
  const tokenRequired = setupTokenRequired === true;
  const firstStep: Step = tokenRequired ? 1 : 2;
  const stepCount = tokenRequired ? STEP_COUNT : STEP_COUNT - 1;
  const [step, setStep] = useState<Step>(firstStep);
  const [values, setValues] = useState<Record<SetupField, string>>({
    setupToken: "",
    displayName: "",
    email: "",
    password: "",
    workspaceName: "",
  });
  const [problems, setProblems] = useState<Problems>({});
  const [failure, setFailure] = useState<Failure | undefined>(undefined);
  const [pending, setPending] = useState(false);
  const [finished, setFinished] = useState(false);
  const firstField = useRef<HTMLInputElement>(null);
  const request = useRef<AbortController | null>(null);

  useEffect(
    () => () => {
      request.current?.abort();
    },
    [],
  );

  useEffect(() => {
    firstField.current?.focus();
  }, [step]);

  function edit(field: SetupField, value: string): void {
    setValues((current) => ({ ...current, [field]: value }));
    setProblems((current) => ({ ...current, [field]: undefined }));
    setFailure(undefined);
  }

  function fieldMessage(field: SetupField): string | undefined {
    switch (problems[field]) {
      case undefined:
        return undefined;
      case "required":
        return field === "setupToken"
          ? t("setup.token.required")
          : field === "displayName"
          ? t("setup.account.name.required")
          : field === "email"
            ? t("setup.account.email.required")
            : field === "password"
              ? t("setup.account.password.required")
              : t("setup.workspace.name.required");
      case "wrongToken":
        return t("setup.token.wrong");
      case "tooShort":
        return t("setup.account.password.tooShort");
      case "tooLong":
        return t("setup.account.password.tooLong");
      case "breached":
        return t("setup.account.password.breached");
      case "weak":
        return t("setup.account.password.weak");
      case "invalid":
        return field === "displayName"
          ? t("setup.account.name.invalid")
          : field === "email"
            ? t("setup.account.email.invalid")
            : field === "password"
              ? t("setup.account.password.weak")
              : t("setup.workspace.name.invalid");
    }
  }

  function failureMessage(value: Failure): string {
    switch (value.kind) {
      case "completed":
        return t("setup.error.completed");
      case "invalid":
        return t("setup.error.invalid");
      case "unavailable":
        return t("setup.error.unavailable");
      case "rateLimited":
        if (value.seconds === undefined) {
          return t("setup.error.rateLimited.unknown");
        }
        return value.seconds < SECONDS_PER_MINUTE
          ? t("setup.error.rateLimited.seconds", { count: value.seconds })
          : t("setup.error.rateLimited.minutes", { count: Math.ceil(value.seconds / SECONDS_PER_MINUTE) });
    }
  }

  async function createAccount(): Promise<void> {
    const controller = new AbortController();
    request.current = controller;
    setPending(true);
    setFailure(undefined);
    try {
      const { data, error } = await router.options.context.api.POST("/api/v1/setup", {
        body: {
          ...(tokenRequired ? { setupToken: values.setupToken.trim() } : {}),
          displayName: values.displayName.trim(),
          email: values.email.trim(),
          password: values.password,
          workspaceName: values.workspaceName.trim(),
        },
        signal: controller.signal,
      });
      if (data === undefined) {
        throw new Error("The setup did not answer with a result", { cause: error });
      }
    } catch (caught) {
      if (controller.signal.aborted) {
        return;
      }
      const result = setupFailureOf(caught, 3, tokenRequired);
      setProblems(result.fields);
      setFailure(result.failure);
      setStep(result.step);
      setPending(false);
      return;
    }
    // The new session is the visitor's now: nothing the cache held belongs to it, and the routes no longer send anyone here.
    queryClient.clear();
    rememberSetupRequired(queryClient, false);
    setPending(false);
    setFinished(true);
  }

  function next(): void {
    const missing = missingFields(step, values);
    setProblems(missing);
    setFailure(undefined);
    if (Object.keys(missing).length > 0) {
      return;
    }
    if (step === STEP_COUNT) {
      void createAccount();
      return;
    }
    setStep((step + 1) as Step);
  }

  function back(): void {
    setProblems({});
    setFailure(undefined);
    setStep((step - 1) as Step);
  }

  function goHome(): void {
    void router.navigate({ to: "/", replace: true });
  }

  function leaveForSignIn(): void {
    rememberSetupRequired(queryClient, false);
    void router.navigate({ to: "/login", replace: true });
  }

  if (finished) {
    return (
      <AuthWizardPage productName={product.name}>
        <Wizard
          backLabel={t("setup.back")}
          description={t("setup.description", { name: product.name })}
          nextLabel={t("setup.done.home")}
          onNext={goHome}
          step={stepCount}
          stepCount={stepCount}
          stepDescription={t("setup.done.description")}
          stepLabel={t("setup.done.step")}
          stepTitle={t("setup.done.title")}
          title={t("setup.title", { name: product.name })}
        >
          <InlineNote title={t("setup.done.mfa.title")}>
            <p>{t("setup.done.mfa.description")}</p>
            <div>
              <Button render={<Link to="/settings/account/security" />} size="sm" variant="outline">
                {t("setup.done.mfa.action")}
              </Button>
            </div>
          </InlineNote>
        </Wizard>
      </AuthWizardPage>
    );
  }

  const tokenError = fieldMessage("setupToken");
  const nameError = fieldMessage("displayName");
  const emailError = fieldMessage("email");
  const passwordError = fieldMessage("password");
  const workspaceError = fieldMessage("workspaceName");
  const onSetupToken = (event: ChangeEvent<HTMLInputElement>): void => {
    edit("setupToken", event.target.value);
  };
  const onDisplayName = (event: ChangeEvent<HTMLInputElement>): void => {
    edit("displayName", event.target.value);
  };
  const onEmail = (event: ChangeEvent<HTMLInputElement>): void => {
    edit("email", event.target.value);
  };
  const onPassword = (event: ChangeEvent<HTMLInputElement>): void => {
    edit("password", event.target.value);
  };
  const onWorkspaceName = (event: ChangeEvent<HTMLInputElement>): void => {
    edit("workspaceName", event.target.value);
  };
  const score = passwordScore(values.password);
  const scoreLabels = [
    t("setup.account.password.strength.score.0"),
    t("setup.account.password.strength.score.1"),
    t("setup.account.password.strength.score.2"),
    t("setup.account.password.strength.score.3"),
    t("setup.account.password.strength.score.4"),
  ] as const;
  const stepTitles = [t("setup.token.title"), t("setup.account.title"), t("setup.workspace.title")] as const;
  const stepDescriptions = [t("setup.token.description"), t("setup.account.description"), t("setup.workspace.description")] as const;

  return (
    <AuthWizardPage productName={product.name}>
      <Wizard
        backLabel={t("setup.back")}
        description={t("setup.description", { name: product.name })}
        nextLabel={step === STEP_COUNT ? t("setup.finish") : t("setup.next")}
        onBack={step === firstStep ? undefined : back}
        onNext={next}
        pending={pending}
        step={step - firstStep + 1}
        stepCount={stepCount}
        stepDescription={stepDescriptions[step - 1]}
        stepLabel={t("setup.step", { step: step - firstStep + 1, count: stepCount })}
        stepTitle={stepTitles[step - 1]}
        title={t("setup.title", { name: product.name })}
      >
        {failure === undefined ? null : (
          <Banner
            action={
              failure.kind === "completed" ? (
                <Button onClick={leaveForSignIn} size="sm" variant="outline">
                  {t("setup.error.signIn")}
                </Button>
              ) : undefined
            }
            title={failureMessage(failure)}
            variant="error"
          />
        )}
        {step === 1 ? (
          <>
            <InlineNote>{t("setup.token.note")}</InlineNote>
            <FormField error={tokenError} label={t("setup.token.label")} name="setupToken">
              <Input
                autoComplete="off"
                maxLength={TOKEN_MAX_LENGTH}
                onChange={onSetupToken}
                ref={firstField}
                spellCheck={false}
                value={values.setupToken}
              />
            </FormField>
          </>
        ) : null}
        {step === 2 ? (
          <>
            <FormField error={nameError} label={t("setup.account.name.label")} name="displayName">
              <Input
                autoComplete="name"
                maxLength={DISPLAY_NAME_MAX_LENGTH}
                onChange={onDisplayName}
                ref={firstField}
                value={values.displayName}
              />
            </FormField>
            <FormField error={emailError} label={t("setup.account.email.label")} name="email">
              <Input
                autoComplete="email"
                onChange={onEmail}
                type="email"
                value={values.email}
              />
            </FormField>
            <div className="flex flex-col gap-2">
              <FormField
                description={t("setup.account.password.description")}
                error={passwordError}
                label={t("setup.account.password.label")}
                name="password"
              >
                <SecretInput
                  autoComplete="new-password"
                  hideLabel={t("setup.account.password.hide")}
                  onChange={onPassword}
                  showLabel={t("setup.account.password.show")}
                  value={values.password}
                />
              </FormField>
              {values.password === "" ? null : (
                <PasswordStrength
                  label={t("setup.account.password.strength.label")}
                  score={score}
                  scoreLabel={scoreLabels[score]}
                />
              )}
            </div>
          </>
        ) : null}
        {step === 3 ? (
          <FormField
            description={t("setup.workspace.name.description")}
            error={workspaceError}
            label={t("setup.workspace.name.label")}
            name="workspaceName"
          >
            <Input
              maxLength={WORKSPACE_NAME_MAX_LENGTH}
              onChange={onWorkspaceName}
              ref={firstField}
              value={values.workspaceName}
            />
          </FormField>
        ) : null}
      </Wizard>
    </AuthWizardPage>
  );
}
