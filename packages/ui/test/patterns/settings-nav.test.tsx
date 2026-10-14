import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsNav, type SettingsNavGroup } from "../../src/patterns/index.ts";
import { expectNoViolations, stubBrowserApis, stubMatchMedia } from "../support.tsx";

const GROUPS: readonly SettingsNavGroup[] = [
  {
    id: "account",
    label: "Account",
    items: [
      { id: "profile", label: "Profile", link: <a href="#profile" />, current: true },
      { id: "security", label: "Security", link: <a href="#security" /> },
    ],
  },
  { id: "workspace", label: "Workspace", items: [{ id: "general", label: "General", link: <a href="#general" /> }] },
];

beforeEach(() => {
  stubBrowserApis();
});

describe("SettingsNav on a wide screen", () => {
  beforeEach(() => {
    stubMatchMedia(false);
  });

  it("lists the links of each group in a navigation landmark and marks the current page", async () => {
    const { container } = render(<SettingsNav groups={GROUPS} label="Settings" onNavigate={() => undefined} />);

    const nav = screen.getByRole("navigation", { name: "Settings" });
    const account = within(within(nav).getByRole("list", { name: "Account" }));
    expect(account.getAllByRole("link").map((link) => link.textContent)).toEqual(["Profile", "Security"]);
    expect(within(nav).getByRole("list", { name: "Workspace" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Profile" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("link", { name: "Security" }).getAttribute("aria-current")).toBeNull();
    expect(screen.getByRole("link", { name: "Security" }).getAttribute("href")).toBe("#security");
    expect(screen.queryByRole("combobox")).toBeNull();
    await expectNoViolations(container);
  });

  it("renders the footer below the groups", () => {
    render(<SettingsNav footer={<a href="#extra">Extra</a>} groups={GROUPS} label="Settings" onNavigate={() => undefined} />);
    expect(within(screen.getByRole("navigation", { name: "Settings" })).getByRole("link", { name: "Extra" })).toBeTruthy();
  });
});

describe("SettingsNav on a narrow screen", () => {
  beforeEach(() => {
    stubMatchMedia(true);
  });

  it("becomes a Select of the same pages, showing the current one, and reports the page the member chooses", async () => {
    const onNavigate = vi.fn<(id: string) => void>();
    const { container } = render(<SettingsNav groups={GROUPS} label="Settings" onNavigate={onNavigate} />);

    expect(screen.queryByRole("navigation")).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
    const select = screen.getByRole("combobox", { name: "Settings" });
    expect(select.textContent).toContain("Profile");
    await expectNoViolations(container);

    await act(async () => {
      fireEvent.click(select);
      await Promise.resolve();
    });
    await act(async () => {
      const option = await screen.findByRole("option", { name: "General" });
      // Base UI commits a click only after the press began on the item.
      fireEvent.pointerDown(option);
      fireEvent.click(option);
      await Promise.resolve();
    });

    expect(onNavigate).toHaveBeenCalledExactlyOnceWith("general");
  });
});
