import { FeedbackToastProvider } from "@slugbase/ui/patterns";
import { QueryClient, QueryClientProvider, useMutation } from "@tanstack/react-query";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiProblemError, type ApiProblemCode } from "../src/api/client.ts";
import { I18nProvider } from "../src/i18n/i18n-provider.tsx";
import { ConfigProvider } from "../src/config/config-context.tsx";
import { inPlaceRefusals, MutationErrorToasts, type InPlaceRefusal } from "../src/shell/mutation-error-toasts.tsx";
import { CONFIG_BODY, stubBrowserApis, stubMatchMedia } from "./support.tsx";

// The shared error toast against mutations that declare which refusals their form shows in place. The failure scenarios are a
// declared refusal that still raises the toast, an undeclared answer (another status, or the same status with another code)
// that is silenced because it looks like the declared one, and a mutation with no declaration that loses its toast.

const TOAST_TITLE = "The change was not saved";

function refusal(status: number, code: ApiProblemCode): ApiProblemError {
  return new ApiProblemError({ status, code, requestId: "req-1" });
}

function Save({ meta, failure }: { readonly meta: Record<string, unknown> | undefined; readonly failure: unknown }) {
  const save = useMutation({
    meta,
    mutationFn: () => Promise.reject(failure instanceof Error ? failure : new Error("failed")),
  });
  return (
    <button
      onClick={() => {
        save.mutate();
      }}
      type="button"
    >
      Save
    </button>
  );
}

async function fail(meta: Record<string, unknown> | undefined, failure: unknown): Promise<void> {
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  render(
    <ConfigProvider config={{ ...CONFIG_BODY, locales: ["en", "de"] }}>
      <I18nProvider>
        <QueryClientProvider client={queryClient}>
          <FeedbackToastProvider regionLabel="Notifications">
            <MutationErrorToasts />
            <Save failure={failure} meta={meta} />
          </FeedbackToastProvider>
        </QueryClientProvider>
      </I18nProvider>
    </ConfigProvider>,
  );
  await act(async () => {
    fireEvent.click(await screen.findByRole("button", { name: "Save" }));
    await Promise.resolve();
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
}

const NAME_TAKEN: readonly InPlaceRefusal[] = [{ status: 409, code: "name_taken" }, { status: 422 }];

beforeEach(() => {
  stubBrowserApis();
  stubMatchMedia();
  vi.spyOn(window.navigator, "languages", "get").mockReturnValue(["en-US", "en"]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the error toast of a mutation that declares refusals its form shows in place", () => {
  it("stays quiet for a declared status and code", async () => {
    await fail(inPlaceRefusals(NAME_TAKEN), refusal(409, "name_taken"));
    expect(screen.queryAllByText(TOAST_TITLE)).toHaveLength(0);
  });

  it("stays quiet for a declared status without a code, whatever the code", async () => {
    await fail(inPlaceRefusals(NAME_TAKEN), refusal(422, "weak_password"));
    expect(screen.queryAllByText(TOAST_TITLE)).toHaveLength(0);
  });

  it("is raised for the declared status with another code", async () => {
    await fail(inPlaceRefusals(NAME_TAKEN), refusal(409, "slug_taken"));
    expect(screen.queryAllByText(TOAST_TITLE).length).toBeGreaterThan(0);
  });

  it("is raised for a status that is not declared", async () => {
    await fail(inPlaceRefusals(NAME_TAKEN), refusal(500, "internal"));
    expect(screen.queryAllByText(TOAST_TITLE).length).toBeGreaterThan(0);
  });

  it("is raised for a failure that is no answer of the API", async () => {
    await fail(inPlaceRefusals(NAME_TAKEN), new Error("offline"));
    expect(screen.queryAllByText(TOAST_TITLE).length).toBeGreaterThan(0);
  });

  it("is raised by a mutation that declares nothing", async () => {
    await fail(undefined, refusal(409, "name_taken"));
    expect(screen.queryAllByText(TOAST_TITLE).length).toBeGreaterThan(0);
  });

  it("stays quiet for the 422 of a mutation marked with fieldErrors", async () => {
    await fail({ fieldErrors: true }, refusal(422, "validation_failed"));
    expect(screen.queryAllByText(TOAST_TITLE)).toHaveLength(0);
  });

  it("raises the toast for a 409 of a mutation marked with fieldErrors", async () => {
    await fail({ fieldErrors: true }, refusal(409, "name_taken"));
    expect(screen.queryAllByText(TOAST_TITLE).length).toBeGreaterThan(0);
  });
});
