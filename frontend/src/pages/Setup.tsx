import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import api from '../api/client';
import { useAppConfig } from '../contexts/AppConfigContext';
import { useAuth } from '../contexts/AuthContext';
import { ArrowRight, Check, Eye, EyeOff, Lock, Mail, User } from 'lucide-react';
import { passwordStrengthScore } from '../utils/passwordStrength';
import { PasswordStrengthMeter } from '../components/auth/PasswordStrengthMeter';
import { authFieldLabel, authInput, fieldError, authSubmit } from '../components/auth/authPageClasses';
import { cn } from '@/lib/utils';

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
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);

  const pwScore = passwordStrengthScore(formData.password);

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
      <div className="flex min-h-screen min-h-dvh w-full items-center justify-center bg-[var(--bg-0)] px-4 py-10">
        <div
          className="w-full max-w-[440px] rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--bg-1)] p-8 text-center shadow-[var(--shadow-lg)]"
          style={{ padding: 32 }}
        >
          <div className="mx-auto mb-4 grid size-14 place-items-center rounded-2xl border border-[rgba(74,222,128,0.35)] bg-[rgba(74,222,128,0.12)]">
            <Check className="size-7 text-[var(--success)]" strokeWidth={2} aria-hidden />
          </div>
          <h2 className="m-0 text-[18px] font-semibold text-[var(--fg-0)]">{t('setup.success')}</h2>
          <p className="mt-2 text-[13px] text-[var(--fg-2)]">{t('setup.redirectingToDashboard')}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen min-h-dvh w-full flex-col items-center justify-center bg-[var(--bg-0)] px-4 py-10">
      <div className="w-full max-w-[440px]" style={{ maxWidth: 440 }}>
        <div className="mb-8 flex items-center gap-3">
          <div className="grid size-8 shrink-0 place-items-center rounded-[9px] border border-[var(--accent-ring)] bg-[var(--accent-bg)]">
            <img src="/slugbase_icon_purple.svg" alt="" className="size-[22px]" width={22} height={22} />
          </div>
          <div>
            <div className="text-[15px] font-semibold tracking-[-0.01em] text-[var(--fg-0)]">{t('app.name')}</div>
            <div className="mt-0.5 text-[13px] font-medium text-[var(--fg-1)]">{t('setup.title')}</div>
            <p className="mt-1 text-[12.5px] text-[var(--fg-2)]">{t('setup.subtitle')}</p>
          </div>
        </div>

        <div
          className="rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--bg-1)] shadow-[var(--shadow-lg)]"
          style={{ padding: 32 }}
        >
          <form onSubmit={handleSubmit} className="space-y-5">
            <div className="space-y-2">
              <label htmlFor="setup-email" className={authFieldLabel}>
                {t('setup.email')}
              </label>
              <div className={authInput}>
                <Mail className="h-4 w-4 shrink-0 text-[var(--fg-3)]" aria-hidden />
                <input
                  id="setup-email"
                  name="email"
                  type="email"
                  required
                  placeholder={t('setup.emailPlaceholder')}
                  value={formData.email}
                  onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                  className="min-w-0 flex-1 border-0 bg-transparent p-0 text-[13px] text-[var(--fg-0)] outline-none placeholder:text-[var(--fg-4)]"
                />
              </div>
            </div>

            <div className="space-y-2">
              <label htmlFor="setup-name" className={authFieldLabel}>
                {t('setup.name')}
              </label>
              <div className={authInput}>
                <User className="h-4 w-4 shrink-0 text-[var(--fg-3)]" aria-hidden />
                <input
                  id="setup-name"
                  name="name"
                  type="text"
                  required
                  placeholder={t('setup.namePlaceholder')}
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  className="min-w-0 flex-1 border-0 bg-transparent p-0 text-[13px] text-[var(--fg-0)] outline-none placeholder:text-[var(--fg-4)]"
                />
              </div>
            </div>

            <div className="space-y-2">
              <label htmlFor="setup-password" className={authFieldLabel}>
                {t('setup.password')}
              </label>
              <div className={authInput}>
                <Lock className="h-4 w-4 shrink-0 text-[var(--fg-3)]" aria-hidden />
                <input
                  id="setup-password"
                  name="password"
                  type={showPassword ? 'text' : 'password'}
                  required
                  minLength={8}
                  placeholder={t('setup.passwordPlaceholder')}
                  value={formData.password}
                  onChange={(e) => setFormData({ ...formData, password: e.target.value })}
                  className="min-w-0 flex-1 border-0 bg-transparent p-0 text-[13px] text-[var(--fg-0)] outline-none placeholder:text-[var(--fg-4)]"
                  aria-describedby="setup-password-strength"
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
              <PasswordStrengthMeter score={pwScore} id="setup-password-strength" />
            </div>

            <div className="space-y-2">
              <label htmlFor="setup-confirm" className={authFieldLabel}>
                {t('setup.confirmPassword')}
              </label>
              <div className={authInput}>
                <Lock className="h-4 w-4 shrink-0 text-[var(--fg-3)]" aria-hidden />
                <input
                  id="setup-confirm"
                  name="confirmPassword"
                  type={showConfirm ? 'text' : 'password'}
                  required
                  minLength={8}
                  placeholder={t('setup.confirmPasswordPlaceholder')}
                  value={formData.confirmPassword}
                  onChange={(e) => setFormData({ ...formData, confirmPassword: e.target.value })}
                  className="min-w-0 flex-1 border-0 bg-transparent p-0 text-[13px] text-[var(--fg-0)] outline-none placeholder:text-[var(--fg-4)]"
                />
                <button
                  type="button"
                  className="shrink-0 rounded p-1 text-[var(--fg-3)] hover:text-[var(--fg-0)]"
                  onClick={() => setShowConfirm((v) => !v)}
                  aria-label={showConfirm ? t('auth.hidePassword') : t('auth.showPassword')}
                >
                  {showConfirm ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>

            <div className="rounded-[var(--radius)] border border-[var(--accent-ring)] bg-[var(--accent-bg)] px-4 py-3 text-[12.5px] leading-snug text-[var(--fg-1)]">
              {t('setup.adminNote')}
            </div>

            {error && (
              <p role="alert" className={cn(fieldError, 'rounded-md border border-[rgba(248,113,113,0.35)] bg-[rgba(248,113,113,0.08)] px-3 py-2')}>
                {error}
              </p>
            )}

            <button type="submit" disabled={loading} className={authSubmit}>
              <span>{loading ? t('common.loading') : t('setup.submit')}</span>
              <ArrowRight className="h-4 w-4 shrink-0 opacity-90" aria-hidden />
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
