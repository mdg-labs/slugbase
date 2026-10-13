import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Button, Tooltip, TooltipPopup, TooltipProvider, TooltipTrigger } from "../../src/index.ts";
import { expectNoViolations } from "../support.tsx";

describe("Tooltip", () => {
  it("shows its text for the trigger when open", async () => {
    const { baseElement } = render(
      <TooltipProvider>
        <Tooltip defaultOpen>
          <TooltipTrigger render={<Button variant="outline" />}>Pin</TooltipTrigger>
          <TooltipPopup>Pin this bookmark</TooltipPopup>
        </Tooltip>
      </TooltipProvider>,
    );

    const popup = await screen.findByText("Pin this bookmark");
    expect(popup.closest("[data-slot='tooltip-popup']")).toBeTruthy();
    await expectNoViolations(baseElement);
  });
});
