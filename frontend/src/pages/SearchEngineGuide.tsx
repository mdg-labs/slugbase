import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Code } from 'lucide-react';
import { Link } from 'react-router-dom';
import Button from '../components/ui/Button';
import { PageHeader } from '../components/PageHeader';
import { ScopeSegmentedControl } from '../components/ScopeSegmentedControl';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { useAppConfig } from '../contexts/AppConfigContext';

export default function SearchEngineGuide() {
  const { t } = useTranslation();
  const { pathPrefixForLinks } = useAppConfig();
  const prefix = (pathPrefixForLinks || '').replace(/\/+/g, '/') || '';
  const [activeTab, setActiveTab] = useState<'chromium' | 'firefox'>('chromium');

  const baseUrl = window.location.origin;
  const goPath = '/go/%s';
  const searchUrl = `${baseUrl}${goPath}`;

  const tabOptions = [
    { value: 'chromium', label: t('searchEngineGuide.tabChromium') },
    { value: 'firefox', label: t('searchEngineGuide.tabFirefox') },
  ];

  return (
    <div className="space-y-6 max-w-4xl mx-auto">
      {/* Header: back + PageHeader with tabs */}
      <div className="flex flex-col gap-4">
        <Link to={`${prefix}/bookmarks`}>
          <Button variant="ghost" size="sm" icon={ArrowLeft}>
            {t('common.back')}
          </Button>
        </Link>
        <PageHeader
          title={t('searchEngineGuide.title')}
          subtitle={t('searchEngineGuide.description')}
          actions={
            <ScopeSegmentedControl
              value={activeTab}
              onChange={(v) => setActiveTab(v as 'chromium' | 'firefox')}
              options={tabOptions}
              ariaLabel={t('searchEngineGuide.title')}
            />
          }
        />
      </div>

      {/* How it works */}
      <Card className="bg-primary/10 border-primary/30">
        <CardHeader>
          <CardTitle className="text-xl text-foreground">
            {t('searchEngineGuide.howItWorks')}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-muted-foreground">
            {t('searchEngineGuide.howItWorksDescription')}
          </p>
          <div className="bg-card rounded-lg p-4 border border-border">
            <div className="flex items-center gap-2 text-sm font-mono text-foreground">
              <Code className="h-4 w-4 text-primary" />
              <span className="text-primary">go</span>
              <span className="text-muted-foreground">your-slug</span>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Your search URL */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">{t('searchEngineGuide.yourSearchUrl')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="bg-muted rounded-lg p-4 border border-border">
            <code className="text-sm font-mono text-foreground break-all">{searchUrl}</code>
          </div>
          <p className="text-sm text-muted-foreground">{t('searchEngineGuide.urlNote')}</p>
        </CardContent>
      </Card>

      {/* Chromium steps (only when active) */}
      {activeTab === 'chromium' && (
        <div className="space-y-4">
          <h2 className="text-lg font-semibold text-foreground">
            {t('searchEngineGuide.chromiumTitle')}
          </h2>
          <p className="text-muted-foreground text-sm">
            {t('searchEngineGuide.chromiumDescription')}
          </p>
          <div className="space-y-4">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">
                  {t('searchEngineGuide.stepTitle', { n: 1 })}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-foreground">{t('searchEngineGuide.chromiumStep1')}</p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">
                  {t('searchEngineGuide.stepTitle', { n: 2 })}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-foreground">{t('searchEngineGuide.chromiumStep2')}</p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">
                  {t('searchEngineGuide.stepTitle', { n: 3 })}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-foreground">{t('searchEngineGuide.chromiumStep3')}</p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">
                  {t('searchEngineGuide.stepTitle', { n: 4 })}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <p className="text-foreground">{t('searchEngineGuide.chromiumStep4')}</p>
                <ul className="list-disc list-inside space-y-1 text-sm text-muted-foreground ml-2">
                  <li>{t('searchEngineGuide.chromiumStep4a')}</li>
                  <li>{t('searchEngineGuide.chromiumStep4b')}</li>
                  <li>{t('searchEngineGuide.chromiumStep4c')}</li>
                </ul>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">
                  {t('searchEngineGuide.stepTitle', { n: 5 })}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-foreground">{t('searchEngineGuide.chromiumStep5')}</p>
              </CardContent>
            </Card>
          </div>
        </div>
      )}

      {/* Firefox steps (only when active) */}
      {activeTab === 'firefox' && (
        <div className="space-y-4">
          <h2 className="text-lg font-semibold text-foreground">
            {t('searchEngineGuide.firefoxTitle')}
          </h2>
          <p className="text-muted-foreground text-sm">
            {t('searchEngineGuide.firefoxDescription')}
          </p>
          <div className="space-y-4">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">
                  {t('searchEngineGuide.stepTitle', { n: 1 })}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-foreground">{t('searchEngineGuide.firefoxStep1')}</p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">
                  {t('searchEngineGuide.stepTitle', { n: 2 })}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-foreground">{t('searchEngineGuide.firefoxStep2')}</p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">
                  {t('searchEngineGuide.stepTitle', { n: 3 })}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-foreground">{t('searchEngineGuide.firefoxStep3')}</p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">
                  {t('searchEngineGuide.stepTitle', { n: 4 })}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <p className="text-foreground">{t('searchEngineGuide.firefoxStep4')}</p>
                <ul className="list-disc list-inside space-y-1 text-sm text-muted-foreground ml-2">
                  <li>{t('searchEngineGuide.firefoxStep4a')}</li>
                  <li>{t('searchEngineGuide.firefoxStep4b')}</li>
                  <li>{t('searchEngineGuide.firefoxStep4c')}</li>
                </ul>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">
                  {t('searchEngineGuide.stepTitle', { n: 5 })}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-foreground">{t('searchEngineGuide.firefoxStep5')}</p>
              </CardContent>
            </Card>
          </div>
        </div>
      )}

      {/* Usage example */}
      <Card className="bg-primary/10 border-primary/30">
        <CardHeader>
          <CardTitle className="text-xl text-foreground">
            {t('searchEngineGuide.usageExample')}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-foreground">{t('searchEngineGuide.usageStep1')}</p>
          <div className="bg-card rounded-lg p-3 border border-border">
            <code className="text-sm font-mono text-foreground">go test</code>
          </div>
          <p className="text-foreground">{t('searchEngineGuide.usageStep2')}</p>
          <p className="text-sm text-muted-foreground">{t('searchEngineGuide.usageNote')}</p>
        </CardContent>
      </Card>
    </div>
  );
}
