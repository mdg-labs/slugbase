import { useTranslate } from "@tolgee/react";
import type { ReactNode } from "react";
import { ToastProvider, useToast } from "@slugbase/ui";

export function AppToastProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslate();

  return (
    <ToastProvider dismissLabel={t("ui.toast.dismiss_label")}>
      {children}
    </ToastProvider>
  );
}

export function useAppToast() {
  const { t } = useTranslate();
  const { toast } = useToast();

  return {
    showToast: (messageKey: string, params?: Record<string, string>) => {
      toast({
        title: t(messageKey, params),
        kind: "success",
      });
    },
    showError: (message: string) => {
      toast({
        title: message,
        kind: "danger",
      });
    },
  };
}
