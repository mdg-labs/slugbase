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
});
