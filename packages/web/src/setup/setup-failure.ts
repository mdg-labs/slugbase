import { ApiProblemError } from "../api/client.ts";

export type SetupField = "setupToken" | "displayName" | "email" | "password" | "workspaceName";

/** Why a field was refused: one of the checks made before the request, or what the server answered. */
export type FieldProblem = "required" | "invalid" | "wrongToken" | "tooShort" | "tooLong" | "breached" | "weak";

/** What stays on the page when the setup did not go through, as far as the visitor is told. */
export type Failure =
  | { readonly kind: "completed" }
  | { readonly kind: "rateLimited"; readonly seconds: number | undefined }
  | { readonly kind: "invalid" }
  | { readonly kind: "unavailable" };

export interface SetupFailure {
  /** The step the wizard returns to: the first one that owns a refused field, otherwise the one the request came from. */
  readonly step: 1 | 2 | 3;
  readonly fields: Partial<Record<SetupField, FieldProblem>>;
  readonly failure: Failure | undefined;
}

/** The step that holds each field. */
const STEP_OF_FIELD: Readonly<Record<SetupField, 1 | 2 | 3>> = {
  setupToken: 1,
  displayName: 2,
  email: 2,
  password: 2,
  workspaceName: 3,
};

const PASSWORD_PROBLEMS: Readonly<Record<string, FieldProblem>> = {
  too_short: "tooShort",
  too_long: "tooLong",
  breached: "breached",
};

function isField(path: string): path is SetupField {
  return Object.hasOwn(STEP_OF_FIELD, path);
}

function firstStepOf(fields: Partial<Record<SetupField, FieldProblem>>, fallback: 1 | 2 | 3): 1 | 2 | 3 {
  const steps = (Object.keys(fields) as SetupField[]).map((field) => STEP_OF_FIELD[field]);
  return steps.length === 0 ? fallback : (Math.min(...steps) as 1 | 2 | 3);
}

/**
 * What a setup request that failed means for the wizard (doc 04 section 10.2): a wrong or missing token goes
 * back to the token step, which exists only while the server requires a token, a refused password or other
 * field to the step that holds it, and a completed setup, a wait, or a failure with no field to blame stays
 * on the step the request came from.
 */
export function setupFailureOf(error: unknown, currentStep: 1 | 2 | 3, tokenRequired: boolean): SetupFailure {
  if (error instanceof ApiProblemError) {
    if (error.status === 403 && error.code === "setup_completed") {
      return { step: currentStep, fields: {}, failure: { kind: "completed" } };
    }
    if (error.status === 403 && error.code === "forbidden" && tokenRequired) {
      return { step: 1, fields: { setupToken: "wrongToken" }, failure: undefined };
    }
    if (error.status === 429) {
      return { step: currentStep, fields: {}, failure: { kind: "rateLimited", seconds: error.retryAfterSeconds } };
    }
    if (error.status === 422) {
      const fields: Partial<Record<SetupField, FieldProblem>> = {};
      for (const { path, code } of error.errors) {
        if (isField(path) && fields[path] === undefined && (tokenRequired || path !== "setupToken")) {
          fields[path] = path === "password" ? (PASSWORD_PROBLEMS[code] ?? "weak") : path === "setupToken" ? "wrongToken" : "invalid";
        }
      }
      if (fields.password === undefined && error.code === "weak_password") {
        fields.password = "weak";
      }
      return Object.keys(fields).length === 0
        ? { step: currentStep, fields, failure: { kind: "invalid" } }
        : { step: firstStepOf(fields, currentStep), fields, failure: undefined };
    }
  }
  return { step: currentStep, fields: {}, failure: { kind: "unavailable" } };
}
