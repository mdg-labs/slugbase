import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Sparkles } from 'lucide-react';
import api from '../../api/client';
import { useToast } from '../ui/Toast';
import { useAppConfig } from '../../contexts/AppConfigContext';
import { PageLoadingSkeleton } from '../ui/PageLoadingSkeleton';
import { Switch } from '../ui/switch';
import { Label } from '../ui/label';
import { Input } from '../ui/input';
import Select from '../ui/Select';
import { cn } from '@/lib/utils';

const PROVIDER_OPTIONS = [
  { value: 'openai', label: 'OpenAI' },
] as const;

function SettingsRow({
  label,
  description,
  control,
  className,
}: {
  label: string;
  description?: string;
  control: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'settings-row flex flex-col gap-3 border-b border-[var(--border-soft)] py-4 last:border-0 sm:flex-row sm:items-center sm:justify-between',
        className,
      )}
    >
      <div className="min-w-0 flex-1 space-y-0.5">
        <p className="text-[13px] font-medium text-[var(--fg-0)]">{label}</p>
        {description ? <p className="text-[12px] text-[var(--fg-2)]">{description}</p> : null}
      </div>
      <div className="shrink-0">{control}</div>
    </div>
  );
}

export default function AdminAI() {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const { adminAiOnlyToggle } = useAppConfig();
  const [loading, setLoading] = useState(true);
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
        ai_provider: adminAiOnlyToggle ? 'openai' : (res.data.ai_provider || 'openai'),
        ai_model: adminAiOnlyToggle ? 'gpt-4o-mini' : (res.data.ai_model || 'gpt-4o-mini'),
        ai_api_key: '',
        ai_api_key_set: adminAiOnlyToggle ? false : (res.data.ai_api_key_set ?? false),
      });
    } catch (err: unknown) {
      const e = err as { response?: { status?: number; data?: { error?: string } } };
      if (e?.response?.status === 403) {
        setLoading(false);
        return;
      }
      if (e?.response?.status === 404) {
        setSettings({
          ai_enabled: false,
          ai_provider: 'openai',
          ai_model: 'gpt-4o-mini',
          ai_api_key: '',
          ai_api_key_set: false,
        });
        setLoading(false);
        return;
      }
      showToast(e?.response?.data?.error || t('common.error'), 'error');
    } finally {
      setLoading(false);
    }
  }, [showToast, t, adminAiOnlyToggle]);

  useEffect(() => {
    loadSettings();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
    if (adminAiOnlyToggle) return;
    if (settings.ai_api_key_set && !loading) {
      loadModels();
    } else {
      setModels([]);
    }
  }, [adminAiOnlyToggle, settings.ai_api_key_set, loading, loadModels]);

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

  const saveSettings = useCallback(
    async (payload: { ai_enabled?: boolean; ai_provider?: string; ai_model?: string; ai_api_key?: string }) => {
      try {
        const body = adminAiOnlyToggle
          ? { ai_enabled: payload.ai_enabled ?? settings.ai_enabled }
          : {
              ...(payload.ai_enabled !== undefined && { ai_enabled: payload.ai_enabled }),
              ...(payload.ai_provider !== undefined && { ai_provider: payload.ai_provider }),
              ...(payload.ai_model !== undefined && { ai_model: payload.ai_model }),
              ...(payload.ai_api_key !== undefined && payload.ai_api_key !== '' && { ai_api_key: payload.ai_api_key }),
            };
        if (adminAiOnlyToggle && payload.ai_enabled === undefined) return;
        if (!adminAiOnlyToggle && Object.keys(body).length === 0) return;
        await api.post('/admin/settings/ai', body);
        showToast(t('common.success'), 'success');
        await loadSettings();
      } catch (err: unknown) {
        const e = err as { response?: { data?: { error?: string } } };
        showToast(e?.response?.data?.error || t('common.error'), 'error');
      }
    },
    [adminAiOnlyToggle, settings.ai_enabled, showToast, t, loadSettings]
  );

  if (loading) {
    return (
      <div className="pb-24">
        <PageLoadingSkeleton lines={8} />
      </div>
    );
  }

  return (
    <div className="space-y-6 pb-24">
      <div className="ai-hero relative overflow-hidden rounded-[var(--radius-lg)] border border-[var(--border)] bg-gradient-to-br from-[var(--accent-bg)] via-[var(--bg-1)] to-[var(--bg-2)] p-6 shadow-[var(--shadow-sm)]">
        <div className="pointer-events-none absolute -right-16 -top-16 h-40 w-40 rounded-full bg-[var(--accent)] opacity-[0.07]" aria-hidden />
        <div className="relative flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex min-w-0 gap-3">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[var(--radius)] bg-[var(--accent-bg)] ring-1 ring-[var(--accent-ring)]">
              <Sparkles className="h-5 w-5 text-[var(--accent-hi)]" aria-hidden />
            </div>
            <div className="min-w-0">
              <h1 className="text-[22px] font-semibold tracking-[-0.02em] text-[var(--fg-0)]">{t('admin.ai.title')}</h1>
              <p className="mt-1 max-w-xl text-[12.5px] leading-relaxed text-[var(--fg-2)]">{t('admin.ai.description')}</p>
            </div>
          </div>
        </div>
      </div>

      <div className="rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--bg-1)] p-1 px-4 shadow-none">
        <SettingsRow
          label={t('admin.ai.enabled')}
          control={
            <Switch
              id="ai-enabled"
              checked={settings.ai_enabled}
              onCheckedChange={(checked) => {
                setSettings((s) => ({ ...s, ai_enabled: checked }));
                saveSettings({ ai_enabled: checked });
              }}
            />
          }
        />

        {!adminAiOnlyToggle && (
          <>
            <SettingsRow
              label={t('admin.ai.provider')}
              control={
                <Select
                  value={settings.ai_provider}
                  onChange={(value) => {
                    setSettings((s) => ({ ...s, ai_provider: value }));
                    saveSettings({ ai_provider: value });
                  }}
                  options={providerOptions}
                  className="w-[200px]"
                />
              }
            />

            <SettingsRow
              label={t('admin.ai.apiKey')}
              description={settings.ai_api_key_set ? t('admin.ai.apiKeyChangeHint') : t('admin.ai.apiKeyHint')}
              control={
                <div className="w-full min-w-[220px] max-w-md space-y-1 sm:text-right">
                  <Input
                    type="password"
                    value={settings.ai_api_key}
                    onChange={(e) => setSettings((s) => ({ ...s, ai_api_key: e.target.value }))}
                    onBlur={() => {
                      if (settings.ai_api_key.trim() !== '') {
                        saveSettings({ ai_api_key: settings.ai_api_key });
                      }
                    }}
                    placeholder={settings.ai_api_key_set ? t('admin.ai.apiKeyPlaceholder') : 'sk-...'}
                    className="font-mono text-[12px]"
                  />
                </div>
              }
            />

            <SettingsRow
              label={t('admin.ai.model')}
              control={
                <div className="w-full min-w-[220px] max-w-xs sm:text-right">
                  <Select
                    value={settings.ai_model}
                    onChange={(value) => {
                      setSettings((s) => ({ ...s, ai_model: value }));
                      saveSettings({ ai_model: value });
                    }}
                    options={modelOptionsWithCurrent}
                    placeholder={
                      !settings.ai_api_key_set
                        ? t('admin.ai.modelPlaceholderNoKey')
                        : modelsLoading
                          ? t('admin.ai.modelPlaceholderLoading')
                          : undefined
                    }
                    disabled={!settings.ai_api_key_set || modelsLoading}
                  />
                </div>
              }
            />
          </>
        )}
      </div>
    </div>
  );
}
