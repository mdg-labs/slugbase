import { DevTools, FormatSimple, Tolgee } from "@tolgee/react";
import { staticMessages } from "./messages.js";

const apiUrl = import.meta.env.VITE_TOLGEE_API_URL as string | undefined;

export const tolgee = Tolgee()
  .use(FormatSimple())
  .use(DevTools())
  .init({
    defaultLanguage: "en",
    apiUrl: apiUrl && apiUrl.length > 0 ? apiUrl : undefined,
    staticData: staticMessages,
  });
