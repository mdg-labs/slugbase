import { describe, expect, it } from "vitest";
import { userAgentFamily } from "../../src/auth/user-agent.ts";

describe("userAgentFamily", () => {
  it.each([
    ["Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0", "Firefox"],
    ["Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 FxiOS/131.0 Mobile/15E148 Safari/605.1.15", "Firefox"],
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36", "Chrome"],
    ["Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 CriOS/130.0.0.0 Mobile/15E148 Safari/604.1", "Chrome"],
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0", "Edge"],
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 OPR/115.0.0.0", "Opera"],
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15", "Safari"],
    ["curl/8.5.0", "curl"],
    ["Vitest", "Other"],
  ])("reads %s as %s", (agent, family) => {
    expect(userAgentFamily(agent)).toBe(family);
  });

  it("is null for a client that sent no user agent, and never returns the header", () => {
    expect(userAgentFamily(null)).toBeNull();
    expect(userAgentFamily("   ")).toBeNull();
    expect(userAgentFamily("Mozilla/5.0 secret-device-id-1234")).toBe("Other");
  });
});
