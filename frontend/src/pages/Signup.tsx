import React, { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import api from '../api/client';
import { useAppConfig } from '../contexts/AppConfigContext';
import { isCloud } from '../config/mode';
import { getAuthProviderUrl } from '../config/api';
import { ArrowRight, Eye, EyeOff, Lock, Mail, Sparkles, User } from 'lucide-react';
import { cn } from '../lib/utils';
import { passwordStrengthScore } from '../utils/passwordStrength';
import { PasswordStrengthMeter } from '../components/auth/PasswordStrengthMeter';
import { AuthSplitLayout } from '../components/auth/AuthSplitLayout';
import {
  authTitle,
  authSub,
  oauthRow,
  dividerLbl,
  authField,
  authFieldLabel,
  authInput,
  fieldError,
  authSubmit,
  checkboxRow,
  checkbox,
  checkboxOn,
} from '../components/auth/authPageClasses';
import { buttonVariants } from '@/components/ui/button-base';
import {
  OidcProviderSignInButton,
  formatOidcProviderDisplayName,
} from '../components/auth/OidcProviderSignInButton';

const MIN_PASSWORD_LENGTH = 8;

export default function Signup() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { pathPrefixForLinks, signupTermsUrl, signupPrivacyUrl } = useAppConfig();
  const termsHref = (signupTermsUrl ?? '').trim();
  const privacyHref = (signupPrivacyUrl ?? '').trim();
  const showLegalAcceptance = Boolean(termsHref && privacyHref);
  const prefix = (pathPrefixForLinks || '').replace(/\/+/g, '/') || '';
  const loginHref = `${prefix}/login`.replace(/\/+/g, '/') || '/login';
  const signupPath = `${prefix}/signup`.replace(/\/+/g, '/') || '/signup';

  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [acceptTerms, setAcceptTerms] = useState(false);
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [providers, setProviders] = useState<any[]>([]);
  const [providersLoading, setProvidersLoading] = useState(true);

  const pwScore = passwordStrengthScore(password);
  const confirmDirty = confirmPassword.length > 0;
  const passwordsMatch = password === confirmPassword;
  const confirmInvalid = confirmDirty && !passwordsMatch;

  useEffect(() => {
    api
      .get('/auth/providers')
      .then((res) => setProviders(res.data))
      .catch(() => setProviders([]))
      .finally(() => setProvidersLoading(false));
  }, []);

  const handleOIDC = (providerKey: string) => {
    window.location.href = getAuthProviderUrl(providerKey);
  };

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
    if (showLegalAcceptance && !acceptTerms) {
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

  const showOidc = !providersLoading && providers.length > 0;

  if (success) {
    return (
      <AuthSplitLayout showTabs={false}>
        <div className="rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--bg-1)] p-8 text-center shadow-[var(--shadow)]">
            <h1 className={authTitle}>{t('signup.successTitle')}</h1>
            <p className={cn(authSub, 'mt-3')}>{t('signup.successMessage')}</p>
            <Link
              to={loginHref}
              className={cn(
                buttonVariants({ variant: 'primary', size: 'lg' }),
                'mt-6 inline-flex w-full max-w-none justify-between no-underline'
              )}
            >
              <span>{t('signup.backToLogin')}</span>
              <ArrowRight className="h-4 w-4 shrink-0 opacity-90" aria-hidden />
            </Link>
          </div>
      </AuthSplitLayout>
    );
  }

  return (
    <AuthSplitLayout
      activeTab="signup"
      showTabs
      onTabChange={(tab) => navigate(tab === 'signup' ? signupPath : loginHref, { replace: true })}
    >
      <form onSubmit={handleSubmit} className="flex flex-col">
        <div className="mb-8">
          <h1 className={authTitle}>{isCloud ? t('signup.cloudTitle') : t('signup.title')}</h1>
          <p className={authSub}>
            {t('signup.alreadyHaveAccount')}{' '}
            <Link to={loginHref} className="font-medium text-[var(--accent-hi)] hover:underline">
              {t('signup.logIn')}
            </Link>
          </p>
        </div>

        {showOidc ? (
          <>
            <div className={oauthRow}>
              {providers.map((provider) => (
                <OidcProviderSignInButton
                  key={provider.id}
                  providerKey={provider.provider_key}
                  label={t('auth.loginWith', {
                    provider: formatOidcProviderDisplayName(provider.provider_key),
                  })}
                  onClick={() => handleOIDC(provider.provider_key)}
                />
              ))}
            </div>
            <div className={dividerLbl}>{t('auth.orEmail')}</div>
          </>
        ) : null}

        <div className="flex flex-col gap-5">
          <div className={authField}>
            <label htmlFor="signup-email" className={authFieldLabel}>
              {t('signup.email')}
            </label>
            <div className={cn(authInput)}>
              <Mail className="h-4 w-4 shrink-0 text-[var(--fg-3)]" aria-hidden />
              <input
                id="signup-email"
                type="email"
                required
                autoComplete="email"
                placeholder={t('auth.emailPlaceholder')}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="min-w-0 flex-1 border-0 bg-transparent p-0 text-[13px] text-[var(--fg-0)] outline-none placeholder:text-[var(--fg-4)]"
              />
            </div>
          </div>

          <div className={authField}>
            <label htmlFor="signup-name" className={authFieldLabel}>
              {t('signup.name')}
            </label>
            <div className={cn(authInput)}>
              <User className="h-4 w-4 shrink-0 text-[var(--fg-3)]" aria-hidden />
              <input
                id="signup-name"
                type="text"
                required
                autoComplete="name"
                placeholder={t('signup.namePlaceholder')}
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="min-w-0 flex-1 border-0 bg-transparent p-0 text-[13px] text-[var(--fg-0)] outline-none placeholder:text-[var(--fg-4)]"
              />
            </div>
          </div>

          <div className={authField}>
            <label htmlFor="signup-password" className={authFieldLabel}>
              {t('signup.password')}
            </label>
            <div className={cn(authInput)}>
              <Lock className="h-4 w-4 shrink-0 text-[var(--fg-3)]" aria-hidden />
              <input
                id="signup-password"
                type={showPassword ? 'text' : 'password'}
                required
                minLength={MIN_PASSWORD_LENGTH}
                autoComplete="new-password"
                placeholder={t('setup.passwordPlaceholder')}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="min-w-0 flex-1 border-0 bg-transparent p-0 text-[13px] text-[var(--fg-0)] outline-none placeholder:text-[var(--fg-4)]"
                aria-describedby="signup-password-requirements"
              />
              <button
                type="button"
                className="shrink-0 rounded p-1 text-[var(--fg-3)] hover:text-[var(--fg-0)]"
                onClick={() => setShowPassword((v) => !v)}
                aria-pressed={showPassword}
                aria-label={showPassword ? t('auth.hidePassword') : t('auth.showPassword')}
              >
                {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
            <PasswordStrengthMeter score={pwScore} id="signup-password-requirements" />
          </div>

          <div className={authField}>
            <label htmlFor="signup-confirm" className={authFieldLabel}>
              {t('signup.confirmPassword')}
            </label>
            <div className={cn(authInput, confirmInvalid && 'border-[rgba(248,113,113,0.5)]')}>
              <Lock className="h-4 w-4 shrink-0 text-[var(--fg-3)]" aria-hidden />
              <input
                id="signup-confirm"
                type={showConfirmPassword ? 'text' : 'password'}
                required
                minLength={MIN_PASSWORD_LENGTH}
                autoComplete="new-password"
                placeholder={t('setup.confirmPasswordPlaceholder')}
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                className="min-w-0 flex-1 border-0 bg-transparent p-0 text-[13px] text-[var(--fg-0)] outline-none placeholder:text-[var(--fg-4)]"
                aria-invalid={confirmInvalid}
                aria-describedby={confirmDirty ? 'signup-password-match-hint' : undefined}
              />
              <button
                type="button"
                className="shrink-0 rounded p-1 text-[var(--fg-3)] hover:text-[var(--fg-0)]"
                onClick={() => setShowConfirmPassword((v) => !v)}
                aria-pressed={showConfirmPassword}
                aria-label={showConfirmPassword ? t('auth.hidePassword') : t('auth.showPassword')}
              >
                {showConfirmPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
            {confirmDirty ? (
              <p
                id="signup-password-match-hint"
                className={cn('text-[11px]', passwordsMatch ? 'text-[var(--success)]' : fieldError)}
                role="status"
              >
              {passwordsMatch ? t('signup.passwordsMatch') : t('signup.passwordsDoNotMatch')}
              </p>
            ) : null}
          </div>

            {showLegalAcceptance ? (
              <label className={cn(checkboxRow, 'cursor-pointer')}>
              <input
                  id="signup-accept-terms"
                type="checkbox"
                required
                checked={acceptTerms}
                onChange={(e) => setAcceptTerms(e.target.checked)}
                  className={cn(checkbox, 'mt-1 accent-[var(--accent)]', acceptTerms && checkboxOn)}
              />
                <span className="text-[13px] leading-snug text-[var(--fg-1)]">
                {t('signup.acceptTermsPrefix')}
                <a
                  href={termsHref}
                  target="_blank"
                  rel="noopener noreferrer"
                    className="font-medium text-[var(--accent-hi)] hover:underline"
                  onClick={(e) => e.stopPropagation()}
                >
                  {t('signup.acceptTermsTerms')}
                </a>
                {t('signup.acceptTermsAnd')}
                <a
                  href={privacyHref}
                  target="_blank"
                  rel="noopener noreferrer"
                    className="font-medium text-[var(--accent-hi)] hover:underline"
                  onClick={(e) => e.stopPropagation()}
                >
                  {t('signup.acceptTermsPrivacy')}
                </a>
                {t('signup.acceptTermsSuffix')}
                </span>
              </label>
          ) : null}

          {error ? (
            <p className={cn(fieldError, 'rounded-md border border-[rgba(248,113,113,0.35)] bg-[rgba(248,113,113,0.08)] px-3 py-2')} role="alert">
              {error}
            </p>
          ) : null}

          <button type="submit" disabled={loading} className={authSubmit}>
            <span>{loading ? t('common.loading') : t('signup.submit')}</span>
            <Sparkles className="h-4 w-4 shrink-0 opacity-90" aria-hidden />
          </button>
        </div>
      </form>
    </AuthSplitLayout>
  );
}
