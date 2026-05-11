import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Copy } from 'lucide-react';
import { Link } from 'react-router-dom';
import Button from '../components/ui/Button';
import { useAppConfig } from '../contexts/AppConfigContext';
import { SegmentedControl, SegmentedControlItem } from '../components/ui/SegmentedControl';
import { copyTextToClipboard } from '../utils/copyTextToClipboard';
import { useToast } from '../components/ui/Toast';

function CodeBlock({ code, copyLabel }: { code: string; copyLabel: string }) {
  const { showToast } = useToast();
  const { t } = useTranslation();
  return (
    <div className="code-block flex flex-col gap-2 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg-2)] p-3 sm:flex-row sm:items-start sm:justify-between sm:gap-3">
      <code className="block min-w-0 flex-1 break-all font-mono text-[12px] text-[var(--fg-0)]">{code}</code>
      <button
        type="button"
        className="inline-flex h-8 shrink-0 items-center justify-center gap-1 self-start rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--bg-3)] px-2.5 text-[11px] font-medium text-[var(--fg-0)] hover:bg-[var(--bg-hover)]"
        onClick={async () => {
          const ok = await copyTextToClipboard(code);
          showToast(ok ? t('common.success') : t('common.error'), ok ? 'success' : 'error');
        }}
      >
        <Copy className="h-3.5 w-3.5" aria-hidden />
        {copyLabel}
      </button>
    </div>
  );
}

function GuideStep({
  n,
  title,
  children,
}: {
  n: number;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="guide-step flex gap-4 rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--bg-1)] p-4 shadow-[var(--shadow-sm)]">
      <div
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[var(--accent-bg)] font-mono text-[12px] font-semibold text-[var(--accent-hi)] ring-1 ring-[var(--accent-ring)]"
        aria-hidden
      >
        {n}
      </div>
      <div className="min-w-0 flex-1 space-y-2">
        <h4 className="text-[14px] font-semibold text-[var(--fg-0)]">{title}</h4>
        <div className="text-[13px] leading-relaxed text-[var(--fg-1)]">{children}</div>
      </div>
    </div>
  );
}

