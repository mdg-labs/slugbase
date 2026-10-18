import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWebApp } from "../src/index.ts";
import { ACCOUNT_BODY, CONFIG_BODY, ME_PATH, SESSION_BODY, SESSION_PATH, json, problem, renderApp, stubBrowserApis, stubMatchMedia } from "./support.tsx";

// The email row of /settings/account and the two pages the emailed links open (doc 03 sections 1.7 and 11.1, doc 02
// section 2.6) over a stubbed transport. The failure scenarios are a link that is redeemed twice, an answer that tells
// whether an address is taken, a change that stays "pending" after it was cancelled, a browser that still looks
// signed in after the "this wasn't me" link ended every session, and a change asked for on a server that cannot send
// the link.

const REQUEST_PATH = "/api/v1/me/email";
const CONFIRM_PATH = "/api/v1/me/email/confirm";
const CANCEL_PATH = "/api/v1/me/email/cancel";
const PENDING_PATH = "/api/v1/me/email/pending";
const REAUTH_PATH = "/api/v1/me/reauth";

type Transport = (request: Request) => Response | Promise<Response>;

interface Call {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
}

interface Server {
  readonly calls: Call[];
  readonly to: (method: string, path: string) => Call[];
  readonly pending: () => string | null;
  /** Holds back the answers to the account request until the returned function is called. */
  readonly holdAccount: () => () => void;
}

interface ServerOptions {
  readonly pending?: string | null;
  /** Whether the server can send email (`features.mail`); on unless a test says otherwise. */
  readonly mail?: boolean;
  readonly request?: (call: number) => Response | Promise<Response>;
  readonly cancelPending?: Transport;
  readonly confirm?: (call: number) => Response | Promise<Response>;
  readonly cancel?: (call: number) => Response | Promise<Response>;
}

const noContent = (): Response => new Response(null, { status: 204 });
const accepted = (): Response => new Response(null, { status: 202 });

function withErrors(status: number, code: string, errors: readonly { path: string; code: string }[]): Response {
  return json(
    { type: `https://slugbase.app/problems/${code}`, title: code, status, code, detail: "x", requestId: "req-422", errors },
    { status, contentType: "application/problem+json" },
  );
}

function rateLimited(seconds: number): Response {
  return new Response(JSON.stringify({ type: "t", title: "rate_limited", status: 429, code: "rate_limited", detail: "d", requestId: "r" }), {
    status: 429,
    headers: { "Content-Type": "application/problem+json", "Retry-After": String(seconds) },
  });
}

/** A server with a signed-in account that holds the pending address it was asked for; the "this wasn't me" link ends the session. */
function stubServer({ pending = null, mail = true, request, cancelPending, confirm, cancel }: ServerOptions = {}): Server {
  let held = pending;
  let signedOut = false;
  let gate: Promise<void> | undefined;
  // The account chose the language of the browser, so a test that opens the app in German sees German.
  const locale = globalThis.navigator.languages.some((language) => language.toLowerCase().startsWith("de")) ? "de" : "en";
  const calls: Call[] = [];
  vi.stubGlobal("fetch", async (incoming: Request) => {
    const { pathname } = new URL(incoming.url);
    const text = await incoming.clone().text();
    calls.push({ method: incoming.method, path: pathname, body: text === "" ? undefined : (JSON.parse(text) as unknown) });
    const count = calls.filter((call) => call.path === pathname).length;
    switch (pathname) {
      case "/api/config":
        return json({ ...CONFIG_BODY, features: { ...CONFIG_BODY.features, mail } });
      case SESSION_PATH:
        return signedOut ? problem(401, "unauthenticated", "req-session") : json(SESSION_BODY);
      case ME_PATH:
        await gate;
        return signedOut
          ? problem(401, "unauthenticated", "req-me")
          : json({ account: { ...ACCOUNT_BODY, locale, pendingEmail: held }, memberships: [], activeWorkspaceId: null });
      case REAUTH_PATH:
        return noContent();
      case REQUEST_PATH: {
        const response = request === undefined ? accepted() : await request(count);
        if (response.status === 202) {
          held = (JSON.parse(text) as { email: string }).email;
        }
        return response;
      }
      case PENDING_PATH: {
        const response = cancelPending === undefined ? noContent() : await cancelPending(incoming);
        if (response.ok) {
          held = null;
        }
        return response;
      }
      case CONFIRM_PATH:
        return confirm === undefined ? noContent() : confirm(count);
      case CANCEL_PATH: {
        const response = cancel === undefined ? noContent() : await cancel(count);
        signedOut ||= response.ok;
        return response;
      }
      default:
        throw new Error(`unexpected call ${incoming.method} ${pathname}`);
    }
  });
  return {
    calls,
    to: (method, path) => calls.filter((call) => call.method === method && call.path === path),
    pending: () => held,
    holdAccount: () => {
      let release: () => void = () => undefined;
      gate = new Promise<void>((resolve) => (release = resolve));
      return release;
    },
  };
}

