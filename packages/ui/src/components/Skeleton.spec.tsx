import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { SkeletonCardGrid, SkeletonList } from "./Skeleton.js";

describe("Skeleton", () => {
  it("exposes busy list skeleton for assistive tech", () => {
    render(<SkeletonList rows={2} testId="list-skeleton" />);
    const root = screen.getByTestId("list-skeleton");
    expect(root.getAttribute("aria-busy")).toBe("true");
    expect(root.getAttribute("aria-live")).toBe("polite");
  });

  it("renders card grid placeholders", () => {
    render(<SkeletonCardGrid count={3} testId="grid-skeleton" />);
    expect(screen.getByTestId("grid-skeleton").children.length).toBe(3);
  });
});
