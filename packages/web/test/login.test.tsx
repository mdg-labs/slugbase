import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { navigateTo } from "../src/auth/navigate.ts";
import { createWebApp } from "../src/index.ts";
import { CONFIG_BODY, PRODUCT_NAME, SESSION_PATH, json, problem, renderApp, signedIn, stubBrowserApis, stubMatchMedia } from "./support.tsx";

vi.mock("../src/auth/navigate.ts", () => ({ navigateTo: vi.fn() }));

type Transport = (request: Request) => Promise<Response>;

const LOGIN_PATH = "/api/v1/auth/login";

interface Server {
  readonly fetch: ReturnType<typeof vi.fn<Transport>>;
  /** The JSON bodies the sign-in received. */
  readonly logins: () => Promise<unknown[]>;
}

/**
 * A server with nobody signed in until a sign-in is answered with `200`; `login` answers the sign-in.
 */
function stubServer(login: Transport): Server {
  let signed = false;
  const received: Request[] = [];
  const fetch = vi.fn<Transport>((request) => {
    const { pathname } = new URL(request.url);
    if (pathname === LOGIN_PATH) {
      received.push(request.clone());
      return login(request).then((response) => {
        signed ||= response.ok;
        return response;
      });
    }
    if (pathname === SESSION_PATH && !signed) {
      return Promise.resolve(problem(401, "unauthenticated", "req-session"));
    }
    return signedIn(request);
  });
  vi.stubGlobal("fetch", fetch);
  return { fetch, logins: () => Promise.all(received.map((request) => request.json() as Promise<unknown>)) };
}

const done = (): Promise<Response> => Promise.resolve(json({ next: "done" }));

async function openLogin(path = "/login"): Promise<void> {
  window.history.replaceState(null, "", path);
  const App = createWebApp({ extensions: [] });
  await renderApp(<App />);
  await screen.findByRole("heading", { level: 1, name: "Sign in" });
}

function typeInto(label: string, value: string): void {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

async function submit(): Promise<void> {
  await act(async () => {
    fireEvent.submit(screen.getByRole("button", { name: /^Sign in/ }).closest("form") ?? document.body);
    await Promise.resolve();
  });
}

async function signInWith(email = "ada@example.org", password = "correct horse"): Promise<void> {
  typeInto("Email", email);
  typeInto("Password", password);
  await submit();
}

beforeEach(() => {
  vi.mocked(navigateTo).mockClear();
  stubBrowserApis();
  stubMatchMedia();
  vi.spyOn(window.navigator, "languages", "get").mockReturnValue(["en-US", "en"]);
  window.history.replaceState(null, "", "/");
});

afterEach(() => {
  vi.restoreAllMocks();
  document.documentElement.removeAttribute("lang");
});

describe("the sign-in page", () => {
  it("shows the authentication card with email, password, remember me and the submit button", async () => {
    stubServer(done);
    await openLogin();

    const main = screen.getByRole("main");
    expect(within(main).getByText(PRODUCT_NAME)).toBeTruthy();
    expect(within(main).getByText(`Sign in to ${PRODUCT_NAME}.`)).toBeTruthy();
    expect(screen.getByLabelText<HTMLInputElement>("Email").type).toBe("email");
    expect(screen.getByLabelText<HTMLInputElement>("Password").type).toBe("password");
    expect(screen.getByRole("button", { name: "Show password" })).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: "Remember me" }).getAttribute("aria-checked")).toBe("false");
    expect(screen.getByRole("button", { name: "Sign in" })).toBeTruthy();
    expect(screen.queryByRole("navigation")).toBeNull();
  });

  it("is written in German", async () => {
    vi.spyOn(window.navigator, "languages", "get").mockReturnValue(["de-AT"]);
    stubServer(done);
    window.history.replaceState(null, "", "/login");
    const App = createWebApp({ extensions: [] });
    await renderApp(<App />);

    expect(await screen.findByRole("heading", { level: 1, name: "Anmelden" })).toBeTruthy();
    expect(screen.getByLabelText("E-Mail")).toBeTruthy();
    expect(screen.getByLabelText("Passwort")).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: "Angemeldet bleiben" })).toBeTruthy();
  });
});

