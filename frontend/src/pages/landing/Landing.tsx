import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import MarketingLayout from '../../components/MarketingLayout';

export default function Landing() {
  const { t } = useTranslation();

  return (
    <MarketingLayout>
      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-16 sm:py-24">
        <div className="text-center">
          <h1 className="text-4xl sm:text-5xl font-bold text-gray-900 dark:text-white tracking-tight">
            {t('landing.heroTitle')}
          </h1>
          <p className="mt-6 text-lg text-gray-600 dark:text-gray-300 max-w-2xl mx-auto">
            {t('landing.heroSubtitle')}
          </p>
          <div className="mt-10">
            <Link
              to="/app/login"
              className="inline-flex items-center justify-center px-8 py-3 text-base font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors"
            >
              {t('landing.ctaSignUp')}
            </Link>
          </div>
        </div>

        <div className="mt-24 grid sm:grid-cols-3 gap-8">
          <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-6">
            <h3 className="text-lg font-semibold text-gray-900 dark:text-white">{t('landing.feature1Title')}</h3>
            <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">{t('landing.feature1Desc')}</p>
          </div>
          <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-6">
            <h3 className="text-lg font-semibold text-gray-900 dark:text-white">{t('landing.feature2Title')}</h3>
            <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">{t('landing.feature2Desc')}</p>
          </div>
          <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-6">
            <h3 className="text-lg font-semibold text-gray-900 dark:text-white">{t('landing.feature3Title')}</h3>
            <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">{t('landing.feature3Desc')}</p>
          </div>
        </div>
      </div>
    </MarketingLayout>
  );
}
