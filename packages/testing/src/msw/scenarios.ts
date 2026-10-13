/**
 * A named state of the mocked API. A scenario answers an operation with one of
 * the responses the contract declares for it, or with a fixture of its own.
 */
export interface Scenario {
  readonly name: string;
  /** operationId to the declared status the operation answers with instead of its success. */
  readonly statuses?: Readonly<Record<string, number>>;
  /** operationId to the body of the operation's success response, replacing the generated one. */
  readonly fixtures?: Readonly<Record<string, unknown>>;
}

export const DEFAULT_SCENARIO: Scenario = { name: "default" };

/**
 * The scenarios the mock knows, by name. The states of doc 08 section 7
 * (`free-at-cap`, `team-admin`, `empty-workspace`, `mfa-required`) are added
 * here with the operations they change.
 */
export const SCENARIOS: Readonly<Record<string, Scenario>> = {
  [DEFAULT_SCENARIO.name]: DEFAULT_SCENARIO,
};

/** The query parameter that picks the scenario of a mocked page. */
export const SCENARIO_PARAMETER = "scenario";

/** The scenario a search string such as `?scenario=default` names; none named means `default`. */
export function scenarioFromSearch(search: string, scenarios: Readonly<Record<string, Scenario>> = SCENARIOS): Scenario {
  const name = new URLSearchParams(search).get(SCENARIO_PARAMETER);
  if (name === null) {
    return DEFAULT_SCENARIO;
  }
  const scenario = Object.hasOwn(scenarios, name) ? scenarios[name] : undefined;
  if (scenario === undefined) {
    throw new Error(`Unknown mock scenario "${name}"; known scenarios: ${Object.keys(scenarios).join(", ")}`);
  }
  return scenario;
}
