import type { ContractFixtures } from "./walker.ts";

// The fixtures of the operations of the committed document: the request the
// walker makes as the valid call of each. An operation added to the contract
// needs its entry here; until it has one the walker fails on it.

/** The account the walker signs in as; the contract test creates it before the walk. */
export const WALKER_ACCOUNT = { email: "walker@example.test", password: "a password for the walker" } as const;

export const FIXTURES: ContractFixtures = {
  getHealth: {},
  getReady: {},
  getVersion: {},
  getApiConfig: {},
  getOpenApiDocument: {},
  login: { body: { ...WALKER_ACCOUNT, remember: false } },
  logout: {},
};
