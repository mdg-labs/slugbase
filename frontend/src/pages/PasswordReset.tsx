import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams, useNavigate, Link } from 'react-router-dom';
import api from '../api/client';
import { useAppConfig } from '../contexts/AppConfigContext';
import { Mail, Key, ArrowLeft } from 'lucide-react';
import Button from '../components/ui/Button';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';

const AUTH_CARD = 'rounded-xl border border-ghost bg-surface p-6 shadow-none';

export default function PasswordReset() {
  const { t } = useTranslation();
  const { pathPrefixForLinks } = useAppConfig();
  const prefix = (pathPrefixForLinks || '').replace(/\/+/g, '/') || '';
  const loginPath = `${prefix}/login`.replace(/\/+/g, '/') || '/login';
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
    <div className="min-h-screen flex items-center justify-center bg-background py-12 px-4 sm:px-6 lg:px-8">
      <div className="max-w-md w-full space-y-6">
        <div>
          <h2 className="mt-2 text-center text-2xl font-bold tracking-tight text-foreground">
            {t('passwordReset.title')}
          </h2>
          <p className="mt-2 text-center text-sm text-muted-foreground">
            {step === 'request'
              ? t('passwordReset.description')
              : t('passwordReset.resetPassword')}
          </p>
        </div>

        {message && (
          <div
            className={`rounded-xl border p-4 text-sm ${
              message.type === 'success'
                ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-800 dark:text-emerald-200'
                : 'border-destructive/30 bg-destructive/10 text-destructive'
            }`}
          >
            {message.text}
          </div>
        )}

        {step === 'request' ? (
          <div className={AUTH_CARD}>
            <form className="space-y-6" onSubmit={handleRequestReset}>
              <div className="space-y-2">
                <Label htmlFor="email" className="typography-label">
                  {t('passwordReset.email')}
                </Label>
                <div className="relative">
                  <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
                  <Input
                    id="email"
                    name="email"
                    type="email"
                    autoComplete="email"
                    required
                    className="pl-10"
                    placeholder={t('passwordReset.emailPlaceholder')}
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                  />
                </div>
              </div>

              <Button
                type="submit"
                variant="primary"
                className="w-full border-0 bg-primary-gradient text-primary-foreground shadow-glow hover:opacity-90"
                disabled={loading}
              >
                {t('passwordReset.requestReset')}
              </Button>

              <div className="text-center">
                <Link
                  to={loginPath}
                  className="inline-flex items-center gap-2 text-sm font-medium text-primary hover:text-primary/90"
                >
                  <ArrowLeft className="h-4 w-4" />
                  {t('passwordReset.backToLogin')}
                </Link>
              </div>
            </form>
          </div>
        ) : (
          <>
            {tokenValid === null ? (
              <div className={`${AUTH_CARD} text-center text-muted-foreground`}>
                {t('common.loading')}
              </div>
            ) : tokenValid === false ? (
              <div className={`${AUTH_CARD} text-center space-y-4`}>
                <p className="text-destructive">
                  {t('passwordReset.invalidToken')}
                </p>
                <Link
                  to={`${prefix}/password-reset`.replace(/\/+/g, '/') || '/password-reset'}
                  className="inline-flex items-center gap-2 text-sm font-medium text-primary hover:text-primary/90"
                >
                  <ArrowLeft className="h-4 w-4" />
                  {t('passwordReset.backToLogin')}
                </Link>
              </div>
            ) : (
              <div className={AUTH_CARD}>
                <form className="space-y-6" onSubmit={handleReset}>
                  <div className="space-y-2">
                    <Label htmlFor="password" className="typography-label">
                      {t('passwordReset.newPassword')}
                    </Label>
                    <div className="relative">
                      <Key className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
                      <Input
                        id="password"
                        name="password"
                        type="password"
                        autoComplete="new-password"
                        required
                        className="pl-10"
                        placeholder={t('auth.passwordPlaceholder')}
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                      />
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="confirmPassword" className="typography-label">
                      {t('passwordReset.confirmPassword')}
                    </Label>
                    <div className="relative">
                      <Key className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
                      <Input
                        id="confirmPassword"
                        name="confirmPassword"
                        type="password"
                        autoComplete="new-password"
                        required
                        className="pl-10"
                        placeholder={t('passwordReset.confirmPassword')}
                        value={confirmPassword}
                        onChange={(e) => setConfirmPassword(e.target.value)}
                      />
                    </div>
                  </div>

                  <Button
                    type="submit"
                    variant="primary"
                    className="w-full border-0 bg-primary-gradient text-primary-foreground shadow-glow hover:opacity-90"
                    disabled={loading}
                  >
                    {t('passwordReset.resetPassword')}
                  </Button>

                  <div className="text-center">
                    <Link
                      to={loginPath}
                      className="inline-flex items-center gap-2 text-sm font-medium text-primary hover:text-primary/90"
                    >
                      <ArrowLeft className="h-4 w-4" />
                      {t('passwordReset.backToLogin')}
                    </Link>
                  </div>
                </form>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
