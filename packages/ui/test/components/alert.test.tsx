import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../../src/index.ts";
import { expectNoViolations } from "../support.tsx";

describe("Alert", () => {
  it("renders an alert with its title, description and action", async () => {
    const { container } = render(
      <Alert variant="warning">
        <AlertTitle>Email not verified</AlertTitle>
        <AlertDescription>Verify your address to keep sharing.</AlertDescription>
        <AlertAction>
          <a href="/verify">Verify</a>
        </AlertAction>
      </Alert>,
    );

    expect(screen.getByRole("alert").textContent).toContain("Email not verified");
    expect(screen.getByRole("link", { name: "Verify" })).toBeTruthy();
    await expectNoViolations(container);
  });
});
