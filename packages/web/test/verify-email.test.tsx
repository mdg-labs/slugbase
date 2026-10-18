import { act, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWebApp } from "../src/index.ts";
import { tokenFromFragment } from "../src/auth/verify-token.ts";
import { SESSION_PATH, json, problem, renderApp, signedIn, stubBrowserApis, stubMatchMedia } from "./support.tsx";

type Transport = (request: Request) => Promise<Response>;

const VERIFY_PATH = "/api/v1/auth/verify-email";
const RESEND_PATH = "/api/v1/auth/verify-email/resend";
const PASSWORD = "correct horse battery staple";

interface Server {
  readonly verifications: () => Promise<unknown[]>;
  readonly resends: () => Promise<unknown[]>;
}

/** A server with nobody signed in until the verification is answered with `200`. */
function stubServer(
  verify: Transport,
  resend: Transport = () => Promise.resolve(new Response(null, { status: 202 })),
  sessionAfter: Transport = signedIn,
): Server {
  let signed = false;
  const verified: Request[] = [];
  const resent: Request[] = [];
  vi.stubGlobal("fetch", (request: Request) => {
    const { pathname } = new URL(request.url);
    if (pathname === VERIFY_PATH) {
      verified.push(request.clone());
      return verify(request).then((response) => {
        signed ||= response.ok;
        return response;
      });
    }
    if (pathname === RESEND_PATH) {
      resent.push(request.clone());
      return resend(request);
    }
    if (pathname === SESSION_PATH && !signed) {
      return Promise.resolve(problem(401, "unauthenticated", "req-session"));
    }
    return sessionAfter(request);
  });
  return {
    verifications: () => Promise.all(verified.map((request) => request.json() as Promise<unknown>)),
    resends: () => Promise.all(resent.map((request) => request.json() as Promise<unknown>)),
  };
}

const done = (): Promise<Response> => Promise.resolve(json({ next: "done" }));

async function openLink(address = "/verify-email#token=abc123"): Promise<void> {
  window.history.replaceState(null, "", address);
  const App = createWebApp({ extensions: [] });
  await renderApp(<App />);
  await screen.findByRole("heading", { level: 1 });
}

