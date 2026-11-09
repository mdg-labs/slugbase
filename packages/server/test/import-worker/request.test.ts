import { IMPORT_MAX_DISTINCT_NAMES } from "@slugbase/contracts";
import { prepareImport } from "@slugbase/core";
import { describe, expect, it } from "vitest";
import { requestHash } from "../../src/http/idempotency.ts";
import type { ChainContext } from "../../src/http/chain.ts";
import { ImportWorkerError } from "../../src/import-worker/client.ts";
import { canonical } from "../../src/import-worker/canonical.ts";
import { readOutcome } from "../../src/import-worker/request.ts";

// What the request thread accepts from the import worker thread (doc 10 T13): the answer is data derived from the user's file, so it is read as untrusted, and anything that is not what the worker is meant to send fails
// that one import (`ImportWorkerError`) before any of it is used.

const prepared = prepareImport([{ url: "https://example.com/a", folders: ["F"] }]);

describe("readOutcome", () => {
  it("takes a prepared file with the canonical body of a JSON import that asked for it", () => {
    const canonicalBody = new TextEncoder().encode("[]");

    expect(readOutcome({ kind: "prepared", prepared, canonicalBody }, "json", true)).toEqual({ kind: "prepared", prepared, canonicalBody });
    expect(readOutcome({ kind: "prepared", prepared }, "json", false)).toEqual({ kind: "prepared", prepared });
  });

  it("takes the digest of an upload that asked for it", () => {
    expect(readOutcome({ kind: "malformed", uploadDigest: "bytes:abc" }, "netscape", true)).toEqual({ kind: "malformed", uploadDigest: "bytes:abc" });
    expect(readOutcome({ kind: "too_large", uploadDigest: "parts:abc" }, "netscape", true)).toEqual({ kind: "too_large", uploadDigest: "parts:abc" });
    expect(readOutcome({ kind: "invalid", errors: [{ path: "file", code: "too_big" }], uploadDigest: "parts:abc" }, "netscape", true)).toEqual({ kind: "invalid", errors: [{ path: "file", code: "too_big" }], uploadDigest: "parts:abc" });
  });

  it.each([
    ["no object", "prepared", "json", false],
    ["an outcome of a kind it does not have", { kind: "done" }, "json", false],
    ["a prepared import over the bound of distinct names", { kind: "prepared", prepared: { kind: "too_many_distinct_names", names: IMPORT_MAX_DISTINCT_NAMES } }, "json", false],
    ["a prepared import that is none", { kind: "prepared", prepared: { kind: "ready" } }, "json", false],
    ["no canonical body where the request hash needs one", { kind: "prepared", prepared }, "json", true],
    ["a canonical body that is not bytes", { kind: "prepared", prepared, canonicalBody: "[]" }, "json", true],
    ["a canonical body for an upload", { kind: "prepared", prepared, canonicalBody: new Uint8Array(1), uploadDigest: "parts:a" }, "netscape", true],
    ["no digest where the request hash needs one", { kind: "malformed" }, "netscape", true],
    ["a digest that is no string", { kind: "malformed", uploadDigest: 5 }, "netscape", true],
    ["a digest for a JSON body", { kind: "malformed", uploadDigest: "parts:a" }, "json", false],
    ["a file too large for a JSON body", { kind: "too_large" }, "json", false],
    ["field errors that are no list", { kind: "invalid", errors: "x" }, "json", false],
    ["more field errors than a problem carries", { kind: "invalid", errors: Array.from({ length: 101 }, () => ({ path: "a", code: "b" })) }, "json", false],
    ["a field error with a path that is not text", { kind: "invalid", errors: [{ path: 1, code: "b" }] }, "json", false],
  ])("refuses %s", (_name, outcome, kind, digest) => {
    expect(() => readOutcome(outcome, kind as "json" | "netscape", digest)).toThrow(ImportWorkerError);
  });
});

describe("the request hash of a JSON import", () => {
  const context = (body?: unknown) =>
    ({ get: (name: string) => ({ workspaceId: "ws-1", input: { params: undefined, query: { dryRun: "true" }, ...(body === undefined ? {} : { body }) } })[name] }) as unknown as ChainContext;

  it("is the hash of the validated body whether the request thread has it or the import worker has serialised it", () => {
    const body = [{ url: "https://example.com/a", folders: ["b", "a"], title: null }, { url: "https://example.com/b" }];
    const canonicalBody = new TextEncoder().encode(JSON.stringify(canonical(body)));

    expect(requestHash(context(), "importJson", undefined, canonicalBody).equals(requestHash(context(body), "importJson"))).toBe(true);
    expect(requestHash(context(), "importJson", undefined, new TextEncoder().encode("[]")).equals(requestHash(context(body), "importJson"))).toBe(false);
  });
});
