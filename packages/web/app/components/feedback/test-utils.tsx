import { ToastProvider } from "@slugbase/ui";
import {
  render,
  type RenderOptions,
  type RenderResult,
} from "@testing-library/react";
import type { ReactElement } from "react";

export function renderWithFeedbackProviders(
  ui: ReactElement,
  options?: Omit<RenderOptions, "wrapper">,
): RenderResult {
  return render(ui, {
    ...options,
    wrapper: ({ children }) => (
      <ToastProvider dismissLabel="Dismiss notification">
        {children}
      </ToastProvider>
    ),
  });
}
