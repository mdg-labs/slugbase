import { act, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HEAVY_TEST_TIMEOUT_MS } from "../../../vitest.shared.ts";
import { createWebApp } from "../src/index.ts";
import type { WebExtension } from "../src/index.ts";
import { CONFIG_BODY, SESSION_PATH, json, problem, renderApp, signedIn, stubBrowserApis, stubMatchMedia } from "./support.tsx";

// The acknowledgements an extension declares (doc 03 sections 1.3 and 1.5) on the two sign-up forms, built through
// createWebApp: each one a required checkbox that keeps the request from being sent until it is ticked, then carried
// in the request body.

const REGISTER_PATH = "/api/v1/auth/register";
const INSPECT_PATH = "/api/v1/invitations/inspect";
const ACCEPT_PATH = "/api/v1/invitations/accept";
const TOKEN = "invitation-token-for-tests";
const PASSWORD = "correct horse battery staple";

const OPEN = { ...CONFIG_BODY, features: { ai: false, mail: true }, signIn: { registration: true, oidc: [] } };

const LEGAL: WebExtension = {
  id: "legal",
  acknowledgements: [
    {
      id: "terms",
      version: "2026-03",
      label: (
        <>
          I accept the <a href="/terms">Terms of Service</a>
        </>
      ),
    },
    { id: "privacy", version: "v4", label: "I have read the privacy notice" },
  ],
};

interface Calls {
  readonly register: unknown[];
  readonly accept: unknown[];
}

function stubServer(config: object, answer: (request: Request) => Response = () => new Response(null, { status: 202 })): Calls {
  const calls: { register: Promise<unknown>[]; accept: Promise<unknown>[] } = { register: [], accept: [] };
  vi.stubGlobal("fetch", (request: Request) => {
    const { pathname } = new URL(request.url);
    if (pathname === "/api/config") {
      return Promise.resolve(json(config));
    }
    if (pathname === INSPECT_PATH) {
      return Promise.resolve(json({ workspaceName: "Compilers", inviterName: "Ada", email: "grace@example.org", role: "admin", accountExists: false }));
    }
    if (pathname === REGISTER_PATH || pathname === ACCEPT_PATH) {
      (pathname === REGISTER_PATH ? calls.register : calls.accept).push(request.clone().json() as Promise<unknown>);
      return Promise.resolve(answer(request));
    }
    return pathname === SESSION_PATH || pathname === "/api/v1/me" ? Promise.resolve(problem(401, "unauthenticated", "req")) : signedIn(request);
  });
  return {
    get register() {
      return calls.register as unknown as unknown[];
    },
    get accept() {
      return calls.accept as unknown as unknown[];
    },
  };
}

async function bodies(promises: unknown[]): Promise<unknown[]> {
  return Promise.all(promises as Promise<unknown>[]);
}

async function open(path: string, extensions: readonly WebExtension[]): Promise<void> {
  window.history.replaceState(null, "", path);
  const App = createWebApp({ extensions });
  await renderApp(<App />);
}

