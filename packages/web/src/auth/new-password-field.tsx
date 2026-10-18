import { PasswordStrength, FormField, SecretInput } from "@slugbase/ui/patterns";
import type { ChangeEvent, ReactElement, Ref } from "react";
import { useTranslation } from "react-i18next";
import type { ApiProblemError } from "../api/client.ts";
import { passwordScore } from "./password-strength.ts";

/** Why a new password was refused: the check made before the request, or what the server's policy answered. */
export type PasswordProblem = "required" | "tooShort" | "tooLong" | "breached" | "weak";

const POLICY_CODES: ReadonlyMap<string, PasswordProblem> = new Map([
  ["too_short", "tooShort"],
  ["too_long", "tooLong"],
  ["breached", "breached"],
]);

/** What the server's answer says about the password, when it refused it: the first field error on `field`, else a plain `weak_password`. */
export function passwordProblemOf(error: ApiProblemError, field = "password"): PasswordProblem | undefined {
  for (const { path, code } of error.errors) {
    if (path === field) {
      return POLICY_CODES.get(code) ?? "weak";
    }
  }
  return error.status === 422 && error.code === "weak_password" ? "weak" : undefined;
}

export interface NewPasswordFieldProps {
  value: string;
  onChange: (value: string) => void;
  problem: PasswordProblem | undefined;
  inputRef?: Ref<HTMLInputElement>;
}

/** The field for a password the visitor chooses: the input with its show toggle, the policy hint and the strength meter. */
export function NewPasswordField({ value, onChange, problem, inputRef }: NewPasswordFieldProps): ReactElement {
  const { t } = useTranslation();
  const score = passwordScore(value);
  const scoreLabels = [
    t("newPassword.strength.score.0"),
    t("newPassword.strength.score.1"),
    t("newPassword.strength.score.2"),
    t("newPassword.strength.score.3"),
    t("newPassword.strength.score.4"),
  ] as const;
  const message = (() => {
    switch (problem) {
      case undefined:
        return undefined;
      case "required":
        return t("newPassword.required");
      case "tooShort":
        return t("newPassword.tooShort");
      case "tooLong":
        return t("newPassword.tooLong");
      case "breached":
        return t("newPassword.breached");
      case "weak":
        return t("newPassword.weak");
    }
  })();
  return (
    <div className="flex flex-col gap-2">
      <FormField description={t("newPassword.description")} error={message} label={t("newPassword.label")} name="password">
        <SecretInput
          autoComplete="new-password"
          hideLabel={t("newPassword.hide")}
          onChange={(event: ChangeEvent<HTMLInputElement>) => {
            onChange(event.target.value);
          }}
          ref={inputRef}
          showLabel={t("newPassword.show")}
          value={value}
        />
      </FormField>
      {value === "" ? null : (
        <PasswordStrength label={t("newPassword.strength.label")} score={score} scoreLabel={scoreLabels[score]} />
      )}
    </div>
  );
}
