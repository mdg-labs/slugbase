import type { ClientErrorReportPort, ClientErrorReportRequest, SeatEntitlements } from "@slugbase/core";
import type { Logger } from "../create-server.ts";
import { ProblemError } from "../http/problem.ts";
import {
  DELETION_REFUSAL_CODES,
  HOOK_NAMES,
  HookResult,
  REGISTRATION_REFUSAL_CODE,
  type DeletionGuardInput,
  type DeletionRefusalCode,
  type HookName,
  type HookRefusals,
  type RegistrationPolicyInput,
  type RegistrationRefusalCode,
  type SeatCheckInput,
  type ServerHooks,
} from "./types.ts";

export const DEFAULT_HOOK_TIMEOUT_MS = 2_000;

/** A hook of one module, in the order the modules were composed. */
export interface HookRegistration {
  readonly module: string;
  readonly hooks: ServerHooks;
  /** The refusal codes the module declared; a hook answering with another code fails. */
  readonly refusals?: HookRefusals;
}

export interface HookDispatcherOptions {
  readonly registrations: readonly HookRegistration[];
  readonly clientErrorReport: ClientErrorReportPort;
  /** The workspace's `seats.max`, which an acceptance's limit starts from before the seat-check hooks are consulted. */
  readonly seats: SeatEntitlements;
  readonly logger: Logger;
  /** How long one hook may take to answer; a hook that is still running is treated as failed. */
  readonly timeoutMs?: number;
}

/**
 * What a call site consults to take part in the decisions of doc 01 section 13.
 * The seat check, the deletion guard and the registration policy fail closed: a
 * hook that throws, times out or answers outside its contract makes the
 * dispatcher throw a `503 unavailable` problem, so the flow's transaction rolls
 * back and nothing is written.
 */
export interface HookDispatcher {
  /** The seat limit of an invitation acceptance: the lowest hook limit, else `entitlementLimit`. `null` is unlimited. */
  seatLimit(input: SeatCheckInput, entitlementLimit: number | null): Promise<number | null>;
  /**
   * The seat limit an acceptance passes to the database: the workspace's `seats.max` as the entitlement engine reads it for
   * `request` (a source that fails rejects, so nothing is accepted without a ceiling), replaced by the lowest limit the
   * seat-check hooks answer. `null` is unlimited.
   */
  acceptanceSeatLimit(input: SeatCheckInput, request: object): Promise<number | null>;
  /** Allow, or the first refusal in registration order. */
  deletionGuard(input: DeletionGuardInput): Promise<HookResult<DeletionRefusalCode>>;
  /** Allow, or `registration_refused` whatever the reason a hook gave. */
  registrationPolicy(input: RegistrationPolicyInput): Promise<HookResult<RegistrationRefusalCode>>;
  /** The DSN for the account's own profile; `null` when there is no source or it fails. */
  clientErrorReportDsn(request: ClientErrorReportRequest): Promise<string | null>;
}

class HookFailure extends Error {
  readonly reason: "threw" | "timeout" | "invalid_result";

  constructor(reason: HookFailure["reason"]) {
    super(`hook ${reason}`);
    this.name = "HookFailure";
    this.reason = reason;
  }
}

function unavailable(): ProblemError {
  return new ProblemError("unavailable", "The service is temporarily unavailable.");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function withinTimeout<Result>(run: () => Result | Promise<Result>, timeoutMs: number): Promise<Result> {
  return new Promise<Result>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new HookFailure("timeout"));
    }, timeoutMs);
    // A hook that answers after the deadline has lost; its late answer or throw is dropped.
    const settle = (settler: () => void): void => {
      clearTimeout(timer);
      settler();
    };
    let pending: Result | Promise<Result>;
    try {
      pending = run();
    } catch {
      settle(() => {
        reject(new HookFailure("threw"));
      });
      return;
    }
    Promise.resolve(pending).then(
      (value) => {
        settle(() => {
          resolve(value);
        });
      },
      () => {
        settle(() => {
          reject(new HookFailure("threw"));
        });
      },
    );
  });
}

/** The hooks of the modules, validated at composition: a hook is a function and the name is one CE declares. */
export function invalidHooks(hooks: unknown): string | undefined {
  if (!isRecord(hooks)) {
    return "hooks must be an object";
  }
  for (const [name, hook] of Object.entries(hooks)) {
    if (!(HOOK_NAMES as readonly string[]).includes(name)) {
      return `${name} is not a hook CE declares`;
    }
    if (hook !== undefined && typeof hook !== "function") {
      return `the hook ${name} must be a function`;
    }
  }
  return undefined;
}

