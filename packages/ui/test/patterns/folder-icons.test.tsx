import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FOLDER_ICON_COMPONENTS } from "../../src/patterns/index.ts";

describe("FOLDER_ICON_COMPONENTS", () => {
  it("holds the sixty curated icons by their lucide names, each a component that draws an svg", () => {
    const names = Object.keys(FOLDER_ICON_COMPONENTS);
    expect(names).toHaveLength(60);
    expect(new Set(names).size).toBe(60);
    for (const name of names) {
      const Icon = FOLDER_ICON_COMPONENTS[name];
      expect(Icon, name).toBeDefined();
      if (Icon !== undefined) {
        const { container, unmount } = render(<Icon />);
        expect(container.querySelector("svg"), name).not.toBeNull();
        unmount();
      }
    }
  });
});
