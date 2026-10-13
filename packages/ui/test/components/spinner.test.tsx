import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Spinner } from "../../src/index.ts";
import { expectNoViolations } from "../support.tsx";

describe("Spinner", () => {
  it("renders a loading status", async () => {
    const { container } = render(<Spinner />);

    expect(screen.getByRole("status", { name: "Loading" })).toBeTruthy();
    await expectNoViolations(container);
  });
});
