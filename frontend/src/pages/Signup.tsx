import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import api from '../api/client';
import { useAppConfig } from '../contexts/AppConfigContext';
import Button from '../components/ui/Button';
import { getDocsBaseUrl } from '../config/docs';

const MIN_PASSWORD_LENGTH = 8;

export default function Signup() {
  const { t } = useTranslation();
  const { pathPrefixForLinks } = useAppConfig();
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [acceptTerms, setAcceptTerms] = useState(false);
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (password !== confirmPassword) {
      setError(t('setup.passwordMismatch'));
      return;
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(t('setup.passwordTooShort'));
      return;
    }
    if (!acceptTerms) {
      setError(t('signup.acceptTermsRequired'));
      return;
    }
    setLoading(true);
    try {
      await api.post('/auth/register', { email, name, password });
      setSuccess(true);
    } catch (err: any) {
      setError(err.response?.data?.error || t('common.error'));
    } finally {
      setLoading(false);
    }
  };

  if (success) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background py-12 px-4 sm:px-6 lg:px-8">
        <div className="max-w-md w-full bg-card rounded-lg border border-border shadow-lg p-6 text-center space-y-4">
          <div className="flex justify-center mb-4">
            <img src="/slugbase_icon_blue.svg" alt="SlugBase" className="h-16 w-16 dark:hidden" />
            <img src="/slugbase_icon_white.svg" alt="SlugBase" className="h-16 w-16 hidden dark:block" />
          </div>
          <h2 className="text-xl font-semibold text-foreground">
            {t('signup.successTitle')}
          </h2>
          <p className="text-muted-foreground text-sm">
            {t('signup.successMessage')}
          </p>
          <Link
            to={`${pathPrefixForLinks}/login`}
            className="inline-flex items-center justify-center px-4 py-2 text-sm font-medium text-primary-foreground bg-primary hover:bg-primary/90 rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          >
            {t('signup.backToLogin')}
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background py-12 px-4 sm:px-6 lg:px-8">
      <div className="max-w-md w-full space-y-8">
        <div className="text-center">
          <div className="flex justify-center mb-6">
            <img src="/slugbase_icon_blue.svg" alt="SlugBase" className="h-16 w-16 dark:hidden" />
            <img src="/slugbase_icon_white.svg" alt="SlugBase" className="h-16 w-16 hidden dark:block" />
          </div>
          <h2 className="text-2xl font-semibold text-foreground">
            {t('signup.title')}
          </h2>
          <p className="mt-2 text-sm text-muted-foreground">
            {t('signup.subtitle')}
          </p>
        </div>

        <div className="bg-card rounded-lg border border-border shadow-lg p-4">
          <form onSubmit={handleSubmit} className="space-y-5">
            <div>
              <label htmlFor="signup-email" className="block text-sm font-semibold text-foreground mb-2">
                {t('signup.email')}
              </label>
              <input
                id="signup-email"
                type="email"
                required
                autoComplete="email"
                className="w-full px-4 h-9 text-sm text-foreground bg-background border border-input rounded-lg focus:outline-none focus:ring-2 focus:ring-ring focus:border-ring"
                placeholder={t('auth.emailPlaceholder')}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            <div>
              <label htmlFor="signup-name" className="block text-sm font-semibold text-foreground mb-2">
                {t('signup.name')}
              </label>
              <input
                id="signup-name"
                type="text"
                required
                autoComplete="name"
                className="w-full px-4 h-9 text-sm text-foreground bg-background border border-input rounded-lg focus:outline-none focus:ring-2 focus:ring-ring focus:border-ring"
                placeholder={t('signup.namePlaceholder')}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div>
              <label htmlFor="signup-password" className="block text-sm font-semibold text-foreground mb-2">
                {t('signup.password')}
              </label>
              <input
                id="signup-password"
                type="password"
                required
                minLength={MIN_PASSWORD_LENGTH}
                autoComplete="new-password"
                className="w-full px-4 h-9 text-sm text-foreground bg-background border border-input rounded-lg focus:outline-none focus:ring-2 focus:ring-ring focus:border-ring"
                placeholder={t('setup.passwordPlaceholder')}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              <p className="mt-1 text-xs text-muted-foreground">{t('signup.passwordHint')}</p>
            </div>
            <div>
              <label htmlFor="signup-confirm" className="block text-sm font-semibold text-foreground mb-2">
                {t('signup.confirmPassword')}
              </label>
              <input
                id="signup-confirm"
                type="password"
                required
                minLength={MIN_PASSWORD_LENGTH}
                autoComplete="new-password"
                className="w-full px-4 h-9 text-sm text-foreground bg-background border border-input rounded-lg focus:outline-none focus:ring-2 focus:ring-ring focus:border-ring"
                placeholder={t('setup.confirmPasswordPlaceholder')}
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
              />
            </div>
            <div className="flex items-start gap-3">
              <input
                id="signup-accept-terms"
                type="checkbox"
                required
                checked={acceptTerms}
                onChange={(e) => setAcceptTerms(e.target.checked)}
                className="mt-1 h-4 w-4 rounded border-input text-primary focus:ring-ring"
              />
              <label htmlFor="signup-accept-terms" className="text-sm text-foreground">
                {t('signup.acceptTermsPrefix')}
                <a href={getDocsBaseUrl()} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
                  {t('signup.acceptTermsTerms')}
                </a>
                {t('signup.acceptTermsAnd')}
                <a href={getDocsBaseUrl()} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
                  {t('signup.acceptTermsPrivacy')}
                </a>
                {t('signup.acceptTermsSuffix')}
              </label>
            </div>
            {error && (
              <div className="px-4 py-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
                <p className="text-sm text-red-800 dark:text-red-200">{error}</p>
              </div>
            )}
            <Button
              type="submit"
              variant="primary"
              disabled={loading}
              className="w-full"
            >
              {loading ? t('common.loading') : t('signup.submit')}
            </Button>
          </form>
          <p className="mt-4 text-center text-sm text-muted-foreground">
            {t('signup.alreadyHaveAccount')}{' '}
            <Link to={`${pathPrefixForLinks}/login`} className="font-medium text-primary hover:underline">
              {t('signup.logIn')}
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
