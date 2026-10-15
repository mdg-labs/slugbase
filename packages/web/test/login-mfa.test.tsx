import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { axe } from "vitest-axe";
import { createWebApp } from "../src/index.ts";
import { CONFIG_BODY, ME_PATH, PRODUCT_NAME, SESSION_BODY, SESSION_PATH, json, meBody, problem, renderApp, stubBrowserApis, stubMatchMedia } from "./support.tsx";

type Transport = (request: Request) => Promise<Response>;

type SessionState = "none" | "partial" | "full";

const LOGIN_PATH = "/api/v1/auth/login";
const VERIFY_PATH = "/api/v1/auth/mfa/verify";
const LOGOUT_PATH = "/api/v1/auth/logout";

interface Server {
  readonly fetch: ReturnType<typeof vi.fn<Transport>>;
  readonly state: () => SessionState;
  /** The JSON bodies the verification received. */
  readonly verifications: () => Promise<unknown[]>;
  readonly logouts: () => number;
}

const verified = (): Promise<Response> => Promise.resolve(json({ next: "done" }));

/**
 * A server whose session is in `initial` state. A sign-in answered `{ next: "mfa" }` leaves a partial session, a
 * verification answered `200` a full one and a sign-out none. A partial session answers every other call
 * `401 mfa_required`.
 */
function stubServer(initial: SessionState, verify: Transport = verified): Server {
  let state = initial;
  const verifications: Request[] = [];
  let logouts = 0;
  const fetch = vi.fn<Transport>((request) => {
    const { pathname } = new URL(request.url);
    if (pathname === "/api/config") {
      return Promise.resolve(json(CONFIG_BODY));
    }
    if (pathname === LOGIN_PATH) {
      state = "partial";
      return Promise.resolve(json({ next: "mfa" }));
    }
    if (pathname === VERIFY_PATH) {
      verifications.push(request.clone());
      return verify(request).then((response) => {
        state = response.ok ? "full" : state;
        return response;
      });
    }
    if (pathname === LOGOUT_PATH) {
      logouts += 1;
      state = "none";
      return Promise.resolve(new Response(null, { status: 204 }));
    }
    if (state === "none") {
      return Promise.resolve(problem(401, "unauthenticated", "req-none"));
    }
    if (state === "partial") {
      return Promise.resolve(problem(401, "mfa_required", "req-partial"));
    }
    if (pathname === ME_PATH) {
      return Promise.resolve(json(meBody()));
    }
    return pathname === SESSION_PATH ? Promise.resolve(json(SESSION_BODY)) : Promise.reject(new Error(`unexpected call to ${pathname}`));
  });
  vi.stubGlobal("fetch", fetch);
  return {
    fetch,
    state: () => state,
    verifications: () => Promise.all(verifications.map((request) => request.json() as Promise<unknown>)),
    logouts: () => logouts,
  };
}

async function open(path: string): Promise<void> {
  window.history.replaceState(null, "", path);
  const App = createWebApp({ extensions: [] });
  await renderApp(<App />);
}

async function openMfa(path = "/login/mfa"): Promise<void> {
  await open(path);
  await screen.findByRole("heading", { level: 1, name: "Two-step verification" });
}

function firstSlot(): HTMLInputElement {
  return screen.getByRole<HTMLInputElement>("textbox", { name: "Authentication code" });
}

async function typeCode(digits: string): Promise<void> {
  await act(async () => {
    fireEvent.change(firstSlot(), { target: { value: digits } });
    await Promise.resolve();
  });
}

beforeEach(() => {
  stubBrowserApis();
  stubMatchMedia();
  vi.spyOn(window.navigator, "languages", "get").mockReturnValue(["en-US", "en"]);
  window.history.replaceState(null, "", "/");
});

afterEach(() => {
  vi.restoreAllMocks();
  document.documentElement.removeAttribute("lang");
});

