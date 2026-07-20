import { describe, expect, it } from "vitest";

import { BillingModule } from "./billing/billing.module.js";
import { ChallengeModule } from "./challenge/challenge.module.js";
import {
  BILLING_MODULE,
  createDomainModules,
  defaultDomainModules,
} from "./domain-modules.registry.js";

describe("domain-modules.registry", () => {
  it("exports BILLING_MODULE symbol for cloud billing injection", () => {
    expect(typeof BILLING_MODULE).toBe("symbol");
    expect(BILLING_MODULE.description).toBe("BILLING_MODULE");
  });

  it("defaults to CE BillingModule", () => {
    const modules = createDomainModules();
    expect(modules).toContain(BillingModule);
    expect(modules).toEqual(defaultDomainModules);
  });

  it("swaps billing module while preserving module count and order", () => {
    const modules = createDomainModules(ChallengeModule);
    const billingIndex = modules.indexOf(ChallengeModule);

    expect(modules).not.toContain(BillingModule);
    expect(billingIndex).toBe(6);
    expect(modules).toHaveLength(defaultDomainModules.length);
  });
});
