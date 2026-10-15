// @vitest-environment jsdom
/// <reference lib="dom" />
import { getResponse } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createHandlers } from "../src/msw.ts";
import { createMockServer, readOpenApiDocument } from "../src/msw/node.ts";

// The MSW node server stores the `Set-Cookie` a mocked response sends, and answers 500 when the value does
// not parse as a cookie. A schema of type string gave the header the value `string`, so no component test
// could use the generated success handler of a sign-in. Here the handlers run on that server, in jsdom.

const document = readOpenApiDocument();
const raw = document as unknown as {
  paths: Record<string, Record<string, { operationId?: string; responses: Record<string, { headers?: Record<string, unknown>; content?: Record<string, unknown> }> }>>;
};

interface WithCookie {
  readonly method: string;
  readonly path: string;
  readonly operationId: string;
}

// The operations whose success response declares a `Set-Cookie`, with a JSON body or as a redirect without one,
// found without the code under test.
function declaringSetCookie(redirects: boolean): WithCookie[] {
  const found: WithCookie[] = [];
  for (const [path, item] of Object.entries(raw.paths)) {
    for (const [method, operation] of Object.entries(item)) {
      const success = Object.entries(operation.responses).find(([status]) => Number(status) < 400);
      const bodiless = success?.[1].content === undefined;
      if (success !== undefined && bodiless === redirects && Object.keys(success[1].headers ?? {}).some((name) => name.toLowerCase() === "set-cookie")) {
        found.push({ method: method.toUpperCase(), path, operationId: String(operation.operationId) });
      }
    }
  }
  return found;
}

interface Answer {
  readonly status: number;
  readonly contentType: string | null;
  readonly body: string;
}

// Through the XMLHttpRequest of jsdom, which the node server intercepts like the fetch of the app.
function send(operation: WithCookie): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open(operation.method, `${window.location.origin}${operation.path}`);
    request.setRequestHeader("Content-Type", "application/json");
    request.onload = () => {
      resolve({ status: request.status, contentType: request.getResponseHeader("Content-Type"), body: request.responseText });
    };
    request.onerror = () => {
      reject(new Error(`${operation.operationId} failed to send`));
    };
    request.send("{}");
  });
}

const server = createMockServer();

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
});

afterEach(() => {
  server.resetHandlers();
});

afterAll(() => {
  server.close();
});

describe("the generated handlers that declare a Set-Cookie, under the MSW node server in jsdom", () => {
  const operations = declaringSetCookie(false);

  it("include the sign-in operation", () => {
    expect(operations.map((operation) => operation.operationId)).toContain("login");
  });

  it.each(operations)("answer $operationId with its success status and body, not the cookie store's 500", async (operation) => {
    const answer = await send(operation);
    expect(answer.status, answer.body).toBeLessThan(300);
    expect(answer.contentType).toContain("application/json");
    expect(JSON.parse(answer.body)).toBeTypeOf("object");
  });

  it("answer the sign-in with the declared result", async () => {
    const answer = await send({ method: "POST", path: "/api/v1/auth/login", operationId: "login" });
    expect(answer.status).toBe(200);
    expect(JSON.parse(answer.body)).toEqual({ next: "done" });
  });

  it.each(operations)("send $operationId one cookie that parses, next to the JSON content type", async (operation) => {
    const handlers = createHandlers(document, { baseUrl: window.location.origin });
    const response = await getResponse(handlers, new Request(`${window.location.origin}${operation.path}`, { method: operation.method }));
    const cookies = response?.headers.getSetCookie() ?? [];
    expect(cookies).toHaveLength(1);
    // name=value, then attributes: a name without "=" is what the cookie store refuses.
    expect(cookies[0]).toMatch(/^[^\s=;]+=[^;]*(; [A-Za-z-]+(=[^;]*)?)*$/);
    expect(response?.headers.get("content-type")).toBe("application/json");
  });
});

describe("the generated handlers of a redirect that declares a Set-Cookie", () => {
  const redirects = declaringSetCookie(true);

  it("include the OIDC sign-in redirects", () => {
    expect(redirects.map((operation) => operation.operationId)).toEqual(expect.arrayContaining(["startOidcSignIn", "completeOidcSignIn"]));
  });

  it.each(redirects)("answer $operationId with its status, an address to follow, one cookie that parses and no body", async (operation) => {
    const handlers = createHandlers(document, { baseUrl: window.location.origin });
    const response = await getResponse(handlers, new Request(`${window.location.origin}${operation.path.replace("{provider}", "idp")}`, { method: operation.method }));
    expect(response?.status).toBe(302);
    expect(response?.headers.get("location")).toBe("/");
    const cookies = response?.headers.getSetCookie() ?? [];
    expect(cookies).toHaveLength(1);
    expect(cookies[0]).toMatch(/^[^\s=;]+=[^;]*(; [A-Za-z-]+(=[^;]*)?)*$/);
    expect(await response?.text()).toBe("");
  });
});
