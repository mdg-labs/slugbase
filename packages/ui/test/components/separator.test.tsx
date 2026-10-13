import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Separator } from "../../src/index.ts";
import { expectNoViolations } from "../support.tsx";

describe("Separator", () => {
  it("renders a separator with the requested orientation", async () => {
    const { container } = render(<Separator orientation="vertical" />);

    expect(screen.getByRole("separator").getAttribute("aria-orientation")).toBe("vertical");
    await expectNoViolations(container);
  });
});
