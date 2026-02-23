import { useTranslation } from 'react-i18next';
import { ArrowLeft, Search, Code, CheckCircle } from 'lucide-react';
import { Link } from 'react-router-dom';
import Button from '../components/ui/Button';
import { useAppConfig } from '../contexts/AppConfigContext';

export default function SearchEngineGuide() {
  const { t } = useTranslation();
  const { pathPrefixForLinks } = useAppConfig();
  const prefix = (pathPrefixForLinks || '').replace(/\/+/g, '/') || '';

  const baseUrl = window.location.origin;
  const goPath = '/go/%s';
  const searchUrl = `${baseUrl}${goPath}`;

  return (
    <div className="space-y-6 max-w-4xl mx-auto">
      {/* Header */}
      <div className="flex items-center gap-4">
        <Link to={`${prefix}/bookmarks`}>
          <Button variant="ghost" size="sm" icon={ArrowLeft}>
            {t('common.back')}
          </Button>
        </Link>
        <div>
          <h1 className="text-3xl font-bold text-gray-900 dark:text-white flex items-center gap-3">
            <Search className="h-8 w-8" />
            {t('searchEngineGuide.title')}
          </h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            {t('searchEngineGuide.description')}
          </p>
        </div>
      </div>

      {/* How it works */}
      <div className="bg-primary/10 border border-primary/30 rounded-xl p-6">
        <h2 className="text-xl font-semibold text-foreground mb-3">
          {t('searchEngineGuide.howItWorks')}
        </h2>
        <p className="text-muted-foreground mb-4">
          {t('searchEngineGuide.howItWorksDescription')}
        </p>
        <div className="bg-card rounded-lg p-4 border border-primary/30">
          <div className="flex items-center gap-2 text-sm font-mono text-foreground">
            <Code className="h-4 w-4 text-primary" />
            <span className="text-primary">go</span>
            <span className="text-gray-400">your-slug</span>
          </div>
        </div>
      </div>

      {/* Your search URL */}
      <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-6">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-3">
          {t('searchEngineGuide.yourSearchUrl')}
        </h2>
        <div className="bg-gray-50 dark:bg-gray-900 rounded-lg p-4 border border-gray-200 dark:border-gray-700">
          <code className="text-sm font-mono text-gray-900 dark:text-white break-all">
            {searchUrl}
          </code>
        </div>
        <p className="mt-3 text-sm text-gray-600 dark:text-gray-400">
          {t('searchEngineGuide.urlNote')}
        </p>
      </div>

      {/* Chromium-based browsers */}
      <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-6">
        <h2 className="text-xl font-semibold text-gray-900 dark:text-white mb-4 flex items-center gap-2">
          <CheckCircle className="h-6 w-6 text-green-600 dark:text-green-400" />
          {t('searchEngineGuide.chromiumTitle')}
        </h2>
        <p className="text-gray-700 dark:text-gray-300 mb-4">
          {t('searchEngineGuide.chromiumDescription')}
        </p>
        <ol className="list-decimal list-inside space-y-3 text-gray-700 dark:text-gray-300">
          <li>{t('searchEngineGuide.chromiumStep1')}</li>
          <li>{t('searchEngineGuide.chromiumStep2')}</li>
          <li>{t('searchEngineGuide.chromiumStep3')}</li>
          <li>
            {t('searchEngineGuide.chromiumStep4')}
            <ul className="list-disc list-inside ml-6 mt-2 space-y-1 text-sm text-gray-600 dark:text-gray-400">
              <li>{t('searchEngineGuide.chromiumStep4a')}</li>
              <li>{t('searchEngineGuide.chromiumStep4b')}</li>
              <li>{t('searchEngineGuide.chromiumStep4c')}</li>
            </ul>
          </li>
          <li>{t('searchEngineGuide.chromiumStep5')}</li>
        </ol>
      </div>

      {/* Firefox */}
      <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-6">
        <h2 className="text-xl font-semibold text-gray-900 dark:text-white mb-4 flex items-center gap-2">
          <CheckCircle className="h-6 w-6 text-orange-600 dark:text-orange-400" />
          {t('searchEngineGuide.firefoxTitle')}
        </h2>
        <p className="text-gray-700 dark:text-gray-300 mb-4">
          {t('searchEngineGuide.firefoxDescription')}
        </p>
        <ol className="list-decimal list-inside space-y-3 text-gray-700 dark:text-gray-300">
          <li>{t('searchEngineGuide.firefoxStep1')}</li>
          <li>{t('searchEngineGuide.firefoxStep2')}</li>
          <li>{t('searchEngineGuide.firefoxStep3')}</li>
          <li>
            {t('searchEngineGuide.firefoxStep4')}
            <ul className="list-disc list-inside ml-6 mt-2 space-y-1 text-sm text-gray-600 dark:text-gray-400">
              <li>{t('searchEngineGuide.firefoxStep4a')}</li>
              <li>{t('searchEngineGuide.firefoxStep4b')}</li>
              <li>{t('searchEngineGuide.firefoxStep4c')}</li>
            </ul>
          </li>
          <li>{t('searchEngineGuide.firefoxStep5')}</li>
        </ol>
      </div>

      {/* Usage example */}
      <div className="bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-xl p-6">
        <h2 className="text-xl font-semibold text-gray-900 dark:text-white mb-3">
          {t('searchEngineGuide.usageExample')}
        </h2>
        <div className="space-y-2 text-gray-700 dark:text-gray-300">
          <p>{t('searchEngineGuide.usageStep1')}</p>
          <div className="bg-white dark:bg-gray-800 rounded-lg p-3 border border-green-200 dark:border-green-700">
            <code className="text-sm font-mono text-gray-900 dark:text-white">go test</code>
          </div>
          <p className="mt-3">{t('searchEngineGuide.usageStep2')}</p>
          <p className="text-sm text-gray-600 dark:text-gray-400">
            {t('searchEngineGuide.usageNote')}
          </p>
        </div>
      </div>
    </div>
  );
}
