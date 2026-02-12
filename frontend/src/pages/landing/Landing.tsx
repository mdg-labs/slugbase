import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Star, ExternalLink } from 'lucide-react';
import MarketingLayout from '../../components/MarketingLayout';

const GITHUB_URL = 'https://github.com/mdg-labs/slugbase';
const DOCS_URL = 'https://docs.slugbase.app';

export default function Landing() {
  const { t } = useTranslation();
  const exampleUrls = t('landing.exampleSnippet').split(/\s{2,}/);

  return (
    <MarketingLayout>
      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-20 sm:py-28">
        {/* Hero */}
        <div className="text-center">
          <h1 className="text-6xl sm:text-7xl font-bold text-gray-900 dark:text-white tracking-tight">
            {t('landing.heroHeadline')}
          </h1>
          <p className="mt-6 text-xl text-gray-600 dark:text-gray-300 max-w-2xl mx-auto">
            {t('landing.heroSubheadline')}
          </p>
          <p className="mt-4 text-base text-gray-600 dark:text-gray-300">
            {t('landing.heroBadges')}
          </p>
          <div className="mt-10 flex flex-col sm:flex-row items-center justify-center gap-4">
            <Link
              to="/app/signup"
              className="inline-flex items-center justify-center px-8 py-3.5 text-base font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-gray-900"
            >
              {t('landing.ctaStartFree')}
            </Link>
            <Link
              to="/app/signup"
              className="inline-flex items-center justify-center px-8 py-3 text-base font-medium text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-700 rounded-lg transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-gray-900"
            >
              {t('landing.ctaViewDemo')}
            </Link>
          </div>
          {/* Example snippet */}
          <div className="mt-12 px-4 py-3 rounded-lg bg-blue-50/50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 ring-1 ring-blue-200 dark:ring-blue-800 inline-block">
            <code className="text-base font-mono text-gray-700 dark:text-gray-300 inline-flex flex-wrap justify-center gap-x-4 gap-y-1">
              {exampleUrls.map((url, i) => (
                <span key={i}>{url}</span>
              ))}
            </code>
          </div>
        </div>

        {/* Trust signals */}
        <div className="mt-16 flex flex-wrap items-center justify-center gap-6 text-base text-gray-600 dark:text-gray-300">
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 hover:text-gray-900 dark:hover:text-white transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 rounded"
            aria-label={t('landing.trustOpenSource')}
          >
            <Star className="h-4 w-4" aria-hidden />
            {t('landing.trustOpenSource')}
            <ExternalLink className="h-3.5 w-3.5" aria-hidden />
          </a>
          <span className="inline-flex items-center">{t('landing.trustActiveDev')}</span>
          <a
            href={DOCS_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 hover:text-gray-900 dark:hover:text-white transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 rounded"
          >
            {t('landing.trustApiDocs')}
            <ExternalLink className="h-3.5 w-3.5" aria-hidden />
          </a>
          <span className="inline-flex items-center">{t('landing.trustDemoResets')}</span>
        </div>

        {/* How it works */}
        <div className="mt-24 sm:mt-32">
          <h2 className="text-xl font-semibold text-gray-900 dark:text-white text-center mb-8">
            {t('landing.howItWorksTitle')}
          </h2>
          <div className="grid sm:grid-cols-3 gap-6 text-center">
            <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-6">
              <span className="inline-flex items-center justify-center w-10 h-10 rounded-full bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 font-semibold">1</span>
              <h3 className="mt-4 text-base font-medium text-gray-900 dark:text-white">{t('landing.howItWorksStep1')}</h3>
              <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">{t('landing.howItWorksStep1Detail')}</p>
            </div>
            <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-6">
              <span className="inline-flex items-center justify-center w-10 h-10 rounded-full bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 font-semibold">2</span>
              <h3 className="mt-4 text-base font-medium text-gray-900 dark:text-white">{t('landing.howItWorksStep2')}</h3>
              <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">{t('landing.howItWorksStep2Detail')}</p>
            </div>
            <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-6">
              <span className="inline-flex items-center justify-center w-10 h-10 rounded-full bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 font-semibold">3</span>
              <h3 className="mt-4 text-base font-medium text-gray-900 dark:text-white">{t('landing.howItWorksStep3')}</h3>
              <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">{t('landing.howItWorksStep3Detail')}</p>
            </div>
          </div>
        </div>

        {/* Problem → Solution */}
        <div className="mt-24 sm:mt-32 grid sm:grid-cols-2 gap-8 max-w-3xl mx-auto">
          <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-6">
            <h3 className="text-lg font-semibold text-gray-900 dark:text-white">{t('landing.problemTitle')}</h3>
            <ul className="mt-4 space-y-2 text-sm text-gray-600 dark:text-gray-400 list-disc list-inside">
              <li>{t('landing.problem1')}</li>
              <li>{t('landing.problem2')}</li>
              <li>{t('landing.problem3')}</li>
            </ul>
          </div>
          <div className="bg-white dark:bg-gray-800 rounded-xl border border-blue-200 dark:border-blue-800 p-6">
            <h3 className="text-lg font-semibold text-gray-900 dark:text-white">{t('landing.solutionTitle')}</h3>
            <ul className="mt-4 space-y-2 text-sm text-gray-600 dark:text-gray-400 list-disc list-inside">
              <li>{t('landing.solution1')}</li>
              <li>{t('landing.solution2')}</li>
              <li>{t('landing.solution3')}</li>
            </ul>
          </div>
        </div>

        {/* Pricing snippet */}
        <div className="mt-24 sm:mt-32" id="pricing">
          <h2 className="text-xl font-semibold text-gray-900 dark:text-white text-center mb-2">
            {t('landing.pricingTitle')}
          </h2>
          <p className="text-center text-gray-600 dark:text-gray-400 text-sm mb-8">
            {t('landing.pricingSubtitle')}
          </p>
          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-6 max-w-5xl mx-auto">
            <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-6 flex flex-col text-center">
              <h3 className="text-lg font-semibold text-gray-900 dark:text-white">{t('pricing.free')}</h3>
              <p className="mt-2 text-2xl font-bold text-gray-900 dark:text-white">{t('pricing.freePrice')}</p>
              <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">{t('pricing.freeBookmarks')}</p>
              <Link to="/app/signup" className="mt-6 inline-flex items-center justify-center px-4 py-2 text-sm font-medium text-blue-600 dark:text-blue-400 border border-blue-600 dark:border-blue-400 rounded-lg hover:bg-blue-50 dark:hover:bg-blue-900/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2">
                {t('landing.ctaStartFree')}
              </Link>
            </div>
            <div className="bg-white dark:bg-gray-800 rounded-xl border border-blue-200 dark:border-blue-800 p-6 flex flex-col text-center ring-2 ring-blue-500/20 relative">
              <span className="absolute -top-3 left-1/2 -translate-x-1/2 px-2.5 py-0.5 text-xs font-medium bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300 rounded-full">
                {t('pricing.mostPopular')}
              </span>
              <h3 className="text-lg font-semibold text-gray-900 dark:text-white mt-1">{t('pricing.personal')}</h3>
              <p className="mt-2 text-2xl font-bold text-gray-900 dark:text-white">{t('pricing.personalPrice')}</p>
              <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">{t('pricing.personalBookmarks')}</p>
              <Link to="/app/signup" className="mt-6 inline-flex items-center justify-center px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2">
                {t('landing.ctaStartFree')}
              </Link>
            </div>
            <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-6 flex flex-col text-center">
              <h3 className="text-lg font-semibold text-gray-900 dark:text-white">{t('pricing.team')}</h3>
              <p className="mt-2 text-2xl font-bold text-gray-900 dark:text-white">{t('pricing.teamPrice')}</p>
              <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">{t('pricing.teamUsers')} · {t('pricing.teamExtraUser')}</p>
              <Link to="/app/signup" className="mt-6 inline-flex items-center justify-center px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2">
                {t('pricing.ctaChoosePlan')}
              </Link>
            </div>
            <div className="bg-white dark:bg-gray-800 rounded-xl border border-amber-200 dark:border-amber-800 p-6 flex flex-col text-center">
              <h3 className="text-lg font-semibold text-gray-900 dark:text-white">{t('pricing.earlySupporter')}</h3>
              <p className="mt-2 text-sm font-medium text-amber-700 dark:text-amber-400">{t('pricing.earlySupporterLifetime')}</p>
              <p className="mt-1 text-2xl font-bold text-gray-900 dark:text-white">{t('pricing.earlySupporterPrice')}</p>
              <Link to="/contact" className="mt-6 inline-flex items-center justify-center px-4 py-2 text-sm font-medium text-amber-700 dark:text-amber-400 border border-amber-500 rounded-lg hover:bg-amber-50 dark:hover:bg-amber-900/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-offset-2">
                {t('pricing.ctaContact')}
              </Link>
            </div>
          </div>
          <p className="mt-6 text-center text-sm text-gray-600 dark:text-gray-400">
            {t('landing.pricingTeaser')}
          </p>
          <div className="mt-6 text-center">
            <Link to="/pricing" className="text-sm font-medium text-blue-600 dark:text-blue-400 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 rounded">
              {t('landing.viewAllPlans')} →
            </Link>
          </div>
        </div>

        {/* Why SlugBase */}
        <div className="mt-24 sm:mt-32">
          <h2 className="text-xl font-semibold text-gray-900 dark:text-white text-center mb-8">
            {t('landing.featuresTitle')}
          </h2>
          <div className="grid sm:grid-cols-3 gap-8">
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
          <div className="mt-10 text-center">
            <Link
              to="/app/signup"
              className="inline-flex items-center justify-center px-6 py-2.5 text-sm font-medium text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 rounded"
            >
              {t('landing.ctaStartFree')} →
            </Link>
          </div>
        </div>

        {/* Built for modern workflows */}
        <div className="mt-24 sm:mt-32">
          <h2 className="text-xl font-semibold text-gray-900 dark:text-white text-center mb-8">
            {t('landing.useCaseTitle')}
          </h2>
          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-6">
            <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-6">
              <h3 className="text-lg font-semibold text-gray-900 dark:text-white">{t('landing.useCaseDevTitle')}</h3>
              <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">{t('landing.useCaseDevDesc')}</p>
            </div>
            <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-6">
              <h3 className="text-lg font-semibold text-gray-900 dark:text-white">{t('landing.useCaseProductTitle')}</h3>
              <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">{t('landing.useCaseProductDesc')}</p>
            </div>
            <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-6">
              <h3 className="text-lg font-semibold text-gray-900 dark:text-white">{t('landing.useCaseFounderTitle')}</h3>
              <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">{t('landing.useCaseFounderDesc')}</p>
            </div>
            <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-6">
              <h3 className="text-lg font-semibold text-gray-900 dark:text-white">{t('landing.useCaseSelfHostTitle')}</h3>
              <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">{t('landing.useCaseSelfHostDesc')}</p>
            </div>
          </div>
        </div>
      </div>
    </MarketingLayout>
  );
}
