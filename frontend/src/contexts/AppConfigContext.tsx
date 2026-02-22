import React, { createContext, useContext } from 'react';
import { appBasePath as defaultAppBasePath, apiBaseUrl as defaultApiBaseUrl, appRootPath as defaultAppRootPath } from '../config/api';

export interface AppConfig {
  appBasePath: string;
  apiBaseUrl: string;
  appRootPath: string;
}

const defaultConfig: AppConfig = {
  appBasePath: defaultAppBasePath,
  apiBaseUrl: defaultApiBaseUrl,
  appRootPath: defaultAppRootPath,
};

const AppConfigContext = createContext<AppConfig>(defaultConfig);

export function AppConfigProvider({
  children,
  appBasePath,
  apiBaseUrl,
  appRootPath,
}: {
  children: React.ReactNode;
  appBasePath?: string;
  apiBaseUrl?: string;
  appRootPath?: string;
}) {
  const value: AppConfig = {
    appBasePath: appBasePath ?? defaultConfig.appBasePath,
    apiBaseUrl: apiBaseUrl ?? defaultConfig.apiBaseUrl,
    appRootPath: appRootPath ?? defaultConfig.appRootPath,
  };
  return <AppConfigContext.Provider value={value}>{children}</AppConfigContext.Provider>;
}

export function useAppConfig(): AppConfig {
  return useContext(AppConfigContext);
}
