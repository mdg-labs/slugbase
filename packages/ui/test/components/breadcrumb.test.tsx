import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "../../src/index.ts";
import { expectNoViolations } from "../support.tsx";

function renderBreadcrumb() {
  return render(
    <Breadcrumb>
      <BreadcrumbList>
        <BreadcrumbItem>
          <BreadcrumbLink href="/settings">Settings</BreadcrumbLink>
        </BreadcrumbItem>
        <BreadcrumbSeparator />
        <BreadcrumbItem>
          <BreadcrumbPage>Account</BreadcrumbPage>
        </BreadcrumbItem>
      </BreadcrumbList>
    </Breadcrumb>,
  );
}

describe("Breadcrumb", () => {
  it("renders a labelled navigation with the current page marked", () => {
    renderBreadcrumb();

    expect(screen.getByRole("navigation", { name: "breadcrumb" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Settings" }).getAttribute("href")).toBe("/settings");
    expect(screen.getByText("Account").getAttribute("aria-current")).toBe("page");
  });

  it("is free of accessibility violations", async () => {
    const { container } = renderBreadcrumb();

    await expectNoViolations(container);
  });
});