describe("the sign-in that continues at the second step", () => {
  it("takes the visitor to /login/mfa, keeping the page they were headed for", async () => {
    stubServer("none");
    await open(`/login?next=${encodeURIComponent("/settings/account/security")}`);
    await screen.findByRole("heading", { level: 1, name: "Sign in" });
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "ada@example.org" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "correct horse" } });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
      await Promise.resolve();
    });

    expect(await screen.findByRole("heading", { level: 1, name: "Two-step verification" })).toBeTruthy();
    expect(window.location.pathname).toBe("/login/mfa");
    expect(window.location.search).toBe(`?next=${encodeURIComponent("/settings/account/security")}`);
  });

  it("is reached by a visitor who opens /", async () => {
    stubServer("partial");

    await open("/settings/account/security");

    expect(await screen.findByRole("heading", { level: 1, name: "Two-step verification" })).toBeTruthy();
    expect(window.location.pathname).toBe("/login/mfa");
    expect(window.location.search).toBe(`?next=${encodeURIComponent("/settings/account/security")}`);
    expect(screen.queryByText("Your session has ended")).toBeNull();
  });
});

describe("the page", () => {
  it("asks for the six-digit code, with the backup code and the way back as alternatives", async () => {
    stubServer("partial");
    await openMfa();

    const main = screen.getByRole("main");
    expect(main.textContent).toContain(PRODUCT_NAME);
    expect(screen.getAllByRole("textbox", { hidden: false }).filter((input) => input.getAttribute("aria-hidden") !== "true")).toHaveLength(6);
    expect(screen.getByRole("button", { name: "Use a backup code instead" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Back to sign in" })).toBeTruthy();
    expect(document.activeElement).toBe(firstSlot());
  });

  it("is written in German", async () => {
    vi.spyOn(window.navigator, "languages", "get").mockReturnValue(["de-AT"]);
    stubServer("partial");

    await open("/login/mfa");

    expect(await screen.findByRole("heading", { level: 1, name: "Zweistufige Bestätigung" })).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "Bestätigungscode" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Stattdessen einen Backup-Code verwenden" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Zurück zur Anmeldung" })).toBeTruthy();
  });

  it.each(["light", "dark"] as const)("has no axe violations in the %s theme, with and without an error", async (theme) => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    stubServer("partial", () => Promise.resolve(problem(422, "invalid_code", "req-1")));
    await openMfa();
    expect((await axe(document.body, { rules: { region: { enabled: false } } })).violations.map(({ id }) => id)).toEqual([]);

    await typeCode("123456");
    await screen.findByRole("alert");

    expect((await axe(document.body, { rules: { region: { enabled: false } } })).violations.map(({ id }) => id)).toEqual([]);
  });

  it("sends a visitor with a full session home, and one without a session to sign in", async () => {
    stubServer("full");
    await open("/login/mfa");
    expect(await screen.findByRole("heading", { level: 1, name: `Welcome to ${PRODUCT_NAME}` })).toBeTruthy();
    expect(window.location.pathname).toBe("/");
  });

  it("sends a visitor without a session back to sign in, keeping the page they were headed for", async () => {
    stubServer("none");

    await open(`/login/mfa?next=${encodeURIComponent("/b/one")}`);

    expect(await screen.findByRole("heading", { level: 1, name: "Sign in" })).toBeTruthy();
    expect(window.location.pathname).toBe("/login");
    expect(window.location.search).toBe(`?next=${encodeURIComponent("/b/one")}`);
  });
});

