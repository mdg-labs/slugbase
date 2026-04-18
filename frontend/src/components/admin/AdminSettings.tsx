import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../contexts/AuthContext';
import api from '../../api/client';
import { useToast } from '../ui/Toast';
import { Save, Mail, Send } from 'lucide-react';
import Button from '../ui/Button';
import { PageLoadingSkeleton } from '../ui/PageLoadingSkeleton';
import { PageHeader } from '../PageHeader';
import { Switch } from '../ui/switch';
import { Label } from '../ui/label';
import { Input } from '../ui/input';

// React in scope for package consumers that use classic JSX transform
void React;

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
      <PageHeader title={t('admin.settings')} subtitle={t('smtp.description')} />

      <div className="rounded-2xl border border-ghost bg-surface p-6 shadow-none">
        <div className="mb-6 flex items-center gap-2">
          <Mail className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-lg font-semibold text-foreground">{t('smtp.title')}</h2>
        </div>

        <div className="space-y-4">
          <div className="flex items-center gap-3">
            <Switch
              id="smtp-enabled"
              checked={smtpSettings.enabled}
              onCheckedChange={(checked) => setSmtpSettings({ ...smtpSettings, enabled: checked })}
            />
            <Label htmlFor="smtp-enabled" className="text-sm font-medium text-foreground cursor-pointer">
              {t('smtp.enabled')}
            </Label>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label className="typography-label">{t('smtp.host')}</Label>
              <Input
                type="text"
                placeholder={t('smtp.hostPlaceholder')}
                value={smtpSettings.host}
                onChange={(e) => setSmtpSettings({ ...smtpSettings, host: e.target.value })}
              />
            </div>
            <div className="space-y-2">
              <Label className="typography-label">{t('smtp.port')}</Label>
              <Input
                type="number"
                placeholder={t('smtp.portPlaceholder')}
                value={smtpSettings.port}
                onChange={(e) => setSmtpSettings({ ...smtpSettings, port: parseInt(e.target.value, 10) || 587 })}
              />
            </div>
            <div className="space-y-2">
              <Label className="typography-label">{t('smtp.user')}</Label>
              <Input
                type="text"
                placeholder={t('smtp.userPlaceholder')}
                value={smtpSettings.user}
                onChange={(e) => setSmtpSettings({ ...smtpSettings, user: e.target.value })}
              />
            </div>
            <div className="space-y-2">
              <Label className="typography-label">{t('smtp.password')}</Label>
              <Input
                type="password"
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
              />
              <p className="mt-1 text-xs text-muted-foreground">
                {passwordIsSet ? t('smtp.passwordChangeHint') : t('admin.leaveBlank')}
              </p>
            </div>
            <div className="space-y-2">
              <Label className="typography-label">{t('smtp.from')}</Label>
              <Input
                type="email"
                placeholder={t('smtp.fromPlaceholder')}
                value={smtpSettings.from}
                onChange={(e) => setSmtpSettings({ ...smtpSettings, from: e.target.value })}
              />
            </div>
            <div className="space-y-2">
              <Label className="typography-label">{t('smtp.fromName')}</Label>
              <Input
                type="text"
                placeholder={t('smtp.fromNamePlaceholder')}
                value={smtpSettings.fromName}
                onChange={(e) => setSmtpSettings({ ...smtpSettings, fromName: e.target.value })}
              />
            </div>
          </div>

          <div className="flex items-center gap-3 pt-2">
            <Switch
              id="smtp-secure"
              checked={smtpSettings.secure}
              onCheckedChange={(checked) => setSmtpSettings({ ...smtpSettings, secure: checked })}
            />
            <Label htmlFor="smtp-secure" className="text-sm font-medium text-foreground cursor-pointer">
              {t('smtp.secure')}
            </Label>
          </div>

          <div className="flex items-center gap-4 pt-4 border-t border-ghost">
            <div className="flex-1 space-y-2">
              <Label className="typography-label">{t('smtp.testEmail')}</Label>
              <div className="rounded-xl border border-ghost bg-surface-low px-4 py-2.5 text-sm text-muted-foreground">
                {user?.email || t('common.loading')}
              </div>
            </div>
            <div className="pt-6">
              <Button
                variant="ghost"
                icon={Send}
                onClick={handleTestEmail}
                disabled={testingEmail || !user?.email}
              >
                {t('smtp.sendTest')}
              </Button>
            </div>
          </div>

          <div className="pt-4">
            <Button variant="primary" icon={Save} onClick={handleSMTPSave} className="border-0 bg-primary-gradient text-primary-foreground shadow-glow hover:opacity-90">
              {t('smtp.save')}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
