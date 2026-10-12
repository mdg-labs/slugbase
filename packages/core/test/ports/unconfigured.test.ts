import { describe, expect, it } from "vitest";
import { PortUnavailable, unconfigured, type Adapters, type PortUnavailableCode } from "../../src/index.ts";

type Behaviour = "rejects" | "no-op" | "disabled";

// The methods of each port, how the unconfigured default answers them, and the
// problem code a rejection carries (doc 04 section 3.2).
const PORTS: Record<
  keyof Adapters,
  { methods: string[]; behaviour: Behaviour; code: PortUnavailableCode }
> = {
  mail: { methods: ["send"], behaviour: "rejects", code: "mail_unavailable" },
  ai: { methods: ["suggest"], behaviour: "rejects", code: "ai_unavailable" },
  identity: { methods: ["begin", "complete", "listProviders"], behaviour: "rejects", code: "unavailable" },
  analytics: { methods: ["track"], behaviour: "no-op", code: "unavailable" },
  errors: { methods: ["capture"], behaviour: "no-op", code: "unavailable" },
  clientErrorReport: { methods: ["dsn"], behaviour: "no-op", code: "unavailable" },
  challenge: { methods: ["verify"], behaviour: "disabled", code: "unavailable" },
  egress: { methods: ["request"], behaviour: "rejects", code: "unavailable" },
  rateLimit: { methods: ["consume"], behaviour: "rejects", code: "unavailable" },
  secretBox: { methods: ["needsRotation", "open", "reseal", "seal"], behaviour: "rejects", code: "unavailable" },
  tenantResolver: { methods: ["resolve"], behaviour: "rejects", code: "unavailable" },
};

function call(port: object, method: string): Promise<unknown> {
  const fn: unknown = Reflect.get(port, method);
  if (typeof fn !== "function") {
    throw new Error(`${method} is not a function`);
  }
  return Promise.resolve(fn.call(port, undefined));
}

describe("unconfigured()", () => {
  it("declares a default for every port of the map", () => {
    expect(Object.keys(unconfigured()).sort()).toEqual(Object.keys(PORTS).sort());
  });

  it("declares exactly the methods of each port", () => {
    for (const [name, spec] of Object.entries(PORTS)) {
      const port = unconfigured()[name as keyof Adapters];
      const methods = Object.entries(port)
        .filter(([, value]) => typeof value === "function")
        .map(([key]) => key)
        .sort();
      expect(methods, name).toEqual(spec.methods);
    }
  });

  it("returns a new object per call", () => {
    expect(unconfigured()).not.toBe(unconfigured());
    expect(unconfigured().mail).not.toBe(unconfigured().mail);
  });

  describe.each(Object.entries(PORTS))("%s", (name, spec) => {
    const port = () => unconfigured()[name as keyof Adapters];

    it("reports available: false", () => {
      expect(port().available).toBe(false);
    });

    if (spec.behaviour === "rejects") {
      it.each(spec.methods)(`rejects ${name}.%s with PortUnavailable carrying ${spec.code}`, async (method) => {
        const rejection = await call(port(), method).then(
          () => undefined,
          (error: unknown) => error,
        );
        expect(rejection).toBeInstanceOf(PortUnavailable);
        expect(rejection).toMatchObject({ port: name, code: spec.code, name: "PortUnavailable" });
      });
    }
  });

  it("rejects the same typed error for a second use", async () => {
    const { mail } = unconfigured();
    await expect(mail.send({ template: "t", to: "a@example.com", locale: "en", data: {} })).rejects.toBeInstanceOf(PortUnavailable);
    await expect(mail.send({ template: "t", to: "a@example.com", locale: "en", data: {} })).rejects.toMatchObject({ code: "mail_unavailable" });
  });

  it("records no analytics event and reports no error, without failing", async () => {
    const { analytics, errors } = unconfigured();
    await expect(analytics.track({ name: "x", consent: true })).resolves.toBeUndefined();
    await expect(errors.capture(new Error("x"))).resolves.toBeUndefined();
  });

  it("answers no client error-report DSN, without failing", async () => {
    const { clientErrorReport } = unconfigured();
    await expect(clientErrorReport.dsn({ accountId: "a", workspaceId: undefined })).resolves.toBeNull();
  });

  it("disables the challenge: it requires no solution and passes every one", async () => {
    const { challenge } = unconfigured();
    expect(challenge.available).toBe(false);
    await expect(challenge.verify(undefined)).resolves.toEqual({ ok: true });
    await expect(challenge.verify("any solution")).resolves.toEqual({ ok: true });
  });
});

describe("PortUnavailable", () => {
  it("names the port and carries the problem code, with no value in the message", () => {
    const error = new PortUnavailable("ai", "ai_unavailable");
    expect(error).toBeInstanceOf(Error);
    expect(error.port).toBe("ai");
    expect(error.code).toBe("ai_unavailable");
    expect(error.message).toBe("The ai port is not configured");
  });
});
