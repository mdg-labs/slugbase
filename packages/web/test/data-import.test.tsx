import { File as NodeFile } from "node:buffer";
import type { ComponentTypes } from "@slugbase/contracts";
import { IMPORT_MAX_BOOKMARKS, IMPORT_MAX_BYTES, IMPORT_MAX_LINKS, IMPORT_MAX_NEW_NAMES } from "@slugbase/contracts";
import { createHandlers, createResolverHandlers } from "@slugbase/testing/msw";
import { createMockServer, readOpenApiDocument } from "@slugbase/testing/msw/node";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { HEAVY_TEST_TIMEOUT_MS } from "../../../vitest.shared.ts";
import { createWebApp } from "../src/index.ts";
import { allowSlowRender, json, meBody, renderApp, stubBrowserApis, stubMatchMedia, WORKSPACE_NAME } from "./support.tsx";

// The import wizard of /settings/account/data (doc 03 section 11.5, doc 02 section 13.1) against the handlers generated from openapi.json.
// The failure scenarios are a file that is sent although it is the wrong kind or too large, a preview or an import shown as done when the
// request failed, a retry that sends the import again under a new key, a second import started while one runs, a wizard that lets the member
// leave mid-way without asking or asks after the result, a refusal that is shown from the server's English text or without the file at the
// field, and a title, address or file name from the file that is rendered as markup or as a link (T14).

type ImportResult = ComponentTypes["schemas"]["ImportResult"];

const server = createMockServer();
const document_ = readOpenApiDocument();

const PREVIEW: ImportResult = {
  detected: { bookmarks: 12, folders: 3, tags: 4 },
  created: 9,
  skipped: [
    { position: 2, title: "Same", url: "https://example.com/same", reason: "duplicate" },
    { position: 3, title: "Same again", url: "https://example.com/same", reason: "duplicate" },
  ],
  failed: [{ position: 5, title: "Bookmarklet", url: "javascript:void(0)", reason: "url_not_allowed" }],
  slugsDropped: 1,
  droppedSlugs: [{ position: 7, title: "Docs", url: "https://example.com/docs", slug: "docs", reason: "slug_conflict" }],
  foldersCreated: 2,
  tagsCreated: 4,
};
const RESULT: ImportResult = { ...PREVIEW, created: 9 };
const WITHOUT_DUPLICATES: ImportResult = { ...PREVIEW, created: 11, skipped: [] };

const HTML_FILE = '<!DOCTYPE NETSCAPE-Bookmark-file-1><DL><DT><A HREF="https://example.com/">Example</A></DL>';
const JSON_FILE = '{"format":"slugbase-export","version":1,"bookmarks":[{"url":"https://example.com/"}]}';

interface Seen {
  readonly kind: "json" | "netscape";
  readonly dryRun: string | null;
  readonly skipDuplicates: string | null;
  readonly key: string | null;
  readonly contentType: string | null;
  readonly text: string;
  readonly fileName: string | undefined;
}

interface World {
  seen: Seen[];
  /** What the page appended to the FormData it built, in order. */
  appended: { readonly name: string; readonly value: string | Blob; readonly fileName: string | undefined }[];
  /** What each call answers, by its place in the list of calls of its kind (dry run or import); the default is the success. */
  answer: (seen: Seen, call: number) => Response | Promise<Response> | undefined;
}

let world: World;

function newWorld(): World {
  return { seen: [], appended: [], answer: () => undefined };
}

function problemOf(status: number, code: string, errors?: readonly { path: string; code: string }[], headers: Record<string, string> = {}): Response {
  return json(
    { type: `https://slugbase.app/problems/${code}`, title: code, status, code, detail: "Hostile <b>English</b> detail of the server", requestId: "req-import", ...(errors === undefined ? {} : { errors }) },
    { status, contentType: "application/problem+json", headers },
  );
}

async function record(request: Request, kind: Seen["kind"]): Promise<Seen> {
  const url = new URL(request.url);
  let text: string;
  let fileName: string | undefined;
  if (kind === "netscape") {
    // The file part is read from what the page appended to its FormData: a request built in jsdom carries no file content to read back.
    const part = world.appended.at(-1);
    if (part?.name !== "file" || typeof part.value === "string") {
      throw new Error("the request has no file part");
    }
    fileName = part.fileName;
    text = await part.value.text();
  } else {
    text = await request.clone().text();
  }
  const seen: Seen = {
    kind,
    dryRun: url.searchParams.get("dryRun"),
    skipDuplicates: url.searchParams.get("skipDuplicates"),
    key: request.headers.get("Idempotency-Key"),
    contentType: request.headers.get("Content-Type"),
    text,
    fileName,
  };
  world.seen.push(seen);
  return seen;
}

