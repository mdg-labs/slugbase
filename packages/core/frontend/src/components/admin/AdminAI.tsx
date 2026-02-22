import React, { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import api from '../../api/client';
import { useToast } from '../ui/Toast';
import { Save, Sparkles } from 'lucide-react';
import Button from '../ui/Button';
import { PageLoadingSkeleton } from '../ui/PageLoadingSkeleton';
import { Switch } from '../ui/switch';
import { Label } from '../ui/label';
import { Input } from '../ui/input';
import Select from '../ui/Select';

const PROVIDER_OPTIONS = [
  { value: 'openai', label: 'OpenAI' },
] as const;

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
  const [models, setModels] = useState<{ id: string }[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);

  const loadSettings = useCallback(async () => {
    try {
      const res = await api.get('/admin/settings/ai');
      setSettings({
        ai_enabled: res.data.ai_enabled ?? false,
        ai_provider: res.data.ai_provider || 'openai',
        ai_model: res.data.ai_model || 'gpt-4o-mini',
        ai_api_key: '',
        ai_api_key_set: res.data.ai_api_key_set ?? false,
      });
    } catch (err: unknown) {
      const e = err as { response?: { status?: number; data?: { error?: string } } };
      if (e?.response?.status === 403) {
        setLoading(false);
        return;
      }
      showToast(e?.response?.data?.error || t('common.error'), 'error');
    } finally {
      setLoading(false);
    }
  }, [showToast, t]);

  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  const loadModels = useCallback(async () => {
    setModelsLoading(true);
    try {
      const res = await api.get<{ models: { id: string }[] }>('/admin/settings/ai/models');
      setModels(Array.isArray(res.data?.models) ? res.data.models : []);
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } } };
      showToast(e?.response?.data?.error || t('admin.ai.modelsLoadError'), 'error');
      setModels([]);
    } finally {
      setModelsLoading(false);
    }
  }, [showToast, t]);

  useEffect(() => {
    if (settings.ai_api_key_set && !loading) {
      loadModels();
    } else {
      setModels([]);
    }
  }, [settings.ai_api_key_set, loading, loadModels]);

  const providerOptions = PROVIDER_OPTIONS.map((p) => ({
    value: p.value,
    label: p.value === 'openai' ? t('admin.ai.providerOpenAI') : p.label,
  }));

  const modelOptions = models.map((m) => ({ value: m.id, label: m.id }));
  const currentModelInList = modelOptions.some((o) => o.value === settings.ai_model);
  const modelOptionsWithCurrent =
    currentModelInList || !settings.ai_model
      ? modelOptions
      : [{ value: settings.ai_model, label: settings.ai_model }, ...modelOptions];

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
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } } };
      showToast(e?.response?.data?.error || t('common.error'), 'error');
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
            <Select
              value={settings.ai_provider}
              onChange={(value) => setSettings({ ...settings, ai_provider: value })}
              options={providerOptions}
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
            <Select
              value={settings.ai_model}
              onChange={(value) => setSettings({ ...settings, ai_model: value })}
              options={modelOptionsWithCurrent}
              placeholder={
                !settings.ai_api_key_set
                  ? t('admin.ai.modelPlaceholderNoKey')
                  : modelsLoading
                    ? t('admin.ai.modelPlaceholderLoading')
                    : undefined
              }
              disabled={!settings.ai_api_key_set || modelsLoading}
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