describe("signing in", () => {
  it("sends the trimmed email, the password and the remember choice, then goes home", async () => {
    const server = stubServer(done);
    await openLogin();
    fireEvent.click(screen.getByRole("checkbox", { name: "Remember me" }));

    await signInWith("  ada@example.org ", "correct horse");

    expect(await screen.findByRole("heading", { level: 1, name: `Welcome to ${PRODUCT_NAME}` })).toBeTruthy();
    expect(await server.logins()).toEqual([{ email: "ada@example.org", password: "correct horse", remember: true }]);
    expect(window.location.pathname).toBe("/");
  });

  it("sends remember as false when the box is left alone", async () => {
    const server = stubServer(done);
    await openLogin();

    await signInWith();

    await screen.findByRole("heading", { level: 1, name: `Welcome to ${PRODUCT_NAME}` });
    expect(await server.logins()).toEqual([{ email: "ada@example.org", password: "correct horse", remember: false }]);
  });

  it("sends a signed-in visitor who opens /login to the home page", async () => {
    vi.stubGlobal("fetch", (request: Request) => signedIn(request));
    window.history.replaceState(null, "", "/login?next=%2Fmissing");
    const App = createWebApp({ extensions: [] });

    await renderApp(<App />);

    expect(await screen.findByRole("heading", { level: 1, name: `Welcome to ${PRODUCT_NAME}` })).toBeTruthy();
    expect(window.location.pathname).toBe("/");
    expect(screen.queryByRole("heading", { name: "Sign in" })).toBeNull();
  });

  it("shows the form when the session check cannot be answered", async () => {
    vi.stubGlobal("fetch", (request: Request) =>
      new URL(request.url).pathname === SESSION_PATH
        ? Promise.reject(new TypeError("fetch failed"))
        : signedIn(request),
    );

    await openLogin();

    expect(screen.getByRole("button", { name: "Sign in" })).toBeTruthy();
  });
});

