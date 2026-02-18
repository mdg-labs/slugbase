import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import api from '../../api/client';
import { useToast } from '../ui/Toast';
import { Save, Sparkles } from 'lucide-react';
import Button from '../ui/Button';
import { PageLoadingSkeleton } from '../ui/PageLoadingSkeleton';
import { Switch } from '../ui/switch';
import { Label } from '../ui/label';
import { Input } from '../ui/input';

export default function AdminAI() {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [settings, setSettings] = useState({
    ai_enabled: false,
    ai_provider: 'openai',
    ai_model: 'gpt-4o-mini',
    ai_api_key: '',
    ai_api_key_set: false,
  });

  useEffect(() => {
    loadSettings();
  }, []);

  const loadSettings = async () => {
    try {
      const res = await api.get('/admin/settings/ai');
      setSettings({
        ai_enabled: res.data.ai_enabled ?? false,
        ai_provider: res.data.ai_provider || 'openai',
        ai_model: res.data.ai_model || 'gpt-4o-mini',
        ai_api_key: '',
        ai_api_key_set: res.data.ai_api_key_set ?? false,
      });
    } catch (err: any) {
      if (err?.response?.status === 403) {
        setLoading(false);
        return;
      }
      showToast(err?.response?.data?.error || t('common.error'), 'error');
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      await api.post('/admin/settings/ai', {
        ai_enabled: settings.ai_enabled,
        ai_provider: settings.ai_provider,
        ai_model: settings.ai_model,
        ai_api_key: settings.ai_api_key || undefined,
      });
      showToast(t('common.success'), 'success');
      await loadSettings();
    } catch (err: any) {
      showToast(err?.response?.data?.error || t('common.error'), 'error');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <PageLoadingSkeleton lines={8} />;
  }

  return (
    <div className="space-y-6">
      <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 shadow-sm p-4">
        <div className="flex items-center gap-2 mb-6">
          <Sparkles className="h-5 w-5 text-violet-500 dark:text-violet-400" />
          <div>
            <h2 className="text-xl font-semibold text-gray-900 dark:text-white">
              {t('admin.ai.title')}
            </h2>
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
              {t('admin.ai.description')}
            </p>
          </div>
        </div>

        <form onSubmit={handleSave} className="space-y-4">
          <div className="flex items-center gap-3">
            <Switch
              id="ai-enabled"
              checked={settings.ai_enabled}
              onCheckedChange={(checked) =>
                setSettings({ ...settings, ai_enabled: checked })
              }
            />
            <Label htmlFor="ai-enabled" className="text-sm font-medium text-gray-900 dark:text-white cursor-pointer">
              {t('admin.ai.enabled')}
            </Label>
          </div>

          <div>
            <Label className="block text-sm font-semibold text-gray-900 dark:text-white mb-2">
              {t('admin.ai.provider')}
            </Label>
            <Input
              type="text"
              value={settings.ai_provider}
              onChange={(e) => setSettings({ ...settings, ai_provider: e.target.value })}
              placeholder="openai"
              className="max-w-xs"
            />
          </div>

          <div>
            <Label className="block text-sm font-semibold text-gray-900 dark:text-white mb-2">
              {t('admin.ai.apiKey')}
            </Label>
            <Input
              type="password"
              value={settings.ai_api_key}
              onChange={(e) => setSettings({ ...settings, ai_api_key: e.target.value })}
              placeholder={settings.ai_api_key_set ? t('admin.ai.apiKeyPlaceholder') : 'sk-...'}
              className="max-w-md font-mono text-sm"
            />
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              {settings.ai_api_key_set ? t('admin.ai.apiKeyChangeHint') : t('admin.ai.apiKeyHint')}
            </p>
          </div>

          <div>
            <Label className="block text-sm font-semibold text-gray-900 dark:text-white mb-2">
              {t('admin.ai.model')}
            </Label>
            <Input
              type="text"
              value={settings.ai_model}
              onChange={(e) => setSettings({ ...settings, ai_model: e.target.value })}
              placeholder="gpt-4o-mini"
              className="max-w-xs"
            />
          </div>

          <div className="pt-2">
            <Button type="submit" variant="primary" disabled={saving}>
              {saving ? t('common.loading') : (
                <>
                  <Save className="h-4 w-4 mr-2 inline" />
                  {t('common.save')}
                </>
              )}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
