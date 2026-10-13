import type { ComponentTypes } from "@slugbase/contracts";
import { createContext, useContext, type ReactElement, type ReactNode } from "react";

/** The bootstrap document of `GET /api/config` (doc 01 section 11). */
export type ApiConfig = ComponentTypes["schemas"]["ApiConfig"];

const ConfigContext = createContext<ApiConfig | null>(null);

export function ConfigProvider({ config, children }: { config: ApiConfig; children: ReactNode }): ReactElement {
  return <ConfigContext.Provider value={config}>{children}</ConfigContext.Provider>;
}

/** The configuration the server served before the first render. */
export function useConfig(): ApiConfig {
  const config = useContext(ConfigContext);
  if (config === null) {
    throw new Error("useConfig must be used inside the web app");
  }
  return config;
}
