import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AvatarStack } from "../../src/patterns/avatar-stack.tsx";
import { avatarColour } from "../../src/patterns/account-avatar.tsx";
import { expectNoViolations } from "../support.tsx";

const PEOPLE = Array.from({ length: 7 }, (_, index) => ({
  id: `0192f3a0-bbbb-7000-8000-${String(index + 1).padStart(12, "0")}`,
  name: `Person ${String.fromCharCode(65 + index)}`,
}));

describe("AvatarStack", () => {
  it("shows an avatar for each person up to the maximum and counts the rest in a chip", async () => {
    const { container } = render(<AvatarStack label="Seven people" people={PEOPLE} />);

    const avatars = container.querySelectorAll('[data-slot="avatar"]');
    expect(avatars).toHaveLength(4);
    expect(avatars[1]?.querySelector('[data-slot="avatar-fallback"]')?.className).toContain(avatarColour(PEOPLE[1]?.id ?? ""));
    expect(container.querySelector('[data-slot="avatar-stack-rest"]')?.textContent).toBe("+3");
    await expectNoViolations(container);
  });

  it("shows no chip when everyone fits, and honours a smaller maximum", () => {
    const { container, rerender } = render(<AvatarStack label="Three people" people={PEOPLE.slice(0, 3)} />);
    expect(container.querySelectorAll('[data-slot="avatar"]')).toHaveLength(3);
    expect(container.querySelector('[data-slot="avatar-stack-rest"]')).toBeNull();

    rerender(<AvatarStack label="Three people" max={1} people={PEOPLE.slice(0, 3)} />);
    expect(container.querySelectorAll('[data-slot="avatar"]')).toHaveLength(1);
    expect(container.querySelector('[data-slot="avatar-stack-rest"]')?.textContent).toBe("+2");
  });

  it("is one image named by its label", () => {
    const { getByRole } = render(<AvatarStack label="Person A, Person B and 5 more" people={PEOPLE} />);

    expect(getByRole("img", { name: "Person A, Person B and 5 more" })).toBeTruthy();
  });

  it("renders an empty stack for no people", () => {
    const { container } = render(<AvatarStack label="No members" people={[]} />);

    expect(container.querySelectorAll('[data-slot="avatar"]')).toHaveLength(0);
    expect(container.querySelector('[data-slot="avatar-stack-rest"]')).toBeNull();
  });
});
