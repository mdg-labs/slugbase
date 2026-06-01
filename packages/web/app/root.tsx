import { Links, Meta, Outlet, Scripts, ScrollRestoration, useRouteLoaderData } from "react-router";
import type { LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";
import { I18nProvider } from "./i18n/I18nProvider.js";
import { isAppLocale, resolveLocale, type AppLocale } from "./i18n/resolve-locale.js";
import { ThemeProvider } from "@slugbase/ui";
import { AnalyticsConsentProvider } from "./components/consent/AnalyticsConsentProvider.js";
import { ConsentBanner } from "./components/consent/ConsentBanner.js";
import { AppToastProvider } from "./components/feedback/AppToastProvider.js";
import { AppErrorBoundary } from "./routes/errors/AppErrorBoundary.js";
import { getSessionUser } from "./lib/session-client.js";
import { getServerApiBaseUrl } from "./lib/server-api-base-url.js";
import stylesheet from "./app.css?url";

const API_BASE_URL = () => getServerApiBaseUrl();

export type RootLoaderData = {
  locale: AppLocale;
};

function readRootLocale(data: unknown): AppLocale {
  if (typeof data !== "object" || data === null) return "en";
  const rawLocale = (data as Record<string, unknown>).locale;
  if (typeof rawLocale === "string" && isAppLocale(rawLocale)) return rawLocale;
  return "en";
}

/**
 * Root loader runs on every navigation. Checks first-run setup status before
 * any auth check so a brand-new instance is redirected to /setup immediately.
 */
export async function loader({ request }: LoaderFunctionArgs): Promise<RootLoaderData | Response> {
  const url = new URL(request.url);
  const user = await getSessionUser(request);
  const locale = resolveLocale({
    userLanguage: user?.language,
    acceptLanguage: request.headers.get("Accept-Language"),
  });

  // Avoid redirect loop — /setup handles its own state
  if (url.pathname === "/setup") return { locale };

  try {
    const res = await fetch(`${API_BASE_URL()}/setup/status`);
    if (res.ok) {
      const data = (await res.json()) as { needsSetup: boolean };
      if (data.needsSetup) return redirect("/setup");
    }
  } catch {
    // If the API is unreachable during startup, let the page render
  }

  return { locale };
}

export const links = () => [
  { rel: "stylesheet", href: stylesheet },
  { rel: "icon", href: "/slugbase_icon.svg", type: "image/svg+xml" },
];

export function Layout({ children }: { children: React.ReactNode }) {
  const data: unknown = useRouteLoaderData("root");
  const locale = readRootLocale(data);

  return (
    <html lang={locale} data-theme="dark">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <Links />
      </head>
      <body className="min-h-screen bg-canvas antialiased">
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function Root() {
  const data: unknown = useRouteLoaderData("root");
  const locale = readRootLocale(data);

  return (
    <I18nProvider locale={locale}>
      <ThemeProvider>
        <AppToastProvider>
          <AnalyticsConsentProvider>
            <Outlet />
            <ConsentBanner />
          </AnalyticsConsentProvider>
        </AppToastProvider>
      </ThemeProvider>
    </I18nProvider>
  );
}

export function ErrorBoundary() {
  const data: unknown = useRouteLoaderData("root");
  const locale = readRootLocale(data);

  return (
    <I18nProvider locale={locale}>
      <ThemeProvider>
        <AppErrorBoundary />
      </ThemeProvider>
    </I18nProvider>
  );
}

export function HydrateFallback() {
  return <div className="min-h-screen bg-canvas" aria-hidden="true" />;
}
