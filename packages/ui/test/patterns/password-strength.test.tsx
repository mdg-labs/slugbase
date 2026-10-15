import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PasswordStrength, type PasswordScore } from "../../src/patterns/index.ts";
import { expectNoViolations } from "../support.tsx";

describe("PasswordStrength", () => {
  it.each([0, 1, 2, 3, 4] as const)("is a meter named by its label, at score %s, read out as the score in words", async (score: PasswordScore) => {
    const { container } = render(<PasswordStrength label="Password strength" score={score} scoreLabel={`Score ${String(score)}`} />);

    const meter = screen.getByRole("meter", { name: "Password strength" });
    expect(meter.getAttribute("aria-valuenow")).toBe(String(score));
    expect(meter.getAttribute("aria-valuemin")).toBe("0");
    expect(meter.getAttribute("aria-valuemax")).toBe("4");
    expect(meter.getAttribute("aria-valuetext")).toBe(`Score ${String(score)}`);
    await expectNoViolations(container);
  });

  it("fills as many segments as the score", () => {
    render(<PasswordStrength label="Password strength" score={3} scoreLabel="Good" />);

    const segments = [...screen.getByRole("meter").children];
    expect(segments).toHaveLength(4);
    expect(segments.map((segment) => segment.className.includes("bg-success"))).toEqual([true, true, true, false]);
  });
});
