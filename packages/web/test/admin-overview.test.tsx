import type { ComponentTypes } from "@slugbase/contracts";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { axe } from "vitest-axe";
import { createWebApp } from "../src/index.ts";
import { ACCOUNT_BODY, ME_PATH, json, meOf, problem, renderApp, signedIn, stubBrowserApis, stubMatchMedia } from "./support.tsx";

// /admin (doc 03 section 12): the sidebar item and the pages are for an instance admin only, an admin without a second
// factor gets the banner and no request for the status, and the overview shows the status the server answers. The failure
// scenarios are an account that is not an admin reaching the area, an area shown while the account cannot be loaded, an
// admin without a second factor asking for the status, and a failed status request shown as zeros or "not configured".

type Transport = (request: Request) => Promise<Response>;
type InstanceStatus = ComponentTypes["schemas"]["InstanceStatus"];

const STATUS_PATH = "/api/v1/instance/status";

const STATUS: InstanceStatus = {
  version: "1.4.2",
  migrations: { expected: 12, applied: 12 },
  ports: { mail: true, ai: false, errorReporting: false },
  oidcProviders: [{ slug: "corp", name: "Corp SSO" }],
  signIn: { publicRegistration: false, emailVerificationRequired: true },
  counts: { accounts: 1204, workspaces: 87, activeSessions: 312 },
  jobs: { queueDepth: 3, failed: 0 },
};

interface ServerOptions {
  isInstanceAdmin?: boolean;
  mfaEnabled?: boolean;
  /** The answers to `GET /instance/status`, one per call; the last one repeats. */
  status?: readonly (() => Response)[];
  /** The answer to `GET /me`, in place of the account. */
  me?: () => Response;
}

function stubServer({ isInstanceAdmin = true, mfaEnabled = true, status = [() => json(STATUS)], me }: ServerOptions = {}): { statusCalls: () => number } {
  let statusCalls = 0;
  const account = { ...ACCOUNT_BODY, isInstanceAdmin, mfaEnabled };
  vi.stubGlobal(
    "fetch",
    vi.fn<Transport>((request) => {
      const { pathname } = new URL(request.url);
      if (pathname === ME_PATH && request.method === "GET" && me !== undefined) {
        return Promise.resolve(me());
      }
      if (pathname === ME_PATH && request.method === "GET") {
        return Promise.resolve(json(meOf(account)));
      }
      return signedIn(request, () => {
        if (pathname === STATUS_PATH) {
          statusCalls += 1;
          return Promise.resolve((status[Math.min(statusCalls, status.length) - 1] ?? (() => problem(500, "internal", "req-500")))());
        }
        return Promise.resolve(problem(404, "not_found", "req-404"));
      });
    }),
  );
  return { statusCalls: () => statusCalls };
}

async function open(path: string): Promise<void> {
  window.history.replaceState(null, "", path);
  const App = createWebApp({ extensions: [] });
  await renderApp(<App />);
}

function sidebar(): HTMLElement {
  return screen.getByRole("navigation", { name: "Main navigation" });
}

