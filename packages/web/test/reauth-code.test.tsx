import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HEAVY_TEST_TIMEOUT_MS } from "../../../vitest.shared.ts";
import { createWebApp } from "../src/index.ts";
import { ACCOUNT_BODY, CONFIG_BODY, ME_PATH, json, meBody, problem, renderApp, stubBrowserApis, stubMatchMedia } from "./support.tsx";

// The code option of the re-authentication prompt (doc 04 section 4.4, doc 10 T18): an account whose two-factor
// authentication is on may confirm it is them with a current code of its authenticator app instead of the password.
// The failure scenarios are a code option offered to an account without the factor, a code that is sent without the
// member asking for it, an action that is not sent again after the code was accepted (or is sent again after a wrong
// one), a refusal or rate limit that is not shown, and a code that stays in the field after it was refused.

type Transport = (request: Request) => Promise<Response>;

const PASSWORD_PATH = "/api/v1/me/password";
const REAUTH_PATH = "/api/v1/me/reauth";
const CODE = "654321";

interface Call {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
}

interface ServerOptions {
  readonly mfaEnabled: boolean;
  readonly hasPassword?: boolean;
  readonly reauth?: (call: number) => Response;
}

/** A server whose password change answers `reauth_required` until `POST /me/reauth` was answered with a success. */
function stubServer({ mfaEnabled, hasPassword = true, reauth }: ServerOptions): { calls: Call[]; to: (path: string) => Call[] } {
  const calls: Call[] = [];
  let reauthenticated = false;
  vi.stubGlobal(
    "fetch",
    vi.fn<Transport>(async (request) => {
      const { pathname } = new URL(request.url);
      if (pathname === "/api/config") {
        return json(CONFIG_BODY);
      }
      if (pathname === ME_PATH && request.method === "GET") {
        const body = meBody() as { account: object };
        return json({ ...body, account: { ...ACCOUNT_BODY, ...body.account, hasPassword, mfaEnabled } });
      }
      const text = request.method === "GET" ? "" : await request.clone().text();
      calls.push({ method: request.method, path: pathname, body: text === "" ? undefined : (JSON.parse(text) as unknown) });
      if (pathname === "/api/v1/me/sessions") {
        return json({ items: [], nextCursor: null });
      }
      if (pathname === "/api/v1/me/identities") {
        return json({ items: [], nextCursor: null });
      }
      if (pathname === REAUTH_PATH) {
        const answer = reauth?.(calls.filter((call) => call.path === REAUTH_PATH).length) ?? new Response(null, { status: 204 });
        reauthenticated = reauthenticated || answer.ok;
        return answer;
      }
      if (pathname === PASSWORD_PATH) {
        return reauthenticated ? new Response(null, { status: 204 }) : problem(401, "reauth_required", "req-reauth");
      }
      return problem(404, "not_found", "req-404");
    }),
  );
  return { calls, to: (path) => calls.filter((call) => call.path === path) };
}

function withErrors(status: number, code: string, headers: Record<string, string> = {}): Response {
  return json(
    { type: `https://slugbase.app/problems/${code}`, title: code, status, code, detail: "x", requestId: "req-422", errors: [{ path: "code", code }] },
    { status, contentType: "application/problem+json", headers },
  );
}

async function act_(action: () => void): Promise<void> {
  await act(async () => {
    action();
    await Promise.resolve();
  });
}

/** Opens the Security page and asks for the change that needs the prompt, which opens it. */
async function openPrompt(hasPassword: boolean): Promise<HTMLElement> {
  window.history.replaceState(null, "", "/settings/account/security");
  const App = createWebApp({ extensions: [] });
  await renderApp(<App />);
  await screen.findByRole("heading", { level: 1, name: "Security" });
  if (hasPassword) {
    fireEvent.change(screen.getByLabelText("Current password"), { target: { value: "old password 1" } });
  }
  fireEvent.change(screen.getByLabelText("New password"), { target: { value: "a much longer new passphrase" } });
  await act_(() => {
    fireEvent.click(screen.getByRole("button", { name: hasPassword ? "Change password" : "Add a password" }));
  });
  return screen.findByRole("dialog", { name: "Confirm it is you" });
}

async function typeCode(dialog: HTMLElement, digits: string): Promise<void> {
  await act_(() => {
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Authentication code" }), { target: { value: digits } });
  });
}

beforeEach(() => {
  stubBrowserApis();
  stubMatchMedia(false);
  vi.spyOn(window.navigator, "languages", "get").mockReturnValue(["en-US", "en"]);
  window.history.replaceState(null, "", "/");
});

afterEach(() => {
  vi.restoreAllMocks();
  document.documentElement.removeAttribute("lang");
});

