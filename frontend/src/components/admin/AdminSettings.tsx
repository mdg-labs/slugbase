import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Eye, EyeOff, Save, Send } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import api from '../../api/client';
import { useToast } from '../ui/Toast';
import Button from '../ui/Button';
import { PageLoadingSkeleton } from '../ui/PageLoadingSkeleton';
import { Switch } from '../ui/switch';
import { Label } from '../ui/label';
import { Input } from '../ui/input';
import { cn } from '@/lib/utils';

void React;

function SettingsRow({
  label,
  description,
  children,
  className,
}: {
  label: string;
  description?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('settings-row flex flex-col gap-2 border-b border-[var(--border-soft)] py-4 last:border-0', className)}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-medium text-[var(--fg-0)]">{label}</p>
          {description ? <p className="mt-0.5 text-[12px] text-[var(--fg-2)]">{description}</p> : null}
        </div>
        <div className="min-w-0 shrink-0 sm:max-w-[min(100%,420px)] sm:text-right">{children}</div>
      </div>
    </div>
  );
}

export default function AdminSettings() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const { showToast } = useToast();
  const [loading, setLoading] = useState(true);
  const [smtpSettings, setSmtpSettings] = useState({
    enabled: false,
    host: '',
    port: 587,
    secure: false,
    user: '',
    password: '',
    from: '',
    fromName: 'SlugBase',
  });
  const [passwordIsSet, setPasswordIsSet] = useState(false);
  const [testingEmail, setTestingEmail] = useState(false);
  const [showPw, setShowPw] = useState(false);

  useEffect(() => {
    loadSmtpSettings();
  }, []);

  const loadSmtpSettings = async () => {
    try {
      const response = await api.get<Record<string, string>>('/admin/settings/smtp');
      const data = response.data;
      const hasPassword = data.smtp_password === '***SET***';
      setPasswordIsSet(hasPassword);
      setSmtpSettings({
        enabled: data.smtp_enabled === 'true',
        host: data.smtp_host || '',
        port: parseInt(data.smtp_port || '587'),
        secure: data.smtp_secure === 'true',
        user: data.smtp_user || '',
        password: hasPassword ? '••••••••••••••••' : '',
        from: data.smtp_from || '',
        fromName: data.smtp_from_name || 'SlugBase',
      });
    } catch (error) {
      console.error('Failed to load SMTP settings:', error);
      showToast(t('common.error'), 'error');
    } finally {
      setLoading(false);
    }
  };

  const handleSMTPSave = async () => {
    try {
      const settingsToSave: Record<string, unknown> = { ...smtpSettings };
      if (settingsToSave.password === '••••••••••••••••') {
        delete settingsToSave.password;
      }
      await api.post('/admin/settings/smtp', settingsToSave);
      showToast(t('common.success'), 'success');
      await loadSmtpSettings();
    } catch (error: unknown) {
      const e = error as { response?: { data?: { error?: string } } };
      showToast(e?.response?.data?.error || t('common.error'), 'error');
    }
  };

  const handleTestEmail = async () => {
    if (!user?.email) {
      showToast(t('admin.noUserEmailAvailable'), 'warning');
      return;
    }
    setTestingEmail(true);
    try {
      await api.post('/admin/settings/smtp/test', { email: user.email });
      showToast(t('smtp.testSent'), 'success');
    } catch (error: unknown) {
      const e = error as { response?: { data?: { error?: string } } };
      showToast(e?.response?.data?.error || t('smtp.testFailed'), 'error');
    } finally {
      setTestingEmail(false);
    }
  };

  if (loading) {
    return (
      <div className="pb-24">
        <PageLoadingSkeleton lines={8} />
      </div>
    );
  }

  return (
    <div className="space-y-6 pb-24">
      <div>
        <h2 className="text-[18px] font-semibold tracking-tight text-[var(--fg-0)]">{t('smtp.title')}</h2>
        <p className="mt-1 text-[12.5px] text-[var(--fg-2)]">{t('smtp.description')}</p>
      </div>

      <div className="rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--bg-1)] px-4 py-1">
        <SettingsRow label={t('smtp.enabled')}>
          <Switch
            id="smtp-enabled"
            checked={smtpSettings.enabled}
            onCheckedChange={(checked) => setSmtpSettings({ ...smtpSettings, enabled: checked })}
          />
        </SettingsRow>

        <SettingsRow label={t('smtp.host')}>
          <Input
            type="text"
            placeholder={t('smtp.hostPlaceholder')}
            value={smtpSettings.host}
            onChange={(e) => setSmtpSettings({ ...smtpSettings, host: e.target.value })}
          />
        </SettingsRow>

        <SettingsRow label={t('smtp.port')}>
          <Input
            type="number"
            placeholder={t('smtp.portPlaceholder')}
            value={smtpSettings.port}
            onChange={(e) => setSmtpSettings({ ...smtpSettings, port: parseInt(e.target.value, 10) || 587 })}
          />
        </SettingsRow>

        <SettingsRow label={t('smtp.user')}>
          <Input
            type="text"
            placeholder={t('smtp.userPlaceholder')}
            value={smtpSettings.user}
            onChange={(e) => setSmtpSettings({ ...smtpSettings, user: e.target.value })}
          />
        </SettingsRow>

        <SettingsRow
          label={t('smtp.password')}
          description={passwordIsSet ? t('smtp.passwordChangeHint') : t('admin.leaveBlank')}
        >
          <div className="relative">
            <Input
              type={showPw ? 'text' : 'password'}
              placeholder={passwordIsSet ? t('smtp.passwordPlaceholder') : t('smtp.passwordPlaceholder')}
              value={smtpSettings.password}
              onChange={(e) => {
                const newValue = e.target.value;
                if (passwordIsSet && smtpSettings.password === '••••••••••••••••' && newValue.length > 0) {
                  setSmtpSettings({ ...smtpSettings, password: newValue });
                  setPasswordIsSet(false);
                } else {
                  setSmtpSettings({ ...smtpSettings, password: newValue });
                  setPasswordIsSet(newValue.length > 0);
                }
              }}
              onFocus={() => {
                if (smtpSettings.password === '••••••••••••••••') {
                  setSmtpSettings({ ...smtpSettings, password: '' });
                  setPasswordIsSet(false);
                }
              }}
              className="pr-10"
            />
            <button
              type="button"
              className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-[var(--radius-sm)] p-1.5 text-[var(--fg-2)] hover:bg-[var(--bg-hover)] hover:text-[var(--fg-0)]"
              onClick={() => setShowPw((v) => !v)}
              aria-label={t('smtp.togglePasswordVisibility')}
            >
              {showPw ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>
        </SettingsRow>

        <SettingsRow label={t('smtp.from')}>
          <Input
            type="email"
            placeholder={t('smtp.fromPlaceholder')}
            value={smtpSettings.from}
            onChange={(e) => setSmtpSettings({ ...smtpSettings, from: e.target.value })}
          />
        </SettingsRow>

        <SettingsRow label={t('smtp.fromName')}>
          <Input
            type="text"
            placeholder={t('smtp.fromNamePlaceholder')}
            value={smtpSettings.fromName}
            onChange={(e) => setSmtpSettings({ ...smtpSettings, fromName: e.target.value })}
          />
        </SettingsRow>

        <SettingsRow label={t('smtp.secure')}>
          <Switch
            id="smtp-secure"
            checked={smtpSettings.secure}
            onCheckedChange={(checked) => setSmtpSettings({ ...smtpSettings, secure: checked })}
          />
        </SettingsRow>

        <div className="settings-row flex flex-col gap-3 border-t border-[var(--border-soft)] py-4 sm:flex-row sm:items-end sm:justify-between">
          <div className="min-w-0 flex-1 space-y-2">
            <Label className="typography-label text-[var(--fg-0)]">{t('smtp.testEmail')}</Label>
            <div className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg-2)] px-3 py-2 text-[13px] text-[var(--fg-2)]">
              {user?.email || t('common.loading')}
            </div>
          </div>
          <Button
            type="button"
            variant="ghost"
            icon={Send}
            onClick={handleTestEmail}
            disabled={testingEmail || !user?.email}
            className="shrink-0"
          >
            {t('smtp.sendTest')}
          </Button>
        </div>

        <div className="flex justify-end border-t border-[var(--border-soft)] py-4">
          <Button
            variant="primary"
            icon={Save}
            onClick={handleSMTPSave}
            className="border-0 bg-primary-gradient text-primary-foreground shadow-glow hover:opacity-90"
          >
            {t('smtp.save')}
          </Button>
        </div>
      </div>
    </div>
  );
}
