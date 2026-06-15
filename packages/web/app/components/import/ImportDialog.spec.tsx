import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { staticMessages } from "../../i18n/messages.js";
import { ImportDialog } from "./ImportDialog.js";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, string | number>) => {
      const messages = staticMessages.en as Record<string, string>;
      const template = messages[key] ?? key;
      return template.replace(/\{(\w+)\}/g, (_match: string, name: string) =>
        params?.[name] != null ? String(params[name]) : `{${name}}`,
      );
    },
  }),
}));

const {
  mockImportJson,
  mockImportNetscapeHtml,
  mockReadFileAsText,
  mockDetectFileType,
} = vi.hoisted(() => ({
  mockImportJson: vi.fn(),
  mockImportNetscapeHtml: vi.fn(),
  mockReadFileAsText: vi.fn(),
  mockDetectFileType: vi.fn(),
}));

vi.mock("../onboarding/import-api.js", () => ({
  importJson: mockImportJson,
  importNetscapeHtml: mockImportNetscapeHtml,
  readFileAsText: mockReadFileAsText,
  detectFileType: mockDetectFileType,
}));

describe("ImportDialog", () => {
  const onSuccess = vi.fn();
  const onOpenChange = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockReadFileAsText.mockResolvedValue('[{"title":"Test","url":"https://example.com"}]');
    mockDetectFileType.mockReturnValue("json");
    mockImportJson.mockResolvedValue({
      total: 1,
      successCount: 1,
      failureCount: 0,
      skippedSlugCount: 0,
      capLimitedCount: 0,
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("shows cap blocked message when atCap is true", () => {
    render(
      <ImportDialog open onOpenChange={onOpenChange} onSuccess={onSuccess} atCap />,
    );

    expect(screen.getByTestId("import-dialog-cap-blocked")).toBeTruthy();
    expect(screen.queryByTestId("import-dialog-drop-zone")).toBeNull();
    expect(screen.queryByTestId("import-dialog-submit")).toBeNull();
  });

  it("imports JSON file and calls onSuccess", async () => {
    render(
      <ImportDialog open onOpenChange={onOpenChange} onSuccess={onSuccess} />,
    );

    const input = screen.getByTestId("import-dialog-file-input");
    const file = new File(['[{"title":"Test","url":"https://example.com"}]'], "bookmarks.json", {
      type: "application/json",
    });

    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => {
      expect(screen.getByText("bookmarks.json")).toBeTruthy();
    });

    fireEvent.click(screen.getByTestId("import-dialog-submit"));

    await waitFor(() => {
      expect(mockImportJson).toHaveBeenCalled();
      expect(onSuccess).toHaveBeenCalledWith(
        expect.objectContaining({ successCount: 1 }),
      );
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  });
});
