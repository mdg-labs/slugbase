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

/**
 * Short feedback for an action. An error is announced at once; the others wait for the
 * screen reader to finish. Returns the id of the toast.
 */
export const feedbackToast = {
  info: (title: string, description?: string): string => toastManager.add({ type: "info", title, description }),
  success: (title: string, description?: string): string => toastManager.add({ type: "success", title, description }),
  error: (title: string, description?: string): string =>
    toastManager.add({ type: "error", title, description, priority: "high" }),
};
