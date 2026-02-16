import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import MarketingLayout from '../../components/MarketingLayout';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../components/ui/card';

export default function Pricing() {
  const { t } = useTranslation();
  const [billingInterval, setBillingInterval] = useState<'monthly' | 'yearly'>('monthly');

  return (
    <MarketingLayout>
      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-16">
        <div className="text-center mb-12">
          <h1 className="text-3xl sm:text-4xl font-bold text-foreground">{t('pricing.title')}</h1>
          <p className="mt-2 text-muted-foreground">{t('pricing.positioning')}</p>
          <div className="mt-4 flex items-center justify-center gap-2">
            <button
              type="button"
              onClick={() => setBillingInterval('monthly')}
              className={`px-4 py-2 text-sm font-medium rounded-lg transition-colors ${
                billingInterval === 'monthly'
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-muted text-muted-foreground hover:bg-accent'
              }`}
            >
              {t('pricing.billingMonthly')}
            </button>
            <button
              type="button"
              onClick={() => setBillingInterval('yearly')}
              className={`px-4 py-2 text-sm font-medium rounded-lg transition-colors ${
                billingInterval === 'yearly'
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-muted text-muted-foreground hover:bg-accent'
              }`}
            >
              {t('pricing.billingYearly')}
            </button>
          </div>
        </div>

        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-6">
          <Card className="flex flex-col">
            <CardHeader>
              <CardTitle>{t('pricing.free')}</CardTitle>
              <p className="text-2xl font-bold">{t('pricing.freePrice')}</p>
            </CardHeader>
            <CardContent className="flex-1 space-y-4">
              <ul className="space-y-2 text-sm text-muted-foreground">
                <li>{t('pricing.freeValue1')}</li>
                <li>{t('pricing.freeValue2')}</li>
                <li>{t('pricing.freeValue3')}</li>
              </ul>
              <Link
                to="/app/signup"
                className="block text-center px-4 py-2 text-sm font-medium text-primary border border-primary rounded-lg hover:bg-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              >
                {t('pricing.ctaStartFree')}
              </Link>
            </CardContent>
          </Card>

          <Card className="flex flex-col border-primary/50 ring-2 ring-primary/20 relative">
            <span className="absolute -top-3 left-1/2 -translate-x-1/2 px-2.5 py-0.5 text-xs font-medium bg-primary/10 text-primary rounded-full">
              {t('pricing.mostPopular')}
            </span>
            <CardHeader>
              <CardTitle className="mt-1">{t('pricing.personal')}</CardTitle>
              <p className="text-2xl font-bold">{t('pricing.personalPrice')}</p>
              <CardDescription>{t('pricing.personalYearly')}</CardDescription>
            </CardHeader>
            <CardContent className="flex-1 space-y-4">
              <ul className="space-y-2 text-sm text-muted-foreground">
                <li>{t('pricing.personalValue1')}</li>
                <li>{t('pricing.personalValue2')}</li>
                <li>{t('pricing.personalValue3')}</li>
                <li>{t('pricing.personalValue4')}</li>
              </ul>
              <Link
                to="/app/signup"
                className="block text-center px-4 py-2 text-sm font-medium text-primary-foreground bg-primary hover:bg-primary/90 rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              >
                {t('pricing.ctaStartFree')}
              </Link>
            </CardContent>
          </Card>

          <Card className="flex flex-col">
            <CardHeader>
              <CardTitle>{t('pricing.team')}</CardTitle>
              <p className="text-2xl font-bold">
                {billingInterval === 'monthly' ? t('pricing.teamPrice') : t('pricing.teamPriceYearly')}
              </p>
              <CardDescription>
                {t('pricing.teamUsers')} · {billingInterval === 'monthly' ? t('pricing.teamExtraUser') : t('pricing.teamExtraUserYearly')}
              </CardDescription>
            </CardHeader>
            <CardContent className="flex-1 space-y-4">
              <ul className="space-y-2 text-sm text-muted-foreground">
                <li>{t('pricing.teamValue1')}</li>
                <li>{t('pricing.teamValue2')}</li>
                <li>{t('pricing.teamValue3')}</li>
                <li>{t('pricing.teamValue4')}</li>
              </ul>
              <Link
                to="/app/signup"
                className="block text-center px-4 py-2 text-sm font-medium text-primary-foreground bg-primary hover:bg-primary/90 rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              >
                {t('pricing.ctaChoosePlan')}
              </Link>
            </CardContent>
          </Card>

          <Card className="flex flex-col border-amber-500/50">
            <CardHeader>
              <CardTitle>{t('pricing.earlySupporter')}</CardTitle>
              <p className="text-sm font-medium text-amber-600 dark:text-amber-400">{t('pricing.earlySupporterLifetime')}</p>
              <p className="text-2xl font-bold">{t('pricing.earlySupporterPrice')}</p>
            </CardHeader>
            <CardContent className="flex-1 space-y-4">
              <ul className="space-y-2 text-sm text-muted-foreground">
                <li>{t('pricing.earlySupporterHelp')}</li>
                <li>{t('pricing.earlySupporterIncludes')}</li>
                <li>{t('pricing.earlySupporterValue4')}</li>
                <li>{t('pricing.earlySupporterSeats')}</li>
                <li className="text-xs">{t('pricing.earlySupporterNote')}</li>
              </ul>
              <Link
                to="/contact"
                className="block text-center px-4 py-2 text-sm font-medium text-amber-700 dark:text-amber-400 border border-amber-500 rounded-lg hover:bg-amber-50 dark:hover:bg-amber-900/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-offset-2"
              >
                {t('pricing.ctaBecomeEarlySupporter')}
              </Link>
            </CardContent>
          </Card>
        </div>

        {/* Comparison section */}
        <div className="mt-16">
          <h2 className="text-lg font-semibold text-center mb-6">
            {t('pricing.comparisonTitle')}
          </h2>
          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <Card>
              <CardHeader className="p-4">
                <CardTitle className="text-sm">{t('pricing.free')}</CardTitle>
                <CardDescription>{t('pricing.comparisonFree')}</CardDescription>
              </CardHeader>
            </Card>
            <Card>
              <CardHeader className="p-4">
                <CardTitle className="text-sm">{t('pricing.personal')}</CardTitle>
                <CardDescription>{t('pricing.comparisonPersonal')}</CardDescription>
              </CardHeader>
            </Card>
            <Card>
              <CardHeader className="p-4">
                <CardTitle className="text-sm">{t('pricing.team')}</CardTitle>
                <CardDescription>{t('pricing.comparisonTeam')}</CardDescription>
              </CardHeader>
            </Card>
            <Card className="border-amber-500/50">
              <CardHeader className="p-4">
                <CardTitle className="text-sm">{t('pricing.earlySupporter')}</CardTitle>
                <CardDescription>{t('pricing.comparisonEarlySupporter')}</CardDescription>
              </CardHeader>
            </Card>
          </div>
        </div>
      </div>
    </MarketingLayout>
  );
}
