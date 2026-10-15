import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { ThemeProvider } from "@slugbase/ui";
import { Suspense, use, type ComponentType, type ReactElement } from "react";
import { createApiClient } from "./api/client.ts";
import { ReauthPrompt } from "./auth/reauth-prompt.tsx";
import { createReauth, reauthMiddleware } from "./auth/reauth.ts";
import { fetchConfig, type ConfigResult } from "./config/bootstrap.ts";
import { ConfigFailure } from "./config/config-failure.tsx";
import { ConfigProvider } from "./config/config-context.tsx";
import { ExtensionsProvider, type WebExtension } from "./extensions/index.ts";
import { AccountI18nProvider } from "./i18n/account-i18n-provider.tsx";
import { I18nProvider } from "./i18n/i18n-provider.tsx";
import { createQueryClient } from "./query-client.ts";
import { createAppRouter } from "./router.ts";
import { AppFeedback } from "./shell/app-feedback.tsx";
import { createSessionExpiry } from "./shell/session-expiry.tsx";
import { ShellLoading } from "./shell/shell-loading.tsx";

export interface CreateWebAppOptions {
  /** What the composition adds; CE passes none. */
  readonly extensions: readonly WebExtension[];
}

/**
 * Builds the web app as a component for the composition's entry to render. The
 * server configuration is requested here, before anything renders, and the
 * product renders only once it is in; a configuration that cannot be loaded
 * shows the failure view instead (doc 01 section 11). Throws on an invalid extension list.
 */
export function createWebApp({ extensions }: CreateWebAppOptions): ComponentType {
  const sessionExpiry = createSessionExpiry();
  const queryClient = createQueryClient();
  const reauth = createReauth();
  const api = createApiClient({
    onUnauthenticated: () => {
      // Nothing cached belongs to a session that has ended, and the session check must ask again.
      queryClient.clear();
      sessionExpiry.notify();
    },
  });
  // Validates the extension list: nothing is requested for one the app cannot start with.
  const router = createAppRouter({ queryClient, api }, extensions);
  const configResult = fetchConfig(api);
  // The configuration request is a GET that never needs re-authentication, and it starts in this turn, before
  // the middleware (which a request waits for) is registered.
  api.use(reauthMiddleware(reauth));

  function Product({ result }: { result: Promise<ConfigResult> }): ReactElement {
    const loaded = use(result);
    if (loaded.status === "failed") {
      // No configuration, so no account preference or default locale: the browser's languages, then English.
      return (
        <I18nProvider>
          <ConfigFailure requestId={loaded.requestId} />
        </I18nProvider>
      );
    }
    return (
      <ConfigProvider config={loaded.config}>
        <QueryClientProvider client={queryClient}>
          <AccountI18nProvider defaultLocale={loaded.config.defaultLocale}>
            <AppFeedback expiry={sessionExpiry} router={router}>
              <ExtensionsProvider extensions={extensions}>
                <RouterProvider router={router} />
              </ExtensionsProvider>
              <ReauthPrompt api={api} reauth={reauth} />
            </AppFeedback>
          </AccountI18nProvider>
        </QueryClientProvider>
      </ConfigProvider>
    );
  }

  return function WebApp(): ReactElement {
    return (
      <ThemeProvider>
        <Suspense
          fallback={
            // No configuration yet, so the browser's languages, then English, as for the failure view.
            <I18nProvider>
              <ShellLoading />
            </I18nProvider>
          }
        >
          <Product result={configResult} />
        </Suspense>
      </ThemeProvider>
    );
  };
}
