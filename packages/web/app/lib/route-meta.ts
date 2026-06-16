import type { MetaFunction } from "react-router";

import { formatDocumentTitle } from "./format-document-title.js";
import { resolvePageTitleKey } from "./resolve-page-title.js";
import { isAppLocale } from "../i18n/resolve-locale.js";
import type { MessageKey } from "../i18n/messages.js";
import type { SupportedLocale } from "../i18n/messages.js";

function readLocaleFromMatches(matches: unknown): SupportedLocale {
  const root = (matches as Array<{ id: string; data: unknown }>).find(
    (match) => match.id === "root",
  );
  if (root?.data && typeof root.data === "object" && "locale" in root.data) {
    const locale = (root.data as { locale: string }).locale;
    if (isAppLocale(locale)) return locale;
  }
  return "en";
}

export function createRouteMeta(pageKey: MessageKey): MetaFunction {
  return ({ matches }) => {
    const locale = readLocaleFromMatches(matches);
    return [{ title: formatDocumentTitle(locale, pageKey) }];
  };
}

/** Meta for signed-in app routes — resolves title from pathname and query. */
export const appRouteMeta: MetaFunction = ({ location, matches }) => {
  const locale = readLocaleFromMatches(matches);
  const pageKey = resolvePageTitleKey(location.pathname, location.search);
  return [{ title: formatDocumentTitle(locale, pageKey) }];
};
