import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import api from '../api/client';
import { useAppConfig } from '../contexts/AppConfigContext';
import Button from '../components/ui/Button';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { getDocsBaseUrl } from '../config/docs';

const MIN_PASSWORD_LENGTH = 8;

const AUTH_CARD = 'rounded-xl border border-ghost bg-surface p-6 shadow-none';

export default function Signup() {
  const { t } = useTranslation();
  const { pathPrefixForLinks } = useAppConfig();
  const prefix = (pathPrefixForLinks || '').replace(/\/+/g, '/') || '';
  const loginHref = `${prefix}/login`.replace(/\/+/g, '/') || '/login';
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
        <div className={`max-w-md w-full ${AUTH_CARD} text-center space-y-4`}>
          <div className="flex justify-center mb-4">
            <img
              src="/slugbase_icon_purple.svg"
              alt="SlugBase"
              className="h-9 w-9 object-contain"
              width={36}
              height={36}
            />
          </div>
          <h2 className="text-xl font-semibold text-foreground">
            {t('signup.successTitle')}
          </h2>
          <p className="text-muted-foreground text-sm">
            {t('signup.successMessage')}
          </p>
          <Link
            to={loginHref}
            className="inline-flex items-center justify-center rounded-xl px-4 py-2.5 text-sm font-semibold text-primary-foreground border-0 bg-primary-gradient shadow-glow hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
            <img
              src="/slugbase_icon_purple.svg"
              alt="SlugBase"
              className="h-9 w-9 object-contain"
              width={36}
              height={36}
            />
          </div>
          <h2 className="text-2xl font-semibold text-foreground">
            {t('signup.title')}
          </h2>
          <p className="mt-2 text-sm text-muted-foreground">
            {t('signup.subtitle')}
          </p>
        </div>

        <div className={AUTH_CARD}>
          <form onSubmit={handleSubmit} className="space-y-5">
            <div className="space-y-2">
              <Label htmlFor="signup-email" className="typography-label">
                {t('signup.email')}
              </Label>
              <Input
                id="signup-email"
                type="email"
                required
                autoComplete="email"
                placeholder={t('auth.emailPlaceholder')}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="signup-name" className="typography-label">
                {t('signup.name')}
              </Label>
              <Input
                id="signup-name"
                type="text"
                required
                autoComplete="name"
                placeholder={t('signup.namePlaceholder')}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="signup-password" className="typography-label">
                {t('signup.password')}
              </Label>
              <Input
                id="signup-password"
                type="password"
                required
                minLength={MIN_PASSWORD_LENGTH}
                autoComplete="new-password"
                placeholder={t('setup.passwordPlaceholder')}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">{t('signup.passwordHint')}</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="signup-confirm" className="typography-label">
                {t('signup.confirmPassword')}
              </Label>
              <Input
                id="signup-confirm"
                type="password"
                required
                minLength={MIN_PASSWORD_LENGTH}
                autoComplete="new-password"
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
              <div className="px-4 py-3 rounded-xl border border-destructive/30 bg-destructive/10">
                <p className="text-sm text-destructive">{error}</p>
              </div>
            )}
            <Button
              type="submit"
              variant="primary"
              disabled={loading}
              className="w-full border-0 bg-primary-gradient text-primary-foreground shadow-glow hover:opacity-90"
            >
              {loading ? t('common.loading') : t('signup.submit')}
            </Button>
          </form>
          <p className="mt-4 text-center text-sm text-muted-foreground">
            {t('signup.alreadyHaveAccount')}{' '}
            <Link to={loginHref} className="font-medium text-primary hover:underline">
              {t('signup.logIn')}
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
