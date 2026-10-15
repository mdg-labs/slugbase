import { QueryClient } from "@tanstack/react-query";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { axe } from "vitest-axe";
import { createWebApp } from "../src/index.ts";
import { ACCOUNT_BODY, CONFIG_BODY, ME_PATH, SESSION_BODY, SESSION_PATH, json, meBody, problem, renderApp, stubBrowserApis, stubMatchMedia } from "./support.tsx";

// The Two-factor authentication card of /settings/account/security (doc 03 section 11.2). The failure scenarios are
// a badge that disagrees with GET /me, an enrolment that goes on after the member gave up re-authenticating, a refused
// or rate-limited code shown as success, backup codes that can be closed before they were acknowledged, a secret that
// is still in the page after the wizard closed, and a disable that is sent before the member confirmed.

type Transport = (request: Request) => Promise<Response>;

const ENROLMENT_PATH = "/api/v1/me/mfa/enrollment";
const CONFIRM_PATH = "/api/v1/me/mfa/enrollment/confirm";
const CODES_PATH = "/api/v1/me/mfa/backup-codes";
const MFA_PATH = "/api/v1/me/mfa";
const QR_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect width="1" height="1"/></svg>';
const SECRETS = ["JBSWY3DPEHPK3PXP", "KRSXG5CTMVRXEZLU"] as const;
const BACKUP_CODES = ["ABCDEFGH23", "JKLMNPQR45", "STUVWXYZ67", "BCDFGHJK89", "MNPQRSTU23", "VWXYZABC45", "DEFGHJKL67", "NPQRSTUV89", "WXYZABCD23", "EFGHJKLM45"];
const NEW_CODES = BACKUP_CODES.map((code) => code.split("").reverse().join(""));

interface Call {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
}

interface Handlers {
  enrolment?: (call: number) => Response | Promise<Response>;
  confirm?: (call: number) => Response | Promise<Response>;
  codes?: (call: number) => Response | Promise<Response>;
  disable?: (call: number) => Response | Promise<Response>;
  me?: () => Response | Promise<Response>;
}

interface Server {
  readonly calls: Call[];
  readonly to: (method: string, path: string) => Call[];
}

function reauthRequired(): Response {
  return problem(401, "reauth_required", "req-reauth");
}

function withErrors(status: number, code: string, errors: readonly { path: string; code: string }[], headers: Record<string, string> = {}): Response {
  return json(
    { type: `https://slugbase.app/problems/${code}`, title: code, status, code, detail: "x", requestId: "req-422", errors },
    { status, contentType: "application/problem+json", headers },
  );
}

/** A server with a signed-in account whose second factor is `initial`; a confirmed enrolment turns it on and a disable off. */
function stubServer(initial: boolean, handlers: Handlers = {}): Server {
  let enabled = initial;
  const calls: Call[] = [];
  const count = (method: string, path: string): number => calls.filter((call) => call.method === method && call.path === path).length;
  const fetch = vi.fn<Transport>(async (request) => {
    const { pathname } = new URL(request.url);
    if (pathname === "/api/config") {
      return json(CONFIG_BODY);
    }
    const text = request.method === "GET" || request.method === "HEAD" ? "" : await request.clone().text();
    calls.push({ method: request.method, path: pathname, body: text === "" ? undefined : (JSON.parse(text) as unknown) });
    if (pathname === ME_PATH) {
      return handlers.me?.() ?? json({ ...(meBody() as { account: object }), account: { ...ACCOUNT_BODY, mfaEnabled: enabled } });
    }
    if (pathname === SESSION_PATH) {
      return json(SESSION_BODY);
    }
    if (pathname === "/api/v1/me/reauth") {
      return new Response(null, { status: 204 });
    }
    if (pathname === ENROLMENT_PATH) {
      const call = count("POST", ENROLMENT_PATH);
      return (
        handlers.enrolment?.(call) ??
        json({ secret: SECRETS[(call - 1) % SECRETS.length], otpauthUri: "otpauth://totp/SlugBase:ada?secret=x", qrSvg: QR_SVG })
      );
    }
    if (pathname === CONFIRM_PATH) {
      const response = handlers.confirm?.(count("POST", CONFIRM_PATH)) ?? json({ backupCodes: BACKUP_CODES });
      const settled = await response;
      enabled = enabled || settled.ok;
      return settled;
    }
    if (pathname === CODES_PATH) {
      return handlers.codes?.(count("POST", CODES_PATH)) ?? json({ backupCodes: NEW_CODES });
    }
    if (pathname === MFA_PATH && request.method === "DELETE") {
      const settled = await (handlers.disable?.(count("DELETE", MFA_PATH)) ?? new Response(null, { status: 204 }));
      enabled = enabled && !settled.ok;
      return settled;
    }
    return problem(404, "not_found", "req-404");
  });
  vi.stubGlobal("fetch", fetch);
  return { calls, to: (method, path) => calls.filter((call) => call.method === method && call.path === path) };
}

