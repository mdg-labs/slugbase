import { type ReactNode, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AuthHero } from '@/components/auth/AuthHero';
import {
  authWrap,
  authFormSide,
  authFormInner,
  authTop,
  authFooter,
  switchTabs,
  switchTabBtn,
} from '@/components/auth/authPageClasses';
import api from '@/api/client';

export interface AuthSplitLayoutProps {
  activeTab?: 'signin' | 'signup';
  onTabChange?: (tab: 'signin' | 'signup') => void;
  showTabs?: boolean;
  children: ReactNode;
}

export function AuthSplitLayout({
  activeTab = 'signin',
  onTabChange,
  showTabs = false,
  children,
}: AuthSplitLayoutProps) {
  const { t } = useTranslation();
  const [shortVersion, setShortVersion] = useState<string | null>(null);

  useEffect(() => {
    api
      .get('/version')
      .then((res) => {
        const c = res.data?.commit as string | undefined;
        if (c) setShortVersion(c.substring(0, 7));
      })
      .catch(() => setShortVersion(null));
  }, []);

  return (
    <div className={authWrap}>
      <div className={authFormSide}>
        <div className={authFormInner}>
          <div className="flex min-h-0 w-full flex-1 flex-col justify-center overflow-y-auto">
            <header className={authTop}>
              <div className="flex items-center gap-3">
                <div className="grid size-8 shrink-0 place-items-center rounded-[9px] border border-[var(--accent-ring)] bg-[var(--accent-bg)]">
                  <img src="/slugbase_icon_purple.svg" alt="" className="size-[22px]" width={22} height={22} />
                </div>
                <span className="text-[15px] font-semibold tracking-[-0.01em] text-[var(--fg-0)]">{t('app.name')}</span>
              </div>
              {shortVersion ? (
                <span className="font-mono text-[10.5px] text-[var(--fg-3)]" title={shortVersion}>
                  {shortVersion}
                </span>
              ) : null}
            </header>

            {showTabs && onTabChange ? (
              <div className={switchTabs} role="tablist" aria-label={t('auth.loginTabs')}>
                <button
                  type="button"
                  role="tab"
                  aria-selected={activeTab === 'signin'}
                  className={switchTabBtn(activeTab === 'signin')}
                  onClick={() => onTabChange('signin')}
                >
                  {t('auth.signInTab')}
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={activeTab === 'signup'}
                  className={switchTabBtn(activeTab === 'signup')}
                  onClick={() => onTabChange('signup')}
                >
                  {t('auth.signUpTab')}
                </button>
              </div>
            ) : null}

            {children}
          </div>

          <footer className={authFooter}>
            <span>© {new Date().getFullYear()} {t('app.name')}</span>
            <a
              className="font-mono text-[var(--fg-2)] hover:text-[var(--accent-hi)]"
              href="https://slugbase.mdg.ninja"
              target="_blank"
              rel="noopener noreferrer"
            >
              {t('auth.footerDocs')}
            </a>
            <a
              className="font-mono text-[var(--fg-2)] hover:text-[var(--accent-hi)]"
              href="https://github.com/mdg-labs/slugbase"
              target="_blank"
              rel="noopener noreferrer"
            >
              {t('auth.footerGitHub')}
            </a>
          </footer>
        </div>
      </div>
      <AuthHero />
    </div>
  );
}
