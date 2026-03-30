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
  /** When true, hide Admin OIDC and SMTP/Settings (e.g. cloud uses Postmark and global OIDC). */
  hideAdminOidcAndSmtp?: boolean;
  /** When true, Admin AI page shows only the enable/disable toggle (e.g. cloud uses env for provider/model/key). */
  adminAiOnlyToggle?: boolean;
  /** Cloud plan (e.g. free, personal, team). Set when running in cloud and plan is fetched. */
  plan?: string;
  /** Bookmark limit for current plan (e.g. 50 for free). null when unlimited. */
  bookmarkLimit?: number | null;
  /** True only when plan is team. Used to gate team sharing UI. */
  canShareWithTeams?: boolean;
  /** Optional extra admin nav items (e.g. cloud billing). Generic extension; no cloud-specific naming. */
  extraAdminNavItems?: { path: string; label: string }[];
  /** Optional extra admin route definitions (e.g. cloud billing). Generic extension. */
  extraAdminRoutes?: { path: string; element: React.ReactNode }[];
  /** Optional guard called before allowing profile/account deletion (e.g. cloud blocks billing owner). Returns { allowed, message }. */
  profileDeleteGuard?: () => Promise<{ allowed: boolean; message?: string }>;
  /** Signup Terms link (e.g. cloud marketing `/terms`). When unset, docs fallback is used. */
  signupTermsUrl?: string;
  /** Signup Privacy link (e.g. cloud marketing `/privacy`). When unset, docs fallback is used. */
  signupPrivacyUrl?: string;
}

const defaultConfig: AppConfig = {
  appBasePath: defaultAppBasePath,
  apiBaseUrl: defaultApiBaseUrl,
  appRootPath: defaultAppRootPath,
  pathPrefixForLinks: defaultAppBasePath,
  hideAdminOidcAndSmtp: false,
  adminAiOnlyToggle: false,
};

const AppConfigContext = createContext<AppConfig>(defaultConfig);

export function AppConfigProvider({
  children,
  appBasePath,
  apiBaseUrl,
  appRootPath,
  skipSetupFlow,
  pathPrefixForLinks,
  hideAdminOidcAndSmtp,
  adminAiOnlyToggle,
  plan,
  bookmarkLimit,
  canShareWithTeams,
  extraAdminNavItems,
  extraAdminRoutes,
  profileDeleteGuard,
  signupTermsUrl,
  signupPrivacyUrl,
}: {
  children: React.ReactNode;
  appBasePath?: string;
  apiBaseUrl?: string;
  appRootPath?: string;
  skipSetupFlow?: boolean;
  /** When set (e.g. "" when under external Router), used for Link/Navigate. Omit to use appBasePath. */
  pathPrefixForLinks?: string;
  /** When true, hide Admin OIDC and SMTP/Settings (e.g. cloud). */
  hideAdminOidcAndSmtp?: boolean;
  /** When true, Admin AI page shows only the enable/disable toggle (e.g. cloud). */
  adminAiOnlyToggle?: boolean;
  /** Cloud plan (e.g. free, personal, team). Pass when running in cloud. */
  plan?: string;
  /** Bookmark limit for current plan (e.g. 50 for free). */
  bookmarkLimit?: number | null;
  /** True only when plan is team. */
  canShareWithTeams?: boolean;
  /** Optional extra admin nav items (e.g. cloud billing). Generic extension. */
  extraAdminNavItems?: { path: string; label: string }[];
  /** Optional extra admin route definitions (e.g. cloud billing). Generic extension. */
  extraAdminRoutes?: { path: string; element: React.ReactNode }[];
  /** Optional guard for profile/account deletion (e.g. cloud blocks billing owner). */
  profileDeleteGuard?: () => Promise<{ allowed: boolean; message?: string }>;
  /** Signup Terms URL (path-absolute or full URL). */
  signupTermsUrl?: string;
  /** Signup Privacy URL (path-absolute or full URL). */
  signupPrivacyUrl?: string;
}) {
  const base = appBasePath ?? defaultConfig.appBasePath;
  const value: AppConfig = {
    appBasePath: base,
    apiBaseUrl: apiBaseUrl ?? defaultConfig.apiBaseUrl,
    appRootPath: appRootPath ?? defaultConfig.appRootPath,
    skipSetupFlow,
    pathPrefixForLinks: pathPrefixForLinks !== undefined ? pathPrefixForLinks : base,
    hideAdminOidcAndSmtp: hideAdminOidcAndSmtp ?? defaultConfig.hideAdminOidcAndSmtp,
    adminAiOnlyToggle: adminAiOnlyToggle ?? defaultConfig.adminAiOnlyToggle,
    plan,
    bookmarkLimit,
    canShareWithTeams,
    extraAdminNavItems,
    extraAdminRoutes,
    profileDeleteGuard,
    signupTermsUrl,
    signupPrivacyUrl,
  };
  return <AppConfigContext.Provider value={value}>{children}</AppConfigContext.Provider>;
}

export function useAppConfig(): AppConfig {
  return useContext(AppConfigContext);
}
