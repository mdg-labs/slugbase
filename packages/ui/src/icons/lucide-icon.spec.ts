import { describe, expect, it } from "vitest";
import { FolderIcon, FolderOpenIcon, PaletteIcon } from "lucide-react";

import { kebabToPascalCase, resolveLucideIcon } from "./lucide-icon.js";

describe("lucide-icon", () => {
  describe("kebabToPascalCase", () => {
    it("converts single-word names", () => {
      expect(kebabToPascalCase("folder")).toBe("Folder");
      expect(kebabToPascalCase("palette")).toBe("Palette");
    });

    it("converts multi-segment names", () => {
      expect(kebabToPascalCase("folder-open")).toBe("FolderOpen");
      expect(kebabToPascalCase("book-open-text")).toBe("BookOpenText");
      expect(kebabToPascalCase("grid-3x3")).toBe("Grid3x3");
    });
  });

  describe("resolveLucideIcon", () => {
    it("maps known kebab-case names to Lucide components", () => {
      expect(resolveLucideIcon("palette")).toBe(PaletteIcon);
      expect(resolveLucideIcon("folder-open")).toBe(FolderOpenIcon);
    });

    it("falls back to FolderIcon for null, empty, or unknown names", () => {
      expect(resolveLucideIcon(null)).toBe(FolderIcon);
      expect(resolveLucideIcon("")).toBe(FolderIcon);
      expect(resolveLucideIcon("not-a-real-lucide-icon-name")).toBe(FolderIcon);
    });
  });
});
