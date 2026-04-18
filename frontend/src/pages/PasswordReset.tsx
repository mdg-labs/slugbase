import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams, useNavigate, Link } from 'react-router-dom';
import { ArrowLeft, ArrowRight, Eye, EyeOff, Lock, Mail } from 'lucide-react';
import api from '../api/client';
import { useAppConfig } from '../contexts/AppConfigContext';
import { passwordStrengthScore } from '../utils/passwordStrength';
import { PasswordStrengthMeter } from '../components/auth/PasswordStrengthMeter';
import { AuthCardLayout } from '../components/auth/AuthCardLayout';
import { authField, authFieldLabel, authInput, fieldError, authSubmit } from '../components/auth/authPageClasses';
import { cn } from '../lib/utils';

export default function PasswordReset() {
  const { t } = useTranslation();
  const { pathPrefixForLinks } = useAppConfig();
  const prefix = (pathPrefixForLinks || '').replace(/\/+/g, '/') || '';
  const loginPath = `${prefix}/login`.replace(/\/+/g, '/') || '/login';
  const resetPath = `${prefix}/password-reset`.replace(/\/+/g, '/') || '/password-reset';
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const token = searchParams.get('token');

  const step: 'request' | 'reset' = token ? 'reset' : 'request';
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [tokenValid, setTokenValid] = useState<boolean | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);

  const pwScore = passwordStrengthScore(password);
  const confirmDirty = step === 'reset' && confirmPassword.length > 0;
  const passwordsMatch = password === confirmPassword;
  const confirmInvalid = confirmDirty && !passwordsMatch;

  useEffect(() => {
    if (token) {
      verifyToken();
    }
  }, [token]);

  const verifyToken = async () => {
    try {
      const response = await api.get('/password-reset/verify', { params: { token } });
      setTokenValid(response.data.valid);
    } catch {
      setTokenValid(false);
      setMessage({ type: 'error', text: t('passwordReset.invalidToken') });
    }
  };

  const handleRequestReset = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setMessage(null);

    try {
      await api.post('/password-reset/request', { email });
      setMessage({ type: 'success', text: t('passwordReset.requestSent') });
      setEmail('');
    } catch {
      setMessage({ type: 'success', text: t('passwordReset.requestSent') });
      setEmail('');
    } finally {
      setLoading(false);
    }
  };

  const handleReset = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setMessage(null);

    if (password !== confirmPassword) {
      setMessage({ type: 'error', text: t('passwordReset.passwordMismatch') });
      setLoading(false);
      return;
    }

    try {
      await api.post('/password-reset/reset', { token, password });
      setMessage({ type: 'success', text: t('passwordReset.resetSuccess') });
      setTimeout(() => {
        navigate(loginPath);
      }, 2000);
    } catch (error: unknown) {
      const err = error as { response?: { data?: { error?: string } } };
      setMessage({
        type: 'error',
        text: err.response?.data?.error || t('common.error'),
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthCardLayout>
      {step === 'request' ? (
        <>
          <h2 className="m-0 text-[18px] font-semibold tracking-[-0.015em] text-[var(--fg-0)]">
            {t('passwordReset.requestTitle')}
          </h2>
          <p className="sub mt-1.5 text-[12.5px] leading-relaxed text-[var(--fg-2)]">{t('passwordReset.requestSubtitle')}</p>

          {message && (
            <div
              className={cn(
                'mt-4 rounded-[var(--radius)] border p-3 text-[13px]',
                message.type === 'success'
                  ? 'border-[rgba(74,222,128,0.35)] bg-[rgba(74,222,128,0.08)] text-[var(--success)]'
                  : 'border-[rgba(248,113,113,0.35)] bg-[rgba(248,113,113,0.08)] text-[var(--danger)]'
              )}
            >
              {message.text}
            </div>
          )}

          <form className="mt-5 space-y-5" onSubmit={handleRequestReset}>
            <div className="space-y-2">
              <label htmlFor="pr-email" className={authFieldLabel}>
                {t('passwordReset.email')}
              </label>
              <div className={cn(authInput)}>
                <Mail className="h-4 w-4 shrink-0 text-[var(--fg-3)]" aria-hidden />
                <input
                  id="pr-email"
                  name="email"
                  type="email"
                  autoComplete="email"
                  required
                  placeholder={t('passwordReset.emailPlaceholder')}
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="min-w-0 flex-1 border-0 bg-transparent p-0 text-[13px] text-[var(--fg-0)] outline-none placeholder:text-[var(--fg-4)]"
                />
              </div>
            </div>

            <button type="submit" disabled={loading} className={authSubmit}>
              <span>{loading ? t('common.loading') : t('passwordReset.requestReset')}</span>
              <ArrowRight className="h-4 w-4 shrink-0 opacity-90" aria-hidden />
            </button>

            <div className="text-center">
              <Link
                to={loginPath}
                className="inline-flex items-center gap-2 text-[13px] font-medium text-[var(--accent-hi)] hover:underline"
              >
                <ArrowLeft className="h-4 w-4" />
                {t('passwordReset.backToLogin')}
              </Link>
            </div>
          </form>
        </>
      ) : (
        <>
          {tokenValid === null ? (
            <p className="text-center text-[13px] text-[var(--fg-2)]">{t('common.loading')}</p>
          ) : tokenValid === false ? (
            <div className="space-y-4 text-center">
              <p className={fieldError}>{t('passwordReset.invalidToken')}</p>
              <Link
                to={resetPath}
                className="inline-flex items-center gap-2 text-[13px] font-medium text-[var(--accent-hi)] hover:underline"
              >
                <ArrowLeft className="h-4 w-4" />
                {t('passwordReset.backToLogin')}
              </Link>
            </div>
          ) : (
            <>
              <h2 className="m-0 text-[18px] font-semibold tracking-[-0.015em] text-[var(--fg-0)]">
                {t('passwordReset.resetTitle')}
              </h2>
              <p className="sub mt-1.5 text-[12.5px] leading-relaxed text-[var(--fg-2)]">{t('passwordReset.resetSubtitle')}</p>

              {message && (
                <div
                  className={cn(
                    'mt-4 rounded-[var(--radius)] border p-3 text-[13px]',
                    message.type === 'success'
                      ? 'border-[rgba(74,222,128,0.35)] bg-[rgba(74,222,128,0.08)] text-[var(--success)]'
                      : 'border-[rgba(248,113,113,0.35)] bg-[rgba(248,113,113,0.08)] text-[var(--danger)]'
                  )}
                >
                  {message.text}
                </div>
              )}

              <form className="mt-5 space-y-5" onSubmit={handleReset}>
                <div className={authField}>
                  <label htmlFor="pr-password" className={authFieldLabel}>
                    {t('passwordReset.newPassword')}
                  </label>
                  <div className={cn(authInput)}>
                    <Lock className="h-4 w-4 shrink-0 text-[var(--fg-3)]" aria-hidden />
                    <input
                      id="pr-password"
                      name="password"
                      type={showPassword ? 'text' : 'password'}
                      autoComplete="new-password"
                      required
                      placeholder={t('auth.passwordPlaceholder')}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      className="min-w-0 flex-1 border-0 bg-transparent p-0 text-[13px] text-[var(--fg-0)] outline-none placeholder:text-[var(--fg-4)]"
                      aria-describedby="pr-password-strength"
                    />
                    <button
                      type="button"
                      className="shrink-0 rounded p-1 text-[var(--fg-3)] hover:text-[var(--fg-0)]"
                      onClick={() => setShowPassword((v) => !v)}
                      aria-label={showPassword ? t('auth.hidePassword') : t('auth.showPassword')}
                    >
                      {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
                  <PasswordStrengthMeter score={pwScore} id="pr-password-strength" />
                </div>

                <div className="space-y-2">
                  <label htmlFor="pr-confirm" className={authFieldLabel}>
                    {t('passwordReset.confirmPassword')}
                  </label>
                  <div className={cn(authInput, confirmInvalid && 'border-[rgba(248,113,113,0.5)]')}>
                    <Lock className="h-4 w-4 shrink-0 text-[var(--fg-3)]" aria-hidden />
                    <input
                      id="pr-confirm"
                      name="confirmPassword"
                      type={showConfirmPassword ? 'text' : 'password'}
                      autoComplete="new-password"
                      required
                      placeholder={t('passwordReset.confirmPassword')}
                      value={confirmPassword}
                      onChange={(e) => setConfirmPassword(e.target.value)}
                      className="min-w-0 flex-1 border-0 bg-transparent p-0 text-[13px] text-[var(--fg-0)] outline-none placeholder:text-[var(--fg-4)]"
                      aria-invalid={confirmInvalid}
                      aria-describedby={confirmDirty ? 'pr-confirm-hint' : undefined}
                    />
                    <button
                      type="button"
                      className="shrink-0 rounded p-1 text-[var(--fg-3)] hover:text-[var(--fg-0)]"
                      onClick={() => setShowConfirmPassword((v) => !v)}
                      aria-label={showConfirmPassword ? t('auth.hidePassword') : t('auth.showPassword')}
                    >
                      {showConfirmPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
                  {confirmDirty ? (
                    <p
                      id="pr-confirm-hint"
                      className={cn('text-[11px]', passwordsMatch ? 'text-[var(--success)]' : fieldError)}
                      role="status"
                    >
                      {passwordsMatch ? t('signup.passwordsMatch') : t('signup.passwordsDoNotMatch')}
                    </p>
                  ) : null}
                </div>

                <button type="submit" disabled={loading} className={authSubmit}>
                  <span>{loading ? t('common.loading') : t('passwordReset.updatePassword')}</span>
                  <ArrowRight className="h-4 w-4 shrink-0 opacity-90" aria-hidden />
                </button>

                <div className="text-center">
                  <Link
                    to={loginPath}
                    className="inline-flex items-center gap-2 text-[13px] font-medium text-[var(--accent-hi)] hover:underline"
                  >
                    <ArrowLeft className="h-4 w-4" />
                    {t('passwordReset.backToLogin')}
                  </Link>
                </div>
              </form>
            </>
          )}
        </>
      )}
    </AuthCardLayout>
  );
}
