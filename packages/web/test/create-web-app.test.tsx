import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWebApp, useConfig } from "../src/index.ts";
import { CONFIG_BODY, PRODUCT_NAME, json, problem, renderApp, stubMatchMedia } from "./support.tsx";

const TAGLINE_EN = "Bookmarks with short, private slugs.";
const TAGLINE_DE = "Lesezeichen mit kurzen, privaten Slugs.";

type Transport = (request: Request) => Promise<Response>;

function stubTransport(handler: Transport) {
  const fetch = vi.fn<Transport>(handler);
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

beforeEach(() => {
  stubMatchMedia();
  vi.spyOn(window.navigator, "languages", "get").mockReturnValue(["en-US", "en"]);
  window.history.replaceState(null, "", "/");
});

afterEach(() => {
  vi.restoreAllMocks();
  document.documentElement.removeAttribute("lang");
});

describe("createWebApp", () => {
  it("requests /api/config before anything renders and shows the product name from it", async () => {
    const fetch = stubTransport(() => Promise.resolve(json(CONFIG_BODY)));
    const App = createWebApp({ extensions: [] });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[0].url).toBe(`${window.location.origin}/api/config`);

    await renderApp(<App />);

    expect(await screen.findByRole("heading", { name: PRODUCT_NAME })).toBeTruthy();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("renders nothing of the product while the configuration is on its way", async () => {
    let answer: (response: Response) => void = () => undefined;
    stubTransport(() => new Promise<Response>((resolve) => (answer = resolve)));
    const App = createWebApp({ extensions: [] });

    await renderApp(<App />);

    expect(screen.queryByRole("heading", { name: PRODUCT_NAME })).toBeNull();
    expect(screen.getByRole("status")).toBeTruthy();
    answer(json(CONFIG_BODY));
    expect(await screen.findByRole("heading", { name: PRODUCT_NAME })).toBeTruthy();
  });

  it("shows the failure view with the request id and none of the problem detail when the server answers a problem", async () => {
    stubTransport(() => Promise.resolve(problem(503, "unavailable", "req-4711", "connection string for db.internal")));
    const App = createWebApp({ extensions: [] });

    await renderApp(<App />);

    expect(await screen.findByText("The app could not be loaded")).toBeTruthy();
    expect(screen.getByText("req-4711")).toBeTruthy();
    expect(screen.queryByText(/db\.internal/)).toBeNull();
    expect(screen.queryByRole("heading", { name: PRODUCT_NAME })).toBeNull();
  });

  it.each([
    ["the network fails", () => Promise.reject(new TypeError("fetch failed: ECONNREFUSED 10.0.0.7"))],
    ["the answer is not JSON", () => Promise.resolve(new Response("<html>proxy error</html>", { status: 200, headers: { "Content-Type": "text/html" } }))],
    ["the answer is a failure without a problem document", () => Promise.resolve(new Response("bad gateway", { status: 502 }))],
  ])("shows the failure view, without the cause, when %s", async (_name, handler) => {
    stubTransport(handler);
    const App = createWebApp({ extensions: [] });

    await renderApp(<App />);

    expect(await screen.findByText("The app could not be loaded")).toBeTruthy();
    expect(screen.queryByText(/ECONNREFUSED|proxy error|bad gateway/)).toBeNull();
    expect(screen.queryByText(/Request ID/)).toBeNull();
  });

  it("writes the failure view in German for a German browser", async () => {
    vi.spyOn(window.navigator, "language", "get").mockReturnValue("de-AT");
    stubTransport(() => Promise.resolve(problem(500, "internal", "req-1")));
    const App = createWebApp({ extensions: [] });

    await renderApp(<App />);

    expect(await screen.findByText("Die App konnte nicht geladen werden")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Neu laden" })).toBeTruthy();
  });

  it("renders the root view in English with lang=en for an English browser", async () => {
    stubTransport(() => Promise.resolve(json(CONFIG_BODY)));
    const App = createWebApp({ extensions: [] });

    await renderApp(<App />);

    expect(await screen.findByRole("heading", { name: PRODUCT_NAME })).toBeTruthy();
    expect(document.documentElement.lang).toBe("en");
  });

  it("renders the root view in German with lang=de for a German browser", async () => {
    vi.spyOn(window.navigator, "languages", "get").mockReturnValue(["de-AT"]);
    stubTransport(() => Promise.resolve(json(CONFIG_BODY)));
    const App = createWebApp({ extensions: [] });

    await renderApp(<App />);

    expect(await screen.findByRole("heading", { name: PRODUCT_NAME })).toBeTruthy();
    expect(screen.getByText(TAGLINE_DE)).toBeTruthy();
    expect(screen.queryByText(TAGLINE_EN)).toBeNull();
    expect(document.documentElement.lang).toBe("de");
  });

  it("uses the server's default locale when the browser accepts none of the catalogs", async () => {
    vi.spyOn(window.navigator, "languages", "get").mockReturnValue(["fr-FR"]);
    stubTransport(() => Promise.resolve(json({ ...CONFIG_BODY, defaultLocale: "de" })));
    const App = createWebApp({ extensions: [] });

    await renderApp(<App />);

    expect(await screen.findByText(TAGLINE_DE)).toBeTruthy();
    expect(document.documentElement.lang).toBe("de");
  });

  it("refuses two extensions with one id before it requests anything", () => {
    const fetch = stubTransport(() => Promise.resolve(json(CONFIG_BODY)));
    expect(() => createWebApp({ extensions: [{ id: "billing" }, { id: "billing" }] })).toThrow(/used twice/);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("useConfig", () => {
  it("refuses to run outside the web app", () => {
    function Probe() {
      return <p>{useConfig().product.name}</p>;
    }
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() => render(<Probe />)).toThrow(/inside the web app/);
  });
});
