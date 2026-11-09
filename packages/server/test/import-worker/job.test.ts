import { IMPORT_MAX_BOOKMARKS, IMPORT_NETSCAPE_MAX_FILE_BYTES } from "@slugbase/contracts";
import { describe, expect, it } from "vitest";
import { runImportJob, type ImportJob } from "../../src/import-worker/job.ts";

// The work the import worker does for a request (doc 02 section 13.1, doc 10 T13), run here in the test's own thread: the same function the worker thread calls, so that every answer it can give is made on purpose.

const text = (value: string): Uint8Array => new TextEncoder().encode(value);
const json = (value: unknown, digest = false): ImportJob => ({ kind: "json", bytes: text(JSON.stringify(value)), contentType: "application/json", digest });

async function upload(parts: readonly (readonly [string, string | File])[], digest = false): Promise<ImportJob> {
  const form = new FormData();
  for (const [name, value] of parts) {
    form.append(name, value);
  }
  const response = new Response(form);
  return { kind: "netscape", bytes: new Uint8Array(await response.arrayBuffer()), contentType: response.headers.get("content-type") ?? "", digest };
}

const file = (content: string, name = "bookmarks.html"): File => new File([content], name, { type: "text/html" });
const LINKS = '<DL><DT><H3>Reading</H3><DL><DT><A HREF="https://example.com/a" TAGS="x, y">A</A></DL></DL>';

describe("an import job of a JSON file", () => {
  it("prepares a valid file, and makes the canonical text of the body the idempotency hash reads only when asked", async () => {
    const body = [{ url: "https://example.com/a", title: "A", folders: ["b"] }];
    const plain = await runImportJob(json(body));
    const asked = await runImportJob(json(body, true));

    expect(plain).toMatchObject({ kind: "prepared", prepared: { kind: "ready", reads: [{ position: 1, url: "https://example.com/a", title: "A" }] } });
    expect(plain).not.toHaveProperty("canonicalBody");
    if (asked.kind !== "prepared" || asked.canonicalBody === undefined) {
      throw new Error("not prepared");
    }
    expect(new TextDecoder().decode(asked.canonicalBody)).toBe('[{"folders":["b"],"title":"A","url":"https://example.com/a"}]');
  });

  it.each([
    ["text that is not JSON", text("{ nope")],
    ["bytes that are not UTF-8", new Uint8Array([0x5b, 0xff, 0x5d])],
    ["a body of white space", text("  ")],
  ])("answers %s as malformed", async (_name, bytes) => {
    expect(await runImportJob({ kind: "json", bytes, contentType: "application/json", digest: false })).toEqual({ kind: "malformed" });
  });

  it("answers an empty body as a body that is no file, with the issue the schema gives for a value that is not there", async () => {
    expect(await runImportJob({ kind: "json", bytes: new Uint8Array(0), contentType: "application/json", digest: false })).toMatchObject({ kind: "invalid", errors: [{ path: "", code: "invalid_union" }] });
  });

  it("answers a body that is not the format with the path and the code of each issue and never a value, at most a hundred", async () => {
    const outcome = await runImportJob(json(Array.from({ length: 300 }, () => ({ url: 7, secret: "do not echo" }))));

    expect(outcome.kind).toBe("invalid");
    if (outcome.kind !== "invalid") {
      return;
    }
    expect(outcome.errors.length).toBe(100);
    expect(JSON.stringify(outcome)).not.toContain("do not echo");
    expect(outcome.errors[0]).toEqual({ path: "0.url", code: "invalid_type" });
  });

  it("refuses more bookmarks than a file may hold as a body that is not the format", async () => {
    const outcome = await runImportJob(json(Array.from({ length: IMPORT_MAX_BOOKMARKS + 1 }, () => ({ url: "https://example.com" }))));

    expect(outcome).toMatchObject({ kind: "invalid", errors: [{ code: "too_big" }] });
  });
});

describe("an import job of an upload", () => {
  it("reads the file part with the reader of browser bookmark files and prepares the bookmarks", async () => {
    const outcome = await runImportJob(await upload([["file", file(LINKS)]]));

    expect(outcome).toMatchObject({ kind: "prepared", prepared: { kind: "ready", reads: [{ position: 1, url: "https://example.com/a", folders: ["Reading"], tags: ["x", "y"] }] } });
    expect(outcome).not.toHaveProperty("uploadDigest");
  });

  it("digests the parts and not the bytes of the request when asked, so another boundary and another file name are the same upload", async () => {
    const [first, second, other] = await Promise.all([upload([["file", file(LINKS)]], true), upload([["file", file(LINKS, "renamed.html")]], true), upload([["file", file(`${LINKS} `)]], true)]);

    const digests = await Promise.all([first, second, other].map(async (job) => (await runImportJob(job)).uploadDigest));

    expect(digests[0]).toMatch(/^parts:[0-9a-f]{64}$/);
    expect(digests[1]).toBe(digests[0]);
    expect(digests[2]).not.toBe(digests[0]);
  });

  it("digests the bytes of a body that is no multipart form, and answers it as malformed", async () => {
    const outcome = await runImportJob({ kind: "netscape", bytes: text("not a form"), contentType: "multipart/form-data; boundary=b", digest: true });

    expect(outcome).toMatchObject({ kind: "malformed", uploadDigest: expect.stringMatching(/^bytes:[0-9a-f]{64}$/) as unknown });
  });

  it.each<[string, readonly (readonly [string, string | File])[], unknown]>([
    ["another part beside the file", [["file", file(LINKS)], ["other", "x"]], { errors: [{ path: "", code: "unrecognized_keys" }] }],
    ["a text part in place of the file", [["file", "text"]], { errors: [{ path: "file", code: "invalid_type" }] }],
    ["no file part", [], { errors: [{ path: "file", code: "invalid_type" }] }],
    ["two file parts", [["file", file(LINKS)], ["file", file(LINKS)]], { errors: [{ path: "file", code: "too_big" }] }],
  ])("answers %s as a body that is not one file", async (_name, parts, expected) => {
    expect(await runImportJob(await upload(parts))).toMatchObject({ kind: "invalid", ...(expected as object) });
  });

  it("answers a file over the largest file as too large, still digested when asked", async () => {
    const big = new File([new Uint8Array(IMPORT_NETSCAPE_MAX_FILE_BYTES + 1)], "big.html");

    expect(await runImportJob(await upload([["file", big]], true))).toMatchObject({ kind: "too_large", uploadDigest: expect.stringMatching(/^parts:/) as unknown });
  });

  it("answers a file with more links than a file may hold as a body that is not one file", async () => {
    const many = Array.from({ length: IMPORT_MAX_BOOKMARKS + 1 }, (_, index) => `<DT><A HREF="https://example.com/${String(index)}">x</A>`).join("");

    expect(await runImportJob(await upload([["file", file(`<DL>${many}</DL>`)]]))).toMatchObject({ kind: "invalid", errors: [{ path: "", code: "too_big" }] });
  });
});
