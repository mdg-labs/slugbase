import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AppShell } from "./AppShell.js";

describe("AppShell", () => {
  it("matches base layout snapshot", () => {
    const { container } = render(
      <AppShell
        sidebar={<div>Sidebar content</div>}
        topBar={<div>TopBar content</div>}
      >
        <p>Content</p>
      </AppShell>,
    );
    expect(container).toMatchSnapshot();
  });

  it("renders sidebar, topbar, and main regions", () => {
    const { container } = render(
      <AppShell sidebar={<span>Nav</span>} topBar={<span>Bar</span>}>
        <p>Main</p>
      </AppShell>,
    );
    expect(container.querySelector('[data-testid="app-shell-sidebar"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="app-shell-topbar"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="app-shell-main"]')).toBeTruthy();
  });
});
