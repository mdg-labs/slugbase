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
          <h1 className="text-5xl sm:text-6xl lg:text-7xl font-bold text-foreground tracking-tight">
            {t('landing.heroHeadline')}
          </h1>
          <p className="mt-6 text-xl text-muted-foreground max-w-2xl mx-auto">
            {t('landing.heroSubheadline')}
          </p>
          <p className="mt-4 text-base text-muted-foreground">
            {t('landing.heroBadges')}
          </p>
          <div className="mt-10 flex flex-col sm:flex-row items-center justify-center gap-4">
            <Link
              to="/app/signup"
              className="inline-flex items-center justify-center px-8 py-3.5 text-base font-semibold text-primary-foreground bg-primary hover:bg-primary/90 rounded-lg transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            >
              {t('landing.ctaStartFree')}
            </Link>
          </div>
          {/* Proof strip: Open Source + API docs */}
          <div className="mt-8 flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-sm text-muted-foreground">
            <span>{t('landing.proofOpenSource')}</span>
            <span>·</span>
            <span>{t('landing.proofApiDocs')}</span>
          </div>
          {/* Example snippet */}
          <div className="mt-12 px-4 py-3 rounded-lg bg-primary/10 border border-primary/30 ring-1 ring-primary/30 inline-block">
            <code className="text-base font-mono text-muted-foreground inline-flex flex-wrap justify-center gap-x-4 gap-y-1">
              {exampleUrls.map((url, i) => (
                <span key={i}>{url}</span>
              ))}
            </code>
          </div>
        </div>

        {/* Why browser bookmarks aren't enough (problem framing) - moved up */}
        <div className="mt-24 sm:mt-32 grid sm:grid-cols-2 gap-8 max-w-3xl mx-auto">
          <div className="bg-card rounded-xl border border-border p-6">
            <h3 className="text-lg font-semibold text-foreground">{t('landing.problemTitle')}</h3>
            <ul className="mt-4 space-y-2 text-sm text-muted-foreground list-disc list-inside">
              <li>{t('landing.problem1')}</li>
              <li>{t('landing.problem2')}</li>
              <li>{t('landing.problem3')}</li>
            </ul>
          </div>
          <div className="bg-card rounded-xl border border-primary/30 p-6">
            <h3 className="text-lg font-semibold text-foreground">{t('landing.solutionTitle')}</h3>
            <ul className="mt-4 space-y-2 text-sm text-muted-foreground list-disc list-inside">
              <li>{t('landing.solution1')}</li>
              <li>{t('landing.solution2')}</li>
              <li>{t('landing.solution3')}</li>
            </ul>
          </div>
        </div>

        {/* How it works */}
        <div className="mt-24 sm:mt-32">
          <h2 className="text-xl font-semibold text-foreground text-center mb-8">
            {t('landing.howItWorksTitle')}
          </h2>
          <div className="grid sm:grid-cols-3 gap-6 text-center">
            <div className="bg-card rounded-xl border border-border p-6">
              <span className="inline-flex items-center justify-center w-10 h-10 rounded-full bg-primary/20 text-primary font-semibold">1</span>
              <h3 className="mt-4 text-base font-medium text-foreground">{t('landing.howItWorksStep1')}</h3>
              <p className="mt-2 text-sm text-muted-foreground">{t('landing.howItWorksStep1Detail')}</p>
            </div>
            <div className="bg-card rounded-xl border border-border p-6">
              <span className="inline-flex items-center justify-center w-10 h-10 rounded-full bg-primary/20 text-primary font-semibold">2</span>
              <h3 className="mt-4 text-base font-medium text-foreground">{t('landing.howItWorksStep2')}</h3>
              <p className="mt-2 text-sm text-muted-foreground">{t('landing.howItWorksStep2Detail')}</p>
            </div>
            <div className="bg-card rounded-xl border border-border p-6">
              <span className="inline-flex items-center justify-center w-10 h-10 rounded-full bg-primary/20 text-primary font-semibold">3</span>
              <h3 className="mt-4 text-base font-medium text-foreground">{t('landing.howItWorksStep3')}</h3>
              <p className="mt-2 text-sm text-muted-foreground">{t('landing.howItWorksStep3Detail')}</p>
            </div>
          </div>
        </div>

        {/* Key differentiators / features (includes AI) */}
        <div className="mt-24 sm:mt-32">
          <h2 className="text-xl font-semibold text-foreground text-center mb-8">
            {t('landing.featuresTitle')}
          </h2>
          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-8">
            <div className="bg-card rounded-xl border border-border p-6">
              <h3 className="text-lg font-semibold text-foreground">{t('landing.feature1Title')}</h3>
              <p className="mt-2 text-sm text-muted-foreground">{t('landing.feature1Desc')}</p>
            </div>
            <div className="bg-card rounded-xl border border-border p-6">
              <h3 className="text-lg font-semibold text-foreground">{t('landing.feature2Title')}</h3>
              <p className="mt-2 text-sm text-muted-foreground">{t('landing.feature2Desc')}</p>
            </div>
            <div className="bg-card rounded-xl border border-border p-6">
              <h3 className="text-lg font-semibold text-foreground">{t('landing.feature3Title')}</h3>
              <p className="mt-2 text-sm text-muted-foreground">{t('landing.feature3Desc')}</p>
            </div>
            <div className="bg-card rounded-xl border border-primary/30 p-6">
              <h3 className="text-lg font-semibold text-foreground">{t('landing.featureAiTitle')}</h3>
              <p className="mt-2 text-sm text-muted-foreground">{t('landing.featureAiDesc')}</p>
            </div>
          </div>
          <div className="mt-10 text-center">
            <Link
              to="/app/signup"
              className="inline-flex items-center justify-center px-6 py-2.5 text-sm font-medium text-primary hover:text-primary/90 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded"
            >
              {t('landing.ctaStartFree')} →
            </Link>
          </div>
        </div>

        {/* Lightweight UI preview */}
        <div className="mt-24 sm:mt-32 flex justify-center">
          <div className="w-full max-w-md bg-card rounded-xl border border-border p-4 shadow-lg">
            <div className="flex items-center gap-2 mb-3">
              <div className="w-2 h-2 rounded-full bg-muted-foreground/50" />
              <div className="w-2 h-2 rounded-full bg-muted-foreground/50" />
              <div className="w-2 h-2 rounded-full bg-muted-foreground/50" />
            </div>
            <div className="space-y-2">
              {[
                { title: 'React Docs', slug: 'react', tags: 'docs, frontend' },
                { title: 'Vite Guide', slug: 'vite', tags: 'build, dev' },
                { title: 'API Reference', slug: 'api', tags: 'backend' },
              ].map((b, i) => (
                <div key={i} className="flex items-center justify-between py-2 px-3 rounded-lg bg-muted/50">
                  <span className="text-sm font-medium text-foreground truncate">{b.title}</span>
                  <span className="text-xs text-muted-foreground ml-2 shrink-0">/{b.slug}</span>
                  <span className="text-xs text-muted-foreground/80 truncate max-w-[100px]">{b.tags}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Pricing preview */}
        <div className="mt-24 sm:mt-32" id="pricing">
          <h2 className="text-xl font-semibold text-foreground text-center mb-2">
            {t('landing.pricingTitle')}
          </h2>
          <p className="text-center text-muted-foreground text-sm mb-8">
            {t('landing.pricingSubtitle')}
          </p>
          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-6 max-w-5xl mx-auto">
            <div className="bg-card rounded-xl border border-border p-6 flex flex-col text-center">
              <h3 className="text-lg font-semibold text-foreground">{t('pricing.free')}</h3>
              <p className="mt-2 text-2xl font-bold text-foreground">{t('pricing.freePrice')}</p>
              <p className="mt-2 text-sm text-muted-foreground">{t('pricing.freeBookmarks')}</p>
              <Link to="/app/signup" className="mt-6 inline-flex items-center justify-center px-4 py-2 text-sm font-medium text-primary border border-primary rounded-lg hover:bg-primary/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2">
                {t('landing.ctaStartFree')}
              </Link>
            </div>
            <div className="bg-card rounded-xl border border-primary/30 p-6 flex flex-col text-center ring-2 ring-primary/20 relative">
              <span className="absolute -top-3 left-1/2 -translate-x-1/2 px-2.5 py-0.5 text-xs font-medium bg-primary/20 text-primary rounded-full">
                {t('pricing.mostPopular')}
              </span>
              <h3 className="text-lg font-semibold text-foreground mt-1">{t('pricing.personal')}</h3>
              <p className="mt-2 text-2xl font-bold text-foreground">{t('pricing.personalPrice')}</p>
              <p className="mt-2 text-sm text-muted-foreground">{t('pricing.personalBookmarks')}</p>
              <p className="mt-1 text-xs text-primary font-medium">{t('pricing.personalValue4')}</p>
              <Link to="/app/signup" className="mt-6 inline-flex items-center justify-center px-4 py-2 text-sm font-medium text-primary-foreground bg-primary hover:bg-primary/90 rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2">
                {t('landing.ctaStartFree')}
              </Link>
            </div>
            <div className="bg-card rounded-xl border border-border p-6 flex flex-col text-center">
              <h3 className="text-lg font-semibold text-foreground">{t('pricing.team')}</h3>
              <p className="mt-2 text-2xl font-bold text-foreground">{t('pricing.teamPrice')}</p>
              <p className="mt-2 text-sm text-muted-foreground">{t('pricing.teamUsers')} · {t('pricing.teamExtraUser')}</p>
              <p className="mt-1 text-xs text-primary font-medium">{t('pricing.teamValue4')}</p>
              <Link to="/app/signup" className="mt-6 inline-flex items-center justify-center px-4 py-2 text-sm font-medium text-primary-foreground bg-primary hover:bg-primary/90 rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2">
                {t('pricing.ctaChoosePlan')}
              </Link>
            </div>
            <div className="bg-card rounded-xl border border-amber-200 dark:border-amber-800 p-6 flex flex-col text-center">
              <h3 className="text-lg font-semibold text-foreground">{t('pricing.earlySupporter')}</h3>
              <p className="mt-2 text-sm font-medium text-amber-700 dark:text-amber-400">{t('pricing.earlySupporterLifetime')}</p>
              <p className="mt-1 text-2xl font-bold text-foreground">{t('pricing.earlySupporterPrice')}</p>
              <Link to="/contact" className="mt-6 inline-flex items-center justify-center px-4 py-2 text-sm font-medium text-amber-700 dark:text-amber-400 border border-amber-500 rounded-lg hover:bg-amber-50 dark:hover:bg-amber-900/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-offset-2">
                {t('pricing.ctaContact')}
              </Link>
            </div>
          </div>
          <p className="mt-6 text-center text-sm text-muted-foreground">
            {t('landing.pricingTeaser')}
          </p>
          <div className="mt-6 text-center">
            <Link to="/pricing" className="text-sm font-medium text-primary hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded">
              {t('landing.viewAllPlans')} →
            </Link>
          </div>
        </div>

        {/* Built for … (audience tiles) */}
        <div className="mt-24 sm:mt-32">
          <h2 className="text-xl font-semibold text-foreground text-center mb-8">
            {t('landing.useCaseTitle')}
          </h2>
          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-6">
            <div className="bg-card rounded-xl border border-border p-6">
              <h3 className="text-lg font-semibold text-foreground">{t('landing.useCaseDevTitle')}</h3>
              <p className="mt-2 text-sm text-muted-foreground">{t('landing.useCaseDevDesc')}</p>
            </div>
            <div className="bg-card rounded-xl border border-border p-6">
              <h3 className="text-lg font-semibold text-foreground">{t('landing.useCaseProductTitle')}</h3>
              <p className="mt-2 text-sm text-muted-foreground">{t('landing.useCaseProductDesc')}</p>
            </div>
            <div className="bg-card rounded-xl border border-border p-6">
              <h3 className="text-lg font-semibold text-foreground">{t('landing.useCaseFounderTitle')}</h3>
              <p className="mt-2 text-sm text-muted-foreground">{t('landing.useCaseFounderDesc')}</p>
            </div>
            <div className="bg-card rounded-xl border border-border p-6">
              <h3 className="text-lg font-semibold text-foreground">{t('landing.useCaseSelfHostTitle')}</h3>
              <p className="mt-2 text-sm text-muted-foreground">{t('landing.useCaseSelfHostDesc')}</p>
            </div>
          </div>
        </div>

        {/* Trust signals (footer strip) */}
        <div className="mt-24 flex flex-wrap items-center justify-center gap-6 text-base text-muted-foreground">
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 hover:text-foreground transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded"
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
            className="inline-flex items-center gap-2 hover:text-foreground transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded"
          >
            {t('landing.trustApiDocs')}
            <ExternalLink className="h-3.5 w-3.5" aria-hidden />
          </a>
        </div>
      </div>
    </MarketingLayout>
  );
}
