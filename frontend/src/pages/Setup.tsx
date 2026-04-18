import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import api from '../api/client';
import { useAppConfig } from '../contexts/AppConfigContext';
import { useAuth } from '../contexts/AuthContext';
import { CheckCircle, UserPlus, Shield } from 'lucide-react';
import Button from '../components/ui/Button';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';

const AUTH_CARD = 'rounded-xl border border-ghost bg-surface p-6 shadow-none';

export default function Setup() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { appRootPath } = useAppConfig();
  const { user, checkAuth } = useAuth();
  const [formData, setFormData] = useState({
    email: '',
    name: '',
    password: '',
    confirmPassword: '',
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    if (user) {
      navigate(appRootPath);
    }
  }, [user, navigate, appRootPath]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    if (formData.password !== formData.confirmPassword) {
      setError(t('setup.passwordMismatch'));
      setLoading(false);
      return;
    }

    if (formData.password.length < 8) {
      setError(t('setup.passwordTooShort'));
      setLoading(false);
      return;
    }

    try {
      const { confirmPassword, ...dataToSend } = formData;
      await api.post('/auth/setup', dataToSend);
      await checkAuth();
      setSuccess(true);
      setTimeout(() => {
        navigate(appRootPath);
      }, 1500);
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } } };
      setError(e.response?.data?.error || t('common.error'));
    } finally {
      setLoading(false);
    }
  };

  if (success) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background py-12 px-4">
        <div className={`max-w-md w-full ${AUTH_CARD} text-center space-y-4`}>
          <div className="mx-auto w-16 h-16 rounded-full bg-emerald-500/15 flex items-center justify-center">
            <CheckCircle className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
          </div>
          <h2 className="text-lg font-semibold text-foreground">
            {t('setup.success')}
          </h2>
          <p className="text-muted-foreground text-sm">
            {t('setup.redirectingToDashboard')}
          </p>
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
            {t('setup.title')}
          </h2>
          <p className="mt-2 text-sm text-muted-foreground">
            {t('setup.description')}
          </p>
        </div>

        <div className={AUTH_CARD}>
          <form onSubmit={handleSubmit} className="space-y-5">
            <div className="space-y-2">
              <Label htmlFor="email" className="typography-label">
                {t('setup.email')}
              </Label>
              <Input
                id="email"
                name="email"
                type="email"
                required
                placeholder={t('setup.emailPlaceholder')}
                value={formData.email}
                onChange={(e) => setFormData({ ...formData, email: e.target.value })}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="name" className="typography-label">
                {t('setup.name')}
              </Label>
              <Input
                id="name"
                name="name"
                type="text"
                required
                placeholder={t('setup.namePlaceholder')}
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="password" className="typography-label">
                {t('setup.password')}
              </Label>
              <Input
                id="password"
                name="password"
                type="password"
                required
                minLength={8}
                placeholder={t('setup.passwordPlaceholder')}
                value={formData.password}
                onChange={(e) => setFormData({ ...formData, password: e.target.value })}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="confirmPassword" className="typography-label">
                {t('setup.confirmPassword')}
              </Label>
              <Input
                id="confirmPassword"
                name="confirmPassword"
                type="password"
                required
                minLength={8}
                placeholder={t('setup.confirmPasswordPlaceholder')}
                value={formData.confirmPassword}
                onChange={(e) => setFormData({ ...formData, confirmPassword: e.target.value })}
              />
            </div>

            <div className="rounded-xl border border-primary/25 bg-primary/10 px-4 py-3">
              <div className="flex items-start gap-2">
                <Shield className="h-4 w-4 text-primary flex-shrink-0 mt-0.5" />
                <p className="text-sm text-foreground">
                  {t('setup.adminNote')}
                </p>
              </div>
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
              icon={UserPlus}
              className="w-full border-0 bg-primary-gradient text-primary-foreground shadow-glow hover:opacity-90"
            >
              {loading ? t('common.loading') : t('setup.submit')}
            </Button>
          </form>
        </div>
      </div>
    </div>
  );
}
