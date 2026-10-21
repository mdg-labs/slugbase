import type { ComponentTypes } from "@slugbase/contracts";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { axe } from "vitest-axe";
import { createWebApp } from "../src/index.ts";
import { stubAdminServer, type AdminAnswer } from "./admin-server.ts";
import { ACCOUNT_BODY, WORKSPACES_PATH, json, problem, renderApp, stubBrowserApis, stubMatchMedia } from "./support.tsx";

// /admin/settings (doc 03 section 12) and the banner for an instance admin on a deployment without mail. The failure scenarios are an
// admin without a second factor asking for or changing anything, a failed read shown as defaults or as "not configured", a change
// shown as saved when the server refused it, a test email reported as sent when no mail adapter exists, and the banner shown to
// somebody who is not an instance admin or made to ask the server.

type InstanceSettings = ComponentTypes["schemas"]["InstanceSettings"];
type InstanceStatus = ComponentTypes["schemas"]["InstanceStatus"];

const SLOW_TEST_TIMEOUT_MS = 30_000;
const SETTINGS_PATH = "/api/v1/instance/settings";
const STATUS_PATH = "/api/v1/instance/status";
const TEST_MAIL_PATH = "/api/v1/instance/mail/test";

const SETTINGS: InstanceSettings = { allowWorkspaceCreation: true, displayName: "Acme Links", signInNotice: "Use your work account." };
const STATUS: InstanceStatus = {
  version: "1.4.2",
  migrations: { expected: 12, applied: 12 },
  ports: { mail: false, ai: true, errorReporting: false },
  oidcProviders: [{ slug: "corp", name: "Corp SSO" }],
  signIn: { publicRegistration: false, emailVerificationRequired: true },
  counts: { accounts: 3, workspaces: 2, activeSessions: 1 },
  jobs: { queueDepth: 0, failed: 0 },
};

const settingsOf = (value: InstanceSettings): AdminAnswer => () => json(value);
const status: AdminAnswer = () => json(STATUS);

function validation(field: string): Response {
  return json({ type: "t", title: "t", status: 422, code: "validation_failed", detail: "d", requestId: "req-422", errors: [{ path: field, code: "too_big" }] }, { status: 422, contentType: "application/problem+json" });
}

beforeEach(() => {
  stubBrowserApis();
  stubMatchMedia(false);
  vi.spyOn(window.navigator, "languages", "get").mockReturnValue(["en-US", "en"]);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  window.history.replaceState(null, "", "/");
});

afterEach(() => {
  vi.restoreAllMocks();
  document.documentElement.removeAttribute("lang");
});

async function open(path = "/admin/settings"): Promise<void> {
  window.history.replaceState(null, "", path);
  const App = createWebApp({ extensions: [] });
  await renderApp(<App />);
}

async function press(element: HTMLElement): Promise<void> {
  await act(async () => {
    fireEvent.click(element);
    await Promise.resolve();
  });
}

async function typeInto(field: HTMLElement, value: string): Promise<void> {
  await act(async () => {
    fireEvent.change(field, { target: { value } });
    await Promise.resolve();
  });
}

const creationSwitch = (): HTMLElement => screen.getByRole("switch", { name: "Allow members to create workspaces" });

