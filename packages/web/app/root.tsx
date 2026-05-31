import { Links, Meta, Outlet, Scripts, ScrollRestoration } from "react-router";
import type { LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";
import { I18nProvider } from "./i18n/I18nProvider.js";
import { ThemeProvider } from "@slugbase/ui";
import { RootErrorBoundary } from "./components/RootErrorBoundary.js";
import stylesheet from "./app.css?url";

const API_BASE_URL = () => process.env["API_BASE_URL"] ?? "";

/**
 * Root loader runs on every navigation. Checks first-run setup status before
 * any auth check so a brand-new instance is redirected to /setup immediately.
 */
export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  // Avoid redirect loop — /setup handles its own state
  if (url.pathname === "/setup") return {};

  try {
    const res = await fetch(`${API_BASE_URL()}/setup/status`);
    if (res.ok) {
      const data = (await res.json()) as { needsSetup: boolean };
      if (data.needsSetup) return redirect("/setup");
    }
  } catch {
    // If the API is unreachable during startup, let the page render
  }

  return {};
}

export const links = () => [
  { rel: "stylesheet", href: stylesheet },
];

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-theme="dark">
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
  return (
    <I18nProvider>
      <ThemeProvider>
        <Outlet />
      </ThemeProvider>
    </I18nProvider>
  );
}

export function ErrorBoundary() {
  return (
    <I18nProvider>
      <ThemeProvider>
        <RootErrorBoundary />
      </ThemeProvider>
    </I18nProvider>
  );
}

export function HydrateFallback() {
  return <div className="min-h-screen bg-canvas" aria-hidden="true" />;
}
