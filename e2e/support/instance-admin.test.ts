import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createWorkspace, enrolSecondFactor, ownAccountId, type ApiClient, type ApiResponse } from "./instance-admin.ts";
import { totpCode, totpStep } from "./totp.ts";

const ORIGIN = "https://127.0.0.1:23456";
const KEY = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
const NOW = Date.UTC(2026, 9, 26, 12, 0, 0);

interface Call {
  method: "GET" | "POST";
  path: string;
  headers: Record<string, string>;
  data?: unknown;
}

function answer(status: number, body: unknown = {}): ApiResponse {
  return { ok: () => status >= 200 && status < 300, status: () => status, json: () => Promise.resolve(body) };
}

/** A client that answers the paths in order and records what it was asked. */
function client(answers: Record<string, ApiResponse>): { api: ApiClient; calls: Call[] } {
  const calls: Call[] = [];
  const find = (path: string): ApiResponse => answers[path] ?? answer(404);
  return {
    calls,
    api: {
      get: (path) => {
        calls.push({ method: "GET", path, headers: {} });
        return Promise.resolve(find(path));
      },
      post: (path, options) => {
        calls.push({ method: "POST", path, headers: options.headers, data: options.data });
        return Promise.resolve(find(path));
      },
    },
  };
}

void describe("the account of the session", () => {
  void it("is read from GET /api/v1/me", async () => {
    const { api } = client({ "/api/v1/me": answer(200, { account: { id: "0190-account" } }) });
    assert.equal(await ownAccountId(api), "0190-account");
  });

  void it("is refused when the answer carries none or the call fails", async () => {
    await assert.rejects(ownAccountId(client({ "/api/v1/me": answer(200, { account: {} }) }).api), /without an account identifier/);
    await assert.rejects(ownAccountId(client({ "/api/v1/me": answer(401) }).api), /GET \/api\/v1\/me answered 401/);
  });
});

void describe("the enrolment of an authenticator app", () => {
  const answers = {
    "/api/v1/me/reauth": answer(204),
    "/api/v1/me/mfa/enrollment": answer(200, { secret: KEY }),
    "/api/v1/me/mfa/enrollment/confirm": answer(200, { backupCodes: [] }),
  };

  void it("confirms the password, starts the enrolment and answers with the code of the key it was given", async () => {
    const { api, calls } = client(answers);
    await enrolSecondFactor(api, "a password", ORIGIN, () => NOW);
    assert.deepEqual(
      calls.map(({ method, path }) => `${method} ${path}`),
      ["POST /api/v1/me/reauth", "POST /api/v1/me/mfa/enrollment", "POST /api/v1/me/mfa/enrollment/confirm"],
    );
    assert.deepEqual(calls[0]?.data, { password: "a password" });
    assert.deepEqual(calls[2]?.data, { code: totpCode(KEY, totpStep(NOW)) });
    for (const call of calls) {
      assert.equal(call.headers.origin, ORIGIN);
      assert.equal(call.headers["content-type"], "application/json");
    }
  });

  void it("stops at the first refusal and names the call, never the password or the code", async () => {
    for (const [path, refused] of [
      ["/api/v1/me/reauth", 401],
      ["/api/v1/me/mfa/enrollment", 422],
      ["/api/v1/me/mfa/enrollment/confirm", 422],
    ] as const) {
      const { api, calls } = client({ ...answers, [path]: answer(refused) });
      await assert.rejects(
        enrolSecondFactor(api, "a password", ORIGIN, () => NOW),
        (error: Error) => error.message === `POST ${path} answered ${String(refused)}`,
      );
      assert.equal(calls.at(-1)?.path, path);
    }
  });

  void it("is refused when the enrolment carries no setup key", async () => {
    const { api } = client({ ...answers, "/api/v1/me/mfa/enrollment": answer(200, {}) });
    await assert.rejects(enrolSecondFactor(api, "a password", ORIGIN, () => NOW), /without a setup key/);
  });
});

void describe("the workspace of an instance admin", () => {
  const created = answer(201, { id: "0190-workspace", name: "Second", ownerInvitation: null });

  void it("is created for an account, which becomes its owner", async () => {
    const { api, calls } = client({ "/api/v1/instance/workspaces": created });
    assert.deepEqual(await createWorkspace(api, "Second", { ownerAccountId: "0190-account" }, ORIGIN), { id: "0190-workspace", name: "Second" });
    assert.deepEqual(calls[0]?.data, { name: "Second", ownerAccountId: "0190-account" });
    assert.equal(calls[0].headers.origin, ORIGIN);
  });

  void it("is created for an address, which gets an owner invitation", async () => {
    const { api, calls } = client({ "/api/v1/instance/workspaces": created });
    await createWorkspace(api, "Second", { ownerEmail: "owner@example.test" }, ORIGIN);
    assert.deepEqual(calls[0]?.data, { name: "Second", ownerEmail: "owner@example.test" });
  });

  void it("is refused when the server refuses, or answers another workspace", async () => {
    const refused = client({ "/api/v1/instance/workspaces": answer(403) });
    await assert.rejects(createWorkspace(refused.api, "Second", { ownerAccountId: "0190-account" }, ORIGIN), /POST \/api\/v1\/instance\/workspaces answered 403/);
    const other = client({ "/api/v1/instance/workspaces": answer(201, { id: "0190-workspace", name: "Other" }) });
    await assert.rejects(createWorkspace(other.api, "Second", { ownerAccountId: "0190-account" }, ORIGIN), /other than the one asked for/);
  });
});
