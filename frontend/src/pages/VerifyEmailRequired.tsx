import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation, Link } from 'react-router-dom';
import { useAppConfig } from '../contexts/AppConfigContext';
import api from '../api/client';
import { ArrowRight, Mail } from 'lucide-react';
import { AuthCardLayout } from '../components/auth/AuthCardLayout';
import { authFieldLabel, authInput, fieldError, authSubmit } from '../components/auth/authPageClasses';
import { cn } from '@/lib/utils';

export default function VerifyEmailRequired() {
  const { t } = useTranslation();
  const location = useLocation();
  const { pathPrefixForLinks } = useAppConfig();
  const stateEmail = (location.state as { email?: string } | null)?.email?.trim() || '';
  const [email, setEmail] = useState(stateEmail);
  const [newEmail, setNewEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);
  const [emailChanged, setEmailChanged] = useState(false);

  const prefix = (pathPrefixForLinks || '').replace(/\/+/g, '/') || '';
  const loginPath = `${prefix}/login`.replace(/\/+/g, '/') || '/login';
  const currentEmail = stateEmail || email.trim();

  const handleResend = async (e: React.FormEvent) => {
    e.preventDefault();
    const toSend = currentEmail || email.trim();
    if (!toSend) {
      setError(t('auth.verifyEmailRequiredPageEmailLabel') + ' is required');
      return;
    }
    setLoading(true);
    setError('');
    setSuccess(false);
    setEmailChanged(false);
    try {
      const payload: { email: string; newEmail?: string } = { email: toSend };
      const newEmailTrimmed = newEmail.trim();
      if (newEmailTrimmed && newEmailTrimmed !== toSend) {
        payload.newEmail = newEmailTrimmed;
      }
      const res = await api.post('/auth/request-signup-resend', payload);
      setSuccess(true);
      setEmailChanged(Boolean((res.data as { emailChanged?: boolean })?.emailChanged));
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      setError(msg || t('common.error'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthCardLayout>
      <>
        <h2 className="m-0 text-[18px] font-semibold text-[var(--fg-0)]">{t('auth.verifyEmailRequiredPageTitle')}</h2>
        <p className="sub mt-1.5 text-[12.5px] leading-relaxed text-[var(--fg-2)]">
          {t('auth.verifyEmailRequiredPageDescription')}
        </p>

        <div className="mt-6 border-t border-[var(--border-soft)] pt-6">
          {success ? (
            <div className="space-y-4 text-center">
              <div className="mx-auto grid size-14 place-items-center rounded-2xl border border-[var(--border)] bg-[var(--bg-2)]">
                <Mail className="size-6 text-[var(--accent-hi)]" aria-hidden />
              </div>
              <p className="text-[13px] text-[var(--fg-2)]">
                {emailChanged ? t('auth.emailChangedResendMessage') : t('auth.resendVerificationSuccess')}
              </p>
              <Link
                to={loginPath}
                className="inline-flex items-center gap-2 font-medium text-[var(--accent-hi)] hover:underline"
              >
                {t('signup.backToLogin')}
              </Link>
            </div>
          ) : (
            <form onSubmit={handleResend} className="space-y-5">
              {stateEmail ? (
                <>
                  <p className="text-[13px] text-[var(--fg-2)]">
                    {t('auth.verifyEmailRequiredPageEmailLabel')}:{' '}
                    <span className="font-medium text-[var(--fg-0)]">{stateEmail}</span>
                  </p>
                  <div className="space-y-2">
                    <label htmlFor="verify-email-required-new-email" className={authFieldLabel}>
                      {t('auth.newEmailLabel')}
                    </label>
                    <div className={cn(authInput)}>
                      <Mail className="h-4 w-4 shrink-0 text-[var(--fg-3)]" aria-hidden />
                      <input
                        id="verify-email-required-new-email"
                        name="newEmail"
                        type="email"
                        placeholder={t('auth.newEmailPlaceholder')}
                        value={newEmail}
                        onChange={(e) => setNewEmail(e.target.value)}
                        className="min-w-0 flex-1 border-0 bg-transparent p-0 text-[13px] text-[var(--fg-0)] outline-none placeholder:text-[var(--fg-4)]"
                      />
                    </div>
                    <p className="text-[11.5px] text-[var(--fg-2)]">{t('auth.newEmailHint')}</p>
                  </div>
                </>
              ) : (
                <div className="space-y-2">
                  <label htmlFor="verify-email-required-email" className={authFieldLabel}>
                    {t('auth.verifyEmailRequiredPageEmailLabel')}
                  </label>
                  <div className={cn(authInput)}>
                    <Mail className="h-4 w-4 shrink-0 text-[var(--fg-3)]" aria-hidden />
                    <input
                      id="verify-email-required-email"
                      name="email"
                      type="email"
                      required
                      placeholder={t('auth.emailPlaceholder')}
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      className="min-w-0 flex-1 border-0 bg-transparent p-0 text-[13px] text-[var(--fg-0)] outline-none placeholder:text-[var(--fg-4)]"
                    />
                  </div>
                </div>
              )}
              {error && (
                <p className={cn(fieldError, 'rounded-md border border-[rgba(248,113,113,0.35)] bg-[rgba(248,113,113,0.08)] px-3 py-2')}>
                  {error}
                </p>
              )}
              <button type="submit" disabled={loading} className={authSubmit}>
                <span>{loading ? t('common.loading') : t('auth.resendVerificationEmail')}</span>
                <ArrowRight className="h-4 w-4 shrink-0 opacity-90" aria-hidden />
              </button>
              <div className="text-center">
                <Link to={loginPath} className="text-[13px] font-medium text-[var(--accent-hi)] hover:underline">
                  {t('signup.backToLogin')}
                </Link>
              </div>
            </form>
          )}
        </div>
      </>
    </AuthCardLayout>
  );
}