async function act_(action: () => void): Promise<void> {
  await act(async () => {
    action();
    await Promise.resolve();
  });
}

async function openApp(address: string, heading: string | RegExp): Promise<void> {
  window.history.replaceState(null, "", address);
  const App = createWebApp({ extensions: [] });
  await renderApp(<App />);
  await screen.findByRole("heading", { level: 1, name: heading });
}

const openProfile = (): Promise<void> => openApp("/settings/account", "Profile");

/** Follows a link of an email from the page the app is on, the way a visitor who has the app open does. */
async function followLink(address: string): Promise<void> {
  await act_(() => {
    window.history.pushState(null, "", address);
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
}

async function openChangeForm(): Promise<HTMLElement> {
  await act_(() => {
    fireEvent.click(screen.getByRole("button", { name: "Change email" }));
  });
  return screen.findByRole("dialog", { name: "Change your email address" });
}

async function sendRequest(dialog: HTMLElement, address: string): Promise<void> {
  fireEvent.change(within(dialog).getByLabelText("New email address"), { target: { value: address } });
  await act_(() => {
    fireEvent.click(within(dialog).getByRole("button", { name: "Send confirmation link" }));
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

describe("the email row of the profile", () => {
  it("shows the address and no pending change by default", async () => {
    stubServer();
    await openProfile();

    expect(screen.getByRole<HTMLInputElement>("textbox", { name: "Email" }).value).toBe("ada@example.org");
    expect(screen.getByRole("button", { name: "Change email" })).toBeTruthy();
    expect(screen.queryByText("Pending verification")).toBeNull();
    expect(screen.queryByRole("button", { name: "Resend link" })).toBeNull();
  });

  it("sends the trimmed address, closes the form and shows the change as pending", async () => {
    const server = stubServer();
    await openProfile();
    const dialog = await openChangeForm();

    await sendRequest(dialog, "  ada@new.example  ");

    expect(server.to("POST", REQUEST_PATH).map((call) => call.body)).toEqual([{ email: "ada@new.example" }]);
    expect(await screen.findByText("Pending verification")).toBeTruthy();
    expect(screen.getByText(/A confirmation link was requested for ada@new\.example\./)).toBeTruthy();
    expect(screen.getAllByText("Check ada@new.example for the confirmation link.").length).toBeGreaterThan(0);
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Change your email address" })).toBeNull();
    });
    // The current address stays until the link is confirmed.
    expect(screen.getByRole<HTMLInputElement>("textbox", { name: "Email" }).value).toBe("ada@example.org");
  });

  it("does not submit the profile form behind the overlay", async () => {
    const server = stubServer();
    await openProfile();
    // An unsaved edit makes the profile form submittable, so a submit that reached it would save the profile.
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "Ada King" } });
    const dialog = await openChangeForm();

    await sendRequest(dialog, "ada@new.example");

    expect(server.to("POST", REQUEST_PATH)).toHaveLength(1);
    expect(server.to("PATCH", ME_PATH)).toEqual([]);
  });

  it("asks for the password through the shared prompt and sends the request again once", async () => {
    const server = stubServer({ request: (call) => (call === 1 ? problem(401, "reauth_required", "req-reauth") : accepted()) });
    await openProfile();
    const dialog = await openChangeForm();

    await sendRequest(dialog, "ada@new.example");

    const prompt = await screen.findByRole("dialog", { name: "Confirm it is you" });
    fireEvent.change(within(prompt).getByLabelText("Password"), { target: { value: "old password 1" } });
    await act_(() => {
      fireEvent.click(within(prompt).getByRole("button", { name: "Confirm" }));
    });

    expect(await screen.findByText("Pending verification")).toBeTruthy();
    expect(server.to("POST", REAUTH_PATH).map((call) => call.body)).toEqual([{ password: "old password 1" }]);
    expect(server.to("POST", REQUEST_PATH).map((call) => call.body)).toEqual([{ email: "ada@new.example" }, { email: "ada@new.example" }]);
  });

  it("keeps the form and says so when the prompt is closed without confirming", async () => {
    const server = stubServer({ request: () => problem(401, "reauth_required", "req-reauth") });
    await openProfile();
    const dialog = await openChangeForm();
    await sendRequest(dialog, "ada@new.example");
    const prompt = await screen.findByRole("dialog", { name: "Confirm it is you" });

    await act_(() => {
      fireEvent.click(within(prompt).getByRole("button", { name: "Cancel" }));
    });

    expect(await screen.findByText("Confirm it is you to continue.")).toBeTruthy();
    expect(screen.getByRole("dialog", { name: "Change your email address" })).toBeTruthy();
    expect(server.to("POST", REQUEST_PATH)).toHaveLength(1);
    expect(screen.queryByText("Pending verification")).toBeNull();
  });

  it("refuses an empty address and the current one without a request", async () => {
    const server = stubServer();
    await openProfile();
    const dialog = await openChangeForm();

    await act_(() => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Send confirmation link" }));
    });
    expect(await within(dialog).findByText("Enter the new email address.")).toBeTruthy();

    await sendRequest(dialog, "ADA@example.org");
    expect(await within(dialog).findByText("That is already your email address.")).toBeTruthy();
    expect(server.to("POST", REQUEST_PATH)).toEqual([]);
  });

  it("shows the field error of a refused address", async () => {
    stubServer({ request: () => withErrors(422, "validation_failed", [{ path: "email", code: "invalid_format" }]) });
    await openProfile();
    const dialog = await openChangeForm();

    await sendRequest(dialog, "not-an-address");

    expect(await within(dialog).findByText("Enter a valid email address.")).toBeTruthy();
    expect(screen.queryByText("Pending verification")).toBeNull();
  });

  it("tells how long to wait when the server rate limits the request", async () => {
    stubServer({ request: () => rateLimited(120) });
    await openProfile();
    const dialog = await openChangeForm();

    await sendRequest(dialog, "ada@new.example");

    expect(await within(dialog).findByText("Too many attempts. Try again in 2 minutes.")).toBeTruthy();
    expect(screen.queryByText("Pending verification")).toBeNull();
  });

  it("reports a failed request instead of closing the form", async () => {
    stubServer({ request: () => problem(503, "service_unavailable", "req-503") });
    await openProfile();
    const dialog = await openChangeForm();

    await sendRequest(dialog, "ada@new.example");

    expect(await within(dialog).findByText("That did not work. Try again in a moment.")).toBeTruthy();
    expect(screen.queryByText("Pending verification")).toBeNull();
  });

  it("answers an address that another account holds like any other, with nothing that says it is taken", async () => {
    // The server answers 202 for every address (doc 04 section 10.3), so the page can only show what it shows for a free one.
    const server = stubServer();
    await openProfile();
    const dialog = await openChangeForm();

    await sendRequest(dialog, "grace@example.org");

    expect(await screen.findByText("Pending verification")).toBeTruthy();
    expect(server.to("POST", REQUEST_PATH)).toHaveLength(1);
    expect(document.body.textContent).not.toMatch(/taken|in use|already (has|exists)|exists/i);
  });

  it("offers no change, and tells the member to ask the instance admin, when the server cannot send email", async () => {
    const server = stubServer({ mail: false });
    await openProfile();

    expect(screen.getByRole<HTMLInputElement>("textbox", { name: "Email" }).value).toBe("ada@example.org");
    expect(screen.getByText("Changing your email needs a confirmation link, and this server cannot send email. Ask your instance admin to set up email.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Change email" })).toBeNull();
    expect(server.to("POST", REQUEST_PATH)).toEqual([]);
  });

  it("works at phone width", async () => {
    stubMatchMedia(true);
    const server = stubServer();
    await openProfile();
    const dialog = await openChangeForm();

    await sendRequest(dialog, "ada@new.example");

    expect(await screen.findByText("Pending verification")).toBeTruthy();
    expect(server.to("POST", REQUEST_PATH)).toHaveLength(1);
  });

  describe("while a change is pending", () => {
    it("shows the badge, the pending address, Resend and Cancel", async () => {
      stubServer({ pending: "ada@new.example" });
      await openProfile();

      expect(await screen.findByText("Pending verification")).toBeTruthy();
      expect(screen.getByText(/A confirmation link was requested for ada@new\.example\./)).toBeTruthy();
      expect(screen.getByRole("button", { name: "Resend link" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "Cancel change" })).toBeTruthy();
    });

    it("offers only Cancel, and says why, when the server cannot send email", async () => {
      const server = stubServer({ pending: "ada@new.example", mail: false });
      await openProfile();

      expect(await screen.findByText("Pending verification")).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Resend link" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Change email" })).toBeNull();
      expect(screen.getByText(/this server cannot send email/)).toBeTruthy();

      fireEvent.click(screen.getByRole("button", { name: "Cancel change" }));

      await waitFor(() => {
        expect(screen.queryByText("Pending verification")).toBeNull();
      });
      expect(server.to("DELETE", PENDING_PATH)).toHaveLength(1);
    });

    it("sends the pending address again on Resend, with the shared prompt for the password", async () => {
      const server = stubServer({
        pending: "ada@new.example",
        request: (call) => (call === 1 ? problem(401, "reauth_required", "req-reauth") : accepted()),
      });
      await openProfile();
      await screen.findByText("Pending verification");

      await act_(() => {
        fireEvent.click(screen.getByRole("button", { name: "Resend link" }));
      });
      const prompt = await screen.findByRole("dialog", { name: "Confirm it is you" });
      fireEvent.change(within(prompt).getByLabelText("Password"), { target: { value: "old password 1" } });
      await act_(() => {
        fireEvent.click(within(prompt).getByRole("button", { name: "Confirm" }));
      });

      expect((await screen.findAllByText("Check ada@new.example for the confirmation link.")).length).toBeGreaterThan(0);
      expect(server.to("POST", REQUEST_PATH).map((call) => call.body)).toEqual([{ email: "ada@new.example" }, { email: "ada@new.example" }]);
      expect(screen.getByText("Pending verification")).toBeTruthy();
    });

    it("reports a Resend that failed", async () => {
      stubServer({ pending: "ada@new.example", request: () => rateLimited(30) });
      await openProfile();
      await screen.findByText("Pending verification");

      await act_(() => {
        fireEvent.click(screen.getByRole("button", { name: "Resend link" }));
      });

      expect((await screen.findAllByText("Too many attempts. Try again in 30 seconds.")).length).toBeGreaterThan(0);
    });

    it("cancels the change and drops the badge", async () => {
      const server = stubServer({ pending: "ada@new.example" });
      await openProfile();
      await screen.findByText("Pending verification");

      await act_(() => {
        fireEvent.click(screen.getByRole("button", { name: "Cancel change" }));
      });

      await waitFor(() => {
        expect(screen.queryByText("Pending verification")).toBeNull();
      });
      expect(server.to("DELETE", PENDING_PATH)).toHaveLength(1);
      expect(server.pending()).toBeNull();
      expect((await screen.findAllByText("Email change cancelled")).length).toBeGreaterThan(0);
    });

    it("keeps the badge and says so when the cancellation failed", async () => {
      stubServer({ pending: "ada@new.example", cancelPending: () => problem(503, "service_unavailable", "req-503") });
      await openProfile();
      await screen.findByText("Pending verification");

      await act_(() => {
        fireEvent.click(screen.getByRole("button", { name: "Cancel change" }));
      });

      expect((await screen.findAllByText("That did not work. Try again in a moment.")).length).toBeGreaterThan(0);
      expect(screen.getByText("Pending verification")).toBeTruthy();
      expect(screen.queryByText("Email change cancelled")).toBeNull();
    });
  });

  it("is in German for a German browser", async () => {
    vi.spyOn(window.navigator, "languages", "get").mockReturnValue(["de-DE", "de"]);
    stubServer({ pending: "ada@new.example" });
    window.history.replaceState(null, "", "/settings/account");
    const App = createWebApp({ extensions: [] });
    await renderApp(<App />);
    await screen.findByRole("heading", { level: 1, name: "Profil" });

    expect(await screen.findByText("Bestätigung ausstehend")).toBeTruthy();
    expect(screen.getByRole("button", { name: "E-Mail ändern" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Link erneut senden" })).toBeTruthy();
  });
});

describe("the confirmation page", () => {
  it("redeems the token from the fragment once and says the address was changed", async () => {
    const server = stubServer();
    await openApp("/email-change/confirm#token=abc123", "Confirm your new email address");

    expect(await screen.findByRole("heading", { name: "Your email address was changed" })).toBeTruthy();
    expect(server.to("POST", CONFIRM_PATH).map((call) => call.body)).toEqual([{ token: "abc123" }]);
    expect(screen.getByRole("link", { name: "Open the app" }).getAttribute("href")).toBe("/");
  });

  it("does not send the token anywhere but the body of the request", async () => {
    const server = stubServer();
    await openApp("/email-change/confirm#token=abc123", "Confirm your new email address");
    await screen.findByRole("heading", { name: "Your email address was changed" });

    expect(server.calls.every((call) => !call.path.includes("abc123"))).toBe(true);
  });

  it("shows one generic explanation for a used, expired or unknown token", async () => {
    stubServer({ confirm: () => problem(410, "token_expired", "req-410") });
    await openApp("/email-change/confirm#token=abc123", "Confirm your new email address");

    expect(await screen.findByText("This link is not valid or has expired")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Go to sign in" }).getAttribute("href")).toBe("/login");
    expect(document.body.textContent).not.toMatch(/taken|in use|exists/i);
    expect(screen.queryByRole("heading", { name: "Your email address was changed" })).toBeNull();
  });

  it("shows the explanation without a request when the link carries no token", async () => {
    const server = stubServer();
    await openApp("/email-change/confirm", "Confirm your new email address");

    expect(await screen.findByText("This link is not valid or has expired")).toBeTruthy();
    expect(server.to("POST", CONFIRM_PATH)).toEqual([]);
  });

  it("shows a working state until the server answers", async () => {
    let answer: (response: Response) => void = () => undefined;
    const server = stubServer({ confirm: () => new Promise<Response>((resolve) => (answer = resolve)) });
    await openApp("/email-change/confirm#token=abc123", "Confirm your new email address");

    expect(screen.getByRole("status", { name: "Working on it" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Your email address was changed" })).toBeNull();
    await act_(() => {
      answer(noContent());
    });
    expect(await screen.findByRole("heading", { name: "Your email address was changed" })).toBeTruthy();
    expect(server.to("POST", CONFIRM_PATH)).toHaveLength(1);
  });

  it("offers another try after a failure that says nothing about the link, and redeems only once per try", async () => {
    const server = stubServer({ confirm: (call) => (call === 1 ? rateLimited(90) : noContent()) });
    await openApp("/email-change/confirm#token=abc123", "Confirm your new email address");

    expect(await screen.findByText("Too many attempts. Try again in 2 minutes.")).toBeTruthy();
    expect(server.to("POST", CONFIRM_PATH)).toHaveLength(1);

    await act_(() => {
      fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    });

    expect(await screen.findByRole("heading", { name: "Your email address was changed" })).toBeTruthy();
    expect(server.to("POST", CONFIRM_PATH)).toHaveLength(2);
  });

  it("reports a server failure with a way to try again", async () => {
    stubServer({ confirm: () => problem(503, "service_unavailable", "req-503") });
    await openApp("/email-change/confirm#token=abc123", "Confirm your new email address");

    expect(await screen.findByText("This could not be completed right now. Try again in a moment.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("drops the cached account, which holds the old address, so the app asks the server for the new one", async () => {
    const server = stubServer();
    await openProfile();
    await followLink("/email-change/confirm#token=abc123");
    await screen.findByRole("heading", { name: "Your email address was changed" });
    const release = server.holdAccount();

    await followLink("/settings/account");

    // Nothing is shown for the account until the server has answered; a kept cache would show the old address at once.
    expect(screen.queryByRole("textbox", { name: "Email" })).toBeNull();
    await act_(release);
    expect(await screen.findByRole("textbox", { name: "Email" })).toBeTruthy();
  });

  it("is in German for a German browser", async () => {
    vi.spyOn(window.navigator, "languages", "get").mockReturnValue(["de-DE", "de"]);
    stubServer();
    await openApp("/email-change/confirm#token=abc123", "Bestätige deine neue E-Mail-Adresse");

    expect(await screen.findByRole("heading", { name: "Deine E-Mail-Adresse wurde geändert" })).toBeTruthy();
  });
});

describe("the page of the \"this wasn't me\" link", () => {
  it("redeems the token once and says every device was signed out", async () => {
    const server = stubServer();
    await openApp("/email-change/cancel#token=def456", "Cancel an email change");

    expect(await screen.findByRole("heading", { name: "The change was cancelled and you were signed out everywhere" })).toBeTruthy();
    expect(server.to("POST", CANCEL_PATH).map((call) => call.body)).toEqual([{ token: "def456" }]);
    expect(screen.getByRole("link", { name: "Sign in" }).getAttribute("href")).toBe("/login");
  });

  it("shows one generic explanation for a used, expired or unknown token", async () => {
    stubServer({ cancel: () => problem(410, "token_expired", "req-410") });
    await openApp("/email-change/cancel#token=def456", "Cancel an email change");

    expect(await screen.findByText("This link is not valid or has expired")).toBeTruthy();
    expect(screen.queryByText(/signed out everywhere/)).toBeNull();
  });

  it("shows the explanation without a request when the link carries no token", async () => {
    const server = stubServer();
    await openApp("/email-change/cancel#token=", "Cancel an email change");

    expect(await screen.findByText("This link is not valid or has expired")).toBeTruthy();
    expect(server.to("POST", CANCEL_PATH)).toEqual([]);
  });

  it("leaves nothing of the signed-in account behind: the app asks the server again and sends the visitor to sign in", async () => {
    const server = stubServer();
    await openProfile();
    // The profile put the signed-in account in the cache; the visitor now follows the link from the notice mail.
    await followLink("/email-change/cancel#token=def456");
    await screen.findByRole("heading", { name: "The change was cancelled and you were signed out everywhere" });
    // The account request stays unanswered, so only what the cache still holds could show the profile.
    server.holdAccount();

    await followLink("/settings/account");

    expect(await screen.findByRole("heading", { level: 1, name: "Sign in" })).toBeTruthy();
    expect(window.location.pathname).toBe("/login");
    expect(screen.queryByRole("heading", { level: 1, name: "Profile" })).toBeNull();
  });
});
