import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from "../../src/index.ts";
import { expectNoViolations, stubBrowserApis, stubCookieStore, stubMatchMedia } from "../support.tsx";

function Shell(): React.ReactElement {
  return (
    <SidebarProvider>
      <Sidebar>
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupLabel>Library</SidebarGroupLabel>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton render={<a href="/bookmarks" />}>Bookmarks</SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroup>
        </SidebarContent>
      </Sidebar>
      <SidebarInset>
        <SidebarTrigger aria-label="Toggle sidebar" />
        <p>Content</p>
      </SidebarInset>
    </SidebarProvider>
  );
}

describe("Sidebar", () => {
  beforeEach(() => {
    stubBrowserApis();
  });

  it("renders the navigation beside the inset on a wide viewport and collapses it", async () => {
    stubMatchMedia(false);
    const cookies = stubCookieStore();
    const { container } = render(<Shell />);

    expect(screen.getByRole("link", { name: "Bookmarks" }).getAttribute("href")).toBe("/bookmarks");
    expect(container.querySelector("[data-slot='sidebar']")?.getAttribute("data-state")).toBe("expanded");
    await expectNoViolations(container);

    fireEvent.click(screen.getByRole("button", { name: "Toggle sidebar" }));

    await waitFor(() => {
      expect(container.querySelector("[data-slot='sidebar']")?.getAttribute("data-state")).toBe("collapsed");
    });
    expect(cookies.set).toHaveBeenCalledWith(expect.objectContaining({ name: "sidebar_state", value: "false" }));
  });

  it("moves the navigation into a sheet on a narrow viewport", async () => {
    stubMatchMedia(true);
    stubCookieStore();
    const { baseElement } = render(<Shell />);

    expect(screen.queryByRole("link", { name: "Bookmarks" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Toggle sidebar" }));

    expect(await screen.findByRole("dialog", { name: "Sidebar" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Bookmarks" })).toBeTruthy();
    await expectNoViolations(baseElement);
  });

  describe("persisting the open state", () => {
    const unhandled: unknown[] = [];
    const collect = (reason: unknown): void => {
      unhandled.push(reason);
    };

    beforeEach(() => {
      unhandled.length = 0;
      process.on("unhandledRejection", collect);
      stubMatchMedia(false);
    });

    afterEach(() => {
      process.off("unhandledRejection", collect);
    });

    async function toggleAndSettle(): Promise<void> {
      fireEvent.click(screen.getByRole("button", { name: "Toggle sidebar" }));
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    it("still toggles when the Cookie Store API is missing", async () => {
      Reflect.deleteProperty(globalThis, "cookieStore");
      const { container } = render(<Shell />);

      await toggleAndSettle();

      expect(container.querySelector("[data-slot='sidebar']")?.getAttribute("data-state")).toBe("collapsed");
      expect(unhandled).toEqual([]);
    });

    it("still toggles when the Cookie Store API rejects", async () => {
      const cookies = stubCookieStore();
      cookies.set.mockRejectedValue(new Error("blocked"));
      const { container } = render(<Shell />);

      await toggleAndSettle();

      expect(cookies.set).toHaveBeenCalledTimes(1);
      expect(container.querySelector("[data-slot='sidebar']")?.getAttribute("data-state")).toBe("collapsed");
      expect(unhandled).toEqual([]);
    });
  });
});
