import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { SpinnerLabelProvider, ThemeProvider } from "@slugbase/ui";
import { UnsavedGuard, unsavedChanges } from "@slugbase/ui/patterns";
import { Suspense, use, useEffect, useRef, useState, useSyncExternalStore, type ComponentType, type ReactElement, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { createApiClient } from "./api/client.ts";
import { LOGIN_PATH, mfaMiddleware } from "./auth/mfa.ts";
import { ReauthPrompt } from "./auth/reauth-prompt.tsx";
import { ReauthProvider } from "./auth/reauth-context.tsx";
import { createReauth, reauthMiddleware } from "./auth/reauth.ts";
import { fetchConfig, type ConfigResult } from "./config/bootstrap.ts";
import { ConfigFailure } from "./config/config-failure.tsx";
import { ConfigProvider } from "./config/config-context.tsx";
import { EntitlementRequiredToasts } from "./entitlements/index.ts";
import { rememberSetupRequired } from "./config/setup-state.ts";
import { ExtensionsProvider, type WebExtension } from "./extensions/index.ts";
import { AccountI18nProvider } from "./i18n/account-i18n-provider.tsx";
import { I18nProvider } from "./i18n/i18n-provider.tsx";
import { createQueryClient } from "./query-client.ts";
import { createAppRouter, type AppRouter } from "./router.ts";
import { AppFeedback } from "./shell/app-feedback.tsx";
import { createSessionExpiry } from "./shell/session-expiry.tsx";
import { ShellLoading } from "./shell/shell-loading.tsx";

/** Gives the spinners of the library, such as a loading button's, their label in the interface language. */
function LocalisedSpinners({ children }: { children: ReactNode }): ReactElement {
  const { t } = useTranslation();
  return <SpinnerLabelProvider label={t("shell.loading")}>{children}</SpinnerLabelProvider>;
}

/** The form overlay that stands on top, where focus goes back to when the question closes and nothing the member had focused is left. */
function topFormOverlay(): HTMLElement | null {
  const overlays = document.querySelectorAll<HTMLElement>('[data-slot="form-overlay"][data-open]');
  return overlays[overlays.length - 1] ?? null;
}

/** Whether a navigation is the sign-in flow taking the member over: a session that ended, a second factor asked for, a sign-out. */
function isSignInRedirect(action: string, pathname: string): boolean {
  return action === "REPLACE" && (pathname === LOGIN_PATH || pathname.startsWith(`${LOGIN_PATH}/`));
}

/** The question that is open: what the router waits for, and what the member's later Back and Forward presses asked for meanwhile. */
interface Question {
  /** Settles the router's wait: `true` cancels the navigation, `false` lets it through. */
  readonly resolve: (blocked: boolean) => void;
  /** Whether the question was asked by the Back or Forward button (or a history jump) rather than by a link or a command. */
  readonly traversal: boolean;
  /** The position in the history of the page the member is on. */
  readonly from: number;
  /** The position the member's last Back or Forward press while the question was open asked for. */
  target: number | undefined;
  /** Whether a press while the question was open landed on an entry with the page's own address, where the browser stays. */
  landed: boolean;
}

function isTraversal(action: string): boolean {
  return action === "BACK" || action === "FORWARD" || action === "GO";
}

/**
 * Holds a route change that would leave a form with unsaved edits (back, forward, a link or a palette command) and asks the
 * discard question: keeping the form cancels the navigation, discarding lets the one that was asked for through. The
 * sign-in flow's own redirects are never held, and a form that saves or is closed by the member releases its edits
 * before it navigates (`useUnsavedForm`).
 *
 * The history answers a held Back or Forward by moving the browser back to where it was, for each press. A press while the
 * question is open is held the same way and remembered; the router's wait for the first press is then settled with
 * "let through" once the browser is back on the page (it must not move the browser again), and a discard goes on to the page
 * of the last press. A press that lands on an entry with the page's own address ends the question at once: the history leaves the
 * browser on that entry, so the wait for the first press is let through without one.
 *
 * Leaving the document (a reload, a closed tab, a Back or Forward across documents) fires no route change, so the browser's own
 * leave prompt is registered for as long as a form holds an edit, and no longer.
 */
function RouteLeaveGuard({ router }: { router: AppRouter }): ReactElement {
  const { t } = useTranslation();
  // The router waits for its blockers before every navigation, so one is registered only while a form holds an edit.
  const armed = useSyncExternalStore(unsavedChanges.subscribe, unsavedChanges.hasUnsaved);
  const [asking, setAsking] = useState(false);
  const question = useRef<Question | undefined>(undefined);
  const opener = useRef<Element | null>(null);

  /** Closes the question with the member's answer (`blocked`: keep editing). */
  function finish(blocked: boolean): void {
    const asked = question.current;
    question.current = undefined;
    setAsking(false);
    if (asked === undefined) {
      return;
    }
    if (asked.landed) {
      asked.resolve(false);
      return;
    }
    if (!asked.traversal || asked.target === undefined) {
      asked.resolve(blocked);
      return;
    }
    // The member pressed Back or Forward again while the question was open: the history has put the browser back on the
    // page by itself for each press, so the first press is let through as a navigation to where the browser already is.
    const { from, target } = asked;
    whenBrowserIsAt(from, () => {
      asked.resolve(false);
      if (!blocked && target !== from) {
        router.history.go(target - from, { ignoreBlocker: true });
      }
    });
  }

  /** Runs `run` once the browser's own history entry is the one at `index` (the history's moves back are asynchronous). */
  function whenBrowserIsAt(index: number, run: () => void): void {
    const there = (): boolean => (window.history.state as { __TSR_index?: number } | null)?.__TSR_index === index;
    if (there()) {
      run();
      return;
    }
    const check = (): void => {
      if (there()) {
        window.removeEventListener("popstate", check);
        run();
      }
    };
    window.addEventListener("popstate", check);
  }

  useEffect(() => {
    if (!armed) {
      return;
    }
    const prompt = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", prompt);
    return () => {
      window.removeEventListener("beforeunload", prompt);
    };
  }, [armed]);

  useEffect(() => {
    if (!armed) {
      return;
    }
    const unblock = router.history.block({
      enableBeforeUnload: false,
      blockerFn: ({ currentLocation, nextLocation, action }) => {
        const asked = question.current;
        if (asked?.traversal === true && isTraversal(action)) {
          if (nextLocation.href === currentLocation.href) {
            // The member is back on the page the question is about: nothing is left to ask. The history does not move the
            // browser back for this press, so it stays on the entry it is on, which is not necessarily the one the question began on.
            asked.landed = true;
            finish(true);
            return false;
          }
          asked.target = nextLocation.state.__TSR_index;
          return true;
        }
        if (
          nextLocation.href === currentLocation.href ||
          isSignInRedirect(action, nextLocation.pathname) ||
          !unsavedChanges.holds({ current: currentLocation, next: nextLocation })
        ) {
          return false;
        }
        if (asked !== undefined) {
          return true;
        }
        opener.current = document.activeElement;
        return new Promise<boolean>((resolve) => {
          question.current = { resolve, traversal: isTraversal(action), from: currentLocation.state.__TSR_index, target: undefined, landed: false };
          setAsking(true);
        });
      },
    });
    return () => {
      unblock();
      finish(true);
    };
  }, [router, armed]);

  function settle(blocked: boolean): void {
    if (!blocked) {
      unsavedChanges.releaseAll();
    }
    finish(blocked);
  }

  function finalFocus(): HTMLElement | boolean {
    const held = opener.current;
    if (held instanceof HTMLElement && held !== document.body && held.isConnected) {
      return true;
    }
    return topFormOverlay() ?? true;
  }

  return (
    <UnsavedGuard
      description={t("unsaved.description")}
      discardLabel={t("unsaved.discard")}
      finalFocus={finalFocus}
      keepEditingLabel={t("unsaved.keepEditing")}
      onDiscard={() => {
        settle(false);
      }}
      onKeepEditing={() => {
        settle(true);
      }}
      open={asking}
      title={t("unsaved.title")}
    />
  );
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
                    <EntitlementRequiredToasts router={router} />
                    <RouterProvider router={router} />
                    <RouteLeaveGuard router={router} />
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
