import { createInstance, type i18n } from "i18next";
import { initReactI18next } from "react-i18next";
import { staticMessages } from "./messages.js";

export function createI18n(lng: string): i18n {
  const instance = createInstance();
  void instance.use(initReactI18next).init({
    lng,
    fallbackLng: "en",
    resources: {
      en: { translation: staticMessages.en },
      de: { translation: staticMessages.de },
    },
    interpolation: { escapeValue: false, prefix: "{", suffix: "}" },
    keySeparator: false,
    nsSeparator: false,
    react: { useSuspense: false },
  });
  return instance;
}
