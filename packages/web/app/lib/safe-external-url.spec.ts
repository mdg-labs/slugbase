import { afterEach, describe, expect, it, vi } from "vitest";

import { isSafeExternalUrl, navigateToExternalUrl } from "./safe-external-url.js";

describe("isSafeExternalUrl", () => {
  it("accepts https URLs", () => {
    expect(isSafeExternalUrl("https://example.com/path")).toBe(true);
  });

  it("accepts http URLs", () => {
    expect(isSafeExternalUrl("http://example.com")).toBe(true);
  });

  it("rejects javascript URLs", () => {
    expect(isSafeExternalUrl("javascript:alert(1)")).toBe(false);
  });

  it("rejects data URLs", () => {
    expect(isSafeExternalUrl("data:text/html,<script>alert(1)</script>")).toBe(
      false,
    );
  });

  it("rejects invalid URLs", () => {
    expect(isSafeExternalUrl("not-a-url")).toBe(false);
  });
});

describe("navigateToExternalUrl", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("opens https URLs in a new tab with noopener,noreferrer", () => {
    const openSpy = vi.spyOn(window, "open").mockReturnValue(null);

    const result = navigateToExternalUrl("https://example.com");

    expect(result).toBe(true);
    expect(openSpy).toHaveBeenCalledWith(
      "https://example.com",
      "_blank",
      "noopener,noreferrer",
    );
  });

  it("assigns the current window when newTab is false", () => {
    const assignSpy = vi
      .spyOn(window.location, "assign")
      .mockImplementation(() => {});

    const result = navigateToExternalUrl("https://example.com", {
      newTab: false,
    });

    expect(result).toBe(true);
    expect(assignSpy).toHaveBeenCalledWith("https://example.com");
  });

  it("rejects javascript URLs and invokes onInvalid", () => {
    const openSpy = vi.spyOn(window, "open").mockReturnValue(null);
    const onInvalid = vi.fn();

    const result = navigateToExternalUrl("javascript:alert(1)", { onInvalid });

    expect(result).toBe(false);
    expect(onInvalid).toHaveBeenCalledOnce();
    expect(openSpy).not.toHaveBeenCalled();
  });
});
