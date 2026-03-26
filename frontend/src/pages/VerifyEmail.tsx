import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useSearchParams, Link } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import api from '../api/client';
import { CheckCircle, XCircle, Mail } from 'lucide-react';
import Button from '../components/ui/Button';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';

const AUTH_CARD = 'rounded-xl border border-ghost bg-surface p-6 shadow-none';

export default function VerifyEmail() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { checkAuth } = useAuth();
  const profilePath = '/profile';
  const loginPath = '/login';
  const signupPath = '/login';
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

    api.post('/auth/verify-signup', { token })
      .then(() => {
        setStatus('success');
        setSignupVerified(true);
        setTimeout(() => navigate(loginPath), 2500);
      })
      .catch(async () => {
        const statusRes = await api.get('/auth/signup-verification/status', { params: { token } }).catch(() => ({ data: { status: 'invalid' } }));
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
          // Not a profile token either
        }
        setStatus('error');
        setError(t('emailVerification.invalidLink'));
      });
  }, [searchParams, t, navigate, checkAuth]);

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

  return (
    <div className="min-h-screen flex items-center justify-center bg-background py-12 px-4 sm:px-6 lg:px-8">
      <div className={`max-w-md w-full ${AUTH_CARD}`}>
        <div className="text-center space-y-4">
          {status === 'verifying' && (
            <>
              <div className="mx-auto w-16 h-16 bg-primary/15 rounded-full flex items-center justify-center">
                <Mail className="h-8 w-8 text-primary animate-pulse" />
              </div>
              <h2 className="text-2xl font-semibold text-foreground">
                {t('emailVerification.verifying')}
              </h2>
              <p className="text-muted-foreground">
                {t('emailVerification.verifyingDescription')}
              </p>
            </>
          )}

          {status === 'success' && (
            <>
              <div className="mx-auto w-16 h-16 bg-green-100 dark:bg-green-900/30 rounded-full flex items-center justify-center">
                <CheckCircle className="h-8 w-8 text-green-600 dark:text-green-400" />
              </div>
              <h2 className="text-2xl font-semibold text-foreground">
                {signupVerified ? t('emailVerification.signupSuccess') : t('emailVerification.success')}
              </h2>
              <p className="text-muted-foreground">
                {signupVerified ? t('emailVerification.signupSuccessDescription') : t('emailVerification.successDescription', { email: newEmail })}
              </p>
              {!signupVerified && (
                <p className="text-sm text-muted-foreground">
                  {t('emailVerification.redirecting')}
                </p>
              )}
            </>
          )}

          {(status === 'resend' || status === 'noToken') && (
            <>
              {resendSuccess ? (
                <>
                  <div className="mx-auto w-16 h-16 bg-green-100 dark:bg-green-900/30 rounded-full flex items-center justify-center">
                    <CheckCircle className="h-8 w-8 text-green-600 dark:text-green-400" />
                  </div>
                  <h2 className="text-2xl font-semibold text-foreground">
                    {t('emailVerification.resendSuccess')}
                  </h2>
                  <p className="text-muted-foreground">
                    {t('emailVerification.resendSuccessDescription')}
                  </p>
                  <Link to={loginPath} className="inline-block mt-2 text-sm font-medium text-primary hover:underline">
                    {t('auth.login')}
                  </Link>
                </>
              ) : (
                <>
                  <div className="mx-auto w-16 h-16 bg-amber-100 dark:bg-amber-900/30 rounded-full flex items-center justify-center">
                    <Mail className="h-8 w-8 text-amber-600 dark:text-amber-400" />
                  </div>
                  <h2 className="text-2xl font-semibold text-foreground">
                    {t('emailVerification.resendTitle')}
                  </h2>
                  <p className="text-muted-foreground">
                    {status === 'resend'
                      ? t('emailVerification.resendDescription')
                      : t('emailVerification.resendNoTokenDescription')}
                  </p>
                  <form onSubmit={status === 'resend' ? handleResendSubmit : handleRequestResendSubmit} className="space-y-4 text-left mt-4">
                    <div className="space-y-2">
                      <Label htmlFor="resend-email" className="typography-label">
                        {t('emailVerification.editEmailLabel')}
                      </Label>
                      <Input
                        id="resend-email"
                        name="email"
                        type="email"
                        required
                        placeholder={t('auth.emailPlaceholder')}
                        value={status === 'resend' ? resendEmail : undefined}
                        onChange={status === 'resend' ? (e) => setResendEmail(e.target.value) : undefined}
                      />
                    </div>
                    {error && (
                      <div className="px-4 py-3 rounded-xl border border-destructive/30 bg-destructive/10">
                        <p className="text-sm text-destructive">{error}</p>
                      </div>
                    )}
                    <Button
                      type="submit"
                      variant="primary"
                      disabled={resendLoading}
                      className="w-full border-0 bg-primary-gradient text-primary-foreground shadow-glow hover:opacity-90"
                    >
                      {resendLoading ? t('common.loading') : t('emailVerification.resendButton')}
                    </Button>
                  </form>
                  <p className="text-sm text-muted-foreground mt-2">
                    <Link to={loginPath} className="font-medium text-primary hover:underline">
                      {t('signup.backToLogin')}
                    </Link>
                    {' · '}
                    <Link to={signupPath} className="font-medium text-primary hover:underline">
                      {t('auth.signUp')}
                    </Link>
                  </p>
                </>
              )}
            </>
          )}

          {status === 'error' && (
            <>
              <div className="mx-auto w-16 h-16 bg-red-100 dark:bg-red-900/30 rounded-full flex items-center justify-center">
                <XCircle className="h-8 w-8 text-red-600 dark:text-red-400" />
              </div>
              <h2 className="text-2xl font-semibold text-foreground">
                {t('emailVerification.error')}
              </h2>
              <p className="text-muted-foreground">
                {error || t('emailVerification.errorDescription')}
              </p>
              <div className="pt-4 space-y-2">
                {error === t('emailVerification.alreadyVerified') ? (
                  <Button variant="primary" onClick={() => navigate(loginPath)} className="border-0 bg-primary-gradient text-primary-foreground shadow-glow hover:opacity-90">
                    {t('auth.login')}
                  </Button>
                ) : (
                  <Button variant="primary" onClick={() => navigate(profilePath)} className="border-0 bg-primary-gradient text-primary-foreground shadow-glow hover:opacity-90">
                    {t('emailVerification.backToProfile')}
                  </Button>
                )}
                {error !== t('emailVerification.alreadyVerified') && (
                  <p className="text-sm">
                    <Link to={signupPath} className="font-medium text-primary hover:underline">
                      {t('auth.signUp')}
                    </Link>
                  </p>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