describe("the workspace creation setting", () => {
  it("shows the stored value and changes it with the switch, saying it was saved", async () => {
    const server = stubAdminServer({
      routes: {
        [`GET ${SETTINGS_PATH}`]: settingsOf(SETTINGS),
        [`GET ${STATUS_PATH}`]: status,
        [`PATCH ${SETTINGS_PATH}`]: () => json({ ...SETTINGS, allowWorkspaceCreation: false }),
      },
    });
    await open();

    await screen.findByRole("switch", { name: "Allow members to create workspaces" });
    expect(creationSwitch().getAttribute("aria-checked")).toBe("true");
    await press(creationSwitch());

    expect(await screen.findByText("Saved.")).toBeTruthy();
    expect(server.received("PATCH", SETTINGS_PATH).map(({ body }) => body)).toEqual([{ allowWorkspaceCreation: false }]);
    expect(creationSwitch().getAttribute("aria-checked")).toBe("false");
  }, SLOW_TEST_TIMEOUT_MS);

  it("shows the default of the deployment, as the account's own ability to create, while it is not set", async () => {
    stubAdminServer({
      routes: {
        [`GET ${SETTINGS_PATH}`]: settingsOf({ ...SETTINGS, allowWorkspaceCreation: null }),
        [`GET ${STATUS_PATH}`]: status,
        [`GET ${WORKSPACES_PATH}`]: () => json({ items: [], canCreate: true }),
      },
    });
    await open();

    await waitFor(() => {
      expect(creationSwitch().getAttribute("aria-checked")).toBe("true");
    });
    expect(screen.getByText(/Not set yet, so the default of this deployment applies/)).toBeTruthy();
  }, SLOW_TEST_TIMEOUT_MS);

  it("keeps the stored value and says so when the server refuses the change", async () => {
    stubAdminServer({
      routes: {
        [`GET ${SETTINGS_PATH}`]: settingsOf(SETTINGS),
        [`GET ${STATUS_PATH}`]: status,
        [`PATCH ${SETTINGS_PATH}`]: () => problem(403, "forbidden", "req-403"),
      },
    });
    await open();
    await screen.findByRole("switch", { name: "Allow members to create workspaces" });
    await press(creationSwitch());

    expect(await screen.findByText("You can no longer manage this instance. The page has been reloaded.")).toBeTruthy();
    expect(screen.queryByText("Saved.")).toBeNull();
    expect(creationSwitch().getAttribute("aria-checked")).toBe("true");
  }, SLOW_TEST_TIMEOUT_MS);
});

