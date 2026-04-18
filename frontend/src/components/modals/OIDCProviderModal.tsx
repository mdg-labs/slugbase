import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import Select from '../ui/Select';
import { Copy, Eye, EyeOff, Key, Shield } from 'lucide-react';
import api from '../../api/client';
import {
  Modal,
  ModalContent,
  ModalHead,
  ModalBody,
  ModalFoot,
} from '../ui/dialog';
import Button from '../ui/Button';
import { useToast } from '../ui/Toast';
import { FormFieldWrapper } from '../ui/FormFieldWrapper';
import { ModalSection } from '../ui/ModalSection';
import { ModalFooterActions } from '../ui/ModalFooterActions';
import { Switch } from '../ui/switch';
import { Label } from '../ui/label';
import { Input } from '../ui/input';

interface OIDCProvider {
  id: string;
  provider_key: string;
  issuer_url: string;
  authorization_url?: string;
  token_url?: string;
  userinfo_url?: string;
  scopes: string;
  auto_create_users: boolean;
  default_role: string;
}

interface OIDCProviderModalProps {
  provider: OIDCProvider | null;
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

export default function OIDCProviderModal({
  provider,
  isOpen,
  onClose,
  onSuccess,
}: OIDCProviderModalProps) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const [showSecret, setShowSecret] = useState(false);
  const [formData, setFormData] = useState({
    provider_key: '',
    client_id: '',
    client_secret: '',
    issuer_url: '',
    authorization_url: '',
    token_url: '',
    userinfo_url: '',
    scopes: 'openid profile email',
    auto_create_users: true,
    default_role: 'user',
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (provider) {
      setFormData({
        provider_key: provider.provider_key,
        client_id: '',
        client_secret: '',
        issuer_url: provider.issuer_url,
        authorization_url: provider.authorization_url || '',
        token_url: provider.token_url || '',
        userinfo_url: provider.userinfo_url || '',
        scopes: provider.scopes,
        auto_create_users: provider.auto_create_users,
        default_role: provider.default_role,
      });
    } else {
      setFormData({
        provider_key: '',
        client_id: '',
        client_secret: '',
        issuer_url: '',
        authorization_url: '',
        token_url: '',
        userinfo_url: '',
        scopes: 'openid profile email',
        auto_create_users: true,
        default_role: 'user',
      });
    }
    setError('');
  }, [provider, isOpen]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError('');

    try {
      const payload: any = { ...formData };

      if (provider) {
        if (!payload.client_id || payload.client_id.trim() === '') {
          delete payload.client_id;
        }
        if (!payload.client_secret || payload.client_secret.trim() === '') {
          delete payload.client_secret;
        }
      } else {
        if (!payload.client_id || payload.client_id.trim() === '') {
          setError(t('admin.clientIdRequired'));
          setLoading(false);
          return;
        }
      }

      if (!payload.authorization_url || payload.authorization_url.trim() === '') {
        delete payload.authorization_url;
      }
      if (!payload.token_url || payload.token_url.trim() === '') {
        delete payload.token_url;
      }
      if (!payload.userinfo_url || payload.userinfo_url.trim() === '') {
        delete payload.userinfo_url;
      }

      if (provider) {
        await api.put(`/oidc-providers/${provider.id}`, payload);
      } else {
        await api.post('/oidc-providers', payload);
      }
      onSuccess();
      onClose();
    } catch (err: any) {
      setError(err.response?.data?.error || t('common.error'));
    } finally {
      setLoading(false);
    }
  }

  const roleOptions = [
    { value: 'user', label: t('admin.user') },
    { value: 'admin', label: t('admin.admin') },
  ];

  const isValid = formData.provider_key.trim() && formData.issuer_url.trim() && (provider || formData.client_id.trim());

  const callbackPreview =
    typeof window !== 'undefined'
      ? `${window.location.origin}/api/auth/${formData.provider_key.trim() || '{key}'}/callback`
      : '';

  async function copyCallback() {
    if (!callbackPreview) return;
    try {
      await navigator.clipboard.writeText(callbackPreview);
      showToast(t('common.copied'), 'success');
    } catch {
      showToast(t('common.error'), 'error');
    }
  }

