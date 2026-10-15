import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Button, Spinner, SpinnerLabelProvider } from "../../src/index.ts";
import { expectNoViolations } from "../support.tsx";

describe("Spinner", () => {
  it("renders a loading status named by its provider", async () => {
    const { container } = render(
      <SpinnerLabelProvider label="Wird geladen">
        <Spinner />
      </SpinnerLabelProvider>,
    );

    expect(screen.getByRole("status", { name: "Wird geladen" })).toBeTruthy();
    await expectNoViolations(container);
  });

  it("lets a caller name one spinner itself", () => {
    render(
      <SpinnerLabelProvider label="Wird geladen">
        <Spinner aria-label="Speichern" />
      </SpinnerLabelProvider>,
    );

    expect(screen.getByRole("status", { name: "Speichern" })).toBeTruthy();
  });

  it("carries no wording of its own without a provider", async () => {
    const { container } = render(<Spinner />);

    expect(screen.getByRole("status").getAttribute("aria-label")).toBeNull();
    await expectNoViolations(container);
  });
});

describe("a loading Button", () => {
  it("is named by its text and the provided busy label", () => {
    render(
      <SpinnerLabelProvider label="Wird geladen">
        <Button loading>Anmelden</Button>
      </SpinnerLabelProvider>,
    );

    expect(screen.getByRole("button", { name: /^Anmelden\s?Wird geladen$/ }).hasAttribute("data-loading")).toBe(true);
    expect(screen.queryByText("Loading")).toBeNull();
  });
});
