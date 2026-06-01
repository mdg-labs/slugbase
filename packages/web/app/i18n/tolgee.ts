import { DevTools, FormatSimple, Tolgee } from "@tolgee/react";

import { staticMessages } from "./messages.js";

const apiUrl = import.meta.env.VITE_TOLGEE_API_URL as string | undefined;
const isDev = import.meta.env.DEV;

type TolgeeClient = ReturnType<ReturnType<typeof Tolgee>["init"]>;

let tolgeeInstance: TolgeeClient | undefined;

/**
 * Lazily creates the shared Tolgee client. Must not run at module scope — Cloudflare
 * Workers forbid setTimeout/fetch during import (Tolgee init emits cache events).
 */
export function getTolgee(): TolgeeClient {
  if (!tolgeeInstance) {
    const builder = Tolgee().use(FormatSimple());
    if (isDev && apiUrl) {
      builder.use(DevTools());
    }
    tolgeeInstance = builder.init({
      defaultLanguage: "en",
      apiUrl: isDev && apiUrl ? apiUrl : undefined,
      staticData: staticMessages,
    });
  }
  return tolgeeInstance;
}