/** The refusal codes a module declares, validated at composition: each is on the closed list of its hook. */
export function invalidHookRefusals(refusals: unknown): string | undefined {
  if (!isRecord(refusals)) {
    return "hookRefusals must be an object";
  }
  for (const [name, codes] of Object.entries(refusals)) {
    if (name !== "deletionGuard") {
      return `${name} is not a hook that refuses with a code from a closed list`;
    }
    if (!Array.isArray(codes)) {
      return `the refusals of ${name} must be a list`;
    }
    for (const code of codes as unknown[]) {
      if (!(DELETION_REFUSAL_CODES as readonly unknown[]).includes(code)) {
        return `${typeof code === "string" ? code : "a refusal code"} is not a refusal code of ${name}`;
      }
    }
  }
  return undefined;
}

export function createHookDispatcher(options: HookDispatcherOptions): HookDispatcher {
  const { registrations, clientErrorReport, seats, logger } = options;
  const timeoutMs = options.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS;

  // Runs the hooks of one kind in registration order; every answer is validated
  // before the next hook runs, and a failure ends the dispatch.
  async function consult<Answer>(
    name: HookName,
    input: object,
    validate: (answer: unknown, registration: HookRegistration) => answer is Answer,
  ): Promise<Answer[]> {
    const answers: Answer[] = [];
    for (const registration of registrations) {
      const { module, hooks } = registration;
      const hook = hooks[name] as ((given: object) => unknown) | undefined;
      if (hook === undefined) {
        continue;
      }
      try {
        // Each hook gets its own frozen copy of plain values: it cannot change what the next one sees.
        const answer: unknown = await withinTimeout(() => hook.call(hooks, Object.freeze({ ...input })), timeoutMs);
        if (!validate(answer, registration)) {
          throw new HookFailure("invalid_result");
        }
        answers.push(answer);
      } catch (error) {
        const reason = error instanceof HookFailure ? error.reason : "threw";
        logger.error("A hook failed; the flow is refused", { hook: name, module, reason });
        throw unavailable();
      }
    }
    return answers;
  }

  const isSeatAnswer = (answer: unknown): answer is { seatLimit: number | null } =>
    isRecord(answer) &&
    (answer.seatLimit === null || (typeof answer.seatLimit === "number" && Number.isSafeInteger(answer.seatLimit) && answer.seatLimit >= 0));

  const isDeletionAnswer = (answer: unknown, registration: HookRegistration): answer is HookResult<DeletionRefusalCode> =>
    isRecord(answer) &&
    (answer.outcome === "allow" ||
      (answer.outcome === "refuse" &&
        (DELETION_REFUSAL_CODES as readonly unknown[]).includes(answer.code) &&
        (registration.refusals?.deletionGuard as readonly unknown[] | undefined)?.includes(answer.code) === true));

  const isRegistrationAnswer = (answer: unknown): answer is HookResult =>
    isRecord(answer) &&
    (answer.outcome === "allow" ||
      (answer.outcome === "refuse" && typeof answer.code === "string" && answer.code !== ""));

  const seatLimit: HookDispatcher["seatLimit"] = async (input, entitlementLimit) => {
    const answers = await consult("seatCheck", input, isSeatAnswer);
    if (answers.length === 0) {
      return entitlementLimit;
    }
    // Hooks replace the entitlement's value; null is unlimited, so only a number can lower the limit.
    const limits = answers.flatMap((answer) => (answer.seatLimit === null ? [] : [answer.seatLimit]));
    return limits.length === 0 ? null : Math.min(...limits);
  };

  return {
    seatLimit,

    async acceptanceSeatLimit(input, request) {
      return seatLimit(input, await seats.limit(input.accountId, input.workspaceId, request));
    },

    async deletionGuard(input) {
      const answers = await consult("deletionGuard", input, isDeletionAnswer);
      return answers.find((answer) => answer.outcome === "refuse") ?? HookResult.allow();
    },

    async registrationPolicy(input) {
      const answers = await consult("registrationPolicy", input, isRegistrationAnswer);
      return answers.some((answer) => answer.outcome === "refuse")
        ? HookResult.refuse(REGISTRATION_REFUSAL_CODE)
        : HookResult.allow();
    },

    async clientErrorReportDsn(request) {
      if (!clientErrorReport.available) {
        return null;
      }
      try {
        const dsn = await withinTimeout(() => clientErrorReport.dsn(Object.freeze({ ...request })), timeoutMs);
        return typeof dsn === "string" && dsn !== "" ? dsn : null;
      } catch (error) {
        logger.warn("The client error-report source failed; no DSN is supplied", {
          reason: error instanceof HookFailure ? error.reason : "threw",
        });
        return null;
      }
    },
  };
}
