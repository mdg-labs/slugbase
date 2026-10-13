// @vitest-environment jsdom
import type { ComponentTypes } from "@slugbase/contracts";
import { act, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";

// The CE web entry: it builds the app with createWebApp, mounts it on #root, and
// the app asks /api/config before it renders. The server side of that answer
// (the product name from the build info) is checked with the built app in
// web-build.test.ts; here the answer is typed from the contract.

const config: ComponentTypes["schemas"]["ApiConfig"] = {
  apiVersion: "v1",
  origin: "https://bookmarks.example.com",
  product: { name: "Bookmarks Entry Test", version: "1.2.3" },
  locales: ["en", "de"],
  defaultLocale: "en",
  docsBaseUrl: "https://slugbase.app/docs",
  features: { mail: false, ai: false },
};

it("mounts the app on #root and shows the product name that /api/config answers with", async () => {
  const requested: string[] = [];
  vi.stubGlobal("fetch", (request: Request) => {
    requested.push(new URL(request.url).pathname);
    return Promise.resolve(Response.json(config));
  });
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
  const root = document.createElement("div");
  root.id = "root";
  document.body.append(root);

  await act(async () => {
    await import("../src/web.tsx");
  });

  const heading = await screen.findByRole("heading", { name: "Welcome to Bookmarks Entry Test" });
  expect(heading.closest("#root")).not.toBeNull();
  expect(requested).toEqual(["/api/config"]);
});
