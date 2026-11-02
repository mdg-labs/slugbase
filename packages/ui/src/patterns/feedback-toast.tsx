import type { ReactElement, ReactNode } from "react";
import { ToastProvider, toastManager } from "../components/ui/toast.tsx";

export interface FeedbackToastProviderProps {
  children: ReactNode;
  /** The accessible name of the region the toasts appear in. */
  regionLabel: string;
}

/** Hosts the toasts that `feedbackToast` raises. The region is a polite live region, so assistive technology announces each toast. */
export function FeedbackToastProvider({ children, regionLabel }: FeedbackToastProviderProps): ReactElement {
  return <ToastProvider viewportLabel={regionLabel}>{children}</ToastProvider>;
}

/** The text of one state of `feedbackToast.promise`: a title, or a title with a description of phrasing content. */
export type PromiseToastText = string | { title: string; description?: ReactNode };

/** What `feedbackToast.promise` says in each state of the promise. */
export interface PromiseToastMessages<Value> {
  /** Shown while the promise is pending; the toast stays until the promise settles. */
  loading: PromiseToastText;
  /** Receives the value the promise resolved with. */
  success: PromiseToastText | ((value: Value) => PromiseToastText);
  /** Receives whatever the promise rejected with. */
  error: PromiseToastText | ((reason: unknown) => PromiseToastText);
}

function toastOptions(text: PromiseToastText): { title: string; description?: ReactNode } {
  return typeof text === "string" ? { title: text } : text;
}

/**
 * Short feedback for an action. An error is announced at once; the others wait for the
 * screen reader to finish. The description is rendered in a paragraph, so it holds phrasing
 * content only. Returns the id of the toast.
 */
export const feedbackToast = {
  info: (title: string, description?: ReactNode): string => toastManager.add({ type: "info", title, description }),
  success: (title: string, description?: ReactNode): string => toastManager.add({ type: "success", title, description }),
  error: (title: string, description?: ReactNode): string =>
    toastManager.add({ type: "error", title, description, priority: "high" }),
  /**
   * Follows a promise: one toast that shows `loading` while it is pending, then becomes the success or the error toast. The error
   * toast is announced at once. Returns the promise itself, which still rejects with the original reason, so the caller decides
   * what else a failure does.
   */
  promise: <Value,>(promise: Promise<Value>, messages: PromiseToastMessages<Value>): Promise<Value> =>
    toastManager.promise(promise, {
      loading: toastOptions(messages.loading),
      success: (value: Value) => toastOptions(typeof messages.success === "function" ? messages.success(value) : messages.success),
      error: (reason: unknown) => ({
        ...toastOptions(typeof messages.error === "function" ? messages.error(reason) : messages.error),
        priority: "high" as const,
      }),
    }),
};
