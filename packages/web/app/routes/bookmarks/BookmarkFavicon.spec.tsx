import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { BookmarkFavicon } from "./BookmarkFavicon.js";
import { BookmarkGlyph } from "./BookmarkGlyph.js";
import { getBookmarkGlyphColor, getBookmarkMonogramInitials } from "./bookmark-glyph.js";

describe("BookmarkGlyph", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders title initials with hostname-hashed background and no image", () => {
    const title = "React 19 — useOptimistic";
    const url = "https://react.dev";
    const view = render(<BookmarkGlyph title={title} url={url} size={32} />);

    const badge = view.container.querySelector("span");
    expect(badge).toBeTruthy();
    expect(badge?.textContent).toBe(getBookmarkMonogramInitials(title));
    expect(badge?.style.backgroundColor).toBe(getBookmarkGlyphColor(url));
    expect(view.container.querySelector("img")).toBeNull();
  });
});

describe("BookmarkFavicon", () => {
  afterEach(() => {
    cleanup();
  });

  it("delegates to BookmarkGlyph without fetching favicons", () => {
    const view = render(
      <BookmarkFavicon title="Pinned guide" url="https://example.com/guide" size={26} />,
    );

    expect(view.container.querySelector("img")).toBeNull();
    expect(view.container.textContent).toBe(
      getBookmarkMonogramInitials("Pinned guide"),
    );
  });
});
