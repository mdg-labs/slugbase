import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { Spinner, ThemeProvider } from "@slugbase/ui";
import { Suspense, use, type ComponentType, type ReactElement } from "react";
import { createApiClient } from "./api/client.ts";
import { fetchConfig, type ConfigResult } from "./config/bootstrap.ts";
import { ConfigFailure } from "./config/config-failure.tsx";
import { ConfigProvider } from "./config/config-context.tsx";
import { assertValidExtensions, type WebExtension } from "./extensions.ts";
import { I18nProvider } from "./i18n/i18n-provider.tsx";
import { createQueryClient } from "./query-client.ts";
import { createAppRouter } from "./router.ts";

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
  assertValidExtensions(extensions);

  const api = createApiClient();
  const queryClient = createQueryClient();
  const router = createAppRouter({ queryClient, api });
  const configResult = fetchConfig(api);

  function Product({ result }: { result: Promise<ConfigResult> }): ReactElement {
    const loaded = use(result);
    if (loaded.status === "failed") {
      return <ConfigFailure requestId={loaded.requestId} />;
    }
    return (
      <ConfigProvider config={loaded.config}>
        <I18nProvider defaultLocale={loaded.config.defaultLocale}>
          <QueryClientProvider client={queryClient}>
            <RouterProvider router={router} />
          </QueryClientProvider>
        </I18nProvider>
      </ConfigProvider>
    );
  }

  return function WebApp(): ReactElement {
    return (
      <ThemeProvider>
        <Suspense fallback={<Spinner className="m-auto size-6" />}>
          <Product result={configResult} />
        </Suspense>
      </ThemeProvider>
    );
  };
}
