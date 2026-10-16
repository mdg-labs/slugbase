import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { SpinnerLabelProvider, ThemeProvider } from "@slugbase/ui";
import { Suspense, use, type ComponentType, type ReactElement, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { createApiClient } from "./api/client.ts";
import { mfaMiddleware } from "./auth/mfa.ts";
import { ReauthPrompt } from "./auth/reauth-prompt.tsx";
import { ReauthProvider } from "./auth/reauth-context.tsx";
import { createReauth, reauthMiddleware } from "./auth/reauth.ts";
import { fetchConfig, type ConfigResult } from "./config/bootstrap.ts";
import { ConfigFailure } from "./config/config-failure.tsx";
import { ConfigProvider } from "./config/config-context.tsx";
import { rememberSetupRequired } from "./config/setup-state.ts";
import { ExtensionsProvider, type WebExtension } from "./extensions/index.ts";
import { AccountI18nProvider } from "./i18n/account-i18n-provider.tsx";
import { I18nProvider } from "./i18n/i18n-provider.tsx";
import { createQueryClient } from "./query-client.ts";
import { createAppRouter } from "./router.ts";
import { AppFeedback } from "./shell/app-feedback.tsx";
import { createSessionExpiry } from "./shell/session-expiry.tsx";
import { ShellLoading } from "./shell/shell-loading.tsx";

/** Gives the spinners of the library, such as a loading button's, their label in the interface language. */
function LocalisedSpinners({ children }: { children: ReactNode }): ReactElement {
  const { t } = useTranslation();
  return <SpinnerLabelProvider label={t("shell.loading")}>{children}</SpinnerLabelProvider>;
}

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
  // The routes decide where a signed-out visitor goes from what the configuration says about setup, and
  // they only run once it is in, so it is recorded here before the product renders.
  const configResult = fetchConfig(api).then((result) => {
    if (result.status === "ready") {
      rememberSetupRequired(queryClient, result.config.setupRequired === true);
    }
    return result;
  });
  // The configuration request is a GET that never needs re-authentication, and it is made in this turn, before
  // the middleware (which a request waits for) is registered.
  api.use(reauthMiddleware(reauth));
  api.use(mfaMiddleware(router.history));

  function Product({ result }: { result: Promise<ConfigResult> }): ReactElement {
    const loaded = use(result);
    if (loaded.status === "failed") {
      // No configuration, so no account preference or default locale: the browser's languages, then English.
      return (
        <I18nProvider>
          <LocalisedSpinners>
            <ConfigFailure requestId={loaded.requestId} />
          </LocalisedSpinners>
        </I18nProvider>
      );
    }
    return (
      <ConfigProvider config={loaded.config}>
        <QueryClientProvider client={queryClient}>
          <AccountI18nProvider defaultLocale={loaded.config.defaultLocale}>
            <LocalisedSpinners>
              <AppFeedback expiry={sessionExpiry} router={router}>
                <ReauthProvider reauth={reauth}>
                  <ExtensionsProvider extensions={extensions}>
                    <RouterProvider router={router} />
                  </ExtensionsProvider>
                  <ReauthPrompt api={api} reauth={reauth} />
                </ReauthProvider>
              </AppFeedback>
            </LocalisedSpinners>
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
