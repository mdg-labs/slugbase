import React from 'react';
import { Link, NavLink } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Sun, Moon } from 'lucide-react';
import { useMarketingTheme } from '../hooks/useMarketingTheme';
import Select from './ui/Select';
import { Button, buttonVariants } from './ui/button-base';

const navLinkClass = ({ isActive }: { isActive: boolean }) =>
  `text-sm transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded ${
    isActive ? 'text-foreground font-medium' : 'text-muted-foreground hover:text-foreground'
  }`;

const LANGUAGES = [
  { value: 'en', labelKey: 'profile.languageEnglish' },
  { value: 'de', labelKey: 'profile.languageGerman' },
  { value: 'fr', labelKey: 'profile.languageFrench' },
  { value: 'es', labelKey: 'profile.languageSpanish' },
  { value: 'it', labelKey: 'profile.languageItalian' },
  { value: 'pt', labelKey: 'profile.languagePortuguese' },
  { value: 'nl', labelKey: 'profile.languageDutch' },
  { value: 'ru', labelKey: 'profile.languageRussian' },
  { value: 'ja', labelKey: 'profile.languageJapanese' },
  { value: 'zh', labelKey: 'profile.languageChinese' },
  { value: 'pl', labelKey: 'profile.languagePolish' },
];

export default function MarketingLayout({ children }: { children: React.ReactNode }) {
  const { t, i18n } = useTranslation();
  const { isDark, toggleTheme } = useMarketingTheme();

  const currentLang = i18n.language?.split('-')[0] || 'en';
  const languageOptions = LANGUAGES.map((l) => ({ value: l.value, label: t(l.labelKey) }));
  const selectedLang = LANGUAGES.some((l) => l.value === currentLang) ? currentLang : 'en';

  return (
    <div className="min-h-screen flex flex-col bg-background">
      <header className="border-b bg-card">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 py-4 flex items-center justify-between">
          <Link to="/" className="flex items-center gap-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded">
            <img src="/slugbase_icon_blue.svg" alt="" className="h-10 w-10 dark:hidden" />
            <img src="/slugbase_icon_white.svg" alt="" className="h-10 w-10 hidden dark:block" />
            <span className="font-semibold text-foreground">{t('app.name')}</span>
          </Link>
          <nav className="flex items-center gap-4 sm:gap-6">
            <a
              href="https://docs.slugbase.app"
              target="_blank"
              rel="noopener noreferrer"
              className={navLinkClass({ isActive: false })}
            >
              {t('landing.footerDocs')}
            </a>
            <NavLink to="/pricing" className={navLinkClass}>
              {t('landing.footerPricing')}
            </NavLink>
            <NavLink to="/contact" className={navLinkClass}>
              {t('landing.footerContact')}
            </NavLink>
            <Select
              value={selectedLang}
              onChange={(value) => i18n.changeLanguage(value)}
              options={languageOptions}
              placeholder={t('profile.language')}
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={toggleTheme}
              aria-label={isDark ? t('profile.themeLight') : t('profile.themeDark')}
            >
              {isDark ? <Sun className="h-4 w-4" aria-hidden /> : <Moon className="h-4 w-4" aria-hidden />}
            </Button>
            <Link to="/app/login" className={buttonVariants({ variant: 'ghost', size: 'sm' })}>
              {t('auth.login')}
            </Link>
            <Button asChild>
              <Link to="/app/signup">{t('landing.ctaStartFree')}</Link>
            </Button>
          </nav>
        </div>
      </header>
      <main className="flex-1">{children}</main>
      <footer className="border-t bg-card py-6">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 flex flex-col sm:flex-row items-center justify-between gap-4">
          <span className="text-sm text-muted-foreground">© SlugBase</span>
          <div className="flex flex-wrap gap-6">
            <a
              href="https://docs.slugbase.app"
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm text-muted-foreground hover:text-foreground"
            >
              {t('landing.footerDocs')}
            </a>
            <Link to="/pricing" className="text-sm text-muted-foreground hover:text-foreground">
              {t('landing.footerPricing')}
            </Link>
            <Link to="/contact" className="text-sm text-muted-foreground hover:text-foreground">
              {t('landing.footerContact')}
            </Link>
            <Link to="/terms" className="text-sm text-muted-foreground hover:text-foreground">
              {t('legal.termsTitle')}
            </Link>
            <Link to="/privacy" className="text-sm text-muted-foreground hover:text-foreground">
              {t('legal.privacyTitle')}
            </Link>
            <Link to="/imprint" className="text-sm text-muted-foreground hover:text-foreground">
              {t('legal.imprintTitle')}
            </Link>
            <Link to="/app" className="text-sm text-muted-foreground hover:text-foreground">
              {t('landing.footerApp')}
            </Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
