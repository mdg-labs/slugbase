import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SettingsSection } from "../../src/patterns/index.ts";
import { expectNoViolations } from "../support.tsx";

describe("SettingsSection", () => {
  it("titles the card with a level-two heading and shows the description, the fields and the actions", async () => {
    const { container } = render(
      <SettingsSection description="How you appear." footer={<button type="submit">Save</button>} title="Profile">
        <p>Fields</p>
      </SettingsSection>,
    );

    expect(screen.getByRole("heading", { level: 2, name: "Profile" })).toBeTruthy();
    expect(screen.getByText("How you appear.")).toBeTruthy();
    expect(screen.getByText("Fields")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save" })).toBeTruthy();
    await expectNoViolations(container);
  });

  it("leaves out the description and the footer when there are none", () => {
    const { container } = render(
      <SettingsSection title="Email">
        <p>Fields</p>
      </SettingsSection>,
    );
    expect(container.querySelector('[data-slot="card-description"]')).toBeNull();
    expect(container.querySelector('[data-slot="card-footer"]')).toBeNull();
  });
});
