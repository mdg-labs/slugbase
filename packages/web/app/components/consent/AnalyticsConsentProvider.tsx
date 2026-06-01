import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import {
  applyAnalyticsConsent,
  initAnalyticsClient,
  isClientAnalyticsConfigured,
} from "./analytics-client.js";
import { fetchAnalyticsConsentStatus, persistAnalyticsConsent } from "./consent-api.js";
import {
  readStoredAnalyticsConsent,
  type StoredAnalyticsConsent,
} from "./consent-storage.js";

export interface AnalyticsConsentContextValue {
  enabled: boolean;
  visible: boolean;
  granted: boolean | null;
  accept: () => Promise<void>;
  decline: () => Promise<void>;
}

const AnalyticsConsentContext = createContext<AnalyticsConsentContextValue | null>(
  null,
);

function storedToGranted(value: StoredAnalyticsConsent | null): boolean | null {
  if (value === "granted") return true;
  if (value === "denied") return false;
  return null;
}

export function AnalyticsConsentProvider({ children }: { children: ReactNode }) {
  const enabled = isClientAnalyticsConfigured();
  const [granted, setGranted] = useState<boolean | null>(() =>
    storedToGranted(readStoredAnalyticsConsent()),
  );
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    const local = readStoredAnalyticsConsent();
    if (local) {
      setGranted(storedToGranted(local));
      if (local === "granted") {
        initAnalyticsClient();
      }
      return;
    }

    void fetchAnalyticsConsentStatus().then((status) => {
      if (!status.enabled) {
        return;
      }
      if (status.decided) {
        const nextGranted = status.granted ?? false;
        applyAnalyticsConsent(nextGranted);
        setGranted(nextGranted);
        return;
      }
      setVisible(true);
    });
  }, [enabled]);

  const persistChoice = useCallback(async (nextGranted: boolean) => {
    applyAnalyticsConsent(nextGranted);
    setGranted(nextGranted);
    setVisible(false);
    try {
      await persistAnalyticsConsent(nextGranted);
    } catch {
      // Local consent still applies when the API is unreachable.
    }
  }, []);

  const value = useMemo<AnalyticsConsentContextValue>(
    () => ({
      enabled,
      visible,
      granted,
      accept: () => persistChoice(true),
      decline: () => persistChoice(false),
    }),
    [enabled, granted, persistChoice, visible],
  );

  return (
    <AnalyticsConsentContext.Provider value={value}>
      {children}
    </AnalyticsConsentContext.Provider>
  );
}

export function useAnalyticsConsent(): AnalyticsConsentContextValue {
  const context = useContext(AnalyticsConsentContext);
  if (!context) {
    throw new Error("useAnalyticsConsent must be used within AnalyticsConsentProvider");
  }
  return context;
}
