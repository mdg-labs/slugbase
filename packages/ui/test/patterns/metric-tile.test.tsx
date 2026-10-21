import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MetricTile } from "../../src/patterns/index.ts";
import { expectNoViolations } from "../support.tsx";

describe("MetricTile", () => {
  it("shows the figure under the name of what it counts", async () => {
    const { container } = render(<MetricTile label="Accounts" value="1,204" />);

    expect(screen.getByText("Accounts")).toBeTruthy();
    expect(screen.getByText("1,204")).toBeTruthy();
    await expectNoViolations(container);
  });

  it("takes the class it is given beside its own", () => {
    const { container } = render(<MetricTile className="w-48" label="Workspaces" value="3" />);

    expect(container.querySelector("[data-slot='card']")?.className).toContain("w-48");
  });
});