function serve(): void {
  server.use(...createHandlers(document_, { scenario: { name: "import" } }));
  const handle = (kind: Seen["kind"]) => async (request: Request): Promise<Response> => {
    const seen = await record(request, kind);
    const call = world.seen.filter((other) => (other.dryRun === "true") === (seen.dryRun === "true")).length;
    const custom = world.answer(seen, call);
    if (custom !== undefined) {
      return custom;
    }
    if (seen.dryRun === "true") {
      return json(seen.skipDuplicates === "false" ? WITHOUT_DUPLICATES : PREVIEW);
    }
    return json(RESULT);
  };
  server.use(...createResolverHandlers(document_, { getMe: () => json(meBody()), importJson: handle("json"), importNetscape: handle("netscape") }));
}

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
});

afterEach(() => {
  server.resetHandlers();
});

afterAll(() => {
  server.close();
});

let restoreWait: () => void = () => undefined;

beforeAll(() => {
  restoreWait = allowSlowRender();
});

afterAll(() => {
  restoreWait();
});

/**
 * The platform's FormData, which fetch can send; jsdom has its own, which a request cannot carry. The tests choose files of the platform's
 * File, which that FormData takes.
 */
async function platformFormData(): Promise<typeof FormData> {
  const form = await new Response("a=1", { headers: { "Content-Type": "application/x-www-form-urlencoded" } }).formData();
  return form.constructor as typeof FormData;
}

function newFile(parts: BlobPart[], name: string, type: string): File {
  return new NodeFile(parts as ConstructorParameters<typeof NodeFile>[0], name, { type }) as unknown as File;
}

beforeEach(async () => {
  world = newWorld();
  const Platform = await platformFormData();
  vi.stubGlobal(
    "FormData",
    class extends Platform {
      override append(name: string, value: string | Blob, fileName?: string): void {
        world.appended.push({ name, value, fileName });
        super.append(name, value as Blob, fileName);
      }
    },
  );
  stubBrowserApis();
  stubMatchMedia();
  vi.spyOn(window.navigator, "languages", "get").mockReturnValue(["en-US", "en"]);
  serve();
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function openPage(): Promise<void> {
  window.history.replaceState(null, "", "/settings/account/data");
  const App = createWebApp({ extensions: [] });
  await renderApp(<App />);
  await screen.findByRole("heading", { level: 2, name: "Import bookmarks" });
}

async function press(element: HTMLElement): Promise<void> {
  await act(async () => {
    fireEvent.click(element);
    await Promise.resolve();
  });
}

function fileInput(): HTMLInputElement {
  return screen.getByLabelText<HTMLInputElement>("Bookmark file");
}

async function choose(file: File): Promise<void> {
  await act(async () => {
    fireEvent.change(fileInput(), { target: { files: [file] } });
    await Promise.resolve();
  });
}

const htmlFile = (name = "bookmarks.html"): File => newFile([HTML_FILE], name, "text/html");
const jsonFile = (name = "export.json"): File => newFile([JSON_FILE], name, "application/json");

async function toPreview(file: File = htmlFile()): Promise<void> {
  await choose(file);
  await press(screen.getByRole("button", { name: "Preview" }));
  await screen.findByRole("heading", { level: 3, name: "Check what will be imported" });
}

/** The texts of the live regions of the page, the wizard's among them. */
function announcements(): string[] {
  return screen.getAllByRole("status").map((region) => region.textContent);
}

function counts(title: string): Record<string, string> {
  const list = screen.getByText(title).parentElement?.querySelector("dl");
  expect(list).not.toBeNull();
  return Object.fromEntries(Array.from((list as HTMLElement).querySelectorAll("div")).map((row) => [row.querySelector("dt")?.textContent ?? "?", row.querySelector("dd")?.textContent ?? "?"]));
}

/** Whether the app asks the browser to raise its own leave prompt: a `beforeunload` that a listener cancels. */
function leavePromptRaised(): boolean {
  const leaving = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(leaving);
  return leaving.defaultPrevented;
}

describe("the page", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
  it("is reached from Settings, Account, Import & export, under the page's own heading", async () => {
    window.history.replaceState(null, "", "/settings/account");
    const App = createWebApp({ extensions: [] });
    await renderApp(<App />);

    const link = await screen.findByRole("link", { name: "Import & export" });
    expect(link.getAttribute("href")).toBe("/settings/account/data");
    await press(link);

    expect(await screen.findByRole("heading", { level: 1, name: "Import & export" })).toBeTruthy();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 2, name: "Import bookmarks" })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 3, name: "Choose a file" })).toBeTruthy();
    expect(window.location.pathname).toBe("/settings/account/data");
  });
});

