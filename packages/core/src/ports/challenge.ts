import type { Port } from "./port.js";

export interface ChallengeVerdict {
  readonly ok: boolean;
}

/**
 * Verifies a bot-protection solution (doc 01 section 6). While `available` is
 * false no challenge is configured and none is required.
 */
export interface ChallengePort extends Port {
  verify(solution: string | undefined): Promise<ChallengeVerdict>;
}
