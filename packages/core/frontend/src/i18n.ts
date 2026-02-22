import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import enTranslations from '@/locales/en.json';
import deTranslations from '@/locales/de.json';
import frTranslations from '@/locales/fr.json';
import esTranslations from '@/locales/es.json';
import itTranslations from '@/locales/it.json';
import ptTranslations from '@/locales/pt.json';
import nlTranslations from '@/locales/nl.json';
import ruTranslations from '@/locales/ru.json';
import jaTranslations from '@/locales/ja.json';
import zhTranslations from '@/locales/zh.json';
import plTranslations from '@/locales/pl.json';

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      en: { translation: enTranslations },
      de: { translation: deTranslations },
      fr: { translation: frTranslations },
      es: { translation: esTranslations },
      it: { translation: itTranslations },
      pt: { translation: ptTranslations },
      nl: { translation: nlTranslations },
      ru: { translation: ruTranslations },
      ja: { translation: jaTranslations },
      zh: { translation: zhTranslations },
      pl: { translation: plTranslations },
    },
    fallbackLng: 'en',
    interpolation: {
      escapeValue: false,
    },
  });

export default i18n;
