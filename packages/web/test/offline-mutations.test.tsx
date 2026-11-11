import { FeedbackToastProvider } from "@slugbase/ui/patterns";
import { onlineManager, QueryClientProvider, useMutation } from "@tanstack/react-query";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigProvider } from "../src/config/config-context.tsx";
import { I18nProvider } from "../src/i18n/i18n-provider.tsx";
import { createQueryClient } from "../src/query-client.ts";
import { MutationErrorToasts } from "../src/shell/mutation-error-toasts.tsx";
import { CONFIG_BODY, stubBrowserApis, stubMatchMedia } from "./support.tsx";

// Doc 03 §13: a change made while the browser is offline fails at once with the offline toast and nothing is queued. The
// failure scenarios are a mutation that TanStack Query pauses (the request never runs and no toast shows) and a paused
// mutation that is sent when the browser comes back online.

const TOAST_TITLE = "The change was not saved";
const OFFLINE_TEXT = "You are offline. Check your connection and try again.";

const send = vi.fn<() => Promise<never>>();

function Save() {
  const save = useMutation({ mutationFn: send });
  return (
    <>
      <button
        onClick={() => {
          save.mutate();
        }}
        type="button"
      >
        Save
      </button>
      <output>{save.isPaused ? "paused" : save.status}</output>
    </>
  );
}

function setBrowserOnline(online: boolean): void {
  vi.spyOn(window.navigator, "onLine", "get").mockReturnValue(online);
  onlineManager.setOnline(online);
}

beforeEach(() => {
  stubBrowserApis();
  stubMatchMedia();
  vi.spyOn(window.navigator, "languages", "get").mockReturnValue(["en-US", "en"]);
  send.mockReset();
  send.mockRejectedValue(new TypeError("Failed to fetch"));
});

afterEach(() => {
  onlineManager.setOnline(true);
  vi.restoreAllMocks();
});

describe("a mutation made while the browser is offline", () => {
  it("fails at once with the offline toast and is not sent again when the browser is back online", async () => {
    setBrowserOnline(false);
    render(
      <ConfigProvider config={{ ...CONFIG_BODY, locales: ["en", "de"] }}>
        <I18nProvider>
          <QueryClientProvider client={createQueryClient()}>
            <FeedbackToastProvider regionLabel="Notifications">
              <MutationErrorToasts />
              <Save />
            </FeedbackToastProvider>
          </QueryClientProvider>
        </I18nProvider>
      </ConfigProvider>,
    );
    await act(async () => {
      fireEvent.click(await screen.findByRole("button", { name: "Save" }));
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    expect(send).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("status", { name: "" }).textContent).toBe("error");
    expect(screen.queryAllByText(TOAST_TITLE).length).toBeGreaterThan(0);
    expect(screen.queryAllByText(OFFLINE_TEXT).length).toBeGreaterThan(0);

    await act(async () => {
      setBrowserOnline(true);
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    expect(send).toHaveBeenCalledTimes(1);
  });
});
