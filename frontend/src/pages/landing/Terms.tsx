import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import MarketingLayout from '../../components/MarketingLayout';

export default function Terms() {
  const { t } = useTranslation();

  return (
    <MarketingLayout>
      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-16">
        <h1 className="text-2xl font-semibold text-gray-900 dark:text-white mb-8">
          {t('legal.termsTitle')}
        </h1>
        <div className="prose prose-gray dark:prose-invert max-w-none space-y-6 text-gray-700 dark:text-gray-300">
          <section>
            <h2 className="text-lg font-medium text-gray-900 dark:text-white mt-6 mb-2">
              {t('legal.termsScopeTitle')}
            </h2>
            <p>{t('legal.termsScopeBody')}</p>
            {t('legal.termsScopeB2BBody') && <p className="mt-2">{t('legal.termsScopeB2BBody')}</p>}
            {t('legal.termsB2BBindingBody') && <p className="mt-2">{t('legal.termsB2BBindingBody')}</p>}
          </section>
          <section>
            <h2 className="text-lg font-medium text-gray-900 dark:text-white mt-6 mb-2">
              {t('legal.termsServiceTitle')}
            </h2>
            <p>{t('legal.termsServiceBody')}</p>
          </section>
          <section>
            <h2 className="text-lg font-medium text-gray-900 dark:text-white mt-6 mb-2">
              {t('legal.termsPlansTitle')}
            </h2>
            <p>{t('legal.termsPlansBody')}</p>
          </section>
          <section>
            <h2 className="text-lg font-medium text-gray-900 dark:text-white mt-6 mb-2">
              {t('legal.termsUserContentTitle')}
            </h2>
            <p>{t('legal.termsUserContentBody')}</p>
          </section>
          <section>
            <h2 className="text-lg font-medium text-gray-900 dark:text-white mt-6 mb-2">
              {t('legal.termsAccountTitle')}
            </h2>
            <p>{t('legal.termsAccountBody')}</p>
          </section>
          <section>
            <h2 className="text-lg font-medium text-gray-900 dark:text-white mt-6 mb-2">
              {t('legal.termsUseTitle')}
            </h2>
            <p>{t('legal.termsUseBody')}</p>
            <ul className="list-disc pl-6 mt-2 space-y-1">
              <li>{t('legal.termsUseProhibited1')}</li>
              <li>{t('legal.termsUseProhibited2')}</li>
              <li>{t('legal.termsUseProhibited3')}</li>
              <li>{t('legal.termsUseProhibited4')}</li>
              <li>{t('legal.termsUseProhibited5')}</li>
              <li>{t('legal.termsUseProhibited6')}</li>
            </ul>
            <p className="mt-2">{t('legal.termsUseAction')}</p>
          </section>
          <section>
            <h2 className="text-lg font-medium text-gray-900 dark:text-white mt-6 mb-2">
              {t('legal.termsShortLinksTitle')}
            </h2>
            <p>{t('legal.termsShortLinksBody')}</p>
          </section>
          <section>
            <h2 className="text-lg font-medium text-gray-900 dark:text-white mt-6 mb-2">
              {t('legal.termsAvailabilityTitle')}
            </h2>
            <p>{t('legal.termsAvailabilityBody')}</p>
          </section>
          <section>
            <h2 className="text-lg font-medium text-gray-900 dark:text-white mt-6 mb-2">
              {t('legal.termsDataLossTitle')}
            </h2>
            <p>{t('legal.termsDataLossBody')}</p>
          </section>
          <section>
            <h2 className="text-lg font-medium text-gray-900 dark:text-white mt-6 mb-2">
              {t('legal.termsLifetimeTitle')}
            </h2>
            <p>{t('legal.termsLifetimeBody')}</p>
          </section>
          <section>
            <h2 className="text-lg font-medium text-gray-900 dark:text-white mt-6 mb-2">
              {t('legal.termsBillingTitle')}
            </h2>
            <p>{t('legal.termsBillingBody')}</p>
          </section>
          <section>
            <h2 className="text-lg font-medium text-gray-900 dark:text-white mt-6 mb-2">
              {t('legal.termsThirdPartyTitle')}
            </h2>
            <p>{t('legal.termsThirdPartyBody')}</p>
          </section>
          <section>
            <h2 className="text-lg font-medium text-gray-900 dark:text-white mt-6 mb-2">
              {t('legal.termsBetaTitle')}
            </h2>
            <p>{t('legal.termsBetaBody')}</p>
          </section>
          <section>
            <h2 className="text-lg font-medium text-gray-900 dark:text-white mt-6 mb-2">
              {t('legal.termsCancellationTitle')}
            </h2>
            <p>{t('legal.termsCancellationBody')}</p>
          </section>
          <section>
            <h2 className="text-lg font-medium text-gray-900 dark:text-white mt-6 mb-2">
              {t('legal.termsWithdrawalTitle')}
            </h2>
            <p>{t('legal.termsWithdrawalBody')}</p>
            {t('legal.termsWithdrawalB2BNote') && <p className="mt-2">{t('legal.termsWithdrawalB2BNote')}</p>}
          </section>
          <section>
            <h2 className="text-lg font-medium text-gray-900 dark:text-white mt-6 mb-2">
              {t('legal.termsIPTitle')}
            </h2>
            <p>{t('legal.termsIPBody')}</p>
          </section>
          <section>
            <h2 className="text-lg font-medium text-gray-900 dark:text-white mt-6 mb-2">
              {t('legal.termsIndemnifyTitle')}
            </h2>
            <p>{t('legal.termsIndemnifyBody')}</p>
          </section>
          <section>
            <h2 className="text-lg font-medium text-gray-900 dark:text-white mt-6 mb-2">
              {t('legal.termsLiabilityTitle')}
            </h2>
            <p>{t('legal.termsLiabilityBody')}</p>
            {t('legal.termsLiabilityB2BNote') && <p className="mt-2">{t('legal.termsLiabilityB2BNote')}</p>}
          </section>
          <section>
            <h2 className="text-lg font-medium text-gray-900 dark:text-white mt-6 mb-2">
              {t('legal.termsTerminationTitle')}
            </h2>
            <p>{t('legal.termsTerminationBody')}</p>
          </section>
          <section>
            <h2 className="text-lg font-medium text-gray-900 dark:text-white mt-6 mb-2">
              {t('legal.termsChangesTitle')}
            </h2>
            <p>{t('legal.termsChangesBody')}</p>
          </section>
          <section>
            <h2 className="text-lg font-medium text-gray-900 dark:text-white mt-6 mb-2">
              {t('legal.termsForceMajeureTitle')}
            </h2>
            <p>{t('legal.termsForceMajeureBody')}</p>
          </section>
          <section>
            <h2 className="text-lg font-medium text-gray-900 dark:text-white mt-6 mb-2">
              {t('legal.termsLawTitle')}
            </h2>
            <p>{t('legal.termsLawBody')}</p>
          </section>
          <section>
            <h2 className="text-lg font-medium text-gray-900 dark:text-white mt-6 mb-2">
              {t('legal.termsSeverabilityTitle')}
            </h2>
            <p>{t('legal.termsSeverabilityBody')}</p>
          </section>
          <section>
            <h2 className="text-lg font-medium text-gray-900 dark:text-white mt-6 mb-2">
              {t('legal.termsContactTitle')}
            </h2>
            <p>{t('legal.termsContactBody')}</p>
          </section>
        </div>
        <p className="mt-10 text-sm text-gray-500 dark:text-gray-400">
          <Link to="/" className="text-blue-600 dark:text-blue-400 hover:underline">
            {t('legal.backToHome')}
          </Link>
        </p>
      </div>
    </MarketingLayout>
  );
}
