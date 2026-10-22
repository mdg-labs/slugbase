import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { useRouter } from "@tanstack/react-router";
import { useMutation } from "@tanstack/react-query";
import { use, type ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApiClient } from "../src/api/client.ts";
import { createWebApp, type WebExtension } from "../src/index.ts";
import { PRODUCT_NAME, problem, renderApp, signedIn, stubBrowserApis, stubMatchMedia } from "./support.tsx";

type Transport = (request: Request) => Promise<Response>;

const INTERNAL_DETAIL = "SELECT * FROM accounts WHERE email = 'a@example.org' at /srv/app/db.ts:42:7";

/** Answers `/api/config` and the session check of a signed-in visitor, and hands every other call to `other`. */
function stubApi(other: Transport = () => Promise.reject(new Error("unexpected call"))): void {
  vi.stubGlobal(
    "fetch",
    vi.fn<Transport>((request) => signedIn(request, other)),
  );
}

function pageAt(path: string, component: () => ReactElement | null): WebExtension {
  return { id: "fixture", routes: [{ path, component }] };
}

async function open(path: string, extensions: readonly WebExtension[] = []): Promise<void> {
  window.history.replaceState(null, "", path);
  const App = createWebApp({ extensions });
  await renderApp(<App />);
}

beforeEach(() => {
  stubBrowserApis();
  stubMatchMedia();
  vi.spyOn(window.navigator, "languages", "get").mockReturnValue(["en-US", "en"]);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  window.history.replaceState(null, "", "/");
});

afterEach(() => {
  vi.restoreAllMocks();
  document.documentElement.removeAttribute("lang");
});

