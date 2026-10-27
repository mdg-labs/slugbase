import { Button, Tabs, TabsList, TabsPanel, TabsTab } from "@slugbase/ui";
import { CopyValue, SettingsSection, StatusBadge } from "@slugbase/ui/patterns";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import type { TFunction } from "i18next";
import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { useCachedAccount } from "../account/use-cached-account.ts";
import { useUpdatePreferences } from "../account/use-update-preferences.ts";
import { bookmarkListQuery } from "../bookmarks/bookmarks.ts";
import { useConfig } from "../config/config-context.tsx";
import { SAMPLE_SLUG, SEARCH_KEYWORD, SLUG_LIST_PARAMS, searchTemplate } from "./forwarding.ts";

const BROWSERS = ["chrome", "firefox", "safari", "edge"] as const;

type Browser = (typeof BROWSERS)[number];

// A type alias, not an interface: the translation function takes the values as a dictionary.
type Values = {
  readonly name: string;
  readonly address: string;
  readonly keyword: string;
};

// The steps of each browser, with every catalog key written out so the catalog check sees it used.
function stepsOf(t: TFunction, browser: Browser, values: Values): readonly string[] {
  switch (browser) {
    case "chrome":
      return [
        t("forwarding.setup.browser.chrome.open"),
        t("forwarding.setup.browser.chrome.add"),
        t("forwarding.setup.browser.chrome.fill", values),
        t("forwarding.setup.browser.chrome.save"),
      ];
    case "firefox":
      return [
        t("forwarding.setup.browser.firefox.open"),
        t("forwarding.setup.browser.firefox.add"),
        t("forwarding.setup.browser.firefox.fill", values),
        t("forwarding.setup.browser.firefox.save"),
      ];
    case "safari":
      return [
        t("forwarding.setup.browser.safari.limit"),
        t("forwarding.setup.browser.safari.extension"),
        t("forwarding.setup.browser.safari.fill", values),
      ];
    case "edge":
      return [
        t("forwarding.setup.browser.edge.open"),
        t("forwarding.setup.browser.edge.add"),
        t("forwarding.setup.browser.edge.fill", values),
        t("forwarding.setup.browser.edge.save"),
      ];
  }
}

function BrowserSteps({ browser, values }: { readonly browser: Browser; readonly values: Values }): ReactElement {
  const { t } = useTranslation();
  return (
    <ol className="flex list-decimal flex-col gap-1.5 ps-5 text-sm">
      {stepsOf(t, browser, values).map((step) => (
        <li key={step}>{step}</li>
      ))}
    </ol>
  );
}

/** "Mark as done" (doc 03 section 8): stores that the member set the browser up, which ticks that step of the Getting started checklist. It is shown as done once the server has stored it. */
function MarkAsDone(): ReactElement {
  const { t } = useTranslation();
  const account = useCachedAccount();
  const update = useUpdatePreferences();
  if (account?.onboarding.browserSetupDone === true && !update.isPending) {
    return <StatusBadge variant="success">{t("forwarding.setup.done.badge")}</StatusBadge>;
  }
  return (
    <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-2">
      {update.isError ? (
        <p className="text-destructive-text text-sm" role="alert">
          {t("forwarding.setup.done.failed")}
        </p>
      ) : (
        <p className="text-muted-foreground text-sm">{t("forwarding.setup.done.description")}</p>
      )}
      <Button
        loading={update.isPending}
        onClick={() => {
          update.mutate({ onboarding: { browserSetupDone: true } });
        }}
        variant="outline"
      >
        {t("forwarding.setup.done.action")}
      </Button>
    </div>
  );
}

/**
 * "Set up your browser" (doc 03 section 8, doc 02 section 6.5): the search-engine address and keyword to copy, how to add them in
 * each of four browsers, and a link that tries it. The address is on the origin the server is configured with, not the one the
 * page was opened on. The test link goes to one of the member's own forwarding slugs, or to a sample address when they have none.
 * "Mark as done" ticks the browser setup step of the Getting started checklist.
 */
export function BrowserSetupSection(): ReactElement {
  const { t } = useTranslation();
  const router = useRouter();
  const { origin, product } = useConfig();
  // The slugs section reads the same list, so this adds no request.
  const list = useInfiniteQuery(bookmarkListQuery(router.options.context.api, SLUG_LIST_PARAMS));
  const own = list.data?.pages.flatMap((page) => page.items).find((bookmark) => bookmark.forwarding && bookmark.slug !== null)?.slug ?? undefined;
  const slug = own ?? SAMPLE_SLUG;
  const address = searchTemplate(origin);
  const values = { name: product.name, address, keyword: SEARCH_KEYWORD };
  return (
    <SettingsSection description={t("forwarding.setup.description")} footer={<MarkAsDone />} title={t("forwarding.setup.title")}>
      <div className="flex flex-col gap-6">
        <div className="grid gap-4 md:grid-cols-[2fr_1fr]">
          <div className="flex min-w-0 flex-col gap-1.5">
            <span className="font-medium text-sm">{t("forwarding.setup.address.label")}</span>
            <CopyValue copiedLabel={t("forwarding.setup.copied")} copyLabel={t("forwarding.setup.address.copy")} label={t("forwarding.setup.address.label")} value={address} />
          </div>
          <div className="flex min-w-0 flex-col gap-1.5">
            <span className="font-medium text-sm">{t("forwarding.setup.keyword.label")}</span>
            <CopyValue copiedLabel={t("forwarding.setup.copied")} copyLabel={t("forwarding.setup.keyword.copy")} label={t("forwarding.setup.keyword.label")} value={SEARCH_KEYWORD} />
          </div>
        </div>
        <Tabs defaultValue="chrome">
          <TabsList aria-label={t("forwarding.setup.browsers")} className="w-full sm:w-fit">
            <TabsTab value="chrome">{t("forwarding.setup.browser.chrome.name")}</TabsTab>
            <TabsTab value="firefox">{t("forwarding.setup.browser.firefox.name")}</TabsTab>
            <TabsTab value="safari">{t("forwarding.setup.browser.safari.name")}</TabsTab>
            <TabsTab value="edge">{t("forwarding.setup.browser.edge.name")}</TabsTab>
          </TabsList>
          {BROWSERS.map((browser) => (
            <TabsPanel key={browser} value={browser}>
              <BrowserSteps browser={browser} values={values} />
            </TabsPanel>
          ))}
        </Tabs>
        <div className="flex flex-col gap-1">
          <a
            className="w-fit rounded-sm font-medium text-primary-text text-sm underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
            href={`/go/${slug}`}
            rel="noopener noreferrer"
            target="_blank"
          >
            {t("forwarding.setup.test.link", { slug })}
          </a>
          <p className="text-muted-foreground text-sm">{own === undefined ? t("forwarding.setup.test.sample") : t("forwarding.setup.test.own", { keyword: SEARCH_KEYWORD, slug })}</p>
        </div>
      </div>
    </SettingsSection>
  );
}