describe("the six-digit code", () => {
  it("is sent as soon as the sixth digit is in, then the visitor goes to the page they were headed for", async () => {
    const server = stubServer("partial");
    await openMfa(`/login/mfa?next=${encodeURIComponent("/settings/account/security")}`);

    await typeCode("12345");
    expect(await server.verifications()).toEqual([]);
    await typeCode("123456");

    await waitFor(() => {
      expect(window.location.pathname).toBe("/settings/account/security");
    });
    expect(await server.verifications()).toEqual([{ code: "123456" }]);
    expect(server.state()).toBe("full");
  });

  it.each(["https://evil.example/x", "//evil.example", "/\\evil.example"])("goes home, not to %s", async (next) => {
    stubServer("partial");
    await openMfa(`/login/mfa?next=${encodeURIComponent(next)}`);

    await typeCode("123456");

    expect(await screen.findByRole("heading", { level: 1, name: `Welcome to ${PRODUCT_NAME}` })).toBeTruthy();
    expect(window.location.pathname).toBe("/");
    expect(window.location.hostname).toBe("localhost");
  });

  it("asks for the missing digits without sending anything", async () => {
    const server = stubServer("partial");
    await openMfa();
    await typeCode("123");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Verify" }));
      await Promise.resolve();
    });

    expect(screen.getByText("Enter the six-digit code.")).toBeTruthy();
    expect(firstSlot().getAttribute("aria-invalid")).toBe("true");
    expect(await server.verifications()).toEqual([]);
  });

  it("shows one generic message for a wrong code, clears the field and takes another try", async () => {
    let answers = 0;
    const server = stubServer("partial", () => {
      answers += 1;
      return answers === 1 ? Promise.resolve(problem(422, "invalid_code", "req-1", "code 123456 was already used")) : verified();
    });
    await openMfa();

    await typeCode("123456");

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("That code is not valid. Check it and try again.");
    expect(document.body.textContent).not.toContain("already used");
    expect(window.location.pathname).toBe("/login/mfa");
    expect(firstSlot().value).toBe("");
    await waitFor(() => {
      expect(document.activeElement).toBe(firstSlot());
    });

    await typeCode("654321");

    await waitFor(() => {
      expect(window.location.pathname).toBe("/");
    });
    expect(await server.verifications()).toEqual([{ code: "123456" }, { code: "654321" }]);
  });

  it("shows the wait of a rate limit and does not call the failure a wrong code", async () => {
    stubServer("partial", () =>
      Promise.resolve(
        new Response(JSON.stringify({ type: "t", title: "rate_limited", status: 429, code: "rate_limited", detail: "d", requestId: "r" }), {
          status: 429,
          headers: { "Content-Type": "application/problem+json", "Retry-After": "120" },
        }),
      ),
    );
    await openMfa();

    await typeCode("123456");

    expect((await screen.findByRole("alert")).textContent).toContain("Try again in 2 minutes.");
  });

  it.each([
    ["a server error", () => Promise.resolve(problem(503, "unavailable", "req-1"))],
    ["a network failure", () => Promise.reject(new TypeError("fetch failed: ECONNREFUSED 10.0.0.7"))],
  ])("does not call %s a wrong code", async (_name, answer) => {
    stubServer("partial", answer);
    await openMfa();

    await typeCode("123456");

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("The code could not be checked right now. Try again in a moment.");
    expect(alert.textContent).not.toContain("ECONNREFUSED");
    expect(window.location.pathname).toBe("/login/mfa");
  });

  it("shows the field and the button as busy and sends the code once while it is verified", async () => {
    let answer: (response: Response) => void = () => undefined;
    const server = stubServer("partial", () => new Promise<Response>((resolve) => (answer = resolve)));
    await openMfa();

    await typeCode("123456");

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Verify/ }).hasAttribute("data-loading")).toBe(true);
    });
    expect(firstSlot().disabled).toBe(true);
    expect(screen.getByRole("button", { name: "Use a backup code instead" }).hasAttribute("disabled")).toBe(true);
    expect(await server.verifications()).toHaveLength(1);

    await act(async () => {
      answer(await verified());
    });
    expect(await screen.findByRole("heading", { level: 1, name: `Welcome to ${PRODUCT_NAME}` })).toBeTruthy();
  });

  it("abandons the request when the page goes away", async () => {
    let signal: AbortSignal | undefined;
    stubServer("partial", (request) => {
      signal = request.signal;
      return new Promise<Response>(() => undefined);
    });
    window.history.replaceState(null, "", "/login/mfa");
    const App = createWebApp({ extensions: [] });
    const { unmount } = await renderApp(<App />);
    await screen.findByRole("heading", { level: 1, name: "Two-step verification" });
    await typeCode("123456");
    await waitFor(() => {
      expect(signal).toBeDefined();
    });
    expect(signal?.aborted).toBe(false);

    unmount();

    expect(signal?.aborted).toBe(true);
  });
});