async function violations(): Promise<string[]> {
  const results = await axe(document.body, { rules: { region: { enabled: false } } });
  return results.violations.map((violation) => `${violation.id}: ${violation.help}`);
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

describe("the Admin sidebar item", () => {
  it("is shown to an instance admin and leads to the overview", async () => {
    stubServer();
    await open("/");
    await screen.findByRole("heading", { level: 1, name: /^Welcome to/ });

    const item = within(sidebar()).getByRole("link", { name: "Admin" });
    expect(item.getAttribute("href")).toBe("/admin");
    fireEvent.click(item);

    expect(await screen.findByRole("heading", { level: 1, name: "Overview" })).toBeTruthy();
    expect(window.location.pathname).toBe("/admin");
  });

  it("is not shown to an account that is not an instance admin", async () => {
    stubServer({ isInstanceAdmin: false });
    await open("/");
    await screen.findByRole("heading", { level: 1, name: /^Welcome to/ });

    expect(within(sidebar()).queryByRole("link", { name: "Admin" })).toBeNull();
  });
});

describe("the admin area for an account that is not an instance admin", () => {
  it.each(["/admin", "/admin/workspaces", "/admin/accounts", "/admin/settings"])("shows the 403 page on %s and asks for nothing", async (path) => {
    const server = stubServer({ isInstanceAdmin: false });
    await open(path);

    const main = await screen.findByRole("main");
    expect(await within(main).findByRole("heading", { level: 1, name: "You don't have access" })).toBeTruthy();
    expect(screen.queryByRole("navigation", { name: "Administration" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Overview" })).toBeNull();
    expect(server.statusCalls()).toBe(0);
  });

  it("does not show the area while the account cannot be loaded", async () => {
    const server = stubServer({ me: () => problem(403, "forbidden", "req-me") });
    await open("/admin");

    expect(await screen.findByText("Your account could not be loaded")).toBeTruthy();
    expect(screen.queryByRole("navigation", { name: "Administration" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Overview" })).toBeNull();
    expect(screen.queryByText("You don't have access")).toBeNull();
    expect(server.statusCalls()).toBe(0);
  });
});

describe("the admin navigation", () => {
  it("lists Overview, Workspaces, Accounts and Settings & status, with the page being shown marked", async () => {
    stubServer();
    await open("/admin");

    const nav = await screen.findByRole("navigation", { name: "Administration" });
    expect(within(nav).getAllByRole("link").map((link) => [link.textContent, link.getAttribute("href")])).toEqual([
      ["Overview", "/admin"],
      ["Workspaces", "/admin/workspaces"],
      ["Accounts", "/admin/accounts"],
      ["Settings & status", "/admin/settings"],
    ]);
    expect(within(nav).getByRole("link", { name: "Overview" }).getAttribute("aria-current")).toBe("page");

    fireEvent.click(within(nav).getByRole("link", { name: "Accounts" }));

    await waitFor(() => {
      expect(within(screen.getByRole("navigation", { name: "Administration" })).getByRole("link", { name: "Accounts" }).getAttribute("aria-current")).toBe("page");
    });
    expect(window.location.pathname).toBe("/admin/accounts");
  });

  it("becomes a select of the same pages on a narrow screen", async () => {
    stubMatchMedia(true);
    stubServer();
    await open("/admin");

    expect(await screen.findByRole("combobox", { name: "Administration" })).toBeTruthy();
    expect(screen.queryByRole("navigation", { name: "Administration" })).toBeNull();
  });
});

describe("an admin without two-factor authentication", () => {
  it.each(["/admin", "/admin/workspaces", "/admin/accounts", "/admin/settings"])(
    "sees the banner on %s, with the way to the security page, and the status is not requested",
    async (path) => {
      const server = stubServer({ mfaEnabled: false });
      await open(path);

      expect(await screen.findByText("Two-factor authentication required")).toBeTruthy();
      const link = screen.getByRole("link", { name: "Set up two-factor authentication" });
      expect(link.getAttribute("href")).toBe("/settings/account/security");
      expect(server.statusCalls()).toBe(0);
    },
  );

  it("sees the overview unavailable instead of the status", async () => {
    stubServer({ mfaEnabled: false });
    await open("/admin");

    expect(await screen.findByRole("heading", { name: "The overview is not available yet" })).toBeTruthy();
    expect(screen.queryByText("Accounts", { selector: "p" })).toBeNull();
    expect(screen.queryByText("Not configured")).toBeNull();
  });

  it("does not see the banner once the account has a second factor", async () => {
    stubServer({ mfaEnabled: true });
    await open("/admin");

    await screen.findByText("1.4.2");
    expect(screen.queryByText("Two-factor authentication required")).toBeNull();
  });
});

describe("the overview", () => {
  it("shows the counts, the version, the migration level, the job health and the configuration from the status", async () => {
    const server = stubServer();
    await open("/admin");

    expect(await screen.findByText("1,204")).toBeTruthy();
    const counts = screen.getByRole("region", { name: "Counts" });
    expect(within(counts).getByText("Accounts")).toBeTruthy();
    expect(within(counts).getByText("87")).toBeTruthy();
    expect(within(counts).getByText("Active sessions")).toBeTruthy();
    expect(within(counts).getByText("312")).toBeTruthy();
    expect(screen.getByText("1.4.2")).toBeTruthy();
    expect(screen.getByText("12 of 12 applied")).toBeTruthy();
    expect(screen.getByText("Up to date")).toBeTruthy();
    expect(screen.getByText("3 jobs")).toBeTruthy();

    const row = (label: string): HTMLElement => (screen.getByText(label).closest("div") as HTMLElement);
    expect(within(row("Failed jobs")).getByText("None")).toBeTruthy();
    expect(within(row("Public registration")).getByText("Off")).toBeTruthy();
    expect(within(row("Email verification required")).getByText("On")).toBeTruthy();
    expect(within(row("Mail")).getByText("Configured")).toBeTruthy();
    expect(within(row("AI suggestions")).getByText("Not configured")).toBeTruthy();
    expect(within(row("Sign-in providers")).getByText("Corp SSO")).toBeTruthy();
    expect(within(row("Error reporting")).getByText("Not configured")).toBeTruthy();
    expect(server.statusCalls()).toBe(1);
  });

  it("flags failed jobs, an out-of-date database and no sign-in providers", async () => {
    stubServer({
      status: [
        () =>
          json({
            ...STATUS,
            migrations: { expected: 12, applied: 10 },
            jobs: { queueDepth: 1, failed: 4 },
            oidcProviders: [],
          } satisfies InstanceStatus),
      ],
    });
    await open("/admin");

    const row = (label: string): HTMLElement => (screen.getByText(label).closest("div") as HTMLElement);
    expect(await screen.findByText("10 of 12 applied")).toBeTruthy();
    expect(screen.getByText("Out of date")).toBeTruthy();
    expect(within(row("Failed jobs")).getByText("4 failed").className).toContain("text-destructive-foreground");
    expect(within(row("Sign-in providers")).getByText("None")).toBeTruthy();
    expect(screen.getByText("1 job")).toBeTruthy();
  });

  it("waits with a loading state for the status", async () => {
    let answer: (response: Response) => void = () => undefined;
    const pending = new Promise<Response>((resolve) => {
      answer = resolve;
    });
    stubServer({ status: [() => ({ then: pending.then.bind(pending) }) as unknown as Response] });
    await open("/admin");

    expect(await screen.findByRole("status", { name: "Loading" })).toBeTruthy();
    expect(screen.queryByText("Not configured")).toBeNull();
    answer(json(STATUS));

    expect(await screen.findByText("1,204")).toBeTruthy();
    expect(screen.queryByRole("status", { name: "Loading" })).toBeNull();
  });

  it("shows an error, not zeros or 'not configured', when the status cannot be loaded, and loads it on retry", async () => {
    const server = stubServer({ status: [() => problem(403, "forbidden", "req-403"), () => json(STATUS)] });
    await open("/admin");

    expect(await screen.findByText("The status of the instance could not be loaded")).toBeTruthy();
    expect(screen.queryByText("Not configured")).toBeNull();
    expect(screen.queryByText("0")).toBeNull();
    expect(screen.getByRole("alert")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByText("1,204")).toBeTruthy();
    expect(screen.queryByText("The status of the instance could not be loaded")).toBeNull();
    expect(server.statusCalls()).toBe(2);
  });

  it.each(["light", "dark"] as const)("has no axe violations at tablet width in the %s theme", async (theme) => {
    stubServer();
    await open("/admin");
    await screen.findByText("1,204");
    document.documentElement.classList.toggle("dark", theme === "dark");

    expect(await violations()).toEqual([]);
  });

  it("has no axe violations while the banner and the unavailable overview show", async () => {
    stubServer({ mfaEnabled: false });
    await open("/admin");
    await screen.findByRole("heading", { name: "The overview is not available yet" });

    expect(await violations()).toEqual([]);
  });
});
