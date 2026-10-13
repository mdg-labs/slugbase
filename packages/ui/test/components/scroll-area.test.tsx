import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { ScrollArea } from "../../src/index.ts";
import { expectNoViolations, stubBrowserApis } from "../support.tsx";

describe("ScrollArea", () => {
  beforeEach(stubBrowserApis);

  it("renders its children inside the scroll viewport", async () => {
    const { container } = render(
      <ScrollArea>
        <p>Folders</p>
      </ScrollArea>,
    );

    expect(screen.getByText("Folders").closest("[data-slot='scroll-area-viewport']")).toBeTruthy();
    await expectNoViolations(container);
  });
});
