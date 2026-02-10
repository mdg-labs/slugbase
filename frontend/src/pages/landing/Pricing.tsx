import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import MarketingLayout from '../../components/MarketingLayout';

export default function Pricing() {
  const { t } = useTranslation();

  return (
    <MarketingLayout>
      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-16">
        <div className="text-center mb-12">
          <h1 className="text-3xl font-bold text-gray-900 dark:text-white">{t('pricing.title')}</h1>
          <p className="mt-2 text-gray-600 dark:text-gray-400">{t('pricing.subtitle')}</p>
        </div>

        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-6">
          <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-6 flex flex-col">
            <h3 className="text-lg font-semibold text-gray-900 dark:text-white">{t('pricing.free')}</h3>
            <p className="mt-2 text-2xl font-bold text-gray-900 dark:text-white">{t('pricing.freePrice')}</p>
            <ul className="mt-4 space-y-2 text-sm text-gray-600 dark:text-gray-400 flex-1">
              <li>{t('pricing.freeUsers')}</li>
              <li>{t('pricing.freeWorkspace')}</li>
              <li>{t('pricing.freeBookmarks')}</li>
              <li>{t('pricing.freeFeatures')}</li>
              <li>{t('pricing.freeSupport')}</li>
            </ul>
            <Link to="/app/login" className="mt-6 block text-center px-4 py-2 text-sm font-medium text-blue-600 dark:text-blue-400 border border-blue-600 dark:border-blue-400 rounded-lg hover:bg-blue-50 dark:hover:bg-blue-900/20">
              {t('pricing.ctaSignUp')}
            </Link>
          </div>

          <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-6 flex flex-col">
            <h3 className="text-lg font-semibold text-gray-900 dark:text-white">{t('pricing.personal')}</h3>
            <p className="mt-2 text-2xl font-bold text-gray-900 dark:text-white">{t('pricing.personalPrice')}</p>
            <p className="text-sm text-gray-500 dark:text-gray-400">{t('pricing.personalYearly')}</p>
            <ul className="mt-4 space-y-2 text-sm text-gray-600 dark:text-gray-400 flex-1">
              <li>{t('pricing.personalUsers')}</li>
              <li>{t('pricing.personalBookmarks')}</li>
              <li>{t('pricing.personalFeatures')}</li>
              <li>{t('pricing.personalUpdates')}</li>
            </ul>
            <Link to="/app/login" className="mt-6 block text-center px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-lg">
              {t('pricing.ctaSignUp')}
            </Link>
          </div>

          <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-6 flex flex-col">
            <h3 className="text-lg font-semibold text-gray-900 dark:text-white">{t('pricing.team')}</h3>
            <p className="mt-2 text-2xl font-bold text-gray-900 dark:text-white">{t('pricing.teamPrice')}</p>
            <ul className="mt-4 space-y-2 text-sm text-gray-600 dark:text-gray-400 flex-1">
              <li>{t('pricing.teamUsers')}</li>
              <li>{t('pricing.teamExtraUser')}</li>
              <li>{t('pricing.teamFeatures')}</li>
              <li>{t('pricing.teamAudit')}</li>
            </ul>
            <Link to="/app/login" className="mt-6 block text-center px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-lg">
              {t('pricing.ctaSignUp')}
            </Link>
          </div>

          <div className="bg-white dark:bg-gray-800 rounded-xl border border-amber-200 dark:border-amber-800 p-6 flex flex-col">
            <h3 className="text-lg font-semibold text-gray-900 dark:text-white">{t('pricing.earlySupporter')}</h3>
            <p className="mt-2 text-sm font-medium text-amber-700 dark:text-amber-400">{t('pricing.earlySupporterLifetime')}</p>
            <p className="mt-1 text-2xl font-bold text-gray-900 dark:text-white">{t('pricing.earlySupporterPrice')}</p>
            <ul className="mt-4 space-y-2 text-sm text-gray-600 dark:text-gray-400 flex-1">
              <li>{t('pricing.earlySupporterSeats')}</li>
              <li>{t('pricing.earlySupporterIncludes')}</li>
              <li className="text-xs text-gray-500">{t('pricing.earlySupporterNote')}</li>
            </ul>
            <Link to="/contact" className="mt-6 block text-center px-4 py-2 text-sm font-medium text-amber-700 dark:text-amber-400 border border-amber-500 rounded-lg hover:bg-amber-50 dark:hover:bg-amber-900/20">
              {t('pricing.ctaSignUp')}
            </Link>
          </div>
        </div>
      </div>
    </MarketingLayout>
  );
}
