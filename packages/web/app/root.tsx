import { Links, Meta, Outlet, Scripts, ScrollRestoration } from "react-router";
import { I18nProvider } from "./i18n/I18nProvider.js";
import { ThemeProvider } from "@slugbase/ui";
import { RootErrorBoundary } from "./components/RootErrorBoundary.js";
import stylesheet from "./app.css?url";

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