function typeInto(label: string, value: string): void {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

async function submit(): Promise<void> {
  await act(async () => {
    fireEvent.submit(screen.getByRole("button", { name: "Verify and sign in" }).closest("form") ?? document.body);
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

describe("the token of the link", () => {
  it.each([
    ["#token=abc", "abc"],
    ["token=abc", "abc"],
    ["#token=a%2Bb&other=1", "a+b"],
    ["#token=", undefined],
    ["#other=abc", undefined],
    ["", undefined],
    [`#token=${"x".repeat(257)}`, undefined],
  ])("is read from the fragment %s", (fragment, token) => {
    expect(tokenFromFragment(fragment)).toBe(token);
  });
});

describe("the verification page", () => {
  it("asks for the password the account signs in with", async () => {
    stubServer(done);
    await openLink();

    expect(screen.getByRole("heading", { level: 1, name: "Verify your email" })).toBeTruthy();
    expect(screen.getByLabelText<HTMLInputElement>("Password").autocomplete).toBe("new-password");
    typeInto("Password", PASSWORD);
    expect(screen.getByRole("meter", { name: "Password strength" })).toBeTruthy();
  });

  it("sends the token from the fragment with the password, signs in and goes home", async () => {
    const server = stubServer(done);
    await openLink();
    typeInto("Password", PASSWORD);

    await submit();

    expect(await screen.findByRole("heading", { level: 1, name: /^Welcome to / })).toBeTruthy();
    expect(await server.verifications()).toEqual([{ token: "abc123", password: PASSWORD }]);
    expect(window.location.pathname).toBe("/");
  });

  it("goes to the second step of the sign-in when the account has a second factor", async () => {
    stubServer(
      () => Promise.resolve(json({ next: "mfa" })),
      undefined,
      (request) => (new URL(request.url).pathname === "/api/config" ? signedIn(request) : Promise.resolve(problem(401, "mfa_required", "req-mfa"))),
    );
    await openLink();
    typeInto("Password", PASSWORD);

    await submit();

    await act(async () => {
      await Promise.resolve();
    });
    expect(window.location.pathname).toBe("/login/mfa");
  });

  it("asks for a password before sending anything", async () => {
    const server = stubServer(done);
    await openLink();

    await submit();

    expect(screen.getByText("Enter a password.")).toBeTruthy();
    expect(await server.verifications()).toEqual([]);
  });

  it.each([
    ["too_short", "Use at least 12 characters."],
    ["breached", "This password appears in a list of breached passwords. Choose a different one."],
  ])("shows a refused password (%s) next to the field and keeps the form", async (code, message) => {
    stubServer(() =>
      Promise.resolve(
        json(
          { type: "t", title: "weak", status: 422, code: "weak_password", detail: "d", requestId: "r", errors: [{ path: "password", code }] },
          { status: 422, contentType: "application/problem+json" },
        ),
      ),
    );
    await openLink();
    typeInto("Password", "short");

    await submit();

    expect(await screen.findByText(message)).toBeTruthy();
    expect(screen.getByLabelText("Password").getAttribute("aria-invalid")).toBe("true");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it.each([
    [() => problem(503, "unavailable", "req-1"), "Your address could not be verified right now. Try again in a moment."],
    [() => problem(422, "validation_failed", "req-1"), "Check your entries and try again."],
  ])("says what went wrong and keeps the form (%#)", async (answer, message) => {
    stubServer(() => Promise.resolve(answer()));
    await openLink();
    typeInto("Password", PASSWORD);

    await submit();

    expect((await screen.findByRole("alert")).textContent).toContain(message);
    expect(screen.getByRole("button", { name: "Verify and sign in" }).hasAttribute("data-loading")).toBe(false);
  });

  it("shows the wait of a rate-limited attempt", async () => {
    stubServer(
      () =>
        Promise.resolve(
          new Response(JSON.stringify({ type: "t", title: "rate_limited", status: 429, code: "rate_limited", detail: "d", requestId: "r" }), {
            status: 429,
            headers: { "Content-Type": "application/problem+json", "Retry-After": "30" },
          }),
        ),
    );
    await openLink();
    typeInto("Password", PASSWORD);

    await submit();

    expect((await screen.findByRole("alert")).textContent).toContain("Too many attempts. Try again in 30 seconds.");
  });

  it("is written in German", async () => {
    vi.spyOn(window.navigator, "languages", "get").mockReturnValue(["de-AT"]);
    stubServer(done);
    await openLink();

    expect(screen.getByRole("heading", { level: 1, name: "Bestätige deine E-Mail-Adresse" })).toBeTruthy();
  });
});

describe("an expired link", () => {
  async function resendFrom(address: string): Promise<void> {
    typeInto("Email", address);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Send the link again" }));
      await Promise.resolve();
    });
  }

  it("shows a banner with the way to ask for a new link when the server refuses the token", async () => {
    const server = stubServer(() => Promise.resolve(problem(410, "token_expired", "req-1")));
    await openLink();
    typeInto("Password", PASSWORD);

    await submit();

    expect(await screen.findByText("This link is not valid or has expired")).toBeTruthy();
    expect(screen.queryByLabelText("Password")).toBeNull();
    await resendFrom(" ada@example.org ");
    expect(await screen.findByText(/a new link is on its way/)).toBeTruthy();
    expect(await server.resends()).toEqual([{ email: "ada@example.org" }]);
  });

  it("is shown at once for an address without a token, and sends no verification", async () => {
    const server = stubServer(done);
    await openLink("/verify-email");

    expect(screen.getByText("This link is not valid or has expired")).toBeTruthy();
    expect(screen.queryByLabelText("Password")).toBeNull();
    expect(await server.verifications()).toEqual([]);
  });

  it("asks for the address before it resends", async () => {
    const server = stubServer(done);
    await openLink("/verify-email");

    await resendFrom("  ");

    expect(screen.getByText("Enter your email address.")).toBeTruthy();
    expect(await server.resends()).toEqual([]);
  });
});
