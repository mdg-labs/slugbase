import React, { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { useAppConfig } from '../contexts/AppConfigContext';
import api from '../api/client';
import { safeRedirectPath } from '../utils/safeRedirectPath';
import { AuthCardLayout } from '../components/auth/AuthCardLayout';
import { fieldError, authSubmit, otpInput } from '../components/auth/authPageClasses';
import { cn } from '../lib/utils';

export default function MfaChallenge() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { user, checkAuth } = useAuth();
  const { pathPrefixForLinks, appRootPath } = useAppConfig();
  const prefix = (pathPrefixForLinks || '').replace(/\/+/g, '/') || '';
  const loginHref = `${prefix}/login`.replace(/\/+/g, '/') || '/login';

  const codeId = useId();
  const hintId = `${codeId}-hint`;
  const errorId = `${codeId}-error`;

  const [code, setCode] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const liveRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (user) {
      const redirectTo = searchParams.get('redirect');
      const safe = safeRedirectPath(redirectTo);
      navigate(safe || appRootPath, { replace: true });
    }
  }, [user, navigate, searchParams, appRootPath]);

  useEffect(() => {
    if (!error) return;
    const id = window.requestAnimationFrame(() => {
      liveRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(id);
  }, [error]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    const trimmed = code.trim();
    if (!trimmed) {
      setError(t('mfa.codeRequired'));
      return;
    }

    setSubmitting(true);
    try {
      await api.post('/auth/mfa/verify', { code: trimmed });
      await checkAuth();
      const redirectTo = searchParams.get('redirect');
      const safe = safeRedirectPath(redirectTo);
      navigate(safe || appRootPath, { replace: true });
    } catch (err: unknown) {
      const ax = err as {
        response?: { status?: number; data?: { code?: string; error?: string } };
      };
      const status = ax.response?.status;
      const apiCode = ax.response?.data?.code;
      const message = ax.response?.data?.error;

      if (apiCode === 'EMAIL_NOT_VERIFIED') {
        const verifyPath =
          `${prefix}/verify-email-required`.replace(/\/+/g, '/') || '/verify-email-required';
        navigate(verifyPath, { replace: true });
        return;
      }

      if (status === 401 && apiCode === 'MFA_PENDING_INVALID') {
        setError(t('mfa.sessionExpired'));
        return;
      }

      setError(message || t('mfa.invalidCode'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AuthCardLayout>
      <h2 className="m-0 text-[18px] font-semibold tracking-[-0.015em] text-[var(--fg-0)]">{t('mfa.challengeTitle')}</h2>
      <p className="sub mt-1.5 text-[12.5px] leading-relaxed text-[var(--fg-2)]">{t('mfa.challengeDescription')}</p>

      <form onSubmit={handleSubmit} className="mt-5 space-y-5" noValidate>
        <div className="space-y-2">
          <label htmlFor={codeId} className="font-mono text-[11px] font-medium uppercase tracking-[0.04em] text-[var(--fg-3)]">
            {t('mfa.codeLabel')}
          </label>
          <input
            id={codeId}
            name="code"
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            autoCorrect="off"
            spellCheck={false}
            maxLength={32}
            placeholder={t('mfa.codePlaceholder')}
            value={code}
            onChange={(e) => setCode(e.target.value)}
            className={cn(
              otpInput,
              'px-3 outline-none focus-visible:border-[var(--accent-ring)] focus-visible:shadow-[0_0_0_3px_var(--accent-bg)]',
              error && 'border-[rgba(248,113,113,0.5)]'
            )}
            aria-invalid={Boolean(error)}
            aria-describedby={error ? `${hintId} ${errorId}` : hintId}
            aria-errormessage={error ? errorId : undefined}
            disabled={submitting}
          />
          <p id={hintId} className="text-[11.5px] text-[var(--fg-2)]">
            {t('mfa.challengeHint')}
          </p>
        </div>

        {error ? (
          <div
            ref={liveRef}
            id={errorId}
            role="alert"
            aria-live="assertive"
            tabIndex={-1}
            className={cn(fieldError, 'rounded-md border border-[rgba(248,113,113,0.35)] bg-[rgba(248,113,113,0.08)] px-3 py-2 outline-none')}
          >
            {error}
          </div>
        ) : null}

        <button type="submit" disabled={submitting} className={authSubmit}>
          <span>{submitting ? t('common.loading') : t('mfa.verify')}</span>
          <ArrowRight className="h-4 w-4 shrink-0 opacity-90" aria-hidden />
        </button>

        <p className="!mt-6 text-center text-[12.5px] text-[var(--fg-2)]">
          <Link
            to={loginHref}
            className="font-medium text-[var(--accent-hi)] hover:underline"
          >
            {t('mfa.backToLogin')}
          </Link>
        </p>
      </form>
    </AuthCardLayout>
  );
}
