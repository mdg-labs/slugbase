import { Reflector } from "@nestjs/core";
import type { ThrottlerStorage } from "@nestjs/throttler";
import { describe, expect, it } from "vitest";

import { IpThrottlerGuard } from "./ip-throttler.guard.js";

/** Expose the protected getTracker for unit testing via a thin subclass. */
class TestableIpThrottlerGuard extends IpThrottlerGuard {
  callGetTracker(req: Record<string, unknown>): Promise<string> {
    return this.getTracker(req);
  }
}

/** Minimal ThrottlerStorage stub - only getTracker is exercised in these tests. */
const storageStub: ThrottlerStorage = {
  increment: () => Promise.resolve({ totalHits: 0, timeToExpire: 0, isBlocked: false, timeToBlockExpire: 0 }),
};

function makeGuard(): TestableIpThrottlerGuard {
  return new TestableIpThrottlerGuard(
    { throttlers: [] },
    storageStub,
    new Reflector(),
  );
}

describe("IpThrottlerGuard", () => {
  describe("getTracker", () => {
    it("returns the first forwarded IP when ips array is set", async () => {
      const guard = makeGuard();
      const tracker = await guard.callGetTracker({
        ip: "1.2.3.4",
        ips: ["10.0.0.1", "1.2.3.4"],
      });
      expect(tracker).toBe("10.0.0.1");
    });

    it("falls back to req.ip when ips is empty", async () => {
      const guard = makeGuard();
      const tracker = await guard.callGetTracker({
        ip: "5.6.7.8",
        ips: [],
      });
      expect(tracker).toBe("5.6.7.8");
    });

    it("returns 'unknown' when neither ip nor ips is set", async () => {
      const guard = makeGuard();
      const tracker = await guard.callGetTracker({});
      expect(tracker).toBe("unknown");
    });
  });
});