describe("step 1, the file", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
  it("offers the formats and the size, and cannot go on without a file", async () => {
    await openPage();

    expect(fileInput().getAttribute("accept")).toBe(".json,.html,.htm");
    expect(screen.getByText(/up to 5 MiB/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Preview" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("progressbar", { name: "Step 1 of 3" })).toBeTruthy();
  });

  it("turns away any other file and a file over 5 MiB with a message, and sends nothing", async () => {
    await openPage();

    await choose(newFile(["notes"], "notes.txt", "text/plain"));
    expect(screen.getByText("Choose a SlugBase JSON file (.json) or a browser bookmark file (.html).")).toBeTruthy();
    expect(fileInput().getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByRole("button", { name: "Preview" }).hasAttribute("disabled")).toBe(true);

    await choose(newFile([new Uint8Array(IMPORT_MAX_BYTES + 1)], "huge.json", "application/json"));
    expect(screen.getByText("This file is larger than 5 MiB. Split it into smaller files.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Preview" }).hasAttribute("disabled")).toBe(true);

    expect(world.seen).toEqual([]);
  });

  it("takes a file of exactly 5 MiB and a file that is dropped", async () => {
    await openPage();

    await choose(newFile([new Uint8Array(IMPORT_MAX_BYTES)], "exact.html", "text/html"));
    expect(screen.getByText("exact.html")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Preview" }).hasAttribute("disabled")).toBe(false);

    const dropped = htmlFile("dropped.html");
    await act(async () => {
      fireEvent.drop(document.querySelector("[data-slot=file-drop-zone]") as HTMLElement, { dataTransfer: { types: ["Files"], files: [dropped] } });
      await Promise.resolve();
    });
    expect(screen.getByText("dropped.html")).toBeTruthy();
  });
});

describe("step 2, the preview", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
  it("asks the dry run for a browser file as multipart, and shows what it would do and where", async () => {
    await openPage();

    await toPreview();

    expect(world.seen).toHaveLength(1);
    expect(world.seen[0]).toMatchObject({ kind: "netscape", dryRun: "true", skipDuplicates: "true", key: null, text: HTML_FILE, fileName: "bookmarks.html" });
    expect(world.seen[0]?.contentType).toMatch(/^multipart\/form-data; boundary=/);
    expect(screen.getByText(`Bookmarks are added to ${WORKSPACE_NAME}.`)).toBeTruthy();
    expect(counts("In the file")).toEqual({ Bookmarks: "12", Folders: "3", Tags: "4" });
    expect(counts("The import would")).toEqual({
      "Add bookmarks": "9",
      "Create folders": "2",
      "Create tags": "4",
      "Skip as duplicates": "2",
      "Skip because the workspace is full": "0",
      "Leave out because the address is not valid": "1",
      "Drop slugs": "1",
    });
    expect(screen.getByRole("checkbox", { name: "Skip duplicates" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("progressbar", { name: "Step 2 of 3" })).toBeTruthy();
  });

  it("sends a SlugBase JSON file as the text it holds, as JSON", async () => {
    await openPage();

    await toPreview(jsonFile());

    expect(world.seen[0]).toMatchObject({ kind: "json", dryRun: "true", text: JSON_FILE });
    expect(world.seen[0]?.contentType).toBe("application/json");
  });

  it("asks the dry run again when Skip duplicates changes", async () => {
    await openPage();
    await toPreview();

    await press(screen.getByRole("checkbox", { name: "Skip duplicates" }));

    await waitFor(() => {
      expect(counts("The import would")["Add bookmarks"]).toBe("11");
    });
    expect(world.seen.map((seen) => [seen.dryRun, seen.skipDuplicates])).toEqual([
      ["true", "true"],
      ["true", "false"],
    ]);
    expect(screen.getByRole("checkbox", { name: "Skip duplicates" }).getAttribute("aria-checked")).toBe("false");
  });

  it("goes back to the file and takes another one, and sends nothing until the run starts", async () => {
    await openPage();
    await toPreview();

    await press(screen.getByRole("button", { name: "Back" }));
    await choose(jsonFile("other.json"));
    await press(screen.getByRole("button", { name: "Preview" }));
    await screen.findByRole("heading", { level: 3, name: "Check what will be imported" });

    expect(world.seen.map((seen) => [seen.kind, seen.dryRun])).toEqual([
      ["netscape", "true"],
      ["json", "true"],
    ]);
  });

  it("shows a refused preview at the file field, with the file still chosen and a retry that asks again", async () => {
    world.answer = (_seen, call) => (call === 1 ? problemOf(503, "unavailable") : undefined);
    await openPage();
    await choose(htmlFile());

    await press(screen.getByRole("button", { name: "Preview" }));

    expect(await screen.findByText("The import could not be done. Try again.")).toBeTruthy();
    expect(screen.getByText("bookmarks.html")).toBeTruthy();
    expect(announcements()).toContain("The file could not be checked.");
    await press(screen.getByRole("button", { name: "Try again" }));
    await screen.findByRole("heading", { level: 3, name: "Check what will be imported" });
    expect(world.seen).toHaveLength(2);
  });
});

describe("step 3, the run", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
  it("shows an indeterminate progress and announces the start while the request runs, starts no second run, and then counts the result", async () => {
    let finish: (response: Response) => void = () => undefined;
    const held = new Promise<Response>((resolve) => {
      finish = resolve;
    });
    world.answer = (seen) => (seen.dryRun === "false" ? held : undefined);
    await openPage();
    await toPreview();
    expect(leavePromptRaised()).toBe(true);

    await press(screen.getByRole("button", { name: "Import" }));

    const bar = await screen.findByRole("progressbar", { name: "Importing your bookmarks" });
    expect(bar.hasAttribute("aria-valuenow")).toBe(false);
    expect(announcements()).toContain("The import has started.");
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
    const next = screen.getByRole("button", { name: /^Importing/ });
    expect(next.hasAttribute("data-loading") || next.hasAttribute("disabled")).toBe(true);
    fireEvent.submit(next.closest("form") as HTMLElement);
    fireEvent.click(next);
    await act(async () => {
      await Promise.resolve();
    });
    expect(world.seen.filter((seen) => seen.dryRun === "false")).toHaveLength(1);
    expect(leavePromptRaised()).toBe(true);

    await act(async () => {
      finish(json(RESULT));
      await held;
    });

    await screen.findByRole("heading", { level: 3, name: "Import finished" });
    expect(screen.queryByRole("progressbar", { name: "Importing your bookmarks" })).toBeNull();
    const tiles: Record<string, string | undefined> = {};
    for (const panel of document.querySelectorAll("[data-slot=card-panel]")) {
      const [label, value] = Array.from(panel.querySelectorAll("p"));
      tiles[label?.textContent ?? "?"] = value?.textContent;
    }
    expect(tiles).toMatchObject({ Added: "9", Skipped: "2", Failed: "1", "Slugs dropped": "1" });
    expect(screen.getByText("2 folders and 4 tags were created.")).toBeTruthy();
    expect(announcements()).toContain("The import finished. 9 bookmarks were added.");
    const run = world.seen.filter((seen) => seen.dryRun === "false");
    expect(run).toHaveLength(1);
    expect(run[0]?.key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(run[0]).toMatchObject({ dryRun: "false", skipDuplicates: "true" });
  });

  it("asks nothing when leaving after the result, and starts over with a new file", async () => {
    await openPage();
    await toPreview();
    await press(screen.getByRole("button", { name: "Import" }));
    await screen.findByRole("heading", { level: 3, name: "Import finished" });

    expect(leavePromptRaised()).toBe(false);
    await press(screen.getByRole("button", { name: "Import another file" }));

    expect(await screen.findByRole("heading", { level: 3, name: "Choose a file" })).toBeTruthy();
    expect(screen.queryByText("bookmarks.html")).toBeNull();
  });

  it("repeats a run that failed under the same key, and a run of another request under another", async () => {
    world.answer = (seen, call) => (seen.dryRun === "false" && call === 1 ? Response.error() : undefined);
    await openPage();
    await toPreview();

    await press(screen.getByRole("button", { name: "Import" }));

    expect(await screen.findByText("The server could not be reached. Check your connection and try again.")).toBeTruthy();
    expect(screen.getByText("bookmarks.html")).toBeTruthy();
    expect(announcements()).toContain("The import did not finish.");
    expect(screen.getByRole("heading", { level: 3, name: "Choose a file" })).toBeTruthy();
    await press(screen.getByRole("button", { name: "Try again" }));
    await screen.findByRole("heading", { level: 3, name: "Import finished" });

    const keys = world.seen.filter((seen) => seen.dryRun === "false").map((seen) => seen.key);
    expect(keys).toHaveLength(2);
    expect(keys[0]).not.toBeNull();
    expect(keys[1]).toBe(keys[0]);

    await press(screen.getByRole("button", { name: "Import another file" }));
    await toPreview();
    await press(screen.getByRole("button", { name: "Import" }));
    await waitFor(() => {
      expect(world.seen.filter((seen) => seen.dryRun === "false")).toHaveLength(3);
    });
    expect(world.seen.filter((seen) => seen.dryRun === "false")[2]?.key).not.toBe(keys[0]);
  });
});

describe("a refusal at the file field", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
  const CASES: readonly [string, () => Response, string][] = [
    ["413", () => problemOf(413, "payload_too_large"), "This file is larger than 5 MiB. Split it into smaller files."],
    ["415", () => problemOf(415, "unsupported_media_type"), "The server does not accept this kind of file. Choose a SlugBase JSON file or a browser bookmark file."],
    [
      "422 for a newer version",
      () => problemOf(422, "validation_failed", [{ path: "version", code: "too_big" }]),
      "This file was made by a newer version of SlugBase than this one can read. Update SlugBase, or export the file again from this one.",
    ],
    [
      "422 for too many new folders and tags",
      () => problemOf(422, "validation_failed", [{ path: "", code: "too_many_new_names" }]),
      "This file would create more than 10,000 new folders and tags. Split it into smaller files.",
    ],
    [
      "422 for folders and tags used more often than one import takes (too_many_links)",
      () => problemOf(422, "validation_failed", [{ path: "", code: "too_many_links" }]),
      "The folders and tags of this file add up to more than 100,000 uses, however few bookmarks it holds. Split it into smaller files.",
    ],
    [
      "422 for more bookmarks than one import reads (too_big)",
      () => problemOf(422, "validation_failed", [{ path: "", code: "too_big" }]),
      "This file holds more than 5,000 bookmarks. Split it into smaller files.",
    ],
    ["another 422", () => problemOf(422, "validation_failed", [{ path: "bookmarks.0.url", code: "invalid_type" }]), "This is not a valid SlugBase JSON file or browser bookmark file."],
    ["429 with a wait in seconds", () => problemOf(429, "rate_limited", undefined, { "Retry-After": "30" }), "Too many imports. Try again in 30 seconds."],
    ["429 with a wait in minutes", () => problemOf(429, "rate_limited", undefined, { "Retry-After": "120" }), "Too many imports. Try again in 2 minutes."],
    ["429 without a wait", () => problemOf(429, "rate_limited"), "Too many imports. Try again later."],
    ["a network failure", () => Response.error(), "The server could not be reached. Check your connection and try again."],
  ];

  it.each(CASES)("is told in the language of the page for %s, from the code and never from the server's text, and offers a retry", async (_name, refusal, message) => {
    world.answer = (_seen, call) => (call === 1 ? refusal() : undefined);
    await openPage();
    await choose(htmlFile());

    await press(screen.getByRole("button", { name: "Preview" }));

    const shown = await screen.findByText(message);
    expect(fileInput().getAttribute("aria-invalid")).toBe("true");
    expect(fileInput().getAttribute("aria-describedby")?.split(" ")).toContain(shown.id);
    expect(screen.queryByText(/Hostile/)).toBeNull();
    expect(screen.getByText("bookmarks.html")).toBeTruthy();
    expect(screen.getByRole("heading", { level: 3, name: "Choose a file" })).toBeTruthy();

    await press(screen.getByRole("button", { name: "Try again" }));
    await screen.findByRole("heading", { level: 3, name: "Check what will be imported" });
  });

  it("tells a file with too many bookmarks, too many new folders and tags, and too many uses of them each in its own words", async () => {
    const refusals = [
      { path: "", code: "too_big" },
      { path: "", code: "too_many_new_names" },
      { path: "", code: "too_many_links" },
    ];
    const shown: string[] = [];
    await openPage();
    await choose(htmlFile());
    for (const refusal of refusals) {
      world.answer = () => problemOf(422, "validation_failed", [refusal]);
      await press(screen.getByRole("button", { name: shown.length === 0 ? "Preview" : "Try again" }));
      await waitFor(() => {
        expect(fileInput().getAttribute("aria-invalid")).toBe("true");
      });
      const message = document.getElementById(fileInput().getAttribute("aria-describedby")?.split(" ").at(-1) ?? "")?.textContent;
      expect(message).toBeTruthy();
      shown.push(message ?? "");
    }
    expect(new Set(shown).size).toBe(3);
    expect(shown[0]).toMatch(/5,000 bookmarks/);
    expect(shown[1]).toMatch(/10,000 new folders and tags/);
    expect(shown[2]).toMatch(/100,000 uses/);
    // Each count is the server's own cap from the contracts, so the sentence cannot drift from the limit the API enforces.
    expect(shown[0]).toContain(`${IMPORT_MAX_BOOKMARKS.toLocaleString("en")} bookmarks`);
    expect(shown[1]).toContain(`${IMPORT_MAX_NEW_NAMES.toLocaleString("en")} new folders and tags`);
    expect(shown[2]).toContain(`${IMPORT_MAX_LINKS.toLocaleString("en")} uses`);
  });

  it("is told for the import itself as for the dry run", async () => {
    world.answer = (seen, call) => (seen.dryRun === "false" && call === 1 ? problemOf(422, "validation_failed", [{ path: "", code: "too_many_new_names" }]) : undefined);
    await openPage();
    await toPreview();

    await press(screen.getByRole("button", { name: "Import" }));

    expect(await screen.findByText("This file would create more than 10,000 new folders and tags. Split it into smaller files.")).toBeTruthy();
    expect(screen.getByText("bookmarks.html")).toBeTruthy();
  });

  it("is told in German for a language of the account that is German", async () => {
    vi.spyOn(window.navigator, "languages", "get").mockReturnValue(["de-DE", "de"]);
    world.answer = (_seen, call) => (call === 1 ? problemOf(422, "validation_failed", [{ path: "", code: "too_many_new_names" }]) : undefined);
    window.history.replaceState(null, "", "/settings/account/data");
    const App = createWebApp({ extensions: [] });
    await renderApp(<App />);
    await screen.findByRole("heading", { level: 2, name: "Lesezeichen importieren" });
    await act(async () => {
      fireEvent.change(screen.getByLabelText<HTMLInputElement>("Lesezeichen-Datei"), { target: { files: [htmlFile()] } });
      await Promise.resolve();
    });

    await press(screen.getByRole("button", { name: "Vorschau" }));

    expect(await screen.findByText("Diese Datei würde mehr als 10.000 neue Ordner und Tags anlegen. Teile sie in kleinere Dateien auf.")).toBeTruthy();
  });
});

describe("text from the file", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
  it("renders a script-laden title, address and file name as text and adds no element or link", async () => {
    const hostile = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
    const report: ImportResult = {
      ...PREVIEW,
      skipped: [{ position: 1, title: hostile, url: "javascript:alert(1)", reason: "duplicate" }],
      failed: [{ position: 2, title: hostile, url: `data:text/html,${hostile}`, reason: "url_not_allowed" }],
      droppedSlugs: [{ position: 3, title: hostile, url: "https://example.com/", slug: hostile, reason: "slug_invalid" }],
    };
    world.answer = () => json(report);
    await openPage();
    const linksBefore = document.querySelectorAll("a").length;

    await choose(htmlFile(`${hostile}.html`));
    expect(screen.getByText(`${hostile}.html`)).toBeTruthy();
    await press(screen.getByRole("button", { name: "Preview" }));
    await screen.findByRole("heading", { level: 3, name: "Check what will be imported" });
    await press(screen.getByRole("button", { name: "Import" }));
    await screen.findByRole("heading", { level: 3, name: "Import finished" });

    for (const selector of ["img", "script", "a[href^='javascript:']", "a[href^='data:']", "[onerror]"]) {
      expect(document.querySelector(selector)).toBeNull();
    }
    expect(document.querySelectorAll("a").length).toBe(linksBefore);
    expect(within(document.body).queryByText(/javascript:alert/)).toBeNull();
  });
});
