import React from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

export default function MarketingLayout({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation();

  return (
    <div className="min-h-screen flex flex-col bg-gray-50 dark:bg-gray-900">
      <header className="border-b border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 py-4 flex items-center justify-between">
          <Link to="/" className="flex items-center gap-2">
            <img src="/slugbase_icon_blue.svg" alt="" className="h-8 w-8 dark:hidden" />
            <img src="/slugbase_icon_white.svg" alt="" className="h-8 w-8 hidden dark:block" />
            <span className="font-semibold text-gray-900 dark:text-white">{t('app.name')}</span>
          </Link>
          <nav className="flex items-center gap-6">
            <Link to="/pricing" className="text-sm text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white">
              {t('landing.footerPricing')}
            </Link>
            <Link to="/contact" className="text-sm text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-white">
              {t('landing.footerContact')}
            </Link>
            <Link
              to="/app/login"
              className="inline-flex items-center justify-center px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors"
            >
              {t('landing.ctaSignUp')}
            </Link>
          </nav>
        </div>
      </header>
      <main className="flex-1">{children}</main>
      <footer className="border-t border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 py-6">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 flex flex-col sm:flex-row items-center justify-between gap-4">
          <span className="text-sm text-gray-500 dark:text-gray-400">© SlugBase</span>
          <div className="flex gap-6">
            <Link to="/pricing" className="text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200">
              {t('landing.footerPricing')}
            </Link>
            <Link to="/contact" className="text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200">
              {t('landing.footerContact')}
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
