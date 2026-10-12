import type { ProblemCode } from "@slugbase/contracts";
import type { Adapters } from "./adapters.js";

/** What every port reports: whether an adapter is configured behind it (D22). */
export interface Port {
  /** False for the unconfigured default; callers degrade and say so instead of calling the port. */
  readonly available: boolean;
}

/** The problem codes an unavailable port answers with (doc 04 section 3.2). */
export type PortUnavailableCode = Extract<ProblemCode, "unavailable" | "mail_unavailable" | "ai_unavailable">;

/**
 * Thrown by a port with no adapter behind it when it is used. The problem
 * mapper answers it as `503 unavailable` carrying `code`.
 */
export class PortUnavailable extends Error {
  readonly port: keyof Adapters;
  readonly code: PortUnavailableCode;

  constructor(port: keyof Adapters, code: PortUnavailableCode) {
    super(`The ${port} port is not configured`);
    this.name = "PortUnavailable";
    this.port = port;
    this.code = code;
  }
}