async function openSecurity(): Promise<void> {
  window.history.replaceState(null, "", "/settings/account/security");
  const App = createWebApp({ extensions: [] });
  await renderApp(<App />);
  await screen.findByRole("heading", { level: 1, name: "Security" });
}

async function act_(action: () => void): Promise<void> {
  await act(async () => {
    action();
    await Promise.resolve();
  });
}

async function click(name: string | RegExp, within_?: HTMLElement): Promise<void> {
  const scope = within_ === undefined ? screen : within(within_);
  await act_(() => {
    fireEvent.click(scope.getByRole("button", { name }));
  });
}

async function typeCode(digits: string, scope?: HTMLElement): Promise<void> {
  const field = (scope === undefined ? screen : within(scope)).getByRole("textbox", { name: "Authentication code" });
  await act(async () => {
    fireEvent.change(field, { target: { value: digits } });
    await Promise.resolve();
  });
}

async function fill(dialog: HTMLElement, password = "old password 1"): Promise<void> {
  await typeCode("654321", dialog);
  fireEvent.change(within(dialog).getByLabelText("Password"), { target: { value: password } });
}

function me(server: Server): number {
  return server.to("GET", ME_PATH).length;
}

async function startEnrolment(): Promise<void> {
  await click("Set up");
  await screen.findByRole("heading", { level: 2, name: "Scan the code" });
}

async function acknowledgeAndFinish(): Promise<void> {
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Done" }).disabled).toBe(true);
  await act_(() => {
    fireEvent.click(screen.getByRole("checkbox", { name: "I have saved these backup codes" }));
  });
  await click("Done");
}

/** The QueryClient the app mounted: `QueryClientProvider` calls `mount()` on the client it was given. */
let mounted: MockInstance<QueryClient["mount"]>;

/** Everything the app's query and mutation caches hold, as text, so a secret cannot hide in a key, a variable or a result. */
function cacheContents(): string {
  const client = mounted.mock.contexts[0] as QueryClient | undefined;
  expect(client).toBeDefined();
  const queries = client?.getQueryCache().getAll() ?? [];
  const mutations = client?.getMutationCache().getAll() ?? [];
  // The account query is in the cache, so an empty read cannot make the assertions below pass.
  expect(queries.length).toBeGreaterThan(0);
  return JSON.stringify([
    ...queries.map((query) => [query.queryKey, query.state.data, query.state.error]),
    ...mutations.map((mutation) => [mutation.options.mutationKey, mutation.state]),
  ]);
}

function expectNotInCache(values: readonly string[]): void {
  const contents = cacheContents();
  for (const value of values) {
    expect(contents).not.toContain(value);
  }
}

beforeEach(() => {
  mounted = vi.spyOn(QueryClient.prototype, "mount");
  stubBrowserApis();
  stubMatchMedia(false);
  vi.spyOn(window.navigator, "languages", "get").mockReturnValue(["en-US", "en"]);
  window.history.replaceState(null, "", "/");
});

afterEach(() => {
  vi.restoreAllMocks();
  document.documentElement.removeAttribute("lang");
});

