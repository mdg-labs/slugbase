import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  Sheet,
  SheetDescription,
  SheetHeader,
  SheetPopup,
  SheetTitle,
  SheetTrigger,
} from "../../src/index.ts";
import { expectNoViolations } from "../support.tsx";

function openSheet() {
  return (
    <Sheet defaultOpen>
      <SheetTrigger>Open tag</SheetTrigger>
      <SheetPopup>
        <SheetHeader>
          <SheetTitle>Tag preview</SheetTitle>
          <SheetDescription>Bookmarks carrying this tag.</SheetDescription>
        </SheetHeader>
      </SheetPopup>
    </Sheet>
  );
}

describe("Sheet", () => {
  it("renders an open sheet as a named dialog", () => {
    render(openSheet());

    expect(screen.getByRole("dialog", { name: "Tag preview" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Close" })).toBeTruthy();
  });

  it("is free of accessibility violations while open", async () => {
    const { baseElement } = render(openSheet());

    await expectNoViolations(baseElement);
  });

  it("keeps the popup out of the document while closed", () => {
    render(
      <Sheet>
        <SheetTrigger>Open tag</SheetTrigger>
        <SheetPopup>
          <SheetTitle>Tag preview</SheetTitle>
        </SheetPopup>
      </Sheet>,
    );

    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
