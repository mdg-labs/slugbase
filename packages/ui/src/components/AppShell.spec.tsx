import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AppShell } from "./AppShell.js";

describe("AppShell", () => {
  it("matches base layout snapshot", () => {
    const { container } = render(
      <AppShell brandLabel="SlugBase" workspaceLabel="Personal workspace">
        <p>Content</p>
      </AppShell>,
    );
    expect(container).toMatchSnapshot();
  });
});
