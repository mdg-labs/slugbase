import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Skeleton } from "../../src/index.ts";
import { expectNoViolations } from "../support.tsx";

describe("Skeleton", () => {
  it("renders a placeholder block that takes the given classes", async () => {
    const { container } = render(<Skeleton className="h-4 w-24" />);

    const block = container.querySelector("[data-slot='skeleton']");
    expect(block?.className).toContain("h-4");
    await expectNoViolations(container);
  });
});
