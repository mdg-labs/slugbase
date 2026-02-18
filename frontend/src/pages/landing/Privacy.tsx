import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import MarketingLayout from '../../components/MarketingLayout';

export default function Privacy() {
  const { t } = useTranslation();

  return (
    <MarketingLayout>
      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-16">
        <h1 className="text-2xl font-semibold text-gray-900 dark:text-white mb-8">
          {t('legal.privacyTitle')}
        </h1>
        <div className="prose prose-gray dark:prose-invert max-w-none space-y-6 text-gray-700 dark:text-gray-300">
          <section>
            <h2 className="text-lg font-medium text-gray-900 dark:text-white mt-6 mb-2">
              {t('legal.privacyScopeTitle')}
            </h2>
            <p>{t('legal.privacyScopeBody')}</p>
          </section>
          <section>
            <h2 className="text-lg font-medium text-gray-900 dark:text-white mt-6 mb-2">
              {t('legal.privacyControllerTitle')}
            </h2>
            <p>{t('legal.privacyControllerBody')}</p>
          </section>
          <section>
            <h2 className="text-lg font-medium text-gray-900 dark:text-white mt-6 mb-2">
              {t('legal.privacyDataTitle')}
            </h2>
            <p>{t('legal.privacyDataBody')}</p>
          </section>
          <section>
            <h2 className="text-lg font-medium text-gray-900 dark:text-white mt-6 mb-2">
              {t('legal.privacyRecipientsTitle')}
            </h2>
            <p>{t('legal.privacyRecipientsBody')}</p>
          </section>
          <section>
            <h2 className="text-lg font-medium text-gray-900 dark:text-white mt-6 mb-2">
              {t('legal.privacyProcessorsTitle')}
            </h2>
            <p>{t('legal.privacyProcessorsBody')}</p>
          </section>
          <section>
            <h2 className="text-lg font-medium text-gray-900 dark:text-white mt-6 mb-2">
              {t('legal.privacyAITitle')}
            </h2>
            <p>{t('legal.privacyAIBody')}</p>
          </section>
          <section>
            <h2 className="text-lg font-medium text-gray-900 dark:text-white mt-6 mb-2">
              {t('legal.privacyTransfersTitle')}
            </h2>
            <p>{t('legal.privacyTransfersBody')}</p>
          </section>
          <section>
            <h2 className="text-lg font-medium text-gray-900 dark:text-white mt-6 mb-2">
              {t('legal.privacyBasisTitle')}
            </h2>
            <p>{t('legal.privacyBasisBody')}</p>
          </section>
          <section>
            <h2 className="text-lg font-medium text-gray-900 dark:text-white mt-6 mb-2">
              {t('legal.privacyRetentionTitle')}
            </h2>
            <p>{t('legal.privacyRetentionBody')}</p>
          </section>
          <section>
            <h2 className="text-lg font-medium text-gray-900 dark:text-white mt-6 mb-2">
              {t('legal.privacySecurityTitle')}
            </h2>
            <p>{t('legal.privacySecurityBody')}</p>
          </section>
          <section>
            <h2 className="text-lg font-medium text-gray-900 dark:text-white mt-6 mb-2">
              {t('legal.privacyRightsTitle')}
            </h2>
            <p>{t('legal.privacyRightsBody')}</p>
          </section>
          <section>
            <h2 className="text-lg font-medium text-gray-900 dark:text-white mt-6 mb-2">
              {t('legal.privacyDPATitle')}
            </h2>
            <p>{t('legal.privacyDPABody')}</p>
          </section>
          <section>
            <h2 className="text-lg font-medium text-gray-900 dark:text-white mt-6 mb-2">
              {t('legal.privacyAutomatedTitle')}
            </h2>
            <p>{t('legal.privacyAutomatedBody')}</p>
          </section>
          <section>
            <h2 className="text-lg font-medium text-gray-900 dark:text-white mt-6 mb-2">
              {t('legal.privacyCookiesTitle')}
            </h2>
            <p>{t('legal.privacyCookiesBody')}</p>
          </section>
          <section>
            <h2 className="text-lg font-medium text-gray-900 dark:text-white mt-6 mb-2">
              {t('legal.privacyHostingTitle')}
            </h2>
            <p>{t('legal.privacyHostingBody')}</p>
          </section>
          <section>
            <h2 className="text-lg font-medium text-gray-900 dark:text-white mt-6 mb-2">
              {t('legal.privacySupervisoryTitle')}
            </h2>
            <p>{t('legal.privacySupervisoryBody')}</p>
          </section>
          <section>
            <h2 className="text-lg font-medium text-gray-900 dark:text-white mt-6 mb-2">
              {t('legal.privacyChangesTitle')}
            </h2>
            <p>{t('legal.privacyChangesBody')}</p>
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
