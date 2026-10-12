import type { ContractFixtures } from "./walker.ts";

// The fixtures of the operations of the committed document: the request the
// walker makes as the valid call of each. An operation added to the contract
// needs its entry here; until it has one the walker fails on it.
export const FIXTURES: ContractFixtures = {
  getHealth: {},
  getReady: {},
  getVersion: {},
  getApiConfig: {},
  getOpenApiDocument: {},
};
