import { Button } from "@slugbase/ui";
import { Banner, FormField, PasswordStrength, SecretInput, SettingsSection } from "@slugbase/ui/patterns";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useState, type ReactElement, type SyntheticEvent } from "react";
import { useTranslation } from "react-i18next";
import { ApiProblemError } from "../api/client.ts";
import { passwordScore } from "../auth/password-strength.ts";
import { SESSIONS_QUERY_KEY } from "./sessions.ts";

type FieldName = "currentPassword" | "newPassword";

/** Why a field was refused: a check made before the request, or one of the codes the server answers with. */
type FieldProblem = "currentRequired" | "newRequired" | "currentWrong" | "tooShort" | "tooLong" | "breached" | "weak";

const SERVER_PROBLEMS: Readonly<Record<string, FieldProblem>> = {
  too_short: "tooShort",
  too_long: "tooLong",
  breached: "breached",
};

/** The reasons the server refused the password, from the field errors of its problem document; empty when it refused for another cause. */
function refusals(error: unknown): Partial<Record<FieldName, readonly FieldProblem[]>> {
  if (!(error instanceof ApiProblemError) || error.status !== 422) {
    return {};
  }
  const newProblems = error.errors
    .filter(({ path }) => path === "newPassword")
    .map(({ code }): FieldProblem => SERVER_PROBLEMS[code] ?? "weak");
  const wrongCurrent = error.errors.some(({ path }) => path === "currentPassword");
  return {
    ...(wrongCurrent ? { currentPassword: ["currentWrong" as const] } : {}),
    ...(newProblems.length > 0 ? { newPassword: newProblems } : error.code === "weak_password" ? { newPassword: ["weak" as const] } : {}),
  };
}

/** The Password card of `/settings/account/security` (doc 03 section 11.2): the current and the new password, with the strength of the new one. */
export function PasswordCard(): ReactElement {
  const { t } = useTranslation();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [local, setLocal] = useState<Partial<Record<FieldName, FieldProblem>>>({});

  const change = useMutation({
    mutationKey: ["account", "password"],
    meta: { fieldErrors: true },
    mutationFn: async (body: { currentPassword: string; newPassword: string }): Promise<void> => {
      const { response, error } = await router.options.context.api.POST("/api/v1/me/password", { body });
      if (!response.ok) {
        throw new Error("The password change did not answer with a problem document", { cause: error });
      }
    },
    onSuccess: () => {
      setCurrentPassword("");
      setNewPassword("");
      void queryClient.invalidateQueries({ queryKey: SESSIONS_QUERY_KEY });
    },
  });

  const refused = refusals(change.error);

  function message(problem: FieldProblem): string {
    switch (problem) {
      case "currentRequired":
        return t("settings.security.password.error.currentRequired");
      case "newRequired":
        return t("settings.security.password.error.newRequired");
      case "currentWrong":
        return t("settings.security.password.error.currentWrong");
      case "tooShort":
        return t("settings.security.password.error.tooShort");
      case "tooLong":
        return t("settings.security.password.error.tooLong");
      case "breached":
        return t("settings.security.password.error.breached");
      case "weak":
        return t("settings.security.password.error.weak");
    }
  }

  function fieldError(name: FieldName): string | undefined {
    const checked = local[name];
    const problems = checked === undefined ? (refused[name] ?? []) : [checked];
    return problems.length === 0 ? undefined : problems.map(message).join(" ");
  }

  function edited(): void {
    setLocal({});
    change.reset();
  }

  function submit(event: SyntheticEvent): void {
    event.preventDefault();
    if (change.isPending) {
      return;
    }
    const missing: Partial<Record<FieldName, FieldProblem>> = {
      ...(currentPassword === "" ? { currentPassword: "currentRequired" as const } : {}),
      ...(newPassword === "" ? { newPassword: "newRequired" as const } : {}),
    };
    setLocal(missing);
    if (Object.keys(missing).length > 0) {
      return;
    }
    change.mutate({ currentPassword, newPassword });
  }

  const currentError = fieldError("currentPassword");
  const newError = fieldError("newPassword");
  const score = passwordScore(newPassword);
  const scoreLabels = [
    t("settings.security.password.strength.score.0"),
    t("settings.security.password.strength.score.1"),
    t("settings.security.password.strength.score.2"),
    t("settings.security.password.strength.score.3"),
    t("settings.security.password.strength.score.4"),
  ] as const;

  return (
    <form noValidate onSubmit={submit}>
      <SettingsSection
        description={t("settings.security.password.description")}
        footer={
          <Button loading={change.isPending} type="submit">
            {t("settings.security.password.submit")}
          </Button>
        }
        title={t("settings.security.password.title")}
      >
        <div className="flex flex-col gap-5">
          {change.isSuccess ? (
            <Banner title={t("settings.security.password.changed")} variant="success" />
          ) : null}
          <FormField error={currentError} label={t("settings.security.password.current.label")} name="currentPassword">
            <SecretInput
              autoComplete="current-password"
              disabled={change.isPending}
              hideLabel={t("settings.security.password.hide")}
              onChange={(event) => {
                setCurrentPassword(event.target.value);
                edited();
              }}
              showLabel={t("settings.security.password.show")}
              value={currentPassword}
            />
          </FormField>
          <div className="flex flex-col gap-2">
            <FormField
              description={t("settings.security.password.new.description")}
              error={newError}
              label={t("settings.security.password.new.label")}
              name="newPassword"
            >
              <SecretInput
                autoComplete="new-password"
                disabled={change.isPending}
                hideLabel={t("settings.security.password.hide")}
                onChange={(event) => {
                  setNewPassword(event.target.value);
                  edited();
                }}
                showLabel={t("settings.security.password.show")}
                value={newPassword}
              />
            </FormField>
            {newPassword === "" ? null : (
              <PasswordStrength
                label={t("settings.security.password.strength.label")}
                score={score}
                scoreLabel={scoreLabels[score]}
              />
            )}
          </div>
        </div>
      </SettingsSection>
    </form>
  );
}