describe("the 404 page", () => {
  it("is the catch-all inside the shell, with the way home", async () => {
    stubApi();
    await open("/no/such/page");

    const main = await screen.findByRole("main");
    expect(within(main).getByRole("heading", { level: 1, name: "This page doesn't exist" })).toBeTruthy();
    expect(screen.getByRole("navigation", { name: "Main navigation" })).toBeTruthy();
    const home = within(main).getByRole("link", { name: "Go home" });
    expect(home.getAttribute("href")).toBe("/");

    fireEvent.click(home);

    expect(await screen.findByRole("heading", { level: 1, name: `Welcome to ${PRODUCT_NAME}` })).toBeTruthy();
    expect(window.location.pathname).toBe("/");
  });

  it("does not take over a page an extension owns", async () => {
    stubApi();
    await open("/plan", [pageAt("/plan", () => <h1>Plan page</h1>)]);

    expect(await screen.findByRole("heading", { name: "Plan page" })).toBeTruthy();
    expect(screen.queryByText("This page doesn't exist")).toBeNull();
  });

  it("is written in German", async () => {
    vi.spyOn(window.navigator, "languages", "get").mockReturnValue(["de-AT"]);
    stubApi();
    await open("/no/such/page");

    expect(await screen.findByRole("heading", { level: 1, name: "Diese Seite gibt es nicht" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Zur Startseite" })).toBeTruthy();
  });
});

describe("the 403 page", () => {
  it("explains itself inside the shell, with the way home", async () => {
    stubApi();
    await open("/403");

    const main = await screen.findByRole("main");
    expect(within(main).getByRole("heading", { level: 1, name: "You don't have access" })).toBeTruthy();
    expect(within(main).getByText(/not a member of this workspace/)).toBeTruthy();
    expect(screen.getByRole("navigation", { name: "Main navigation" })).toBeTruthy();
    expect(within(main).getByRole("link", { name: "Go home" }).getAttribute("href")).toBe("/");
    expect(screen.queryByText("This page doesn't exist")).toBeNull();
  });

  it("is written in German", async () => {
    vi.spyOn(window.navigator, "languages", "get").mockReturnValue(["de-AT"]);
    stubApi();
    await open("/403");

    expect(await screen.findByRole("heading", { level: 1, name: "Du hast keinen Zugriff" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Zur Startseite" })).toBeTruthy();
  });
});

function Throws(): never {
  throw new Error(INTERNAL_DETAIL);
}

let pendingCall: Promise<unknown> = Promise.resolve();

function FailsWithProblem(): null {
  use(pendingCall);
  return null;
}

function failWithProblem(detail: string, requestId: string): void {
  stubApi(() => Promise.resolve(problem(500, "internal", requestId, detail)));
  pendingCall = createApiClient().GET("/version");
  pendingCall.catch(() => undefined);
}

describe("the 500 page", () => {
  it("replaces the app when a page throws, and renders none of the error", async () => {
    stubApi();
    await open("/boom", [pageAt("/boom", Throws)]);

    expect(await screen.findByRole("heading", { level: 1, name: "Something went wrong" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reload" })).toBeTruthy();
    expect(document.body.textContent).not.toContain("SELECT");
    expect(document.body.textContent).not.toContain("db.ts");
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("navigation")).toBeNull();
    expect(screen.getByRole("main")).toBeTruthy();
  });

  it("shows the request id of an API problem in a copyable mono field and nothing of its detail", async () => {
    stubApi();
    failWithProblem(INTERNAL_DETAIL, "req-9f3c");
    await open("/boom", [pageAt("/boom", FailsWithProblem)]);

    expect(await screen.findByRole("heading", { level: 1, name: "Something went wrong" })).toBeTruthy();
    const field = screen.getByRole<HTMLInputElement>("textbox", { name: "Request ID" });
    expect(field.value).toBe("req-9f3c");
    expect(field.readOnly).toBe(true);
    expect(field.closest("[data-slot='input-control']")?.className).toContain("font-mono");
    expect(document.body.textContent).not.toContain("SELECT");
    expect(document.body.textContent).not.toContain("db.ts");
    expect(document.body.textContent).not.toContain("internal");
    expect(Array.from(document.querySelectorAll("input")).map((input) => input.value)).toEqual(["req-9f3c"]);
  });

  it("copies the request id", async () => {
    stubApi();
    failWithProblem(INTERNAL_DETAIL, "req-9f3c");
    await open("/boom", [pageAt("/boom", FailsWithProblem)]);
    const writeText = vi.fn<(text: string) => Promise<void>>(() => Promise.resolve());
    vi.stubGlobal("navigator", Object.assign(Object.create(window.navigator) as Navigator, { clipboard: { writeText } }));

    await act(async () => {
      fireEvent.click(await screen.findByRole("button", { name: "Copy request ID" }));
      await Promise.resolve();
    });

    expect(writeText).toHaveBeenCalledWith("req-9f3c");
    expect(screen.getByRole("button", { name: "Copied" })).toBeTruthy();
  });

  it("reloads the page from its button, which a keyboard reaches", async () => {
    stubApi();
    await open("/boom", [pageAt("/boom", Throws)]);
    const reload = await screen.findByRole("button", { name: "Reload" });
    reload.focus();
    expect(document.activeElement).toBe(reload);
    const reloadPage = vi.fn();
    vi.stubGlobal("location", { origin: window.location.origin, reload: reloadPage });

    fireEvent.click(reload);

    expect(reloadPage).toHaveBeenCalledTimes(1);
  });

  it("is written in German", async () => {
    vi.spyOn(window.navigator, "languages", "get").mockReturnValue(["de-AT"]);
    stubApi();
    failWithProblem(INTERNAL_DETAIL, "req-9f3c");
    await open("/boom", [pageAt("/boom", FailsWithProblem)]);

    expect(await screen.findByRole("heading", { level: 1, name: "Etwas ist schiefgelaufen" })).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "Anfrage-ID" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Anfrage-ID kopieren" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Neu laden" })).toBeTruthy();
  });
});

describe("the route pending state", () => {
  it("shows the loading skeleton while a page is on its way", async () => {
    stubApi();
    await open("/slow", [pageAt("/slow", () => use(new Promise<never>(() => undefined)))]);

    expect(await screen.findByRole("status", { name: "Loading" })).toBeTruthy();
    expect(screen.getByRole("main").querySelector("[data-slot='skeleton']")).not.toBeNull();
  });
});

describe("the offline banner", () => {
  function setOnline(value: boolean): void {
    vi.spyOn(window.navigator, "onLine", "get").mockReturnValue(value);
  }

  it("appears when the browser goes offline and clears when it returns", async () => {
    setOnline(true);
    stubApi();
    await open("/");
    await screen.findByRole("main");
    expect(screen.queryByText("You are offline")).toBeNull();

    act(() => {
      setOnline(false);
      window.dispatchEvent(new Event("offline"));
    });

    const title = within(screen.getByRole("main")).getByText("You are offline");
    expect(title.closest("[role='status']")?.textContent).toContain("Changes cannot be saved until your connection is back.");

    act(() => {
      setOnline(true);
      window.dispatchEvent(new Event("online"));
    });

    expect(screen.queryByText("You are offline")).toBeNull();
  });

  it("shows at once when the page opens offline, in German", async () => {
    vi.spyOn(window.navigator, "languages", "get").mockReturnValue(["de-AT"]);
    setOnline(false);
    stubApi();
    await open("/");

    expect(await screen.findByText("Du bist offline")).toBeTruthy();
  });
});

function SaveButton(): ReactElement {
  const { api } = useRouter().options.context;
  const save = useMutation({ mutationFn: () => api.GET("/version") });
  return (
    <button
      onClick={() => {
        save.mutate();
      }}
      type="button"
    >
      Save
    </button>
  );
}

describe("a failed mutation", () => {
  const savePage = pageAt("/save", SaveButton);

  async function save(): Promise<void> {
    await open("/save", [savePage]);
    fireEvent.click(await screen.findByRole("button", { name: "Save" }));
  }

  it("shows an error toast with the request id and none of the problem detail", async () => {
    stubApi(() => Promise.resolve(problem(500, "internal", "req-77", INTERNAL_DETAIL)));
    await save();

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("The change was not saved");
    expect(alert.textContent).toContain("Request ID: req-77");
    expect(document.body.textContent).not.toContain("SELECT");
  });

  it("says the browser is offline when the request could not be sent", async () => {
    vi.spyOn(window.navigator, "onLine", "get").mockReturnValue(false);
    stubApi(() => Promise.reject(new TypeError("Failed to fetch")));
    await save();

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("You are offline. Check your connection and try again.");
    expect(alert.textContent).not.toContain("Request ID");
    expect(document.body.textContent).not.toContain("Failed to fetch");
  });

  it("is written in German", async () => {
    vi.spyOn(window.navigator, "languages", "get").mockReturnValue(["de-AT"]);
    stubApi(() => Promise.resolve(problem(500, "internal", "req-77", INTERNAL_DETAIL)));
    await save();

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Die Änderung wurde nicht gespeichert");
    expect(alert.textContent).toContain("Anfrage-ID: req-77");
  });

  it("raises no error toast when it failed because the session ended", async () => {
    // Only the mutation is answered with the end of the session: the transport here settles in microtasks, so
    // a read that was answered the same way would be asked for again, and its answer cleared again, without end.
    stubApi((request) =>
      new URL(request.url).pathname === "/version"
        ? Promise.resolve(problem(401, "unauthenticated", "req-1", INTERNAL_DETAIL))
        : Promise.reject(new Error("unexpected call")),
    );
    await save();

    await waitFor(() => {
      expect(window.location.pathname).toBe("/login");
    });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText("The change was not saved")).toBeNull();
  });
});
