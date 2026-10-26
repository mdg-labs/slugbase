import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unconfigured, type BookmarkUsage, type GoNavigation } from "@slugbase/core";
import { Hono } from "hono";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionPrincipal } from "../../src/http/authenticate.ts";
import { responseStage } from "../../src/http/problem.ts";
import { RouteTable, installChain, type ChainEnv, type StageImplementations } from "../../src/http/chain.ts";
import type { RequestTenant } from "../../src/http/tenant.ts";
import { goNavigationRoutes, isGoShell } from "../../src/routes/go/navigate.ts";
import { hookDispatcher, rateLimitDependencies, recordingLogger, tenantDependencies } from "../support.ts";

// What `/go/<slug>` answers for each outcome of the resolution, where the store has no sharing to give a second candidate yet: the outcome is fixed and the chain
// is real. The cases that need the database are in go-navigation.integration.test.ts.

const navigation = vi.hoisted<{ outcome: unknown; asked: unknown[] }>(() => ({ outcome: undefined, asked: [] }));

vi.mock("@slugbase/core", async (importOriginal) => ({
  ...(await importOriginal()),
  navigateToSlug: (_dependencies: unknown, ask: unknown) => {
    navigation.asked.push(ask);
    return Promise.resolve(navigation.outcome);
  },
}));

const roots: string[] = [];

afterAll(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
});

const ACCOUNT = "0192f3a0-bbbb-7000-8000-00000000000a";
const SHELL = "<!doctype html><title>shell</title>";

function member(): { readonly principal: SessionPrincipal; readonly tenant: RequestTenant } {
  return {
    principal: { kind: "session", accountId: ACCOUNT, sessionId: "s", activeWorkspaceId: "w", instanceAdmin: false },
    tenant: { accountId: ACCOUNT, workspaceId: "w", memberId: "m", role: "member", withTenant: (fn) => fn({} as never) },
  };
}

function setup(outcome: GoNavigation, options: { readonly webRoot?: string } = {}) {
  navigation.outcome = outcome;
  navigation.asked = [];
  const { principal, tenant } = member();
  const taken: string[] = [];
  const validate = responseStage("throw");
  const stages: StageImplementations = {
    // As the composition has it: the shell is the SPA's page, which no schema describes.
    response: (context) => (isGoShell(context) ? undefined : validate(context)),
    authentication: async (context, next) => {
      context.set("principal", principal);
      await next();
    },
    "rate-limiting": async (context, next) => {
      context.set("takeAccountLimit", (_context, accountId) => {
        taken.push(accountId);
        return Promise.resolve();
      });
      await next();
    },
    "tenant-resolution": async (context, next) => {
      context.set("tenant", tenant);
      await next();
    },
  };
  const usage: BookmarkUsage = { record: () => undefined };
  const app = new Hono<ChainEnv>();
  installChain(
    app,
    {
      logger: recordingLogger(),
      routes: new RouteTable(goNavigationRoutes({ usage, webRoot: options.webRoot })),
      trustedProxyHops: 0,
      appOrigin: "https://bookmarks.example.com",
      challenge: unconfigured().challenge,
      errors: unconfigured().errors,
      ...tenantDependencies(),
      ...rateLimitDependencies(),
      hooks: hookDispatcher(),
      responseValidation: "throw",
    },
    stages,
  );
  return { app, taken };
}

describe("GET /go/<slug>", () => {
  beforeEach(() => {
    navigation.asked = [];
  });

  it("answers the SPA shell with 200 where the member has to choose, at the same address, with no caching and no referrer", async () => {
    const webRoot = mkdtempSync(join(tmpdir(), "slugbase-go-shell-"));
    roots.push(webRoot);
    writeFileSync(join(webRoot, "index.html"), SHELL);
    const { app, taken } = setup({ kind: "choose" }, { webRoot });

    const response = await app.request("/go/Mail");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/^text\/html/);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("location")).toBeNull();
    expect(await response.text()).toBe(SHELL);
    expect(navigation.asked).toEqual([{ accountId: ACCOUNT, slug: "mail" }]);
    expect(taken).toEqual([ACCOUNT]);
  });

  it("redirects to the address the resolution answers", async () => {
    const { app } = setup({ kind: "forward", url: "https://example.com/docs" });

    const response = await app.request("/go/docs");

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://example.com/docs");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("asks the resolution nothing for a path or a query after the slug or a slug outside the grammar, and without a web build answers 404 for what needs a shell", async () => {
    const { app } = setup({ kind: "forward", url: "https://example.com/docs" });

    for (const path of ["/go/docs/more", "/go/docs?x=1", "/go/-docs"]) {
      const response = await app.request(path);
      expect(response.status, path).toBe(404);
      expect(response.headers.get("location"), path).toBeNull();
    }
    expect(navigation.asked).toEqual([]);
  });
});