describe("the status", () => {
  it("is Off with a way to set up when GET /me says the second factor is off", async () => {
    stubServer(false);
    await openSecurity();

    const card = (await screen.findByRole("heading", { level: 2, name: "Two-factor authentication" })).closest("[data-slot=card]") as HTMLElement;
    expect(within(card).getByText("Off")).toBeTruthy();
    expect(within(card).getByRole("button", { name: "Set up" })).toBeTruthy();
    expect(within(card).queryByRole("button", { name: "Replace backup codes" })).toBeNull();
    expect(within(card).queryByRole("button", { name: "Turn off" })).toBeNull();
  });

  it("is On with a way to replace the backup codes and to turn off when GET /me says it is on", async () => {
    stubServer(true);
    await openSecurity();

    const card = (await screen.findByRole("heading", { level: 2, name: "Two-factor authentication" })).closest("[data-slot=card]") as HTMLElement;
    expect(within(card).getByText("On")).toBeTruthy();
    expect(within(card).getByRole("button", { name: "Replace backup codes" })).toBeTruthy();
    expect(within(card).getByRole("button", { name: "Turn off" })).toBeTruthy();
    expect(within(card).queryByRole("button", { name: "Set up" })).toBeNull();
  });

  it("shows no status when the account could not be loaded, rather than claiming the factor is off", async () => {
    stubServer(true, { me: () => problem(400, "bad_request", "req-400") });
    await openSecurity();

    expect(await screen.findByText("Your security settings could not be loaded")).toBeTruthy();
    expect(screen.queryByRole("heading", { level: 2, name: "Two-factor authentication" })).toBeNull();
    expect(screen.queryByText("Off")).toBeNull();
  });
});

