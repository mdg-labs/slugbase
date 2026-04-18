import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useSearchParams, Link } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { useAppConfig } from '../contexts/AppConfigContext';
import api from '../api/client';
import { AlertTriangle, ArrowRight, Check, Mail } from 'lucide-react';
import { AuthCardLayout } from '../components/auth/AuthCardLayout';
import { authFieldLabel, authInput, authSubmit, fieldError } from '../components/auth/authPageClasses';
import { cn } from '@/lib/utils';

export default function VerifyEmail() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { checkAuth } = useAuth();
  const { pathPrefixForLinks, appRootPath } = useAppConfig();
  const prefix = (pathPrefixForLinks || '').replace(/\/+/g, '/') || '';
  const profilePath = `${prefix}/profile`.replace(/\/+/g, '/') || '/profile';
  const loginPath = `${prefix}/login`.replace(/\/+/g, '/') || '/login';
  const signupPath = `${prefix}/signup`.replace(/\/+/g, '/') || '/signup';
  const passwordResetHref = `${prefix}/password-reset`.replace(/\/+/g, '/') || '/password-reset';

  const [status, setStatus] = useState<'verifying' | 'success' | 'error' | 'resend' | 'noToken'>('verifying');
  const [error, setError] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [signupVerified, setSignupVerified] = useState(false);
  const [resendEmail, setResendEmail] = useState('');
  const [resendToken, setResendToken] = useState('');
  const [resendLoading, setResendLoading] = useState(false);
  const [resendSuccess, setResendSuccess] = useState(false);

  useEffect(() => {
    const token = searchParams.get('token');
    if (!token) {
      setStatus('error');
      setError(t('emailVerification.tokenRequired'));
      return;
    }

    api
      .post('/auth/verify-signup', { token })
      .then(() => {
        setStatus('success');
        setSignupVerified(true);
        setTimeout(() => navigate(loginPath), 2500);
      })
      .catch(async () => {
        const statusRes = await api
          .get('/auth/signup-verification/status', { params: { token } })
          .catch(() => ({ data: { status: 'invalid' } }));
        const { status: tokenStatus, email } = statusRes.data;
        if (tokenStatus === 'expired' && email) {
          setStatus('resend');
          setResendEmail(email);
          setResendToken(token);
          return;
        }
        if (tokenStatus === 'used') {
          setStatus('error');
          setError(t('emailVerification.alreadyVerified'));
          return;
        }

        try {
          const verifyRes = await api.get('/email-verification/verify', { params: { token } });
          if (verifyRes.data.valid) {
            setNewEmail(verifyRes.data.newEmail || '');
            await api.post('/email-verification/confirm', { token });
            setStatus('success');
            await checkAuth();
            setTimeout(() => navigate(profilePath), 3000);
            return;
          }
        } catch {
          /* not profile token */
        }
        setStatus('error');
        setError(t('emailVerification.invalidLink'));
      });
  }, [searchParams, t, navigate, checkAuth, loginPath, profilePath]);

  const handleResendSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setResendLoading(true);
    setError('');
    try {
      await api.post('/auth/resend-signup-verification', {
        token: resendToken,
        newEmail: resendEmail.trim() || undefined,
      });
      setResendSuccess(true);
    } catch (err: any) {
      setError(err.response?.data?.error || t('common.error'));
    } finally {
      setResendLoading(false);
    }
  };

  const handleRequestResendSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const form = e.target as HTMLFormElement;
    const emailInput = form.elements.namedItem('email') as HTMLInputElement | null;
    const email = emailInput?.value?.trim();
    if (!email) return;
    setResendLoading(true);
    setError('');
    try {
      await api.post('/auth/request-signup-resend', { email });
      setResendSuccess(true);
    } catch (err: any) {
      setError(err.response?.data?.error || t('common.error'));
    } finally {
      setResendLoading(false);
    }
  };

  const successTile = (
    <div className="mx-auto grid size-14 place-items-center rounded-2xl border border-[rgba(74,222,128,0.35)] bg-[rgba(74,222,128,0.12)]">
      <Check className="size-7 text-[var(--success)]" strokeWidth={2} aria-hidden />
    </div>
  );

  const dangerTile = (
    <div className="mx-auto grid size-14 place-items-center rounded-2xl border border-[rgba(248,113,113,0.35)] bg-[rgba(248,113,113,0.12)]">
      <AlertTriangle className="size-7 text-[var(--danger)]" strokeWidth={2} aria-hidden />
    </div>
  );

  return (
    <AuthCardLayout>
      <div className="space-y-4 text-center">
        {status === 'verifying' && (
          <>
            <div className="mx-auto grid size-14 place-items-center rounded-2xl border border-[var(--border)] bg-[var(--bg-2)]">
              <Mail className="size-6 text-[var(--accent-hi)] animate-pulse" aria-hidden />
            </div>
            <h2 className="m-0 text-[18px] font-semibold text-[var(--fg-0)]">{t('emailVerification.verifying')}</h2>
            <p className="text-[13px] text-[var(--fg-2)]">{t('emailVerification.verifyingDescription')}</p>
          </>
        )}

        {status === 'success' && (
          <>
            {successTile}
            <h2 className="m-0 text-[18px] font-semibold text-[var(--fg-0)]">
              {signupVerified ? t('emailVerification.signupSuccess') : t('emailVerification.success')}
            </h2>
            <p className="text-[13px] text-[var(--fg-2)]">
              {signupVerified
                ? t('emailVerification.signupSuccessDescription')
                : t('emailVerification.successDescription', { email: newEmail })}
            </p>
            <button
              type="button"
              onClick={() => navigate(signupVerified ? loginPath : appRootPath)}
              className={cn(authSubmit, 'mx-auto mt-2 w-full max-w-full')}
            >
              <span>{t('emailVerification.continueToApp')}</span>
              <ArrowRight className="h-4 w-4 shrink-0 opacity-90" aria-hidden />
            </button>
            {!signupVerified && (
              <p className="text-[12.5px] text-[var(--fg-3)]">{t('emailVerification.redirecting')}</p>
            )}
          </>
        )}

        {(status === 'resend' || status === 'noToken') && (
          <>
            {resendSuccess ? (
              <>
                {successTile}
                <h2 className="m-0 text-[18px] font-semibold text-[var(--fg-0)]">{t('emailVerification.resendSuccess')}</h2>
                <p className="text-[13px] text-[var(--fg-2)]">{t('emailVerification.resendSuccessDescription')}</p>
                <Link
                  to={loginPath}
                  className="inline-flex items-center justify-center gap-2 font-medium text-[var(--accent-hi)] hover:underline"
                >
                  {t('auth.signInButton')}
                </Link>
              </>
            ) : (
              <>
                <div className="mx-auto grid size-14 place-items-center rounded-2xl border border-[var(--border)] bg-[var(--bg-2)]">
                  <Mail className="size-6 text-[var(--accent-hi)]" aria-hidden />
                </div>
                <h2 className="m-0 text-[18px] font-semibold text-[var(--fg-0)]">{t('emailVerification.resendTitle')}</h2>
                <p className="text-[13px] text-[var(--fg-2)]">
                  {status === 'resend'
                    ? t('emailVerification.resendDescription')
                    : t('emailVerification.resendNoTokenDescription')}
                </p>
                <form
                  onSubmit={status === 'resend' ? handleResendSubmit : handleRequestResendSubmit}
                  className="mt-4 space-y-4 text-left"
                >
                  <div className="space-y-2">
                    <label htmlFor="resend-email" className={authFieldLabel}>
                      {t('emailVerification.editEmailLabel')}
                    </label>
                    <div className={cn(authInput)}>
                      <input
                        id="resend-email"
                        name="email"
                        type="email"
                        required
                        placeholder={t('auth.emailPlaceholder')}
                        value={status === 'resend' ? resendEmail : undefined}
                        onChange={status === 'resend' ? (e) => setResendEmail(e.target.value) : undefined}
                        className="min-w-0 flex-1 border-0 bg-transparent p-0 text-[13px] text-[var(--fg-0)] outline-none placeholder:text-[var(--fg-4)]"
                      />
                    </div>
                  </div>
                  {error && (
                    <p className={cn(fieldError, 'rounded-md border border-[rgba(248,113,113,0.35)] bg-[rgba(248,113,113,0.08)] px-3 py-2')}>
                      {error}
                    </p>
                  )}
                  <button type="submit" disabled={resendLoading} className={authSubmit}>
                    <span>{resendLoading ? t('common.loading') : t('emailVerification.resendButton')}</span>
                    <ArrowRight className="h-4 w-4 shrink-0 opacity-90" aria-hidden />
                  </button>
                </form>
                <p className="mt-2 text-[13px] text-[var(--fg-2)]">
                  <Link to={loginPath} className="font-medium text-[var(--accent-hi)] hover:underline">
                    {t('signup.backToLogin')}
                  </Link>
                  {' · '}
                  <Link to={signupPath} className="font-medium text-[var(--accent-hi)] hover:underline">
                    {t('auth.signUp')}
                  </Link>
                </p>
              </>
            )}
          </>
        )}

        {status === 'error' && (
          <>
            {dangerTile}
            <h2 className="m-0 text-[18px] font-semibold text-[var(--fg-0)]">{t('emailVerification.error')}</h2>
            <p className="text-[13px] text-[var(--fg-2)]">{error || t('emailVerification.errorDescription')}</p>
            <div className="flex flex-col gap-2 pt-2">
              {error === t('emailVerification.alreadyVerified') ? (
                <button type="button" onClick={() => navigate(loginPath)} className={authSubmit}>
                  <span>{t('auth.signInButton')}</span>
                  <ArrowRight className="h-4 w-4 shrink-0 opacity-90" aria-hidden />
                </button>
              ) : (
                <>
                  <button type="button" onClick={() => navigate(profilePath)} className={authSubmit}>
                    <span>{t('emailVerification.backToProfile')}</span>
                    <ArrowRight className="h-4 w-4 shrink-0 opacity-90" aria-hidden />
                  </button>
                  <p className="text-[13px] text-[var(--fg-2)]">
                    <Link to={passwordResetHref} className="font-medium text-[var(--accent-hi)] hover:underline">
                      {t('emailVerification.requestNewLink')}
                    </Link>
                  </p>
                </>
              )}
              {error !== t('emailVerification.alreadyVerified') && (
                <p className="text-[13px]">
                  <Link to={signupPath} className="font-medium text-[var(--accent-hi)] hover:underline">
                    {t('auth.signUp')}
                  </Link>
                </p>
              )}
            </div>
          </>
        )}
      </div>
    </AuthCardLayout>
  );
}
