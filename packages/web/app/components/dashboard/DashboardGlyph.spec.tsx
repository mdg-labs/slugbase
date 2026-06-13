import { cleanup, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { staticMessages } from "../../i18n/messages.js";
import { DashboardPinned } from "./DashboardPinned.js";
import { DashboardRecent } from "./DashboardRecent.js";
import type { DashboardBookmark } from "./dashboard.types.js";
import { getBookmarkMonogramInitials } from "../../routes/bookmarks/bookmark-glyph.js";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, string | number>) => {
      const messages = staticMessages.en as Record<string, string>;
      const template = messages[key] ?? key;
      if (!params) {
        return template;
      }
      return Object.entries(params).reduce(
        (value, [name, replacement]) =>
          value.replaceAll(`{${name}}`, String(replacement)),
        template,
      );
    },
  }),
}));

vi.mock("react-router", () => ({
  Link: ({ children, to }: { children: ReactNode; to: string }) => (
    <a href={to}>{children}</a>
  ),
}));

const pinnedBookmark: DashboardBookmark = {
  id: "bm-1",
  title: "Pinned guide",
  url: "https://example.com/guide",
  slug: "guide",
  forwardingEnabled: true,
  pinned: true,
  accessCount: 3,
  lastAccessedAt: "2026-05-29T08:00:00.000Z",
};

const recentBookmark: DashboardBookmark = {
  id: "bm-2",
  title: "Recent article",
  url: "https://example.com/article",
  slug: null,
  forwardingEnabled: false,
  pinned: false,
  accessCount: 1,
  lastAccessedAt: "2026-05-31T09:00:00.000Z",
};

describe("DashboardPinned", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders monogram badges instead of favicon images", () => {
    const view = render(<DashboardPinned bookmarks={[pinnedBookmark]} />);

    expect(view.container.querySelector("img")).toBeNull();
    expect(view.getByText(getBookmarkMonogramInitials(pinnedBookmark.title))).toBeTruthy();
  });
});

describe("DashboardRecent", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders monogram badges instead of favicon images", () => {
    const view = render(<DashboardRecent bookmarks={[recentBookmark]} />);

    expect(view.container.querySelector("img")).toBeNull();
    expect(view.getByText(getBookmarkMonogramInitials(recentBookmark.title))).toBeTruthy();
  });
});