  return (
    <Modal open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <ModalContent wide className="flex max-h-[calc(100vh-4rem)] flex-col overflow-hidden p-0">
        <ModalHead icon={Shield} title={provider ? t('admin.editProvider') : t('admin.addProvider')} />

        <ModalBody>
          <form id="oidc-provider-form" onSubmit={handleSubmit} className="space-y-6">
          <ModalSection>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <FormFieldWrapper label={t('admin.providerKey')} required error={error}>
                <Input
                  type="text"
                  required
                  value={formData.provider_key}
                  onChange={(e) => setFormData({ ...formData, provider_key: e.target.value })}
                  placeholder={t('admin.providerKey')}
                  leftSlot={<Key className="text-[var(--fg-3)]" strokeWidth={1.75} />}
                />
              </FormFieldWrapper>
              <FormFieldWrapper label={t('admin.issuerUrl')} required>
                <Input
                  type="url"
                  required
                  value={formData.issuer_url}
                  onChange={(e) => setFormData({ ...formData, issuer_url: e.target.value })}
                  placeholder="https://issuer.example.com"
                  className="font-mono text-[11px]"
                />
              </FormFieldWrapper>
            </div>

            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <FormFieldWrapper
                label={provider ? `${t('admin.clientId')} (${t('admin.leaveBlankToKeep')})` : t('admin.clientId')}
                required={!provider}
              >
                <Input
                  type="text"
                  required={!provider}
                  value={formData.client_id}
                  onChange={(e) => setFormData({ ...formData, client_id: e.target.value })}
                  placeholder={provider ? t('admin.leaveBlankToKeep') : ''}
                />
              </FormFieldWrapper>
              <FormFieldWrapper
                label={provider ? `${t('admin.clientSecret')} (${t('admin.leaveBlank')})` : t('admin.clientSecret')}
                required={!provider}
              >
                <Input
                  type={showSecret ? 'text' : 'password'}
                  required={!provider}
                  value={formData.client_secret}
                  onChange={(e) => setFormData({ ...formData, client_secret: e.target.value })}
                  rightSlot={
                    <button
                      type="button"
                      className="rounded p-0.5 text-[var(--fg-3)] hover:bg-[var(--bg-3)] hover:text-[var(--fg-0)]"
                      onClick={() => setShowSecret((s) => !s)}
                      aria-label={showSecret ? t('common.hidePassword') : t('common.showPassword')}
                    >
                      {showSecret ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
                    </button>
                  }
                />
              </FormFieldWrapper>
            </div>

            <FormFieldWrapper label={t('admin.scopes')}>
              <Input
                type="text"
                value={formData.scopes}
                onChange={(e) => setFormData({ ...formData, scopes: e.target.value })}
                placeholder="openid profile email"
                className="font-mono text-[11px]"
              />
            </FormFieldWrapper>
          </ModalSection>

          <ModalSection title={`${t('admin.customEndpoints')} (${t('admin.optional')})`} description={t('admin.customEndpointsDescription')}>
            <div className="space-y-4">
              <FormFieldWrapper label={t('admin.authorizationUrl')}>
                <Input
                  type="url"
                  placeholder={`${formData.issuer_url || 'https://issuer.com'}/authorize`}
                  value={formData.authorization_url}
                  onChange={(e) => setFormData({ ...formData, authorization_url: e.target.value })}
                />
              </FormFieldWrapper>
              <FormFieldWrapper label={t('admin.tokenUrl')}>
                <Input
                  type="url"
                  placeholder={`${formData.issuer_url || 'https://issuer.com'}/token`}
                  value={formData.token_url}
                  onChange={(e) => setFormData({ ...formData, token_url: e.target.value })}
                />
              </FormFieldWrapper>
              <FormFieldWrapper label={t('admin.userinfoUrl')}>
                <Input
                  type="url"
                  placeholder={`${formData.issuer_url || 'https://issuer.com'}/userinfo`}
                  value={formData.userinfo_url}
                  onChange={(e) => setFormData({ ...formData, userinfo_url: e.target.value })}
                />
              </FormFieldWrapper>
            </div>
          </ModalSection>

          <ModalSection>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="flex items-center justify-between rounded-lg border p-3">
                <Label htmlFor="auto_create" className="text-sm font-medium cursor-pointer">
                  {t('admin.autoCreate')}
                </Label>
                <Switch
                  id="auto_create"
                  checked={formData.auto_create_users}
                  onCheckedChange={(checked) => setFormData({ ...formData, auto_create_users: checked })}
                />
              </div>
              <FormFieldWrapper label={t('admin.defaultRole')}>
                <Select
                  value={formData.default_role}
                  onChange={(value) => setFormData({ ...formData, default_role: value })}
                  options={roleOptions}
                />
              </FormFieldWrapper>
            </div>
          </ModalSection>
        </form>

          <div className="rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--bg-2)] px-3 py-2.5">
            <p className="mb-1 font-mono text-[10px] font-medium uppercase tracking-[0.08em] text-[var(--fg-3)]">
              {t('admin.callbackUrl')}
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <code className="min-w-0 flex-1 break-all font-mono text-[11px] text-[var(--fg-0)]">{callbackPreview}</code>
              <Button type="button" variant="ghost" size="sm" icon={Copy} onClick={() => void copyCallback()}>
                {t('common.copy')}
              </Button>
            </div>
          </div>
        </ModalBody>

        <ModalFoot>
          <ModalFooterActions
            onCancel={onClose}
            submitLabel={t('common.save')}
            loading={loading}
            submitDisabled={!isValid}
            formId="oidc-provider-form"
          />
        </ModalFoot>
      </ModalContent>
    </Modal>
  );
}
