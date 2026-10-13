import type { ReactElement, ReactNode } from "react";
import { useEffect } from "react";
import { ToastProvider, toastManager } from "../components/ui/toast.tsx";

export interface FeedbackToastProviderProps {
  children: ReactNode;
  /** The accessible name of the region the toasts appear in. */
  regionLabel: string;
}

const VIEWPORT = '[data-slot="toast-viewport"]';

// The viewport of the base toast names its region in English; this gives it the app's language.
// The viewport is portalled after the provider's own effects run, so the label waits for it.
function RegionLabel({ label }: { label: string }): null {
  useEffect(() => {
    const apply = (): boolean => {
      const viewports = document.querySelectorAll(VIEWPORT);
      viewports.forEach((viewport) => {
        viewport.setAttribute("aria-label", label);
      });
      return viewports.length > 0;
    };
    if (apply()) {
      return undefined;
    }
    const observer = new MutationObserver(() => {
      if (apply()) {
        observer.disconnect();
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
    };
  }, [label]);
  return null;
}

/** Hosts the toasts that `feedbackToast` raises. The region is a polite live region, so assistive technology announces each toast. */
export function FeedbackToastProvider({ children, regionLabel }: FeedbackToastProviderProps): ReactElement {
  return (
    <ToastProvider>
      {children}
      <RegionLabel label={regionLabel} />
    </ToastProvider>
  );
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
