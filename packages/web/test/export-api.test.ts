import { describe, expect, it, vi } from "vitest";
import { createApiClient } from "../src/api/client.ts";
import { exportCountOf, exportFailureOf, fetchExport, type ExportRequest } from "../src/data/export-api.ts";
import { ApiProblemError } from "../src/api/client.ts";

// The request the export makes (doc 04 section 10.9). The failure scenarios are a selection that is sent as the whole library (the server takes a request with no
// selection parameter for it), a "select all matching" that loses the scope or a tag of the list, and a count taken from a header that is not a count.

const FOLDER = "0192f3a0-cccc-7000-8000-000000000001";
const TAG_A = "0192f3a0-dddd-7000-8000-000000000001";
const TAG_B = "0192f3a0-dddd-7000-8000-000000000002";
const ID_A = "0192f3a0-aaaa-7000-8000-000000000001";
const ID_B = "0192f3a0-aaaa-7000-8000-000000000002";

async function sent(request: ExportRequest): Promise<URL> {
  const send = vi.fn<(request: Request) => Promise<Response>>(() => Promise.resolve(new Response("{}", { headers: { "Content-Type": "application/json", "X-Export-Count": "4" } })));
  const file = await fetchExport(createApiClient({ fetch: send }), request);
  expect(file.count).toBe(4);
  return new URL(send.mock.calls[0]?.[0].url ?? "");
}

describe("the query of an export", () => {
  it("is includeShared alone for the whole library", async () => {
    const url = await sent({ format: "json", includeShared: true });
    expect(url.pathname).toBe("/api/v1/export/json");
    expect(Object.fromEntries(url.searchParams)).toEqual({ includeShared: "true" });
  });

  it("is the identifiers repeated for a selection by identifier, and never includeShared with them", async () => {
    const url = await sent({ format: "netscape", includeShared: true, selection: { kind: "ids", ids: [ID_A, ID_B] } });
    expect(url.pathname).toBe("/api/v1/export/netscape");
    expect(url.search).toBe(`?id=${ID_A}&id=${ID_B}`);
  });

  it("is the filters of the list with their scope for a selection by filters, the scope being all when the list leaves it out", async () => {
    const all = await sent({ format: "json", includeShared: false, selection: { kind: "filter", filters: { pinned: "true", folderId: FOLDER, q: "docs", tag: [TAG_A, TAG_B] } } });
    expect(all.searchParams.get("scope")).toBe("all");
    expect(all.searchParams.get("pinned")).toBe("true");
    expect(all.searchParams.get("folderId")).toBe(FOLDER);
    expect(all.searchParams.get("q")).toBe("docs");
    expect(all.searchParams.getAll("tag")).toEqual([TAG_A, TAG_B]);
    expect(all.searchParams.has("id")).toBe(false);
    expect(all.searchParams.has("includeShared")).toBe(false);
    const nothing = await sent({ format: "json", includeShared: false, selection: { kind: "filter", filters: {} } });
    expect(nothing.search).toBe("?scope=all");
    const mine = await sent({ format: "json", includeShared: false, selection: { kind: "filter", filters: { scope: "mine" } } });
    expect(mine.search).toBe("?scope=mine");
  });
});

describe("the count of an export", () => {
  it("is a whole number from the header and nothing else", () => {
    expect(exportCountOf("0")).toBe(0);
    expect(exportCountOf("150")).toBe(150);
    for (const header of [null, "", "-1", "1.5", "12abc", " 7", "1e3", "9999999999"]) {
      expect(exportCountOf(header), String(header)).toBeUndefined();
    }
  });
});

describe("the failure of an export", () => {
  it("says a selection the API refuses is too large, apart from a rate limit, an unavailable server and a failure", () => {
    const problem = (status: number) => new ApiProblemError({ code: status === 422 ? "validation_failed" : "internal", status, requestId: "req" });
    expect(exportFailureOf(problem(422))).toEqual({ kind: "tooMany" });
    expect(exportFailureOf(problem(500))).toEqual({ kind: "failed" });
    expect(exportFailureOf(problem(503))).toEqual({ kind: "unavailable" });
  });
});
