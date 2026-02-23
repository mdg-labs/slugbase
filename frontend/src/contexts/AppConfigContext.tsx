import React, { createContext, useContext } from 'react';
import { appBasePath as defaultAppBasePath, apiBaseUrl as defaultApiBaseUrl, appRootPath as defaultAppRootPath } from '../config/api';

export interface AppConfig {
  appBasePath: string;
  apiBaseUrl: string;
  appRootPath: string;
  /** When true, skip the first-time setup flow (e.g. in cloud; first user registers via Signup). */
  skipSetupFlow?: boolean;
  /** Prefix for Link/Navigate paths. Empty when under external Router (e.g. cloud basename="/app"); otherwise appBasePath. Use for all in-app navigation. */
  pathPrefixForLinks: string;
}

const defaultConfig: AppConfig = {
  appBasePath: defaultAppBasePath,
  apiBaseUrl: defaultApiBaseUrl,
  appRootPath: defaultAppRootPath,
  pathPrefixForLinks: defaultAppBasePath,
};

const AppConfigContext = createContext<AppConfig>(defaultConfig);

export function AppConfigProvider({
  children,
  appBasePath,
  apiBaseUrl,
  appRootPath,
  skipSetupFlow,
  pathPrefixForLinks,
}: {
  children: React.ReactNode;
  appBasePath?: string;
  apiBaseUrl?: string;
  appRootPath?: string;
  skipSetupFlow?: boolean;
  /** When set (e.g. "" when under external Router), used for Link/Navigate. Omit to use appBasePath. */
  pathPrefixForLinks?: string;
}) {
  const base = appBasePath ?? defaultConfig.appBasePath;
  const value: AppConfig = {
    appBasePath: base,
    apiBaseUrl: apiBaseUrl ?? defaultConfig.apiBaseUrl,
    appRootPath: appRootPath ?? defaultConfig.appRootPath,
    skipSetupFlow,
    pathPrefixForLinks: pathPrefixForLinks !== undefined ? pathPrefixForLinks : base,
  };
  return <AppConfigContext.Provider value={value}>{children}</AppConfigContext.Provider>;
}

export function useAppConfig(): AppConfig {
  return useContext(AppConfigContext);
}
