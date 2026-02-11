import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import MarketingLayout from '../../components/MarketingLayout';

export default function Pricing() {
  const { t } = useTranslation();

  return (
    <MarketingLayout>
      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-16">
        <div className="text-center mb-12">
          <h1 className="text-3xl sm:text-4xl font-bold text-gray-900 dark:text-white">{t('pricing.title')}</h1>
          <p className="mt-2 text-gray-600 dark:text-gray-400">{t('pricing.subtitle')}</p>
        </div>

        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-6">
          <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-6 flex flex-col">
            <h3 className="text-lg font-semibold text-gray-900 dark:text-white">{t('pricing.free')}</h3>
            <p className="mt-2 text-2xl font-bold text-gray-900 dark:text-white">{t('pricing.freePrice')}</p>
            <ul className="mt-4 space-y-2 text-sm text-gray-600 dark:text-gray-400 flex-1">
              <li>{t('pricing.freeValue1')}</li>
              <li>{t('pricing.freeValue2')}</li>
              <li>{t('pricing.freeValue3')}</li>
            </ul>
            <Link
              to="/app/signup"
              className="mt-6 block text-center px-4 py-2 text-sm font-medium text-blue-600 dark:text-blue-400 border border-blue-600 dark:border-blue-400 rounded-lg hover:bg-blue-50 dark:hover:bg-blue-900/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2"
            >
              {t('pricing.ctaStartFree')}
            </Link>
          </div>

          <div className="bg-white dark:bg-gray-800 rounded-xl border border-blue-200 dark:border-blue-800 p-6 flex flex-col ring-2 ring-blue-500/20 relative">
            <span className="absolute -top-3 left-1/2 -translate-x-1/2 px-2.5 py-0.5 text-xs font-medium bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300 rounded-full">
              {t('pricing.mostPopular')}
            </span>
            <h3 className="text-lg font-semibold text-gray-900 dark:text-white mt-1">{t('pricing.personal')}</h3>
            <p className="mt-2 text-2xl font-bold text-gray-900 dark:text-white">{t('pricing.personalPrice')}</p>
            <p className="text-sm text-gray-500 dark:text-gray-400">{t('pricing.personalYearly')}</p>
            <ul className="mt-4 space-y-2 text-sm text-gray-600 dark:text-gray-400 flex-1">
              <li>{t('pricing.personalValue1')}</li>
              <li>{t('pricing.personalValue2')}</li>
              <li>{t('pricing.personalValue3')}</li>
            </ul>
            <Link
              to="/app/signup"
              className="mt-6 block text-center px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2"
            >
              {t('pricing.ctaStartFree')}
            </Link>
          </div>

          <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-6 flex flex-col">
            <h3 className="text-lg font-semibold text-gray-900 dark:text-white">{t('pricing.team')}</h3>
            <p className="mt-2 text-2xl font-bold text-gray-900 dark:text-white">{t('pricing.teamPrice')}</p>
            <ul className="mt-4 space-y-2 text-sm text-gray-600 dark:text-gray-400 flex-1">
              <li>{t('pricing.teamValue1')}</li>
              <li>{t('pricing.teamValue2')}</li>
              <li>{t('pricing.teamValue3')}</li>
            </ul>
            <Link
              to="/app/signup"
              className="mt-6 block text-center px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2"
            >
              {t('pricing.ctaChoosePlan')}
            </Link>
          </div>

          <div className="bg-white dark:bg-gray-800 rounded-xl border border-amber-200 dark:border-amber-800 p-6 flex flex-col">
            <h3 className="text-lg font-semibold text-gray-900 dark:text-white">{t('pricing.earlySupporter')}</h3>
            <p className="mt-2 text-sm font-medium text-amber-700 dark:text-amber-400">{t('pricing.earlySupporterLifetime')}</p>
            <p className="mt-1 text-2xl font-bold text-gray-900 dark:text-white">{t('pricing.earlySupporterPrice')}</p>
            <ul className="mt-4 space-y-2 text-sm text-gray-600 dark:text-gray-400 flex-1">
              <li>{t('pricing.earlySupporterHelp')}</li>
              <li>{t('pricing.earlySupporterIncludes')}</li>
              <li>{t('pricing.earlySupporterSeats')}</li>
              <li className="text-xs text-gray-500">{t('pricing.earlySupporterNote')}</li>
            </ul>
            <Link
              to="/contact"
              className="mt-6 block text-center px-4 py-2 text-sm font-medium text-amber-700 dark:text-amber-400 border border-amber-500 rounded-lg hover:bg-amber-50 dark:hover:bg-amber-900/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-offset-2"
            >
              {t('pricing.ctaBecomeEarlySupporter')}
            </Link>
          </div>
        </div>

        {/* Comparison section */}
        <div className="mt-16">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white text-center mb-6">
            {t('pricing.comparisonTitle')}
          </h2>
          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-4">
              <p className="text-sm font-medium text-gray-900 dark:text-white">{t('pricing.free')}</p>
              <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">{t('pricing.comparisonFree')}</p>
            </div>
            <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-4">
              <p className="text-sm font-medium text-gray-900 dark:text-white">{t('pricing.personal')}</p>
              <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">{t('pricing.comparisonPersonal')}</p>
            </div>
            <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-4">
              <p className="text-sm font-medium text-gray-900 dark:text-white">{t('pricing.team')}</p>
              <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">{t('pricing.comparisonTeam')}</p>
            </div>
            <div className="bg-white dark:bg-gray-800 rounded-xl border border-amber-200 dark:border-amber-800 p-4">
              <p className="text-sm font-medium text-gray-900 dark:text-white">{t('pricing.earlySupporter')}</p>
              <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">{t('pricing.comparisonEarlySupporter')}</p>
            </div>
          </div>
        </div>
      </div>
    </MarketingLayout>
  );
}