describe("the code option of the re-authentication prompt", { timeout: HEAVY_TEST_TIMEOUT_MS }, () => {
  it("offers no code to an account whose two-factor authentication is off", async () => {
    stubServer({ mfaEnabled: false });
    const dialog = await openPrompt(true);

    expect(within(dialog).getByLabelText("Password")).toBeTruthy();
    expect(within(dialog).queryByRole("button", { name: "Use a code instead" })).toBeNull();
  });

  it("asks for the password first, and sends nothing until the member chooses the code", async () => {
    const server = stubServer({ mfaEnabled: true });
    const dialog = await openPrompt(true);

    expect(within(dialog).getByLabelText("Password")).toBeTruthy();
    expect(within(dialog).queryByRole("textbox", { name: "Authentication code" })).toBeNull();
    expect(server.to(REAUTH_PATH)).toEqual([]);
  });

  it("sends the code as the contract defines it and sends the change again once it is accepted", async () => {
    const server = stubServer({ mfaEnabled: true });
    const dialog = await openPrompt(true);

    await act_(() => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Use a code instead" }));
    });
    expect(within(dialog).getByText("This change needs a code from your authenticator app.")).toBeTruthy();
    expect(within(dialog).queryByLabelText("Password")).toBeNull();
    await typeCode(dialog, CODE);

    expect(await screen.findByText("Your password was changed. Your other sessions were signed out.")).toBeTruthy();
    expect(server.to(REAUTH_PATH).map((call) => call.body)).toEqual([{ code: CODE }]);
    expect(server.calls.filter((call) => [PASSWORD_PATH, REAUTH_PATH].includes(call.path)).map((call) => call.path)).toEqual([PASSWORD_PATH, REAUTH_PATH, PASSWORD_PATH]);
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
  });

  it("goes back to the password, and the password still confirms", async () => {
    const server = stubServer({ mfaEnabled: true });
    const dialog = await openPrompt(true);
    await act_(() => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Use a code instead" }));
    });

    await act_(() => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Use your password instead" }));
    });
    fireEvent.change(within(dialog).getByLabelText("Password"), { target: { value: "old password 1" } });
    await act_(() => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Confirm" }));
    });

    expect(await screen.findByText("Your password was changed. Your other sessions were signed out.")).toBeTruthy();
    expect(server.to(REAUTH_PATH).map((call) => call.body)).toEqual([{ password: "old password 1" }]);
  });

  it("shows the wrong code in its field, empties the field, stays open and does not send the change again", async () => {
    const server = stubServer({ mfaEnabled: true, reauth: () => withErrors(422, "invalid_code") });
    const dialog = await openPrompt(true);
    await act_(() => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Use a code instead" }));
    });

    await typeCode(dialog, CODE);

    expect(await within(dialog).findByText("That code is not valid. Check it and try again.")).toBeTruthy();
    expect(screen.getByRole("dialog", { name: "Confirm it is you" })).toBeTruthy();
    expect(within(dialog).getByRole<HTMLInputElement>("textbox", { name: "Authentication code" }).value).toBe("");
    expect(server.to(PASSWORD_PATH)).toHaveLength(1);
    expect(screen.queryByText(/Your password was changed/)).toBeNull();
  });

  it("says when to try again when the code is rate limited, and sends the change again for no one", async () => {
    const server = stubServer({ mfaEnabled: true, reauth: () => withErrors(429, "rate_limited", { "Retry-After": "90" }) });
    const dialog = await openPrompt(true);
    await act_(() => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Use a code instead" }));
    });

    await typeCode(dialog, CODE);

    expect(await within(dialog).findByText("Too many attempts. Try again in 2 minutes.")).toBeTruthy();
    expect(server.to(PASSWORD_PATH)).toHaveLength(1);
  });

  it("says so when the code could not be checked", async () => {
    stubServer({ mfaEnabled: true, reauth: () => problem(503, "service_unavailable", "req-503") });
    const dialog = await openPrompt(true);
    await act_(() => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Use a code instead" }));
    });

    await typeCode(dialog, CODE);

    expect(await within(dialog).findByText("The code could not be checked right now. Try again in a moment.")).toBeTruthy();
  });

  it("sends nothing and raises no failure when the member cancels from the code step", async () => {
    const server = stubServer({ mfaEnabled: true });
    const dialog = await openPrompt(true);
    await act_(() => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Use a code instead" }));
    });

    await typeCode(dialog, "654");
    await act_(() => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    });

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    expect(server.to(REAUTH_PATH)).toEqual([]);
    expect(server.to(PASSWORD_PATH)).toHaveLength(1);
    expect(screen.queryByText(/Your password was changed/)).toBeNull();
  });

  it("opens at the password again after it was closed from the code step", async () => {
    stubServer({ mfaEnabled: true });
    const dialog = await openPrompt(true);
    await act_(() => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Use a code instead" }));
    });
    await act_(() => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    });
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });

    await act_(() => {
      fireEvent.click(screen.getByRole("button", { name: "Change password" }));
    });

    expect(within(await screen.findByRole("dialog", { name: "Confirm it is you" })).getByLabelText("Password")).toBeTruthy();
  });

  it("gives an account without a password the code next to its provider when its two-factor authentication is on", async () => {
    const server = stubServer({ mfaEnabled: true, hasPassword: false });
    const dialog = await openPrompt(false);
    expect(within(dialog).getByText("This change needs you to confirm it is you with your sign-in provider.")).toBeTruthy();

    await act_(() => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Use a code instead" }));
    });
    expect(within(dialog).getByRole("button", { name: "Use your sign-in provider instead" })).toBeTruthy();
    expect(within(dialog).queryByRole("button", { name: "Use your password instead" })).toBeNull();
    await typeCode(dialog, CODE);

    expect(await screen.findByText("Your password was added. Your other sessions were signed out.")).toBeTruthy();
    expect(server.to(REAUTH_PATH).map((call) => call.body)).toEqual([{ code: CODE }]);
  });

  it("gives an account without a password and without two-factor authentication no code", async () => {
    stubServer({ mfaEnabled: false, hasPassword: false });
    const dialog = await openPrompt(false);

    expect(within(dialog).getByText("This change needs you to confirm it is you with your sign-in provider.")).toBeTruthy();
    expect(within(dialog).queryByRole("button", { name: "Use a code instead" })).toBeNull();
  });
});
