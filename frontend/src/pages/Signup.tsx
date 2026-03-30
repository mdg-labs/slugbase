import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import api from '../api/client';
import { useAppConfig } from '../contexts/AppConfigContext';
import Button from '../components/ui/Button';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { isCloud } from '../config/mode';
import { getDefaultSignupPrivacyUrl, getDefaultSignupTermsUrl } from '../config/docs';
import { cn } from '../lib/utils';
import {
  AUTH_CARD_CLASS,
  AUTH_CROSS_LINK,
  AUTH_CROSS_LINK_FOOTER,
  AUTH_INPUT_CLASS,
  AUTH_PAGE_INNER,
  AUTH_PAGE_OUTER,
} from '../components/auth/authPageClasses';

const MIN_PASSWORD_LENGTH = 8;

export default function Signup() {
  const { t } = useTranslation();
  const { pathPrefixForLinks, signupTermsUrl, signupPrivacyUrl } = useAppConfig();
  const termsHref = signupTermsUrl ?? getDefaultSignupTermsUrl();
  const privacyHref = signupPrivacyUrl ?? getDefaultSignupPrivacyUrl();
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

  const minLengthMet = password.length >= MIN_PASSWORD_LENGTH;
  const confirmDirty = confirmPassword.length > 0;
  const passwordsMatch = password === confirmPassword;
  const confirmInvalid = confirmDirty && !passwordsMatch;

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
      <div className={AUTH_PAGE_OUTER}>
        <div className={AUTH_PAGE_INNER}>
          <div className={cn(AUTH_CARD_CLASS, 'space-y-4 text-center')}>
            <div className="mb-4 flex justify-center">
              <img
                src="/slugbase_icon_purple.svg"
                alt="SlugBase"
                className="h-[72px] w-[72px] object-contain"
                width={72}
                height={72}
              />
            </div>
            <h2 className="text-xl font-semibold text-foreground">{t('signup.successTitle')}</h2>
            <p className="text-sm text-muted-foreground">{t('signup.successMessage')}</p>
            <Link
              to={loginHref}
              className="inline-flex items-center justify-center rounded-xl border-0 bg-primary-gradient px-4 py-2.5 text-sm font-semibold text-primary-foreground shadow-glow hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            >
              {t('signup.backToLogin')}
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={AUTH_PAGE_OUTER}>
      <div className={AUTH_PAGE_INNER}>
        <div className="text-center">
          <div className="mb-6 flex justify-center">
            <img
              src="/slugbase_icon_purple.svg"
              alt="SlugBase"
              className="h-[72px] w-[72px] object-contain"
              width={72}
              height={72}
            />
          </div>
          <h2 className="text-2xl font-semibold text-foreground">{t('signup.title')}</h2>
          <p className="mt-2 text-sm text-muted-foreground">{t('signup.subtitle')}</p>
        </div>

        <div className={AUTH_CARD_CLASS}>
          <form onSubmit={handleSubmit} className="space-y-5">
            <div className="space-y-2">
              <Label htmlFor="signup-email" className="auth-field-label">
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
                className={cn(AUTH_INPUT_CLASS)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="signup-name" className="auth-field-label">
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
                className={cn(AUTH_INPUT_CLASS)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="signup-password" className="auth-field-label">
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
                className={cn(AUTH_INPUT_CLASS)}
                aria-describedby="signup-password-requirements"
              />
              <ul
                id="signup-password-requirements"
                className="space-y-1 text-xs"
                aria-live="polite"
              >
                <li
                  className={cn('flex items-center gap-2', minLengthMet ? 'text-primary' : 'text-muted-foreground')}
                >
                  <span aria-hidden className="inline-block w-3 shrink-0 text-center tabular-nums">
                    {minLengthMet ? '✓' : '✗'}
                  </span>
                  <span>{t('signup.passwordRequirementMinLength', { count: MIN_PASSWORD_LENGTH })}</span>
                </li>
              </ul>
            </div>
            <div className="space-y-2">
              <Label htmlFor="signup-confirm" className="auth-field-label">
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
                className={cn(AUTH_INPUT_CLASS)}
                aria-invalid={confirmInvalid}
                aria-describedby={confirmDirty ? 'signup-password-match-hint' : undefined}
              />
              {confirmDirty ? (
                <p
                  id="signup-password-match-hint"
                  className={cn('text-xs', passwordsMatch ? 'text-primary' : 'text-destructive')}
                  role="status"
                >
                  {passwordsMatch ? t('signup.passwordsMatch') : t('signup.passwordsDoNotMatch')}
                </p>
              ) : null}
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
                <a
                  href={termsHref}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary hover:underline"
                >
                  {t('signup.acceptTermsTerms')}
                </a>
                {t('signup.acceptTermsAnd')}
                <a
                  href={privacyHref}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary hover:underline"
                >
                  {t('signup.acceptTermsPrivacy')}
                </a>
                {t('signup.acceptTermsSuffix')}
              </label>
            </div>
            {error && (
              <div className="rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3">
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
          <p className={AUTH_CROSS_LINK_FOOTER}>
            {t('signup.alreadyHaveAccount')}{' '}
            <Link to={loginHref} className={AUTH_CROSS_LINK}>
              {t('signup.logIn')}
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
