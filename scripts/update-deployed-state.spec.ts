import { describe, expect, it } from "vitest";
import {
  buildSurfaceUpdates,
  deployedStateVariableName,
  isValidDeployedStateJson,
  mergeDeployedState,
  parseDeployedState,
  surfacesToUpdate,
} from "./update-deployed-state.mjs";

describe("parseDeployedState", () => {
  it("returns empty object for blank input", () => {
    expect(parseDeployedState("")).toEqual({});
    expect(parseDeployedState(undefined)).toEqual({});
  });

  it("returns null for invalid JSON", () => {
    expect(parseDeployedState("{not json")).toBeNull();
    expect(parseDeployedState("[]")).toBeNull();
  });

  it("parses valid surface entries", () => {
    expect(
      parseDeployedState(
        '{"marketing":{"version":"0.1.0","sha":"abc1234"}}',
      ),
    ).toEqual({
      marketing: { version: "0.1.0", sha: "abc1234" },
    });
  });
});

describe("isValidDeployedStateJson", () => {
  it("accepts empty object and rejects invalid payloads", () => {
    expect(isValidDeployedStateJson("{}")).toBe(true);
    expect(isValidDeployedStateJson("")).toBe(true);
    expect(isValidDeployedStateJson("not-json")).toBe(false);
  });
});

describe("mergeDeployedState", () => {
  it("merges only the provided surfaces", () => {
    const merged = mergeDeployedState(
      '{"api":{"version":"0.1.0","sha":"old"}}',
      {
        marketing: { version: "0.1.1", sha: "new1234" },
      },
    );

    expect(JSON.parse(merged)).toEqual({
      api: { version: "0.1.0", sha: "old" },
      marketing: { version: "0.1.1", sha: "new1234" },
    });
  });
});

describe("surfacesToUpdate", () => {
  it("includes only deployed surfaces that succeeded", () => {
    expect(
      surfacesToUpdate({
        deployFlags: {
          api: "false",
          web: "false",
          marketing: "true",
          admin: "false",
        },
        deployResults: {
          api: "skipped",
          web: "skipped",
          marketing: "success",
          admin: "skipped",
        },
      }),
    ).toEqual(["marketing"]);
  });

  it("excludes failed deploys", () => {
    expect(
      surfacesToUpdate({
        deployFlags: {
          api: "true",
          web: "true",
          marketing: "false",
          admin: "false",
        },
        deployResults: {
          api: "success",
          web: "failure",
          marketing: "skipped",
          admin: "skipped",
        },
      }),
    ).toEqual(["api"]);
  });
});

describe("buildSurfaceUpdates", () => {
  it("maps surfaces to package versions and sha", () => {
    expect(
      buildSurfaceUpdates({
        sha: "abc1234",
        surfaces: ["marketing"],
        packageVersions: {
          "@slugbase/marketing": "0.1.2",
        },
      }),
    ).toEqual({
      marketing: { version: "0.1.2", sha: "abc1234" },
    });
  });
});

describe("deployedStateVariableName", () => {
  it("returns environment-scoped variable names", () => {
    expect(deployedStateVariableName("staging")).toBe("DEPLOYED_STATE_staging");
    expect(deployedStateVariableName("production")).toBe(
      "DEPLOYED_STATE_production",
    );
  });
});
