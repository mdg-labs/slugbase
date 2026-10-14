import { Banner } from "@slugbase/ui/patterns";
import { useSyncExternalStore, type ReactElement } from "react";
import { useTranslation } from "react-i18next";

function subscribe(onChange: () => void): () => void {
  globalThis.addEventListener("online", onChange);
  globalThis.addEventListener("offline", onChange);
  return () => {
    globalThis.removeEventListener("online", onChange);
    globalThis.removeEventListener("offline", onChange);
  };
}

function isOnline(): boolean {
  return globalThis.navigator.onLine;
}

/** The banner for a browser that has gone offline; it is gone as soon as the browser is back online. */
export function OfflineBanner(): ReactElement | null {
  const { t } = useTranslation();
  const online = useSyncExternalStore(subscribe, isOnline, () => true);
  return online ? null : (
    <Banner description={t("shell.offline.description")} title={t("shell.offline.title")} variant="warning" />
  );
}
