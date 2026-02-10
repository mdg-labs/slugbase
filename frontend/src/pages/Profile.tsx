import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { appBasePath } from '../config/api';
import { Mail, User as UserIcon, Globe, Palette, AlertCircle, Link2 } from 'lucide-react';
import Select from '../components/ui/Select';
import Button from '../components/ui/Button';
import { useToast } from '../components/ui/Toast';

export default function Profile() {
  const { t } = useTranslation();
  const { user, updateUser, checkAuth } = useAuth();
  const { showToast } = useToast();
  const [formData, setFormData] = useState({
    email: '',
    name: '',
    language: 'en',
    theme: 'auto',
  });
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<{ email?: string; name?: string }>({});
  const [editingEmail, setEditingEmail] = useState(false);
  const [editingName, setEditingName] = useState(false);

  useEffect(() => {
    if (user) {
      setFormData({
        email: user.email || '',
        name: user.name || '',
        language: user.language || 'en',
        theme: user.theme || 'auto',
      });
    }
  }, [user]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setErrors({});
    try {
      const response = await updateUser(formData) as any;
      
      // Check if email verification is required
      if (response?.emailVerificationRequired) {
        showToast(t('emailVerification.emailSent'), 'success');
        setEditingEmail(false);
        // Refresh user data to get email_pending
        await checkAuth();
      } else {
        setEditingEmail(false);
        setEditingName(false);
        showToast(t('common.success'), 'success');
      }
    } catch (error: any) {
      console.error('Failed to update profile:', error);
      if (error.response?.data?.error) {
        const errorMessage = error.response.data.error;
        if (errorMessage.includes('email')) {
          setErrors({ email: errorMessage });
        } else if (errorMessage.includes('name') || errorMessage.includes('Name')) {
          setErrors({ name: errorMessage });
        } else {
          setErrors({ email: errorMessage, name: errorMessage });
        }
        showToast(errorMessage, 'error');
      } else {
        showToast(t('common.error'), 'error');
      }
    } finally {
      setSaving(false);
    }
  }

  if (!user) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="text-gray-500 dark:text-gray-400">{t('common.loading')}</div>
      </div>
    );
  }

  const languageOptions = [
    { value: 'en', label: t('profile.languageEnglish') },
    { value: 'de', label: t('profile.languageGerman') },
    { value: 'fr', label: t('profile.languageFrench') },
    { value: 'es', label: t('profile.languageSpanish') },
    { value: 'it', label: t('profile.languageItalian') },
    { value: 'pt', label: t('profile.languagePortuguese') },
    { value: 'nl', label: t('profile.languageDutch') },
    { value: 'ru', label: t('profile.languageRussian') },
    { value: 'ja', label: t('profile.languageJapanese') },
    { value: 'zh', label: t('profile.languageChinese') },
    { value: 'pl', label: t('profile.languagePolish') },
  ];

  const themeOptions = [
    { value: 'auto', label: t('profile.themeAuto') },
    { value: 'light', label: t('profile.themeLight') },
    { value: 'dark', label: t('profile.themeDark') },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-gray-900 dark:text-white">
          {t('profile.title')}
        </h1>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          {t('profile.description')}
        </p>
      </div>

      <div className="space-y-6">
        {/* Account Information Section */}
        <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 shadow-sm overflow-hidden">
          <div className="p-4">
            <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">
              {t('profile.accountInformation')}
            </h2>
            <div className="space-y-6">
              {/* Email */}
              <div className="flex items-start gap-4">
                <div className="flex-shrink-0">
                  <div className="h-10 w-10 rounded-lg bg-blue-100 dark:bg-blue-900/30 flex items-center justify-center">
                    <Mail className="h-5 w-5 text-blue-600 dark:text-blue-400" />
                  </div>
                </div>
                <div className="flex-1 min-w-0">
                  <label className="block text-sm font-semibold text-gray-900 dark:text-white mb-1">
                    {t('profile.email')}
                  </label>
                  {editingEmail ? (
                    <div className="space-y-1">
                      <input
                        type="email"
                        value={formData.email}
                        onChange={(e) => {
                          setFormData({ ...formData, email: e.target.value });
                          setErrors({ ...errors, email: undefined });
                        }}
                        className="w-full px-4 h-9 text-sm text-gray-900 dark:text-white bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition-colors"
                        placeholder={t('profile.emailPlaceholder')}
                      />
                      {errors.email && (
                        <p className="text-xs text-red-600 dark:text-red-400">{errors.email}</p>
                      )}
                      <div className="flex gap-2 mt-2">
                        <Button
                          type="button"
                          variant="primary"
                          size="sm"
                          onClick={handleSubmit}
                          disabled={saving}
                        >
                          {saving ? t('common.loading') : t('common.save')}
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            setEditingEmail(false);
                            setFormData({ ...formData, email: user?.email || '' });
                            setErrors({ ...errors, email: undefined });
                          }}
                        >
                          {t('common.cancel')}
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      <div className="flex items-center gap-2">
                        <p className="text-sm text-gray-600 dark:text-gray-400 flex-1">{user.email}</p>
                        {!user.oidc_provider && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => setEditingEmail(true)}
                          >
                            {t('common.edit')}
                          </Button>
                        )}
                      </div>
                      {user.oidc_provider && (
                        <p className="text-xs text-gray-500 dark:text-gray-400">
                          {t('profile.emailManagedByOIDC')}
                        </p>
                      )}
                      {user.email_pending && (
                        <div className="flex items-start gap-2 px-3 py-2 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg">
                          <AlertCircle className="h-4 w-4 text-blue-600 dark:text-blue-400 flex-shrink-0 mt-0.5" />
                          <div className="flex-1">
                            <p className="text-xs text-blue-800 dark:text-blue-200 font-medium">
                              {t('emailVerification.pendingTitle')}
                            </p>
                            <p className="text-xs text-blue-700 dark:text-blue-300 mt-1">
                              {t('emailVerification.pendingDescription', { email: user.email_pending })}
                            </p>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>

              {/* Name */}
              <div className="flex items-start gap-4">
                <div className="flex-shrink-0">
                  <div className="h-10 w-10 rounded-lg bg-green-100 dark:bg-green-900/30 flex items-center justify-center">
                    <UserIcon className="h-5 w-5 text-green-600 dark:text-green-400" />
                  </div>
                </div>
                <div className="flex-1 min-w-0">
                  <label className="block text-sm font-semibold text-gray-900 dark:text-white mb-1">
                    {t('profile.name')}
                  </label>
                  {editingName ? (
                    <div className="space-y-1">
                      <input
                        type="text"
                        value={formData.name}
                        onChange={(e) => {
                          setFormData({ ...formData, name: e.target.value });
                          setErrors({ ...errors, name: undefined });
                        }}
                        className="w-full px-4 h-9 text-sm text-gray-900 dark:text-white bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition-colors"
                        placeholder={t('profile.namePlaceholder')}
                      />
                      {errors.name && (
                        <p className="text-xs text-red-600 dark:text-red-400">{errors.name}</p>
                      )}
                      <div className="flex gap-2 mt-2">
                        <Button
                          type="button"
                          variant="primary"
                          size="sm"
                          onClick={handleSubmit}
                          disabled={saving}
                        >
                          {saving ? t('common.loading') : t('common.save')}
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            setEditingName(false);
                            setFormData({ ...formData, name: user?.name || '' });
                            setErrors({ ...errors, name: undefined });
                          }}
                        >
                          {t('common.cancel')}
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2">
                      <p className="text-sm text-gray-600 dark:text-gray-400 flex-1">{user.name}</p>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => setEditingName(true)}
                      >
                        {t('common.edit')}
                      </Button>
                    </div>
                  )}
                </div>
              </div>

              {/* Quick access / go preferences */}
              <div className="flex items-start gap-4">
                <div className="flex-shrink-0">
                  <div className="h-10 w-10 rounded-lg bg-purple-100 dark:bg-purple-900/30 flex items-center justify-center">
                    <Link2 className="h-5 w-5 text-purple-600 dark:text-purple-400" />
                  </div>
                </div>
                <div className="flex-1 min-w-0">
                  <label className="block text-sm font-semibold text-gray-900 dark:text-white mb-2">
                    {t('profile.quickAccess')}
                  </label>
                  <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">
                    {t('profile.quickAccessDescription')}
                  </p>
                  <Link
                    to={`${appBasePath}/go-preferences`}
                    className="text-sm font-medium text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300"
                  >
                    {t('goPreferences.title')} →
                  </Link>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Preferences Section */}
        <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 shadow-sm">
          <div className="p-4">
            <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">
              {t('profile.preferences')}
            </h2>
            <form onSubmit={handleSubmit} className="space-y-6">
              <div className="flex items-start gap-4">
                <div className="flex-shrink-0">
                  <div className="h-10 w-10 rounded-lg bg-indigo-100 dark:bg-indigo-900/30 flex items-center justify-center">
                    <Globe className="h-5 w-5 text-indigo-600 dark:text-indigo-400" />
                  </div>
                </div>
                <div className="flex-1">
                  <label className="block text-sm font-semibold text-gray-900 dark:text-white mb-2">
                    {t('profile.language')}
                  </label>
                  <Select
                    value={formData.language}
                    onChange={(value) => setFormData({ ...formData, language: value })}
                    options={languageOptions}
                  />
                </div>
              </div>

              <div className="flex items-start gap-4">
                <div className="flex-shrink-0">
                  <div className="h-10 w-10 rounded-lg bg-pink-100 dark:bg-pink-900/30 flex items-center justify-center">
                    <Palette className="h-5 w-5 text-pink-600 dark:text-pink-400" />
                  </div>
                </div>
                <div className="flex-1">
                  <label className="block text-sm font-semibold text-gray-900 dark:text-white mb-2">
                    {t('profile.theme')}
                  </label>
                  <Select
                    value={formData.theme}
                    onChange={(value) => setFormData({ ...formData, theme: value })}
                    options={themeOptions}
                  />
                </div>
              </div>

              <div className="pt-2">
                <Button type="submit" variant="primary" disabled={saving}>
                  {saving ? t('common.loading') : t('profile.save')}
                </Button>
              </div>
            </form>
          </div>
        </div>
      </div>
    </div>
  );
}