function typeInto(label: string, value: string): void {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

async function submitForm(button: string): Promise<void> {
  await act(async () => {
    fireEvent.submit(screen.getByRole("button", { name: button }).closest("form") ?? document.body);
    await Promise.resolve();
  });
}

function tick(name: string | RegExp): void {
  fireEvent.click(screen.getByRole("checkbox", { name }));
}

const FORMS = [
  {
    name: "registration form",
    path: "/register",
    button: "Create account",
    ready: () => screen.findByRole("heading", { level: 1, name: "Create an account" }),
    fill: () => {
      typeInto("Name", "Ada Lovelace");
      typeInto("Email", "ada@example.org");
      typeInto("Password", PASSWORD);
    },
    sent: (calls: Calls) => bodies(calls.register),
    config: OPEN,
    expected: { displayName: "Ada Lovelace", email: "ada@example.org", password: PASSWORD },
  },
  {
    name: "invitation sign-up form",
    path: `/invite/${TOKEN}`,
    button: "Create account and join",
    ready: () => screen.findByRole("button", { name: "Create account and join" }),
    fill: () => {
      typeInto("Name", "Grace Hopper");
      typeInto("Password", PASSWORD);
    },
    sent: (calls: Calls) => bodies(calls.accept),
    config: CONFIG_BODY,
    expected: { token: TOKEN, displayName: "Grace Hopper", password: PASSWORD },
  },
] as const;

beforeEach(() => {
  stubBrowserApis();
  stubMatchMedia();
  vi.spyOn(window.navigator, "languages", "get").mockReturnValue(["en-US", "en"]);
});

afterEach(() => {
  vi.restoreAllMocks();
  document.documentElement.removeAttribute("lang");
});

describe.each(FORMS)("the $name with declared acknowledgements", ({ path, button, ready, fill, sent, config, expected }) => {
  it("renders one required checkbox per acknowledgement, in order, labelled by its content, inside the form before the submit button", async () => {
    stubServer(config);
    await open(path, [LEGAL]);
    await ready();

    const submit = screen.getByRole("button", { name: button });
    const form = submit.closest("form") ?? document.body;
    const boxes = within(form).getAllByRole("checkbox");
    expect(boxes.map((box) => box.getAttribute("aria-required"))).toEqual(["true", "true"]);
    expect(within(form).getByRole("checkbox", { name: "I accept the Terms of Service" })).toBeTruthy();
    expect(boxes[0]?.closest("label")?.textContent).toBe("I accept the Terms of Service");
    expect(boxes[1]?.closest("label")?.textContent).toBe("I have read the privacy notice");
    expect(within(form).getByRole("link", { name: "Terms of Service" }).getAttribute("href")).toBe("/terms");
    for (const box of boxes) {
      expect(box.compareDocumentPosition(submit) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  });

  it("sends nothing while a box is unticked, marks each unticked one and focuses the first", async () => {
    const calls = stubServer(config);
    await open(path, [LEGAL]);
    await ready();
    fill();
    tick("I have read the privacy notice");

    await submitForm(button);

    expect(await sent(calls)).toEqual([]);
    const alerts = screen.getAllByRole("alert");
    expect(alerts.map((alert) => alert.textContent)).toEqual(["Tick this box to continue."]);
    const terms = screen.getByRole("checkbox", { name: "I accept the Terms of Service" });
    expect(terms.getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByRole("checkbox", { name: "I have read the privacy notice" }).getAttribute("aria-invalid")).not.toBe("true");
    expect(document.activeElement).toBe(terms);

    tick("I accept the Terms of Service");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("marks every unticked box when none is ticked", async () => {
    const calls = stubServer(config);
    await open(path, [LEGAL]);
    await ready();
    fill();

    await submitForm(button);

    expect(await sent(calls)).toEqual([]);
    expect(screen.getAllByRole("alert")).toHaveLength(2);
  });

  it("still checks the other fields first: an empty name is marked and takes the focus", async () => {
    const calls = stubServer(config);
    await open(path, [LEGAL]);
    await ready();
    tick(/Terms of Service/);
    tick(/privacy notice/);

    await submitForm(button);

    expect(await sent(calls)).toEqual([]);
    expect(document.activeElement).toBe(screen.getByLabelText("Name"));
  });

  it("sends the declared entries once every box is ticked", async () => {
    const calls = stubServer(config, () => json({ workspaceId: "w", role: "admin" }, { status: 201 }));
    await open(path, [LEGAL]);
    await ready();
    fill();
    tick(/Terms of Service/);
    tick(/privacy notice/);

    await submitForm(button);

    expect(await sent(calls)).toEqual([
      {
        ...expected,
        acknowledgements: [
          { id: "terms", version: "2026-03" },
          { id: "privacy", version: "v4" },
        ],
      },
    ]);
  });

  it("shows the refusal banner and keeps the ticks when the policy refuses", async () => {
    const calls = stubServer(config, () => problem(403, "registration_refused", "req-403"));
    await open(path, [LEGAL]);
    await ready();
    fill();
    tick(/Terms of Service/);
    tick(/privacy notice/);

    await submitForm(button);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/cannot be created/);
    expect((await sent(calls)).length).toBe(1);
    expect(screen.getByRole("checkbox", { name: /Terms of Service/ }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("checkbox", { name: /privacy notice/ }).getAttribute("aria-checked")).toBe("true");
  });

  it("shows the invalid banner for a 422 that names the acknowledgements", async () => {
    stubServer(config, () =>
      json(
        { type: "t", title: "validation_failed", status: 422, code: "validation_failed", detail: "d", requestId: "r", errors: [{ path: "acknowledgements", code: "too_big" }] },
        { status: 422, contentType: "application/problem+json" },
      ),
    );
    await open(path, [LEGAL]);
    await ready();
    fill();
    tick(/Terms of Service/);
    tick(/privacy notice/);

    await submitForm(button);

    expect((await screen.findByRole("alert")).textContent).toBe("Check your entries and try again.");
  });

  it("is written in German", async () => {
    vi.spyOn(window.navigator, "languages", "get").mockReturnValue(["de-AT"]);
    stubServer(config);
    await open(path, [LEGAL]);
    await screen.findByRole("heading", { level: 1 });

    const form = screen.getAllByRole("checkbox")[0]?.closest("form") ?? document.body;
    fireEvent.submit(form);

    expect((await screen.findAllByRole("alert"))[0]?.textContent).toBe("Setze dieses Häkchen, um fortzufahren.");
  });

  it("is unchanged when no extension declares an acknowledgement: no checkbox, and no acknowledgements key", async () => {
    const calls = stubServer(config, () => json({ workspaceId: "w", role: "admin" }, { status: 201 }));
    await open(path, [{ id: "plain" }]);
    await ready();
    fill();

    expect(screen.queryByRole("checkbox")).toBeNull();
    await submitForm(button);

    expect(await sent(calls)).toEqual([expected]);
  });
});

describe("the app with acknowledgements", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
  it("takes the list across extensions in registration order", async () => {
    stubServer(OPEN);
    await open("/register", [
      { id: "first", acknowledgements: [{ id: "one", version: "1", label: "First box" }] },
      { id: "second", acknowledgements: [{ id: "two", version: "1", label: "Second box" }] },
    ]);
    await screen.findByRole("heading", { level: 1, name: "Create an account" });

    expect(screen.getAllByRole("checkbox").map((box) => box.closest("label")?.textContent)).toEqual(["First box", "Second box"]);
  });

  it("keeps the slot auth.register.footer where it renders today", async () => {
    stubServer(OPEN);
    await open("/register", [{ ...LEGAL, slots: { "auth.register.footer": () => <p>Text under the form</p> } }]);
    await screen.findByRole("heading", { level: 1, name: "Create an account" });

    const form = screen.getByRole("button", { name: "Create account" }).closest("form") ?? document.body;
    expect(within(form).getByText("Text under the form")).toBeTruthy();
  });

  it.each([
    ["an invalid id", { id: "Bad Id", version: "1", label: "x" }],
    ["an invalid version", { id: "terms", version: "", label: "x" }],
  ])("refuses to start with %s", (_name, entry) => {
    expect(() => createWebApp({ extensions: [{ id: "legal", acknowledgements: [entry] }] })).toThrow(/acknowledgement/);
  });
});
