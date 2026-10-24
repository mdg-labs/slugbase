import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Kbd, KbdGroup } from "../../src/index.ts";
import { expectNoViolations } from "../support.tsx";

describe("Kbd", () => {
  it("renders a key as a kbd element and a group of keys as one", async () => {
    const { container } = render(
      <KbdGroup>
        <Kbd>G</Kbd>
        <Kbd>H</Kbd>
      </KbdGroup>,
    );

    expect(screen.getByText("G").tagName).toBe("KBD");
    expect(screen.getByText("G").getAttribute("data-slot")).toBe("kbd");
    expect(container.querySelector("[data-slot='kbd-group']")?.querySelectorAll("kbd[data-slot='kbd']")).toHaveLength(2);
    await expectNoViolations(container);
  });
});
