import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AppToastProvider } from "../feedback/AppToastProvider.js";
import { staticMessages } from "../../i18n/messages.js";
import type { GlobalSearchResult } from "../../lib/search.types.js";
import { CommandPalette } from "./CommandPalette.js";
import {
  CommandPaletteProvider,
  useCommandPalette,
} from "./CommandPaletteProvider.js";

const mockNavigate = vi.fn();
const mockLoad = vi.fn();

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const messages = staticMessages.en as Record<string, string>;
      return messages[key] ?? key;
    },
  }),
}));

vi.mock("react-router", async (importOriginal) => {
  const original = await importOriginal<typeof import("react-router")>();
  return {
    ...original,
    useNavigate: () => mockNavigate,
    useFetcher: () => ({
      state: "idle" as const,
      data: undefined as GlobalSearchResult | undefined,
      load: mockLoad,
    }),
  };
});

function PaletteHarness() {
  const { open, setOpen } = useCommandPalette();
  return <CommandPalette open={open} onOpenChange={setOpen} />;
}

function renderWithToast(ui: ReactElement) {
  return render(<AppToastProvider>{ui}</AppToastProvider>);
}

describe("CommandPalette", () => {
  beforeEach(() => {
    mockNavigate.mockReset();
    mockLoad.mockReset();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("opens when ⌘K is pressed", async () => {
    const view = renderWithToast(
      <CommandPaletteProvider>
        <PaletteHarness />
      </CommandPaletteProvider>,
    );

    expect(view.queryByTestId("command-palette-dialog")).toBeNull();

    act(() => {
      fireEvent.keyDown(document, { key: "k", metaKey: true, bubbles: true });
    });

    await waitFor(() => {
      expect(view.getByTestId("command-palette-dialog")).toBeTruthy();
    });
  });

  it("shows grouped quick actions when empty", () => {
    const view = renderWithToast(<CommandPalette open onOpenChange={vi.fn()} />);

    expect(view.getByText("Create")).toBeTruthy();
    expect(view.getByText("Go to")).toBeTruthy();
    expect(view.getByText("Workspace")).toBeTruthy();
    expect(view.getByText("New bookmark")).toBeTruthy();
    expect(view.getByText("Go to Folders")).toBeTruthy();
  });

  it("centers the palette panel in the viewport", () => {
    const view = renderWithToast(<CommandPalette open onOpenChange={vi.fn()} />);

    const panel = document.querySelector("[cmdk-dialog]");
    expect(panel).toBeTruthy();
    expect(panel?.className).toContain("fixed");
    expect(panel?.className).toContain("left-1/2");
    expect(panel?.className).toContain("top-1/2");
    expect(panel?.className).toContain("-translate-x-1/2");
    expect(panel?.className).toContain("-translate-y-1/2");
    expect(panel?.className).toContain("z-[101]");

    const overlay = document.querySelector("[cmdk-overlay]");
    expect(overlay?.className).toContain("backdrop-blur-[3px]");
    expect(overlay?.className).not.toContain("items-center");
    expect(overlay?.className).not.toContain("justify-center");

    expect(view.getByTestId("command-palette-dialog")).toBeTruthy();
  });

  it("enters search mode and loads results from the search API route", async () => {
    vi.useFakeTimers();

    const view = renderWithToast(<CommandPalette open onOpenChange={vi.fn()} />);

    await act(async () => {
      fireEvent.change(view.getByTestId("command-palette-input"), {
        target: { value: "react" },
      });
      await vi.advanceTimersByTimeAsync(300);
    });

    expect(mockLoad).toHaveBeenCalledWith(
      "/api/search?q=react&bookmarkLimit=3&folderLimit=3&tagLimit=3",
    );
  });
});
