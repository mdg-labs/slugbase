import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Button, Tooltip, TooltipPopup, TooltipProvider, TooltipTrigger } from "../../src/index.ts";
import { expectNoViolations } from "../support.tsx";

function renderOpenTooltip() {
  return render(
    <TooltipProvider>
      <Tooltip defaultOpen>
        <TooltipTrigger render={<Button variant="outline" />}>Pin</TooltipTrigger>
        <TooltipPopup>Pin this bookmark</TooltipPopup>
      </Tooltip>
    </TooltipProvider>,
  );
}

describe("Tooltip", () => {
  it("shows its text for the trigger when open", async () => {
    renderOpenTooltip();

    const popup = await screen.findByText("Pin this bookmark");
    expect(popup.closest("[data-slot='tooltip-popup']")).toBeTruthy();
  });

  it("is free of accessibility violations when open", async () => {
    const { baseElement } = renderOpenTooltip();
    await screen.findByText("Pin this bookmark");

    await expectNoViolations(baseElement);
  });
});
