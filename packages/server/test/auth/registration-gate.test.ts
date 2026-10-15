import { describe, expect, it } from "vitest";
import { assertRegistrationAllowed } from "../../src/auth/registration-gate.ts";
import { createServer, type ServerModule } from "../../src/create-server.ts";
import { HookResult } from "../../src/hooks/index.ts";
import { ProblemError } from "../../src/http/problem.ts";
import { adapters, documentOf, fakeDatabase, hookDispatcher, operation, recordingLogger, registrationPolicyModule, serverConfig } from "../support.ts";

// The gate of the account-creation paths (doc 01 section 13.5, doc 02 section 1 principle 3): one
// answer for every refusal, whichever module refused and whatever reason it gave, so a refusal
// carries no information beyond "this address cannot register".

const registrations = (...modules: ServerModule[]) =>
  modules.flatMap((module) => (module.hooks === undefined ? [] : [{ module: module.name, hooks: module.hooks }]));

async function refusal(run: Promise<void>): Promise<ProblemError> {
  const error = await run.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(ProblemError);
  return error as ProblemError;
}

describe("assertRegistrationAllowed", () => {
  it("allows with no module registered", async () => {
    await expect(assertRegistrationAllowed(hookDispatcher(), { email: "someone@blocked.example", path: "self-registration" })).resolves.toBeUndefined();
  });

  it("allows an address the policy allows, on every path", async () => {
    const hooks = hookDispatcher(registrations(registrationPolicyModule()));
    for (const path of ["self-registration", "invitation", "oidc"] as const) {
      await expect(assertRegistrationAllowed(hooks, { email: "someone@example.test", path })).resolves.toBeUndefined();
    }
  });

  it("throws a 403 registration_refused for an address the policy refuses, on every path", async () => {
    const hooks = hookDispatcher(registrations(registrationPolicyModule()));
    for (const path of ["self-registration", "invitation", "oidc"] as const) {
      const problem = await refusal(assertRegistrationAllowed(hooks, { email: "someone@blocked.example", path }));
      expect(problem.code).toBe("registration_refused");
    }
  });

  it("hands the hook the address and the path and nothing else", async () => {
    const seen: unknown[] = [];
    const spy: ServerModule = {
      name: "spy",
      hooks: {
        registrationPolicy: (input) => {
          seen.push(input);
          return HookResult.allow();
        },
      },
      register: () => ({}),
    };

    await assertRegistrationAllowed(hookDispatcher(registrations(spy)), {
      email: "someone@example.test",
      path: "oidc",
      extra: "a field the gate does not forward",
    } as Parameters<typeof assertRegistrationAllowed>[1]);

    expect(seen).toEqual([{ email: "someone@example.test", path: "oidc" }]);
  });

  it("fails with 503 unavailable when a hook throws or hangs, as the dispatcher does", async () => {
    const throws: ServerModule = {
      name: "throws",
      hooks: {
        registrationPolicy: () => {
          throw new Error("boom");
        },
      },
      register: () => ({}),
    };
    const hangs: ServerModule = { name: "hangs", hooks: { registrationPolicy: () => new Promise(() => undefined) }, register: () => ({}) };
    for (const module of [throws, hangs]) {
      const hooks = hookDispatcher(registrations(module));
      const problem = await refusal(assertRegistrationAllowed(hooks, { email: "someone@example.test", path: "self-registration" }));
      expect(problem.code).toBe("unavailable");
    }
  }, 10_000);
});

describe("the refusal on the wire", () => {
  function served(modules: readonly ServerModule[]) {
    const probe: ServerModule = {
      name: "probe",
      register: () => ({
        routes: [
          {
            operation: operation("get", "/api/v1/gate", "gateProbe"),
            handler: async (context) => {
              const hooks = context.get("hooks");
              if (hooks === undefined) {
                throw new Error("no hooks in the handler");
              }
              await assertRegistrationAllowed(hooks, { email: new URL(context.req.url).searchParams.get("email") ?? "", path: "self-registration" });
              return Response.json({ allowed: true });
            },
          },
        ],
      }),
    };
    return createServer({
      config: serverConfig(),
      adapters: adapters(),
      modules: [probe, ...modules],
      openApiDocument: documentOf([probe, ...modules]),
      migrations: [],
      logger: recordingLogger(),
      database: fakeDatabase(),
      hookTimeoutMs: 25,
    });
  }

  async function answer(modules: readonly ServerModule[], email: string) {
    // The same request ID every time, so the body and the headers can be compared whole.
    const response = await served(modules).fetch(
      new Request(`http://localhost/api/v1/gate?email=${encodeURIComponent(email)}`, { headers: { "x-request-id": "gate-test.1" } }),
    );
    const headers = Object.fromEntries([...response.headers].filter(([name]) => name !== "date"));
    return { status: response.status, headers, body: await response.text() };
  }

  it("answers 403 registration_refused as a problem document", async () => {
    const { status, headers, body } = await answer([registrationPolicyModule()], "someone@blocked.example");
    expect(status).toBe(403);
    expect(headers["content-type"]).toContain("application/problem+json");
    expect(JSON.parse(body)).toMatchObject({ code: "registration_refused", status: 403 });
  });

  it("answers byte for byte the same whatever reason the hook gave", async () => {
    const first = await answer([registrationPolicyModule({ reason: "domain_blocked" })], "someone@blocked.example");
    const second = await answer([registrationPolicyModule({ reason: "disposable domain with a long, specific explanation" })], "someone@blocked.example");
    expect(first.status).toBe(403);
    expect(second).toEqual(first);
  });

  it("answers byte for byte the same whichever module refused", async () => {
    const byA = await answer([registrationPolicyModule({ name: "module-a", domain: "a.example" })], "someone@a.example");
    const byB = await answer([registrationPolicyModule({ name: "module-b", domain: "b.example", reason: "other" })], "someone@b.example");
    const byOneOfTwo = await answer(
      [registrationPolicyModule({ name: "module-c", domain: "c.example" }), registrationPolicyModule({ name: "module-d", domain: "a.example" })],
      "someone@a.example",
    );
    expect(byA.status).toBe(403);
    expect(byB).toEqual(byA);
    expect(byOneOfTwo).toEqual(byA);
  });

  it("allows other addresses, and answers 503 unavailable for a hook that hangs", async () => {
    expect((await answer([registrationPolicyModule()], "someone@example.test")).status).toBe(200);
    const hangs: ServerModule = { name: "hangs", hooks: { registrationPolicy: () => new Promise(() => undefined) }, register: () => ({}) };
    const { status, body } = await answer([hangs], "someone@example.test");
    expect(status).toBe(503);
    expect(JSON.parse(body)).toMatchObject({ code: "unavailable" });
  });
});