describe("the sign-in page form", () => {
  it("starts from the stored values, keeps Save off until something changes, and sends only what changed", async () => {
    const server = stubAdminServer({
      routes: {
        [`GET ${SETTINGS_PATH}`]: settingsOf(SETTINGS),
        [`GET ${STATUS_PATH}`]: status,
        [`PATCH ${SETTINGS_PATH}`]: () => json({ ...SETTINGS, displayName: "Acme" }),
      },
    });
    await open();

    const name = await screen.findByRole<HTMLInputElement>("textbox", { name: "Instance name" });
    expect(name.value).toBe("Acme Links");
    expect(screen.getByRole<HTMLInputElement>("textbox", { name: "Sign-in notice" }).value).toBe("Use your work account.");
    const save = screen.getByRole<HTMLButtonElement>("button", { name: "Save" });
    expect(save.disabled).toBe(true);
    await typeInto(name, "  Acme  ");
    expect(save.disabled).toBe(false);
    await press(save);

    expect(await screen.findByText("Saved.")).toBeTruthy();
    expect(server.received("PATCH", SETTINGS_PATH).map(({ body }) => body)).toEqual([{ displayName: "Acme" }]);
    await waitFor(() => {
      expect(screen.getByRole<HTMLButtonElement>("button", { name: "Save" }).disabled).toBe(true);
    });
  }, SLOW_TEST_TIMEOUT_MS);

  it("clears a setting by sending null when its field is emptied", async () => {
    const server = stubAdminServer({
      routes: {
        [`GET ${SETTINGS_PATH}`]: settingsOf(SETTINGS),
        [`GET ${STATUS_PATH}`]: status,
        [`PATCH ${SETTINGS_PATH}`]: () => json({ ...SETTINGS, signInNotice: null }),
      },
    });
    await open();

    await typeInto(await screen.findByRole("textbox", { name: "Sign-in notice" }), "   ");
    await press(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Saved.")).toBeTruthy();
    expect(server.received("PATCH", SETTINGS_PATH).map(({ body }) => body)).toEqual([{ signInNotice: null }]);
  }, SLOW_TEST_TIMEOUT_MS);

  it("explains the field the server refuses and does not say saved", async () => {
    stubAdminServer({
      routes: { [`GET ${SETTINGS_PATH}`]: settingsOf(SETTINGS), [`GET ${STATUS_PATH}`]: status, [`PATCH ${SETTINGS_PATH}`]: () => validation("displayName") },
    });
    await open();

    await typeInto(await screen.findByRole("textbox", { name: "Instance name" }), "A name the server refuses");
    await press(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Use a name of 1 to 100 characters.")).toBeTruthy();
    expect(screen.queryByText("Saved.")).toBeNull();
    expect(screen.getByRole("textbox", { name: "Instance name" }).getAttribute("aria-invalid")).toBe("true");
  }, SLOW_TEST_TIMEOUT_MS);
});

describe("the test email", () => {
  it("queues it for the admin's address and says so in a toast", async () => {
    const server = stubAdminServer({
      mail: true,
      routes: { [`GET ${SETTINGS_PATH}`]: settingsOf(SETTINGS), [`GET ${STATUS_PATH}`]: status, [`POST ${TEST_MAIL_PATH}`]: () => new Response(null, { status: 202 }) },
    });
    await open();
    await press(await screen.findByRole("button", { name: "Send test email" }));

    expect((await screen.findAllByText(`A test email to ${ACCOUNT_BODY.email} was queued.`)).length).toBeGreaterThan(0);
    expect(server.received("POST", TEST_MAIL_PATH)).toHaveLength(1);
  }, SLOW_TEST_TIMEOUT_MS);

  it("explains that no mail is configured instead of saying it was queued", async () => {
    stubAdminServer({
      routes: { [`GET ${SETTINGS_PATH}`]: settingsOf(SETTINGS), [`GET ${STATUS_PATH}`]: status, [`POST ${TEST_MAIL_PATH}`]: () => problem(503, "mail_unavailable", "req-503") },
    });
    await open();
    await press(await screen.findByRole("button", { name: "Send test email" }));

    expect((await screen.findAllByText("This server has no mail configured. Set up the mail connection in the server's environment, restart it, and try again.")).length).toBeGreaterThan(0);
    expect(screen.queryByText(`A test email to ${ACCOUNT_BODY.email} was queued.`)).toBeNull();
  }, SLOW_TEST_TIMEOUT_MS);

  it("reports another failure in the error toast, never as queued", async () => {
    stubAdminServer({
      routes: { [`GET ${SETTINGS_PATH}`]: settingsOf(SETTINGS), [`GET ${STATUS_PATH}`]: status, [`POST ${TEST_MAIL_PATH}`]: () => problem(500, "internal", "req-500") },
    });
    await open();
    await press(await screen.findByRole("button", { name: "Send test email" }));

    expect((await screen.findAllByText("The change was not saved")).length).toBeGreaterThan(0);
    expect(screen.queryByText(`A test email to ${ACCOUNT_BODY.email} was queued.`)).toBeNull();
  }, SLOW_TEST_TIMEOUT_MS);
});

describe("the configuration table", () => {
  it("shows what the operator configured, read-only, and says credentials are set through the environment only", async () => {
    stubAdminServer({ routes: { [`GET ${SETTINGS_PATH}`]: settingsOf(SETTINGS), [`GET ${STATUS_PATH}`]: status } });
    await open();

    const table = await screen.findByRole("table", { name: "Operator configuration" });
    const rows = within(table)
      .getAllByRole("row")
      .slice(1)
      .map((row) => within(row).getAllByRole("cell").map((cell) => cell.textContent));
    expect(rows).toEqual([
      ["Public registration", "Off"],
      ["Email verification required", "On"],
      ["Mail", "Not configured"],
      ["AI suggestions", "Configured"],
      ["Error reporting", "Not configured"],
      ["Sign-in providers", "Corp SSO"],
    ]);
    expect(within(table).queryByRole("textbox")).toBeNull();
    expect(screen.getByText(/set through environment variables on the server only/)).toBeTruthy();
    const results = await axe(document.body, { rules: { region: { enabled: false } } });
    expect(results.violations.map(({ id }) => id)).toEqual([]);
  }, SLOW_TEST_TIMEOUT_MS);

  it("shows a failed status as an error with a retry, never as 'not configured'", async () => {
    stubAdminServer({
      routes: { [`GET ${SETTINGS_PATH}`]: settingsOf(SETTINGS), [`GET ${STATUS_PATH}`]: [() => problem(429, "rate_limited", "req-429"), status] },
    });
    await open();

    expect(await screen.findByText("The configuration could not be loaded")).toBeTruthy();
    expect(screen.queryByText("Not configured")).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
    await press(screen.getAllByRole("button", { name: "Try again" })[0] as HTMLElement);
    expect(await screen.findByRole("table", { name: "Operator configuration" })).toBeTruthy();
  }, SLOW_TEST_TIMEOUT_MS);
});

describe("the states of the page", () => {
  it("shows a loading state while the settings are on their way", async () => {
    stubAdminServer({ routes: { [`GET ${SETTINGS_PATH}`]: () => new Promise<Response>(() => undefined), [`GET ${STATUS_PATH}`]: status } });
    await open();

    expect(await screen.findAllByRole("status", { name: "Loading" })).toBeTruthy();
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.queryByRole("textbox", { name: "Instance name" })).toBeNull();
  }, SLOW_TEST_TIMEOUT_MS);

  it("shows failed settings as an error with a retry, never as empty fields", async () => {
    const server = stubAdminServer({
      routes: { [`GET ${SETTINGS_PATH}`]: [() => problem(429, "rate_limited", "req-429"), settingsOf(SETTINGS)], [`GET ${STATUS_PATH}`]: status },
    });
    await open();

    expect(await screen.findByText("The settings could not be loaded")).toBeTruthy();
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.queryByRole("textbox", { name: "Instance name" })).toBeNull();
    await press(screen.getByRole("button", { name: "Try again" }));
    expect((await screen.findByRole<HTMLInputElement>("textbox", { name: "Instance name" })).value).toBe("Acme Links");
    expect(server.received("GET", SETTINGS_PATH)).toHaveLength(2);
  }, SLOW_TEST_TIMEOUT_MS);

  it("asks for nothing and offers no action to an admin without a second factor", async () => {
    const server = stubAdminServer({ mfaEnabled: false, routes: { [`GET ${SETTINGS_PATH}`]: settingsOf(SETTINGS), [`GET ${STATUS_PATH}`]: status } });
    await open();

    expect(await screen.findByText("The settings are not available yet")).toBeTruthy();
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.queryByRole("button", { name: "Send test email" })).toBeNull();
    expect(server.instanceCalls()).toEqual([]);
  }, SLOW_TEST_TIMEOUT_MS);
});

