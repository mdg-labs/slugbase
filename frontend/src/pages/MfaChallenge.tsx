import React, { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { useAppConfig } from '../contexts/AppConfigContext';
import api from '../api/client';
import { LogIn } from 'lucide-react';
import Button from '../components/ui/Button';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { cn } from '../lib/utils';
import { safeRedirectPath } from '../utils/safeRedirectPath';
import {
  AUTH_CARD_CLASS,
  AUTH_CROSS_LINK,
  AUTH_INPUT_CLASS,
  AUTH_PAGE_INNER,
  AUTH_PAGE_OUTER,
} from '../components/auth/authPageClasses';

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
        const verifyPath = `${prefix}/verify-email-required`.replace(/\/+/g, '/') || '/verify-email-required';
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
          <h1 className="text-2xl font-semibold text-foreground">{t('mfa.challengeTitle')}</h1>
          <p className="mt-2 text-sm text-muted-foreground">{t('mfa.challengeDescription')}</p>
        </div>

        <div className={AUTH_CARD_CLASS}>
          <form onSubmit={handleSubmit} className="space-y-5" noValidate>
            <div className="space-y-2">
              <Label htmlFor={codeId} className="auth-field-label">
                {t('mfa.codeLabel')}
              </Label>
              <Input
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
                className={cn(AUTH_INPUT_CLASS)}
                aria-invalid={Boolean(error)}
                aria-describedby={error ? `${hintId} ${errorId}` : hintId}
                aria-errormessage={error ? errorId : undefined}
                disabled={submitting}
              />
              <p id={hintId} className="text-xs text-muted-foreground">
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
                className="rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3 outline-none"
              >
                <p className="text-sm text-destructive">{error}</p>
              </div>
            ) : null}

            <Button
              type="submit"
              variant="primary"
              disabled={submitting}
              icon={LogIn}
              className="w-full border-0 bg-primary-gradient text-primary-foreground shadow-glow hover:opacity-90"
            >
              {submitting ? t('common.loading') : t('mfa.verify')}
            </Button>

            <p className="text-center text-sm text-muted-foreground">
              <Link to={loginHref} className={AUTH_CROSS_LINK}>
                {t('mfa.backToLogin')}
              </Link>
            </p>
          </form>
        </div>
      </div>
    </div>
  );
}