describe("the enrolment wizard", () => {
  it("re-authenticates, shows the QR code as an image with the text key, verifies a code and shows the backup codes once", async () => {
    const server = stubServer(false, { enrolment: (call) => (call === 1 ? reauthRequired() : json({ secret: SECRETS[0], otpauthUri: "otpauth://x", qrSvg: QR_SVG })) });
    await openSecurity();

    await click("Set up");
    const prompt = await screen.findByRole("dialog", { name: "Confirm it is you" });
    expect(screen.queryByRole("heading", { level: 2, name: "Scan the code" })).toBeNull();
    fireEvent.change(within(prompt).getByLabelText("Password"), { target: { value: "old password 1" } });
    await click("Confirm", prompt);

    expect(await screen.findByRole("heading", { level: 2, name: "Scan the code" })).toBeTruthy();
    expect(server.to("POST", "/api/v1/me/reauth").map((call) => call.body)).toEqual([{ password: "old password 1" }]);
    expect(server.to("POST", ENROLMENT_PATH)).toHaveLength(2);
    const image = screen.getByRole<HTMLImageElement>("img", { name: "QR code to scan with your authenticator app" });
    expect(image.getAttribute("src")).toBe(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(QR_SVG)}`);
    expect(document.body.querySelector("svg[viewBox='0 0 1 1']")).toBeNull();
    expect(screen.getByRole<HTMLInputElement>("textbox", { name: "Setup key" }).value).toBe(SECRETS[0]);

    await click("Next");
    expect(await screen.findByRole("heading", { level: 2, name: "Enter a code" })).toBeTruthy();
    expect(server.to("POST", CONFIRM_PATH)).toEqual([]);
    const meBefore = me(server);
    await typeCode("123456");

    expect(await screen.findByRole("heading", { level: 2, name: "Save your backup codes" })).toBeTruthy();
    expect(server.to("POST", CONFIRM_PATH).map((call) => call.body)).toEqual([{ code: "123456" }]);
    const list = screen.getByRole("list", { name: "Backup codes" });
    expect(within(list).getAllByRole("listitem").map((item) => item.textContent)).toEqual(BACKUP_CODES);
    await waitFor(() => {
      expect(me(server)).toBeGreaterThan(meBefore);
    });

    await acknowledgeAndFinish();

    await waitFor(() => {
      expect(screen.queryByRole("heading", { level: 2, name: "Save your backup codes" })).toBeNull();
    });
    expect(screen.getByText("On")).toBeTruthy();
    expect(screen.queryByDisplayValue(SECRETS[0])).toBeNull();
    expect(screen.queryByDisplayValue(BACKUP_CODES.join(" "))).toBeNull();
    for (const code of [SECRETS[0], ...BACKUP_CODES]) {
      expect(document.body.textContent).not.toContain(code);
    }
    expectNotInCache([SECRETS[0], "otpauth://", ...BACKUP_CODES]);
  });

  it("keeps Done disabled until the backup codes are acknowledged, and does not finish on Enter before", async () => {
    stubServer(false);
    await openSecurity();
    await startEnrolment();
    await click("Next");
    await typeCode("123456");
    await screen.findByRole("heading", { level: 2, name: "Save your backup codes" });

    const done = screen.getByRole<HTMLButtonElement>("button", { name: "Done" });
    expect(done.disabled).toBe(true);
    fireEvent.submit(done.closest("form") ?? document.body);
    expect(screen.getByRole("heading", { level: 2, name: "Save your backup codes" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
  });

  it("opens no wizard and sends nothing again when the member closes the re-authentication prompt", async () => {
    const server = stubServer(false, { enrolment: () => reauthRequired() });
    await openSecurity();

    await click("Set up");
    const prompt = await screen.findByRole("dialog", { name: "Confirm it is you" });
    await click("Cancel", prompt);

    expect(await screen.findByText("Confirm it is you to continue.")).toBeTruthy();
    expect(screen.queryByRole("heading", { level: 2, name: "Scan the code" })).toBeNull();
    expect(server.to("POST", ENROLMENT_PATH)).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Set up" })).toBeTruthy();
  });

  it("says in place that the start was refused as too many requests, and opens no wizard", async () => {
    stubServer(false, { enrolment: () => withErrors(429, "rate_limited", [], { "Retry-After": "120" }) });
    await openSecurity();

    await click("Set up");

    expect(await screen.findByText("Too many attempts. Try again in 2 minutes.")).toBeTruthy();
    expect(screen.queryByRole("heading", { level: 2, name: "Scan the code" })).toBeNull();
  });

  it("says the start did not work when the server fails, and opens no wizard", async () => {
    stubServer(false, { enrolment: () => problem(503, "unavailable", "req-503") });
    await openSecurity();

    await click("Set up");

    expect(await screen.findByText("That did not work. Try again in a moment.")).toBeTruthy();
    expect(screen.queryByRole("heading", { level: 2, name: "Scan the code" })).toBeNull();
  });

  it("shows a refused code in the field, stays on the step and does not show backup codes", async () => {
    const server = stubServer(false, { confirm: () => withErrors(422, "invalid_code", [{ path: "code", code: "invalid_code" }]) });
    await openSecurity();
    await startEnrolment();
    await click("Next");

    await typeCode("123456");

    expect(await screen.findByText("That code is not valid. Check it and try again.")).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "Authentication code" }).getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByRole("heading", { level: 2, name: "Enter a code" })).toBeTruthy();
    expect(screen.queryByRole("heading", { level: 2, name: "Save your backup codes" })).toBeNull();
    expect(server.to("POST", CONFIRM_PATH)).toHaveLength(1);
    expect(screen.queryByText("On")).toBeNull();
  });

  it("shows a rate-limited code in a banner and no backup codes", async () => {
    stubServer(false, { confirm: () => withErrors(429, "rate_limited", [], { "Retry-After": "30" }) });
    await openSecurity();
    await startEnrolment();
    await click("Next");

    await typeCode("123456");

    expect(await screen.findByText("Too many attempts. Try again in 30 seconds.")).toBeTruthy();
    expect(screen.queryByRole("heading", { level: 2, name: "Save your backup codes" })).toBeNull();
  });

  it("asks for all six digits before sending anything", async () => {
    const server = stubServer(false);
    await openSecurity();
    await startEnrolment();
    await click("Next");

    await typeCode("123");
    await click("Turn on");

    expect(screen.getByText("Enter the six-digit code.")).toBeTruthy();
    expect(server.to("POST", CONFIRM_PATH)).toEqual([]);
  });

  it("sends a complete code once", async () => {
    const server = stubServer(false);
    await openSecurity();
    await startEnrolment();
    await click("Next");

    await typeCode("123456");
    await screen.findByRole("heading", { level: 2, name: "Save your backup codes" });

    expect(server.to("POST", CONFIRM_PATH)).toHaveLength(1);
  });

  it("goes back to the key, and a cancelled wizard leaves neither secret nor code, and a new one gets a new secret", async () => {
    const server = stubServer(false);
    await openSecurity();
    await startEnrolment();
    expect(screen.getByRole<HTMLInputElement>("textbox", { name: "Setup key" }).value).toBe(SECRETS[0]);
    await click("Next");
    await typeCode("123");
    await click("Back");
    expect(screen.getByRole("heading", { level: 2, name: "Scan the code" })).toBeTruthy();

    await click("Cancel");

    expect(screen.queryByRole("heading", { level: 2, name: "Scan the code" })).toBeNull();
    expect(screen.queryByDisplayValue(SECRETS[0])).toBeNull();
    expect(server.to("POST", CONFIRM_PATH)).toEqual([]);
    await startEnrolment();
    expect(screen.getByRole<HTMLInputElement>("textbox", { name: "Setup key" }).value).toBe(SECRETS[1]);
    await click("Next");
    expect(screen.getByRole<HTMLInputElement>("textbox", { name: "Authentication code" }).value).toBe("");
  });
});

describe("the backup codes", () => {
  it("asks for a code, shows the new set once, and keeps it until it is acknowledged", async () => {
    const server = stubServer(true);
    await openSecurity();
    await click("Replace backup codes");
    const dialog = await screen.findByRole("dialog", { name: "Replace your backup codes" });
    expect(server.to("POST", CODES_PATH)).toEqual([]);

    await typeCode("654321", dialog);

    expect(await within(dialog).findByRole("list", { name: "Backup codes" })).toBeTruthy();
    expect(server.to("POST", CODES_PATH).map((call) => call.body)).toEqual([{ code: "654321" }]);
    expect(within(within(dialog).getByRole("list", { name: "Backup codes" })).getAllByRole("listitem").map((item) => item.textContent)).toEqual(NEW_CODES);
    expect(within(dialog).getByRole<HTMLButtonElement>("button", { name: "Done" }).disabled).toBe(true);

    await act_(() => {
      fireEvent.keyDown(dialog, { key: "Escape" });
    });
    expect(screen.getByRole("dialog", { name: "Replace your backup codes" })).toBeTruthy();
    expect(within(dialog).getByRole("list", { name: "Backup codes" })).toBeTruthy();

    await act_(() => {
      fireEvent.click(within(dialog).getByRole("checkbox", { name: "I have saved these backup codes" }));
    });
    await click("Done", dialog);

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    expect(screen.queryByDisplayValue(NEW_CODES.join(" "))).toBeNull();
    for (const code of NEW_CODES) {
      expect(document.body.textContent).not.toContain(code);
    }
    expectNotInCache(NEW_CODES);
  });

  it("shows a refused code in the field and no codes, and keeps the old set", async () => {
    stubServer(true, { codes: () => withErrors(422, "invalid_code", [{ path: "code", code: "invalid_code" }]) });
    await openSecurity();
    await click("Replace backup codes");
    const dialog = await screen.findByRole("dialog", { name: "Replace your backup codes" });

    await typeCode("654321", dialog);

    expect(await within(dialog).findByText("That code is not valid. Check it and try again.")).toBeTruthy();
    expect(within(dialog).queryByRole("list", { name: "Backup codes" })).toBeNull();
  });

  it("asks for re-authentication through the shared prompt and sends the code again once it is accepted", async () => {
    const server = stubServer(true, { codes: (call) => (call === 1 ? reauthRequired() : json({ backupCodes: NEW_CODES })) });
    await openSecurity();
    await click("Replace backup codes");
    const dialog = await screen.findByRole("dialog", { name: "Replace your backup codes" });
    await typeCode("654321", dialog);

    const prompt = await screen.findByRole("dialog", { name: "Confirm it is you" });
    fireEvent.change(within(prompt).getByLabelText("Password"), { target: { value: "old password 1" } });
    await click("Confirm", prompt);

    expect(await screen.findByRole("list", { name: "Backup codes" })).toBeTruthy();
    expect(server.to("POST", CODES_PATH)).toHaveLength(2);
  });

  it("says in place that it was refused as too many requests", async () => {
    stubServer(true, { codes: () => withErrors(429, "rate_limited", [], { "Retry-After": "45" }) });
    await openSecurity();
    await click("Replace backup codes");
    const dialog = await screen.findByRole("dialog", { name: "Replace your backup codes" });

    await typeCode("654321", dialog);

    expect(await within(dialog).findByText("Too many attempts. Try again in 45 seconds.")).toBeTruthy();
    expect(within(dialog).queryByRole("list", { name: "Backup codes" })).toBeNull();
  });
});

describe("turning off", () => {
  it("asks for a code and the password, sends nothing before the confirmation, then turns off and refetches the account", async () => {
    const server = stubServer(true);
    await openSecurity();
    await click("Turn off");
    const dialog = await screen.findByRole("dialog", { name: "Turn off two-factor authentication" });
    await fill(dialog);

    await click("Turn off", dialog);
    const confirm = await screen.findByRole("alertdialog", { name: "Turn off two-factor authentication?" });
    expect(server.to("DELETE", MFA_PATH)).toEqual([]);
    await click("Cancel", confirm);
    await waitFor(() => {
      expect(screen.queryByRole("alertdialog")).toBeNull();
    });
    expect(server.to("DELETE", MFA_PATH)).toEqual([]);

    await click("Turn off", dialog);
    const again = await screen.findByRole("alertdialog", { name: "Turn off two-factor authentication?" });
    const meBefore = me(server);
    await click("Turn off", again);

    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Turn off two-factor authentication" })).toBeNull();
    });
    expect(server.to("DELETE", MFA_PATH).map((call) => call.body)).toEqual([{ code: "654321", password: "old password 1" }]);
    await waitFor(() => {
      expect(me(server)).toBeGreaterThan(meBefore);
    });
    expect(await screen.findByText("Off")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Set up" })).toBeTruthy();
  });

  it("accepts a backup code in place of the code", async () => {
    const server = stubServer(true);
    await openSecurity();
    await click("Turn off");
    const dialog = await screen.findByRole("dialog", { name: "Turn off two-factor authentication" });

    await click("Use a backup code instead", dialog);
    fireEvent.change(within(dialog).getByLabelText("Backup code"), { target: { value: " abcdefgh23 " } });
    fireEvent.change(within(dialog).getByLabelText("Password"), { target: { value: "old password 1" } });
    await click("Turn off", dialog);
    await click("Turn off", await screen.findByRole("alertdialog"));

    await waitFor(() => {
      expect(server.to("DELETE", MFA_PATH)).toHaveLength(1);
    });
    expect(server.to("DELETE", MFA_PATH)[0]?.body).toEqual({ backupCode: "abcdefgh23", password: "old password 1" });
  });

  it("asks for both before it asks for confirmation", async () => {
    const server = stubServer(true);
    await openSecurity();
    await click("Turn off");
    const dialog = await screen.findByRole("dialog", { name: "Turn off two-factor authentication" });

    await click("Turn off", dialog);

    expect(within(dialog).getByText("Enter the six-digit code.")).toBeTruthy();
    expect(within(dialog).getByText("Enter your password.")).toBeTruthy();
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(server.to("DELETE", MFA_PATH)).toEqual([]);
  });

  it("shows a wrong password in its field and stays on, still On", async () => {
    stubServer(true, { disable: () => withErrors(422, "validation_failed", [{ path: "password", code: "invalid_password" }]) });
    await openSecurity();
    await click("Turn off");
    const dialog = await screen.findByRole("dialog", { name: "Turn off two-factor authentication" });
    await fill(dialog, "nope");
    await click("Turn off", dialog);
    await click("Turn off", await screen.findByRole("alertdialog"));

    expect(await within(dialog).findByText("The password is not right.")).toBeTruthy();
    expect(within(dialog).getByLabelText("Password").getAttribute("aria-invalid")).toBe("true");
    await waitFor(() => {
      expect(screen.queryByRole("alertdialog")).toBeNull();
    });
    expect(screen.getByRole("dialog", { name: "Turn off two-factor authentication" })).toBeTruthy();
    expect(screen.getByText("On")).toBeTruthy();
  });

  it("shows a refused code in the code field", async () => {
    stubServer(true, { disable: () => withErrors(422, "invalid_code", [{ path: "code", code: "invalid_code" }]) });
    await openSecurity();
    await click("Turn off");
    const dialog = await screen.findByRole("dialog", { name: "Turn off two-factor authentication" });
    await fill(dialog);
    await click("Turn off", dialog);
    await click("Turn off", await screen.findByRole("alertdialog"));

    expect(await within(dialog).findByText("That code is not valid. Check it and try again.")).toBeTruthy();
    expect(screen.getByText("On")).toBeTruthy();
  });

  it("says in place that it was refused as too many requests, and stays On", async () => {
    stubServer(true, { disable: () => withErrors(429, "rate_limited", [], { "Retry-After": "90" }) });
    await openSecurity();
    await click("Turn off");
    const dialog = await screen.findByRole("dialog", { name: "Turn off two-factor authentication" });
    await fill(dialog);
    await click("Turn off", dialog);
    await click("Turn off", await screen.findByRole("alertdialog"));

    expect(await within(dialog).findByText("Too many attempts. Try again in 2 minutes.")).toBeTruthy();
    expect(screen.getByText("On")).toBeTruthy();
  });

  it("says in place that a fresh confirmation is needed when the member gives up re-authenticating", async () => {
    const server = stubServer(true, { disable: () => reauthRequired() });
    await openSecurity();
    await click("Turn off");
    const dialog = await screen.findByRole("dialog", { name: "Turn off two-factor authentication" });
    await fill(dialog);
    await click("Turn off", dialog);
    await click("Turn off", await screen.findByRole("alertdialog"));
    const prompt = await screen.findByRole("dialog", { name: "Confirm it is you" });
    await click("Cancel", prompt);

    expect(await within(dialog).findByText("Confirm it is you to continue.")).toBeTruthy();
    expect(server.to("DELETE", MFA_PATH)).toHaveLength(1);
    expect(screen.getByText("On")).toBeTruthy();
  });
});

describe("accessibility", () => {
  async function violations(): Promise<string[]> {
    const results = await axe(document.body, { rules: { region: { enabled: false } } });
    return results.violations.map((violation) => `${violation.id}: ${violation.help}`);
  }

  it.each(["light", "dark"] as const)("has no axe violations in the enrolled state, and with the wizard open, in the %s theme", async (theme) => {
    stubServer(false);
    await openSecurity();
    document.documentElement.classList.toggle("dark", theme === "dark");
    await screen.findByRole("heading", { level: 2, name: "Two-factor authentication" });
    expect(await violations()).toEqual([]);

    await startEnrolment();
    expect(await violations()).toEqual([]);
    await click("Next");
    await typeCode("123456");
    await screen.findByRole("heading", { level: 2, name: "Save your backup codes" });
    expect(await violations()).toEqual([]);
  });

  it("has no axe violations with the turn-off dialogs open", async () => {
    stubServer(true);
    await openSecurity();
    await click("Turn off");
    const dialog = await screen.findByRole("dialog", { name: "Turn off two-factor authentication" });
    await fill(dialog);
    await click("Turn off", dialog);
    await screen.findByRole("alertdialog");

    expect(await violations()).toEqual([]);
  });
});
