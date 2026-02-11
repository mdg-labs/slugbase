import React from 'react';
import { Link, NavLink } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Sun, Moon } from 'lucide-react';
import { useMarketingTheme } from '../hooks/useMarketingTheme';

const navLinkClass = ({ isActive }: { isActive: boolean }) =>
  `text-sm transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 rounded ${
    isActive ? 'text-gray-900 dark:text-white font-medium' : 'text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white'
  }`;

const LANGUAGES = [
  { value: 'en', labelKey: 'profile.languageEnglish' },
  { value: 'de', labelKey: 'profile.languageGerman' },
  { value: 'fr', labelKey: 'profile.languageFrench' },
  { value: 'es', labelKey: 'profile.languageSpanish' },
  { value: 'it', labelKey: 'profile.languageItalian' },
  { value: 'pt', labelKey: 'profile.languagePortuguese' },
  { value: 'nl', labelKey: 'profile.languageDutch' },
  { value: 'ru', labelKey: 'profile.languageRussian' },
  { value: 'ja', labelKey: 'profile.languageJapanese' },
  { value: 'zh', labelKey: 'profile.languageChinese' },
  { value: 'pl', labelKey: 'profile.languagePolish' },
];

export default function MarketingLayout({ children }: { children: React.ReactNode }) {
  const { t, i18n } = useTranslation();
  const { isDark, toggleTheme } = useMarketingTheme();

  const currentLang = i18n.language?.split('-')[0] || 'en';

  return (
    <div className="min-h-screen flex flex-col bg-gray-50 dark:bg-gray-900">
      <header className="border-b border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 py-4 flex items-center justify-between">
          <Link to="/" className="flex items-center gap-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 rounded">
            <img src="/slugbase_icon_blue.svg" alt="" className="h-10 w-10 dark:hidden" />
            <img src="/slugbase_icon_white.svg" alt="" className="h-10 w-10 hidden dark:block" />
            <span className="font-semibold text-gray-900 dark:text-white">{t('app.name')}</span>
          </Link>
          <nav className="flex items-center gap-4 sm:gap-6">
            <NavLink to="/pricing" className={navLinkClass}>
              {t('landing.footerPricing')}
            </NavLink>
            <NavLink to="/contact" className={navLinkClass}>
              {t('landing.footerContact')}
            </NavLink>
            <select
              value={LANGUAGES.some((l) => l.value === currentLang) ? currentLang : 'en'}
              onChange={(e) => i18n.changeLanguage(e.target.value)}
              aria-label={t('profile.language')}
              className="text-sm font-medium text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-1.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-gray-800 cursor-pointer"
            >
              {LANGUAGES.map((lang) => (
                <option key={lang.value} value={lang.value}>
                  {t(lang.labelKey)}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={toggleTheme}
              aria-label={isDark ? t('profile.themeLight') : t('profile.themeDark')}
              className="p-2 rounded-lg text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-gray-800"
            >
              {isDark ? <Sun className="h-4 w-4" aria-hidden /> : <Moon className="h-4 w-4" aria-hidden />}
            </button>
            <Link
              to="/app/login"
              className="text-sm text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 rounded"
            >
              {t('auth.login')}
            </Link>
            <Link
              to="/app/signup"
              className="inline-flex items-center justify-center px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2"
            >
              {t('landing.ctaStartFree')}
            </Link>
          </nav>
        </div>
      </header>
      <main className="flex-1">{children}</main>
      <footer className="border-t border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 py-6">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 flex flex-col sm:flex-row items-center justify-between gap-4">
          <span className="text-sm text-gray-500 dark:text-gray-400">© SlugBase</span>
          <div className="flex flex-wrap gap-6">
            <Link to="/pricing" className="text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200">
              {t('landing.footerPricing')}
            </Link>
            <Link to="/contact" className="text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200">
              {t('landing.footerContact')}
            </Link>
            <Link to="/terms" className="text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200">
              {t('legal.termsTitle')}
            </Link>
            <Link to="/privacy" className="text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200">
              {t('legal.privacyTitle')}
            </Link>
            <Link to="/imprint" className="text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200">
              {t('legal.imprintTitle')}
            </Link>
            <Link to="/app" className="text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200">
              {t('landing.footerApp')}
            </Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