export default function SearchEngineGuide() {
  const { t } = useTranslation();
  const { pathPrefixForLinks } = useAppConfig();
  const prefix = (pathPrefixForLinks || '').replace(/\/+/g, '/') || '';
  const [activeTab, setActiveTab] = useState<'chromium' | 'firefox'>('chromium');

  const baseUrl = window.location.origin;
  const goPath = '/go/%s';
  const searchUrl = `${baseUrl}${goPath}`;

  const pageTitle = t('searchEngineGuide.title');
  const pageSubtitle = t('searchEngineGuide.description');

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div className="flex flex-col gap-4">
        <Link to={`${prefix}/bookmarks`}>
          <Button variant="ghost" size="sm" icon={ArrowLeft}>
            {t('common.back')}
          </Button>
        </Link>

        <div className="page-head flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div className="min-w-0">
            <h1 className="text-[22px] font-semibold tracking-[-0.02em] text-[var(--fg-0)]">{pageTitle}</h1>
            <p className="mt-1 max-w-2xl text-[12.5px] leading-relaxed text-[var(--fg-2)]">
              {pageSubtitle}{' '}
              <code className="rounded-[var(--radius-sm)] bg-[var(--bg-2)] px-1.5 py-0.5 font-mono text-[12px] text-[var(--accent-hi)]">
                g
              </code>
            </p>
          </div>
          <SegmentedControl
            value={activeTab}
            onValueChange={(v) => v && setActiveTab(v as 'chromium' | 'firefox')}
            className="self-start lg:self-auto"
            aria-label={pageTitle}
          >
            <SegmentedControlItem value="chromium">{t('searchEngineGuide.tabChromium')}</SegmentedControlItem>
            <SegmentedControlItem value="firefox">{t('searchEngineGuide.tabFirefox')}</SegmentedControlItem>
          </SegmentedControl>
        </div>
      </div>

      <div className="rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--bg-1)] p-4 shadow-[var(--shadow-sm)]">
        <h2 className="text-[15px] font-semibold text-[var(--fg-0)]">{t('searchEngineGuide.howItWorks')}</h2>
        <p className="mt-2 text-[13px] text-[var(--fg-2)]">{t('searchEngineGuide.howItWorksDescription')}</p>
        <div className="mt-3">
          <CodeBlock code="g your-slug" copyLabel={t('admin.copyRedirect')} />
        </div>
      </div>

      <div className="rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--bg-1)] p-4 shadow-[var(--shadow-sm)]">
        <h2 className="text-[15px] font-semibold text-[var(--fg-0)]">{t('searchEngineGuide.yourSearchUrl')}</h2>
        <div className="mt-3">
          <CodeBlock code={searchUrl} copyLabel={t('admin.copyRedirect')} />
        </div>
        <p className="mt-3 text-[12px] text-[var(--fg-2)]">{t('searchEngineGuide.urlNote')}</p>
      </div>

      {activeTab === 'chromium' && (
        <div className="space-y-4">
          <h2 className="text-[16px] font-semibold text-[var(--fg-0)]">{t('searchEngineGuide.chromiumTitle')}</h2>
          <p className="text-[13px] text-[var(--fg-2)]">{t('searchEngineGuide.chromiumDescription')}</p>
          <div className="space-y-4">
            <GuideStep n={1} title={t('searchEngineGuide.stepTitle', { n: 1 }) as string}>
              <p>{t('searchEngineGuide.chromiumStep1')}</p>
            </GuideStep>
            <GuideStep n={2} title={t('searchEngineGuide.stepTitle', { n: 2 }) as string}>
              <p>{t('searchEngineGuide.chromiumStep2')}</p>
            </GuideStep>
            <GuideStep n={3} title={t('searchEngineGuide.stepTitle', { n: 3 }) as string}>
              <p>{t('searchEngineGuide.chromiumStep3')}</p>
            </GuideStep>
            <GuideStep n={4} title={t('searchEngineGuide.stepTitle', { n: 4 }) as string}>
              <p>{t('searchEngineGuide.chromiumStep4')}</p>
              <ul className="ml-4 list-disc space-y-1 text-[12.5px] text-[var(--fg-2)]">
                <li>{t('searchEngineGuide.chromiumStep4a')}</li>
                <li>{t('searchEngineGuide.chromiumStep4b')}</li>
                <li>{t('searchEngineGuide.chromiumStep4c')}</li>
              </ul>
            </GuideStep>
            <GuideStep n={5} title={t('searchEngineGuide.stepTitle', { n: 5 }) as string}>
              <p>{t('searchEngineGuide.chromiumStep5')}</p>
            </GuideStep>
          </div>
        </div>
      )}

      {activeTab === 'firefox' && (
        <div className="space-y-4">
          <h2 className="text-[16px] font-semibold text-[var(--fg-0)]">{t('searchEngineGuide.firefoxTitle')}</h2>
          <p className="text-[13px] text-[var(--fg-2)]">{t('searchEngineGuide.firefoxDescription')}</p>
          <div className="space-y-4">
            <GuideStep n={1} title={t('searchEngineGuide.stepTitle', { n: 1 }) as string}>
              <p>{t('searchEngineGuide.firefoxStep1')}</p>
            </GuideStep>
            <GuideStep n={2} title={t('searchEngineGuide.stepTitle', { n: 2 }) as string}>
              <p>{t('searchEngineGuide.firefoxStep2')}</p>
            </GuideStep>
            <GuideStep n={3} title={t('searchEngineGuide.stepTitle', { n: 3 }) as string}>
              <p>{t('searchEngineGuide.firefoxStep3')}</p>
            </GuideStep>
            <GuideStep n={4} title={t('searchEngineGuide.stepTitle', { n: 4 }) as string}>
              <p>{t('searchEngineGuide.firefoxStep4')}</p>
              <ul className="ml-4 list-disc space-y-1 text-[12.5px] text-[var(--fg-2)]">
                <li>{t('searchEngineGuide.firefoxStep4a')}</li>
                <li>{t('searchEngineGuide.firefoxStep4b')}</li>
                <li>{t('searchEngineGuide.firefoxStep4c')}</li>
              </ul>
            </GuideStep>
            <GuideStep n={5} title={t('searchEngineGuide.stepTitle', { n: 5 }) as string}>
              <p>{t('searchEngineGuide.firefoxStep5')}</p>
            </GuideStep>
          </div>
        </div>
      )}

      <div className="rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--bg-1)] p-4 shadow-[var(--shadow-sm)]">
        <h2 className="text-[15px] font-semibold text-[var(--fg-0)]">{t('searchEngineGuide.usageExample')}</h2>
        <div className="mt-3 space-y-3 text-[13px] text-[var(--fg-1)]">
          <p>{t('searchEngineGuide.usageStep1')}</p>
          <CodeBlock code="go test" copyLabel={t('admin.copyRedirect')} />
          <p>{t('searchEngineGuide.usageStep2')}</p>
          <p className="text-[12px] text-[var(--fg-2)]">{t('searchEngineGuide.usageNote')}</p>
        </div>
      </div>
    </div>
  );
}