describe("the backup code", () => {
  it("is a text input that takes the place of the six digits, and sends the code as typed, trimmed", async () => {
    const server = stubServer("partial");
    await openMfa();

    fireEvent.click(screen.getByRole("button", { name: "Use a backup code instead" }));

    const input = screen.getByLabelText<HTMLInputElement>("Backup code");
    expect(input.type).toBe("text");
    expect(screen.queryByRole("textbox", { name: "Authentication code" })).toBeNull();
    expect(screen.getByRole("button", { name: "Use the authenticator app instead" })).toBeTruthy();
    await waitFor(() => {
      expect(document.activeElement).toBe(input);
    });

    fireEvent.change(input, { target: { value: " abcd-efgh-ijkl " } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Verify" }));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(window.location.pathname).toBe("/");
    });
    expect(await server.verifications()).toEqual([{ backupCode: "abcd-efgh-ijkl" }]);
  });

  it("asks for a code when the field is empty, without sending anything", async () => {
    const server = stubServer("partial");
    await openMfa();
    fireEvent.click(screen.getByRole("button", { name: "Use a backup code instead" }));

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Verify" }));
      await Promise.resolve();
    });

    expect(screen.getByText("Enter a backup code.")).toBeTruthy();
    expect(screen.getByLabelText("Backup code").getAttribute("aria-invalid")).toBe("true");
    expect(await server.verifications()).toEqual([]);
  });

  it("shows the same generic message for a wrong or used backup code, and the visitor can switch back", async () => {
    stubServer("partial", () => Promise.resolve(problem(422, "invalid_code", "req-1")));
    await openMfa();
    fireEvent.click(screen.getByRole("button", { name: "Use a backup code instead" }));
    fireEvent.change(screen.getByLabelText("Backup code"), { target: { value: "abcd-efgh" } });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Verify" }));
      await Promise.resolve();
    });

    expect((await screen.findByRole("alert")).textContent).toContain("That code is not valid. Check it and try again.");

    fireEvent.click(screen.getByRole("button", { name: "Use the authenticator app instead" }));

    expect(screen.getByRole("textbox", { name: "Authentication code" })).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("a pending session that has ended", () => {
  it.each([
    ["the session expired", "unauthenticated"],
    ["its fifth refused code revoked it", "unauthenticated"],
  ])("goes back to sign in with an info toast when %s", async (_name, code) => {
    stubServer("partial", () => Promise.resolve(problem(401, code, "req-1")));
    await openMfa(`/login/mfa?next=${encodeURIComponent("/b/one")}`);

    await typeCode("123456");

    expect(await screen.findByRole("heading", { level: 1, name: "Sign in" })).toBeTruthy();
    expect(window.location.pathname).toBe("/login");
    expect(window.location.search).toBe(`?next=${encodeURIComponent("/b/one")}`);
    expect(await screen.findByText("Your sign-in has expired")).toBeTruthy();
    expect(screen.getAllByText("Your sign-in has expired")).toHaveLength(1);
    expect(screen.queryByText("Your session has ended")).toBeNull();
  });
});

describe("back to sign in", () => {
  it("ends the pending session and shows the sign-in page", async () => {
    const server = stubServer("partial");
    await openMfa(`/login/mfa?next=${encodeURIComponent("/b/one")}`);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Back to sign in" }));
      await Promise.resolve();
    });

    expect(await screen.findByRole("heading", { level: 1, name: "Sign in" })).toBeTruthy();
    expect(server.logouts()).toBe(1);
    expect(server.state()).toBe("none");
    expect(window.location.search).toBe(`?next=${encodeURIComponent("/b/one")}`);
  });

  it("stays on the page and says so when the session could not be ended", async () => {
    const server = stubServer("partial");
    server.fetch.mockImplementation((request) =>
      new URL(request.url).pathname === LOGOUT_PATH
        ? Promise.resolve(problem(503, "unavailable", "req-1"))
        : request.url.endsWith("/api/config")
          ? Promise.resolve(json(CONFIG_BODY))
          : Promise.resolve(problem(401, "mfa_required", "req-partial")),
    );
    await openMfa();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Back to sign in" }));
      await Promise.resolve();
    });

    expect((await screen.findByRole("alert")).textContent).toContain("Going back to sign in did not work. Try again.");
    expect(window.location.pathname).toBe("/login/mfa");
  });
});