describe("the mail banner", () => {
  const BANNER = "Email is not set up";

  it("tells an instance admin on a deployment without mail what is degraded and links to the settings page", async () => {
    const server = stubAdminServer({});
    await open("/");

    expect(await screen.findByText(BANNER)).toBeTruthy();
    const banner = screen.getByText(BANNER).closest("[role=status]") as HTMLElement;
    expect(banner.textContent).toContain("invitation emails, address verification and password-reset emails are not delivered");
    expect(within(banner).getByRole("link", { name: "Open settings & status" }).getAttribute("href")).toBe("/admin/settings");
    expect(server.instanceCalls()).toEqual([]);
  }, SLOW_TEST_TIMEOUT_MS);

  it("is shown to an admin without a second factor too, and still asks the server for nothing", async () => {
    const server = stubAdminServer({ mfaEnabled: false });
    await open("/");

    expect(await screen.findByText(BANNER)).toBeTruthy();
    expect(server.instanceCalls()).toEqual([]);
  }, SLOW_TEST_TIMEOUT_MS);

  it("is not shown to an account that is not an instance admin", async () => {
    const server = stubAdminServer({ isInstanceAdmin: false });
    await open("/");

    await screen.findByRole("heading", { level: 1, name: /^Welcome to/ });
    expect(screen.queryByText(BANNER)).toBeNull();
    expect(server.instanceCalls()).toEqual([]);
  }, SLOW_TEST_TIMEOUT_MS);

  it("is not shown where the deployment sends email", async () => {
    stubAdminServer({ mail: true });
    await open("/");

    await screen.findByRole("heading", { level: 1, name: /^Welcome to/ });
    expect(screen.queryByText(BANNER)).toBeNull();
  }, SLOW_TEST_TIMEOUT_MS);

  it("leads to the settings page", async () => {
    stubAdminServer({ routes: { [`GET ${SETTINGS_PATH}`]: settingsOf(SETTINGS), [`GET ${STATUS_PATH}`]: status } });
    await open("/");
    await press(await screen.findByRole("link", { name: "Open settings & status" }));

    expect(await screen.findByRole("heading", { level: 1, name: "Settings & status" })).toBeTruthy();
    expect(window.location.pathname).toBe("/admin/settings");
  }, SLOW_TEST_TIMEOUT_MS);
});
