import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import MarketingLayout from '../../components/MarketingLayout';

const COMPANY = {
  name: 'Guggernbichler Michael David',
  legalForm: 'Einzelunternehmen',
  address: 'Linzer Str. 17',
  city: '4100 Ottensheim',
  country: 'Austria',
  uid: 'ATU82945789',
  email: 'hello@slugbase.app',
  chamber: 'WKO Oberösterreich',
};

const ODR_URL = 'https://ec.europa.eu/consumers/odr';

export default function Imprint() {
  const { t } = useTranslation();

  return (
    <MarketingLayout>
      <div className="max-w-2xl mx-auto px-4 sm:px-6 py-16">
        <h1 className="text-2xl font-semibold text-gray-900 dark:text-white mb-6">
          {t('legal.imprintTitle')}
        </h1>
        <div className="prose prose-gray dark:prose-invert max-w-none space-y-6 text-gray-700 dark:text-gray-300">
          <section>
            <h2 className="text-lg font-medium text-gray-900 dark:text-white mt-6 mb-2">
              {t('legal.imprintProviderTitle')}
            </h2>
            <p>
              {COMPANY.name}<br />
              {COMPANY.legalForm}<br />
              {COMPANY.address}<br />
              {COMPANY.city}, {COMPANY.country}
            </p>
            <p className="mt-2">
              {t('legal.uid')}: {COMPANY.uid}
            </p>
            <p className="mt-2">
              <a
                href={`mailto:${COMPANY.email}`}
                className="text-blue-600 dark:text-blue-400 hover:underline"
              >
                {COMPANY.email}
              </a>
            </p>
            <p className="mt-2">{t('legal.imprintChamber', { chamber: COMPANY.chamber })}</p>
          </section>
          <section>
            <h2 className="text-lg font-medium text-gray-900 dark:text-white mt-6 mb-2">
              {t('legal.imprintCourtTitle')}
            </h2>
            <p>{t('legal.imprintCourtBody')}</p>
          </section>
          <section>
            <h2 className="text-lg font-medium text-gray-900 dark:text-white mt-6 mb-2">
              {t('legal.imprintOdrTitle')}
            </h2>
            <p>
              {t('legal.imprintOdrBody')}{' '}
              <a
                href={ODR_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-600 dark:text-blue-400 hover:underline"
              >
                {ODR_URL}
              </a>
            </p>
          </section>
          {t('legal.imprintAppliesTo') && (
            <p className="mt-4 text-sm text-muted-foreground">
              {t('legal.imprintAppliesTo')}
            </p>
          )}
        </div>
        <p className="mt-8 text-sm text-gray-500 dark:text-gray-400">
          <Link to="/" className="text-blue-600 dark:text-blue-400 hover:underline">
            {t('legal.backToHome')}
          </Link>
        </p>
      </div>
    </MarketingLayout>
  );
}