describe("a sign-in that does not go through", () => {
  it.each([
    ["an unknown email or a wrong password", "unauthenticated"],
    ["a disabled account", "unauthenticated"],
  ])("says one generic thing for %s", async (_name, code) => {
    stubServer(() => Promise.resolve(problem(401, code, "req-1", "no such account: ada@example.org")));
    await openLogin();

    await signInWith();

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("The email address or the password is wrong.");
    expect(document.body.textContent).not.toContain("no such account");
    expect(screen.getByLabelText("Email").getAttribute("aria-invalid")).toBeNull();
    expect(window.location.pathname).toBe("/login");
    expect(screen.queryByText("Your session has ended")).toBeNull();
    expect(screen.getByRole("button", { name: "Sign in" }).hasAttribute("data-loading")).toBe(false);
  });

  it.each([
    [42, "Too many sign-in attempts. Try again in 42 seconds."],
    [1, "Too many sign-in attempts. Try again in 1 second."],
    [120, "Too many sign-in attempts. Try again in 2 minutes."],
    [61, "Too many sign-in attempts. Try again in 2 minutes."],
  ])("shows the wait of a Retry-After of %s seconds", async (seconds, message) => {
    stubServer(() =>
      Promise.resolve(
        new Response(JSON.stringify({ type: "t", title: "rate_limited", status: 429, code: "rate_limited", detail: "d", requestId: "r" }), {
          status: 429,
          headers: { "Content-Type": "application/problem+json", "Retry-After": String(seconds) },
        }),
      ),
    );
    await openLogin();

    await signInWith();

    expect((await screen.findByRole("alert")).textContent).toContain(message);
  });

  it("says to try later when a 429 names no wait", async () => {
    stubServer(() => Promise.resolve(problem(429, "rate_limited", "req-1")));
    await openLogin();

    await signInWith();

    expect((await screen.findByRole("alert")).textContent).toContain("Too many sign-in attempts. Try again later.");
  });

  it("shows the wait in German", async () => {
    vi.spyOn(window.navigator, "languages", "get").mockReturnValue(["de-AT"]);
    stubServer(() =>
      Promise.resolve(
        new Response(JSON.stringify({ type: "t", title: "rate_limited", status: 429, code: "rate_limited", detail: "d", requestId: "r" }), {
          status: 429,
          headers: { "Content-Type": "application/problem+json", "Retry-After": "90" },
        }),
      ),
    );
    window.history.replaceState(null, "", "/login");
    const App = createWebApp({ extensions: [] });
    await renderApp(<App />);
    await screen.findByRole("heading", { level: 1, name: "Anmelden" });

    fireEvent.change(screen.getByLabelText("E-Mail"), { target: { value: "ada@example.org" } });
    fireEvent.change(screen.getByLabelText("Passwort"), { target: { value: "pw" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Anmelden" }));
      await Promise.resolve();
    });

    expect((await screen.findByRole("alert")).textContent).toContain("Zu viele Anmeldeversuche. Versuche es in 2 Minuten erneut.");
  });

  it.each([
    ["a server error", () => Promise.resolve(problem(503, "unavailable", "req-1"))],
    ["a refused cross-site request", () => Promise.resolve(problem(403, "cross_site_request", "req-1"))],
    ["a network failure", () => Promise.reject(new TypeError("fetch failed: ECONNREFUSED 10.0.0.7"))],
    ["an answer that is not a problem document", () => Promise.resolve(new Response("<html>bad gateway</html>", { status: 502 }))],
  ])("does not call %s a wrong password", async (_name, answer) => {
    stubServer(answer);
    await openLogin();

    await signInWith();

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Signing in is not possible right now. Try again in a moment.");
    expect(alert.textContent).not.toContain("ECONNREFUSED");
    expect(window.location.pathname).toBe("/login");
    expect(screen.getByRole("button", { name: "Sign in" }).hasAttribute("data-loading")).toBe(false);
  });

  it("ties the errors of a refused field to that field", async () => {
    stubServer(() =>
      Promise.resolve(
        json(
          {
            type: "t",
            title: "validation_failed",
            status: 422,
            code: "validation_failed",
            detail: "d",
            requestId: "r",
            errors: [{ path: "email", code: "too_long" }],
          },
          { status: 422, contentType: "application/problem+json" },
        ),
      ),
    );
    await openLogin();

    await signInWith();

    const message = await screen.findByText("Check the email address.");
    const email = screen.getByLabelText("Email");
    expect(email.getAttribute("aria-invalid")).toBe("true");
    expect(email.getAttribute("aria-describedby")?.split(" ")).toContain(message.id);
    expect(screen.getByLabelText("Password").getAttribute("aria-invalid")).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain("Check your entries and try again.");
  });

  it("asks for what is missing, linked to its field, without sending anything", async () => {
    const server = stubServer(done);
    await openLogin();
    const callsBefore = server.fetch.mock.calls.length;

    await submit();

    const email = screen.getByLabelText("Email");
    const password = screen.getByLabelText("Password");
    expect(email.getAttribute("aria-invalid")).toBe("true");
    expect(password.getAttribute("aria-invalid")).toBe("true");
    expect(email.getAttribute("aria-describedby")?.split(" ")).toContain(screen.getByText("Enter your email address.").id);
    expect(password.getAttribute("aria-describedby")?.split(" ")).toContain(screen.getByText("Enter your password.").id);
    expect(document.activeElement).toBe(email);
    expect(server.fetch.mock.calls.length).toBe(callsBefore);

    typeInto("Email", "ada@example.org");
    await submit();

    expect(screen.getByLabelText("Email").getAttribute("aria-invalid")).toBeNull();
    expect(document.activeElement).toBe(screen.getByLabelText("Password"));
    expect(server.fetch.mock.calls.length).toBe(callsBefore);
  });
});

describe("a sign-in under way", () => {
  it("shows the button as loading and sends the sign-in once, however often it is submitted", async () => {
    let answer: (response: Response) => void = () => undefined;
    const server = stubServer(() => new Promise<Response>((resolve) => (answer = resolve)));
    await openLogin();
    typeInto("Email", "ada@example.org");
    typeInto("Password", "correct horse");

    await submit();
    await submit();

    const button = screen.getByRole("button", { name: /Sign in/ });
    expect(button.hasAttribute("data-loading")).toBe(true);
    expect(button.hasAttribute("disabled")).toBe(true);
    expect(await server.logins()).toHaveLength(1);

    await act(async () => {
      answer(await done());
    });
    expect(await screen.findByRole("heading", { level: 1, name: `Welcome to ${PRODUCT_NAME}` })).toBeTruthy();
  });

  it("names the loading button in the interface language", async () => {
    vi.spyOn(window.navigator, "languages", "get").mockReturnValue(["de-AT"]);
    stubServer(() => new Promise<Response>(() => undefined));
    window.history.replaceState(null, "", "/login");
    const App = createWebApp({ extensions: [] });
    await renderApp(<App />);
    await screen.findByRole("heading", { level: 1, name: "Anmelden" });
    typeInto("E-Mail", "ada@example.org");
    typeInto("Passwort", "correct horse");

    await act(async () => {
      fireEvent.submit(screen.getByRole("button", { name: /^Anmelden/ }).closest("form") ?? document.body);
      await Promise.resolve();
    });

    const button = screen.getByRole("button", { name: /^Anmelden\s?Wird geladen$/ });
    expect(button.hasAttribute("data-loading")).toBe(true);
    expect(screen.queryByText("Loading")).toBeNull();
  });

  it("abandons the request when the page goes away", async () => {
    let signal: AbortSignal | undefined;
    stubServer((request) => {
      signal = request.signal;
      return new Promise<Response>(() => undefined);
    });
    const { unmount } = await (async () => {
      window.history.replaceState(null, "", "/login");
      const App = createWebApp({ extensions: [] });
      const rendered = await renderApp(<App />);
      await screen.findByRole("heading", { level: 1, name: "Sign in" });
      return rendered;
    })();
    await signInWith();
    await waitFor(() => {
      expect(signal).toBeDefined();
    });
    expect(signal?.aborted).toBe(false);

    unmount();

    expect(signal?.aborted).toBe(true);
  });
});

describe("the password toggle", () => {
  it("shows what was typed and hides it again", async () => {
    stubServer(done);
    await openLogin();
    typeInto("Password", "correct horse");

    fireEvent.click(screen.getByRole("button", { name: "Show password" }));

    expect(screen.getByLabelText<HTMLInputElement>("Password").type).toBe("text");
    expect(screen.getByLabelText<HTMLInputElement>("Password").value).toBe("correct horse");
    fireEvent.click(screen.getByRole("button", { name: "Hide password" }));
    expect(screen.getByLabelText<HTMLInputElement>("Password").type).toBe("password");
  });
});

describe("the sign-in page with instance settings", () => {
  function serveConfig(instance: unknown): void {
    vi.stubGlobal(
      "fetch",
      vi.fn<Transport>((request) => {
        const { pathname } = new URL(request.url);
        if (pathname === "/api/config") {
          return Promise.resolve(json({ ...CONFIG_BODY, instance }));
        }
        return pathname === SESSION_PATH ? Promise.resolve(problem(401, "unauthenticated", "req-session")) : signedIn(request);
      }),
    );
  }

  it("shows the instance name the admin set beside the mark and in the description", async () => {
    serveConfig({ displayName: "Acme Links", signInNotice: null });
    await openLogin();

    const main = screen.getByRole("main");
    expect(within(main).getByText("Acme Links")).toBeTruthy();
    expect(within(main).getByText("Sign in to Acme Links.")).toBeTruthy();
    expect(within(main).queryByText(PRODUCT_NAME)).toBeNull();
    expect(screen.queryByRole("note")).toBeNull();
  });

  it("shows the notice as text only: markup in it is not rendered, and its line breaks stay", async () => {
    const notice = 'Planned maintenance <b>Friday</b>\n<img src=x onerror="alert(1)"><script>alert(2)</script>';
    serveConfig({ displayName: PRODUCT_NAME, signInNotice: notice });
    await openLogin();

    const note = screen.getByRole("note");
    expect(note.textContent).toBe(notice);
    expect(note.querySelector("b, img, script")).toBeNull();
    expect(document.querySelector("main img, main script")).toBeNull();
    expect(within(screen.getByRole("main")).getByText(PRODUCT_NAME)).toBeTruthy();
  });

  it("shows no notice for a blank one", async () => {
    serveConfig({ displayName: PRODUCT_NAME, signInNotice: "  \n " });
    await openLogin();

    expect(screen.queryByRole("note")).toBeNull();
  });
});

describe("coming back from a /go address (doc 04 section 9.3)", () => {
  it("goes back to /go/<slug> with a request to the server, which forwards it, not with the router", async () => {
    stubServer(done);
    await openLogin(`/login?returnTo=${encodeURIComponent("/go/mail")}`);

    await signInWith();

    await waitFor(() => {
      expect(navigateTo).toHaveBeenCalledExactlyOnceWith("/go/mail");
    });
    expect(window.location.pathname).toBe("/login");
  });

  it.each([
    "https://evil.example",
    "https://evil.example/go/mail",
    "//evil.example",
    "//evil.example/go/mail",
    "/\\evil.example",
    "/go/../admin",
    "/go/mail/..%2fadmin",
    "javascript:alert(1)",
    "/go/Mail",
    "/go/-mail",
    "/go/mail/inbox",
    "/go/mail?next=/admin",
    "/go/mail#x",
    "/go/%2e%2e",
    "/go/ma%20il",
    `/go/${"a".repeat(65)}`,
    "/go/",
    "/go",
    "/settings/account/security",
  ])("ignores the return address %j and lands on the default page", async (returnTo) => {
    stubServer(done);
    await openLogin(`/login?returnTo=${encodeURIComponent(returnTo)}`);

    await signInWith();

    expect(await screen.findByRole("heading", { level: 1, name: `Welcome to ${PRODUCT_NAME}` })).toBeTruthy();
    expect(window.location.pathname).toBe("/");
    expect(window.location.hostname).toBe("localhost");
    expect(navigateTo).not.toHaveBeenCalled();
  });

  it("goes to the /go address of a `next` too, with a request to the server", async () => {
    stubServer(done);
    await openLogin(`/login?next=${encodeURIComponent("/go/mail")}`);

    await signInWith();

    await waitFor(() => {
      expect(navigateTo).toHaveBeenCalledExactlyOnceWith("/go/mail");
    });
  });
});
