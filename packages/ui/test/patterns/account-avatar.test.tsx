import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { avatarColour, AccountAvatar, initialsOf } from "../../src/patterns/account-avatar.tsx";
import { expectNoViolations } from "../support.tsx";

const SEEDS = Array.from({ length: 64 }, (_, index) => `0192f3a0-bbbb-7000-8000-${index.toString(16).padStart(12, "0")}`);

describe("initialsOf", () => {
  it.each([
    ["Ada Lovelace", "AL"],
    ["ada lovelace", "AL"],
    ["Ada", "A"],
    ["  Ada   Byron   Lovelace ", "AL"],
    ["émile zola", "ÉZ"],
    ["日本 太郎", "日太"],
    ["😀 Smile", "😀S"],
    ["   ", ""],
  ])("%j gives %j", (name, initials) => {
    expect(initialsOf(name)).toBe(initials);
  });
});

describe("avatarColour", () => {
  it("is the same colour for the same identifier and independent of the name", () => {
    for (const seed of SEEDS) {
      expect(avatarColour(seed)).toBe(avatarColour(seed));
    }
  });

  it("spreads identifiers over all eight colours of the folder set", () => {
    const colours = new Set(SEEDS.map((seed) => avatarColour(seed)));
    expect(colours.size).toBe(8);
    for (const colour of colours) {
      expect(colour).toMatch(/^bg-folder-[1-8]$/);
    }
  });
});

describe("AccountAvatar", () => {
  it("shows the initials on the colour of the identifier and hides them from assistive technology", async () => {
    const seed = SEEDS[3] ?? "";
    const { container } = render(<AccountAvatar name="Ada Lovelace" seed={seed} size="lg" />);
    const avatar = container.querySelector('[data-slot="avatar"]');
    expect(avatar?.getAttribute("aria-hidden")).toBe("true");
    expect(avatar?.textContent).toBe("AL");
    expect(container.querySelector('[data-slot="avatar-fallback"]')?.className).toContain(avatarColour(seed));
    await expectNoViolations(container);
  });

  it("keeps its colour when the name changes", () => {
    const seed = SEEDS[5] ?? "";
    const { container, rerender } = render(<AccountAvatar name="Ada Lovelace" seed={seed} />);
    const before = container.querySelector('[data-slot="avatar-fallback"]')?.className;
    rerender(<AccountAvatar name="Grace Hopper" seed={seed} />);
    expect(container.querySelector('[data-slot="avatar-fallback"]')?.className).toBe(before);
    expect(container.textContent).toBe("GH");
  });
});
