import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import enTranslations from '@/locales/en.json';
import deTranslations from '@/locales/de.json';

/** Locales shipped in this build; expand when more `frontend/src/locales/*.json` are added. */
export const SUPPORTED_LOCALES = ['en', 'de'] as const;
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

export function resolveSupportedLocale(code: string | undefined | null): SupportedLocale {
  return code === 'de' ? 'de' : 'en';
}

i18n
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
