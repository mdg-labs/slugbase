import { act, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { FeedbackToastProvider, feedbackToast } from "../../src/patterns/index.ts";
import { expectNoViolations, stubBrowserApis } from "../support.tsx";

describe("FeedbackToastProvider", () => {
  beforeEach(stubBrowserApis);

  it("hosts the toasts in a live region named in the app's language", async () => {
    const { baseElement } = render(<FeedbackToastProvider regionLabel="Mitteilungen">{null}</FeedbackToastProvider>);

    act(() => {
      feedbackToast.info("Abgemeldet", "Melde dich erneut an.");
    });

    expect(await screen.findByText("Abgemeldet")).toBeTruthy();
    const region = screen.getByRole("region", { name: "Mitteilungen" });
    expect(region.getAttribute("aria-live")).toBe("polite");
    expect(region.textContent).toContain("Melde dich erneut an.");
    expect(screen.queryByRole("region", { name: "Notifications" })).toBeNull();
    await expectNoViolations(baseElement);
  });

  it("names the region before any toast is raised, and renames it when the label changes", async () => {
    const { rerender } = render(<FeedbackToastProvider regionLabel="Mitteilungen">{null}</FeedbackToastProvider>);

    expect(await screen.findByRole("region", { name: "Mitteilungen" })).toBeTruthy();

    rerender(<FeedbackToastProvider regionLabel="Notices">{null}</FeedbackToastProvider>);

    expect(await screen.findByRole("region", { name: "Notices" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Mitteilungen" })).toBeNull();
  });

  it.each(["info", "success", "error"] as const)("raises a %s toast that is announced and free of accessibility violations", async (kind) => {
    const { baseElement } = render(<FeedbackToastProvider regionLabel="Notifications">{null}</FeedbackToastProvider>);

    act(() => {
      feedbackToast[kind](`A ${kind} toast`);
    });

    expect((await screen.findAllByText(`A ${kind} toast`)).length).toBeGreaterThan(0);
    await expectNoViolations(baseElement);
  });

  it("announces an error at once, in an alert beside the region", async () => {
    render(<FeedbackToastProvider regionLabel="Notifications">{null}</FeedbackToastProvider>);

    act(() => {
      feedbackToast.error("The change was not saved", "Try again.");
    });

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("The change was not saved");
    expect(alert.textContent).toContain("Try again.");
  });

  it("renders a description that is an element, such as an action the app places in the toast", async () => {
    render(<FeedbackToastProvider regionLabel="Notifications">{null}</FeedbackToastProvider>);

    act(() => {
      feedbackToast.error("Not available", <a href="/upgrade">Upgrade</a>);
    });

    const alert = await screen.findByRole("alert");
    expect(within(alert).getByRole("link", { name: "Upgrade" }).getAttribute("href")).toBe("/upgrade");
  });

  it("does not announce an info toast as an alert", async () => {
    render(<FeedbackToastProvider regionLabel="Notifications">{null}</FeedbackToastProvider>);

    act(() => {
      feedbackToast.info("Signed out");
    });

    await screen.findByText("Signed out");
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
