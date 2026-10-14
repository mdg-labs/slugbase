import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { ToastProvider, toastManager } from "../../src/index.ts";
import { expectNoViolations, stubBrowserApis } from "../support.tsx";

describe("Toast", () => {
  beforeEach(stubBrowserApis);

  it("announces a toast added through the manager", async () => {
    const { baseElement } = render(<ToastProvider>{null}</ToastProvider>);

    act(() => {
      toastManager.add({ title: "Bookmark pinned", description: "It is at the top of your list." });
    });

    expect(await screen.findByText("Bookmark pinned")).toBeTruthy();
    expect(screen.getByText("It is at the top of your list.")).toBeTruthy();
    await expectNoViolations(baseElement);
  });

  it("names the live region with the given label, never with the English default", async () => {
    render(<ToastProvider viewportLabel="Mitteilungen">{null}</ToastProvider>);

    expect(await screen.findByRole("region", { name: "Mitteilungen" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Notifications" })).toBeNull();
  });

  it("keeps the base name of the live region when no label is given", async () => {
    render(<ToastProvider>{null}</ToastProvider>);

    expect(await screen.findByRole("region", { name: "Notifications" })).toBeTruthy();
  });
});
