import { describe, expect, it } from "vitest";
import { parseCiLaunchStatus } from "./reportportal-ci-launch.js";

describe("parseCiLaunchStatus", () => {
  it("normalizes workflow outcomes", () => {
    expect(parseCiLaunchStatus("PASSED")).toBe("passed");
    expect(parseCiLaunchStatus("FAILED")).toBe("failed");
    expect(parseCiLaunchStatus("failed")).toBe("failed");
    expect(parseCiLaunchStatus(undefined)).toBe("passed");
  });
});
