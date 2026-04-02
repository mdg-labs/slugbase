import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import {
  withTolgee,
  Tolgee,
  I18nextPlugin,
  FormatSimple,
  DevTools,
} from '@tolgee/i18next';
import enTranslations from '@/locales/en.json';
import deTranslations from '@/locales/de.json';

/** Locales shipped in this build; expand when more `frontend/src/locales/*.json` are added. */
export const SUPPORTED_LOCALES = ['en', 'de'] as const;
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

export function resolveSupportedLocale(code: string | undefined | null): SupportedLocale {
  return code === 'de' ? 'de' : 'en';
}

function createTolgee() {
  let builder = Tolgee().use(I18nextPlugin()).use(FormatSimple());
  if (import.meta.env.DEV && import.meta.env.VITE_TOLGEE_API_KEY) {
    builder = builder.use(DevTools());
  }
  return builder.init({
    apiUrl: import.meta.env.VITE_TOLGEE_API_URL,
    apiKey: import.meta.env.VITE_TOLGEE_API_KEY,
    staticData: {
      en: enTranslations,
      de: deTranslations,
    },
  });
}

const tolgee = createTolgee();

withTolgee(i18n, tolgee)
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      en: { translation: enTranslations },
      de: { translation: deTranslations },
    },
    supportedLngs: [...SUPPORTED_LOCALES],
    fallbackLng: 'en',
    interpolation: {
      escapeValue: false,
    },
  });

export default i18n;
