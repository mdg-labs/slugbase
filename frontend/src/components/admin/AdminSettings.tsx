import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../contexts/AuthContext';
import api from '../../api/client';
import { useToast } from '../ui/Toast';
import { Save, Plus, Trash2, Settings as SettingsIcon, Mail, Send } from 'lucide-react';
import Button from '../ui/Button';
import ConfirmDialog from '../ui/ConfirmDialog';
import { useConfirmDialog } from '../../hooks/useConfirmDialog';

export default function AdminSettings() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const { showConfirm, dialogState } = useConfirmDialog();
  const { showToast } = useToast();
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [newKey, setNewKey] = useState('');
  const [newValue, setNewValue] = useState('');

  // SMTP settings state
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
    loadSettings();
  }, []);

  const loadSettings = async () => {
    try {
      const response = await api.get('/admin/settings');
      const allSettings = response.data;
      setSettings(allSettings);

      // Load SMTP settings
      // Check if password is set (backend returns '***SET***' if password exists)
      const hasPassword = allSettings.smtp_password === '***SET***';
      setPasswordIsSet(hasPassword);
      
      setSmtpSettings({
        enabled: allSettings.smtp_enabled === 'true',
        host: allSettings.smtp_host || '',
        port: parseInt(allSettings.smtp_port || '587'),
        secure: allSettings.smtp_secure === 'true',
        user: allSettings.smtp_user || '',
        password: hasPassword ? '••••••••••••••••' : '', // Show masked password if set, empty if not
        from: allSettings.smtp_from || '',
        fromName: allSettings.smtp_from_name || 'SlugBase',
      });
    } catch (error) {
      console.error('Failed to load settings:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async (key: string, value: string) => {
    try {
      await api.post('/admin/settings', { key, value });
      setSettings({ ...settings, [key]: value });
      showToast(t('common.success'), 'success');
    } catch (error: any) {
      showToast(error.response?.data?.error || t('common.error'), 'error');
    }
  };

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newKey) return;
    try {
      await api.post('/admin/settings', { key: newKey, value: newValue });
      setSettings({ ...settings, [newKey]: newValue });
      setNewKey('');
      setNewValue('');
      showToast(t('common.success'), 'success');
    } catch (error: any) {
      showToast(error.response?.data?.error || t('common.error'), 'error');
    }
  };

  const handleDelete = (key: string) => {
    showConfirm(
      t('admin.confirmDeleteSetting'),
      t('admin.confirmDeleteSetting'),
      async () => {
        try {
          await api.delete(`/admin/settings/${key}`);
          const newSettings = { ...settings };
          delete newSettings[key];
          setSettings(newSettings);
          showToast(t('common.success'), 'success');
        } catch (error: any) {
          showToast(error.response?.data?.error || t('common.error'), 'error');
        }
      },
      { variant: 'danger', confirmText: t('common.delete'), cancelText: t('common.cancel') }
    );
  };

  const handleSMTPSave = async () => {
    try {
      // If password field contains the masked string, don't send it (keep existing password)
      const settingsToSave: any = { ...smtpSettings };
      if (settingsToSave.password === '••••••••••••••••') {
        // Password is masked, don't send it to keep existing password
        delete settingsToSave.password;
      }
      
      await api.post('/admin/settings/smtp', settingsToSave);
      showToast(t('common.success'), 'success');
      await loadSettings();
    } catch (error: any) {
      showToast(error.response?.data?.error || t('common.error'), 'error');
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
    } catch (error: any) {
      showToast(error.response?.data?.error || t('smtp.testFailed'), 'error');
    } finally {
      setTestingEmail(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="text-gray-500 dark:text-gray-400">{t('common.loading')}</div>
      </div>
    );
  }

  // Filter out SMTP settings from general settings display
  const generalSettings = Object.fromEntries(
    Object.entries(settings).filter(([key]) => !key.startsWith('smtp_'))
  );

  return (
    <div className="space-y-6">
      {/* SMTP Settings Section */}
      <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 shadow-sm p-4">
        <div className="flex items-center gap-2 mb-6">
          <Mail className="h-5 w-5 text-gray-400 dark:text-gray-500" />
          <div>
            <h2 className="text-xl font-semibold text-gray-900 dark:text-white">
              {t('smtp.title')}
            </h2>
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
              {t('smtp.description')}
            </p>
          </div>
        </div>

        <div className="space-y-4">
          <div className="flex items-center gap-3">
            <input
              type="checkbox"
              id="smtp-enabled"
              checked={smtpSettings.enabled}
              onChange={(e) => setSmtpSettings({ ...smtpSettings, enabled: e.target.checked })}
              className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
            />
            <label htmlFor="smtp-enabled" className="text-sm font-medium text-gray-900 dark:text-white">
              {t('smtp.enabled')}
            </label>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-semibold text-gray-900 dark:text-white mb-2">
                    {t('smtp.host')}
                  </label>
                  <input
                    type="text"
                    className="w-full px-4 h-9 text-sm text-gray-900 dark:text-white bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    placeholder={t('smtp.hostPlaceholder')}
                    value={smtpSettings.host}
                    onChange={(e) => setSmtpSettings({ ...smtpSettings, host: e.target.value })}
                  />
                </div>
                <div>
                  <label className="block text-sm font-semibold text-gray-900 dark:text-white mb-2">
                    {t('smtp.port')}
                  </label>
                  <input
                    type="number"
                    className="w-full px-4 h-9 text-sm text-gray-900 dark:text-white bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    placeholder={t('smtp.portPlaceholder')}
                    value={smtpSettings.port}
                    onChange={(e) => setSmtpSettings({ ...smtpSettings, port: parseInt(e.target.value) || 587 })}
                  />
                </div>
                <div>
                  <label className="block text-sm font-semibold text-gray-900 dark:text-white mb-2">
                    {t('smtp.user')}
                  </label>
                  <input
                    type="text"
                    className="w-full px-4 h-9 text-sm text-gray-900 dark:text-white bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    placeholder={t('smtp.userPlaceholder')}
                    value={smtpSettings.user}
                    onChange={(e) => setSmtpSettings({ ...smtpSettings, user: e.target.value })}
                  />
                </div>
                <div>
                  <label className="block text-sm font-semibold text-gray-900 dark:text-white mb-2">
                    {t('smtp.password')}
                  </label>
                  <input
                    type="password"
                    className="w-full px-4 h-9 text-sm text-gray-900 dark:text-white bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    placeholder={passwordIsSet ? t('smtp.passwordPlaceholder') : t('smtp.passwordPlaceholder')}
                    value={smtpSettings.password}
                    onChange={(e) => {
                      // If user starts typing, clear the masked password
                      const newValue = e.target.value;
                      if (passwordIsSet && smtpSettings.password === '••••••••••••••••' && newValue.length > 0) {
                        // User is typing, clear the masked value
                        setSmtpSettings({ ...smtpSettings, password: newValue });
                        setPasswordIsSet(false);
                      } else {
                        setSmtpSettings({ ...smtpSettings, password: newValue });
                        if (newValue.length > 0) {
                          setPasswordIsSet(true);
                        }
                      }
                    }}
                    onFocus={() => {
                      // Clear masked password when field is focused
                      if (smtpSettings.password === '••••••••••••••••') {
                        setSmtpSettings({ ...smtpSettings, password: '' });
                        setPasswordIsSet(false);
                      }
                    }}
                  />
                  <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                    {passwordIsSet ? t('smtp.passwordChangeHint') : t('admin.leaveBlank')}
                  </p>
                </div>
                <div>
                  <label className="block text-sm font-semibold text-gray-900 dark:text-white mb-2">
                    {t('smtp.from')}
                  </label>
                  <input
                    type="email"
                    className="w-full px-4 h-9 text-sm text-gray-900 dark:text-white bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    placeholder={t('smtp.fromPlaceholder')}
                    value={smtpSettings.from}
                    onChange={(e) => setSmtpSettings({ ...smtpSettings, from: e.target.value })}
                  />
                </div>
                <div>
                  <label className="block text-sm font-semibold text-gray-900 dark:text-white mb-2">
                    {t('smtp.fromName')}
                  </label>
                  <input
                    type="text"
                    className="w-full px-4 h-9 text-sm text-gray-900 dark:text-white bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    placeholder={t('smtp.fromNamePlaceholder')}
                    value={smtpSettings.fromName}
                    onChange={(e) => setSmtpSettings({ ...smtpSettings, fromName: e.target.value })}
                  />
                </div>
              </div>

              <div className="flex items-center gap-3 pt-2">
                <input
                  type="checkbox"
                  id="smtp-secure"
                  checked={smtpSettings.secure}
                  onChange={(e) => setSmtpSettings({ ...smtpSettings, secure: e.target.checked })}
                  className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
                />
                <label htmlFor="smtp-secure" className="text-sm font-medium text-gray-900 dark:text-white">
                  {t('smtp.secure')}
                </label>
              </div>

              <div className="flex items-center gap-4 pt-4 border-t border-gray-200 dark:border-gray-700">
                <div className="flex-1">
                  <label className="block text-sm font-semibold text-gray-900 dark:text-white mb-2">
                    {t('smtp.testEmail')}
                  </label>
                  <div className="px-4 py-2.5 text-sm text-gray-600 dark:text-gray-400 bg-gray-50 dark:bg-gray-700/50 border border-gray-300 dark:border-gray-600 rounded-lg">
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
                <Button variant="primary" icon={Save} onClick={handleSMTPSave} >
                  {t('smtp.save')}
                </Button>
              </div>
        </div>
      </div>

      {/* General Settings Section */}
      <div>
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white">{t('admin.settings')}</h2>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          {Object.keys(generalSettings).length} {Object.keys(generalSettings).length === 1 ? t('common.setting') : t('common.settings')}
        </p>
      </div>

      {/* Existing Settings */}
      {Object.keys(generalSettings).length > 0 && (
        <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 shadow-sm overflow-hidden">
          <div className="divide-y divide-gray-200 dark:divide-gray-700">
            {Object.entries(generalSettings).map(([key, value]) => (
              <div key={key} className="px-6 py-4 hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors">
                <div className="flex items-center justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <label className="block text-sm font-semibold text-gray-900 dark:text-white mb-2">
                      {key}
                    </label>
                    <input
                      type="text"
                      className="w-full px-4 h-9 text-sm text-gray-900 dark:text-white bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition-colors"
                      value={value}
                      onChange={(e) => setSettings({ ...settings, [key]: e.target.value })}
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      icon={Save}
                      onClick={() => handleSave(key, settings[key])}
                    />
                    <Button
                      variant="danger"
                      size="sm"
                      icon={Trash2}
                      onClick={() => handleDelete(key)}
                    />
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Add New Setting */}
      <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 shadow-sm p-4">
        <div className="flex items-center gap-2 mb-4">
          <SettingsIcon className="h-5 w-5 text-gray-400 dark:text-gray-500" />
          <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
            {t('admin.addSetting')}
          </h3>
        </div>
        <form onSubmit={handleAdd} className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-semibold text-gray-900 dark:text-white mb-2">
                {t('admin.settingKey')}
              </label>
              <input
                type="text"
                required
                className="w-full px-4 py-2.5 text-sm text-gray-900 dark:text-white bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition-colors"
                value={newKey}
                onChange={(e) => setNewKey(e.target.value)}
              />
            </div>
            <div>
              <label className="block text-sm font-semibold text-gray-900 dark:text-white mb-2">
                {t('admin.settingValue')}
              </label>
              <input
                type="text"
                className="w-full px-4 py-2.5 text-sm text-gray-900 dark:text-white bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition-colors"
                value={newValue}
                onChange={(e) => setNewValue(e.target.value)}
              />
            </div>
          </div>
          <Button type="submit" variant="primary" icon={Plus}>
            {t('admin.addSetting')}
          </Button>
        </form>
      </div>

      <ConfirmDialog {...dialogState} />
    </div>
  );
}
