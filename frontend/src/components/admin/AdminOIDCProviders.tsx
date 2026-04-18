import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import api from '../../api/client';
import ConfirmDialog from '../ui/ConfirmDialog';
import { useConfirmDialog } from '../../hooks/useConfirmDialog';
import { Plus, Edit, Trash2, Key, Copy, MoreHorizontal, Info } from 'lucide-react';
import OIDCProviderModal from '../modals/OIDCProviderModal';
import Button from '../ui/Button';
import { PageLoadingSkeleton } from '../ui/PageLoadingSkeleton';
import { EmptyState } from '../EmptyState';
import { Badge } from '../ui/badge';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';
import { useToast } from '../ui/Toast';
import { copyTextToClipboard } from '../../utils/copyTextToClipboard';

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
  created_at: string;
  callback_url?: string;
}

function providerAbbrev(key: string): string {
  const k = key.trim().toUpperCase();
  if (k.length <= 2) return k.padEnd(2, '·');
  if (k.includes('GOOGLE') || k === 'GOOGLE') return 'GO';
  if (k.includes('OKTA')) return 'OK';
  if (k.includes('AZURE') || k === 'AZUREAD') return 'AZ';
  return k.slice(0, 2);
}

function providerColor(key: string): string {
  const lower = key.toLowerCase();
  if (lower.includes('google')) return '#4285F4';
  if (lower.includes('okta')) return '#007dc1';
  if (lower.includes('azure')) return '#0078d4';
  if (lower.includes('auth0')) return '#eb5424';
  return 'var(--accent)';
}

export default function AdminOIDCProviders() {
  const { t } = useTranslation();
  const { showConfirm, dialogState } = useConfirmDialog();
  const { showToast } = useToast();
  const [providers, setProviders] = useState<OIDCProvider[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingProvider, setEditingProvider] = useState<OIDCProvider | null>(null);

  useEffect(() => {
    loadProviders();
  }, []);

  const loadProviders = async () => {
    try {
      const response = await api.get('/oidc-providers');
      setProviders(response.data);
    } catch (error) {
      console.error('Failed to load providers:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleEdit = (provider: OIDCProvider) => {
    setEditingProvider(provider);
    setModalOpen(true);
  };

  const handleDelete = (id: string) => {
    showConfirm(
      t('admin.confirmDeleteProvider'),
      t('admin.confirmDeleteProvider'),
      async () => {
        try {
          await api.delete(`/oidc-providers/${id}`);
          await loadProviders();
        } catch (error: unknown) {
          const e = error as { response?: { data?: { error?: string } } };
          console.error('Failed to delete provider:', error);
          alert(e.response?.data?.error || t('common.error'));
        }
      },
      { variant: 'danger', confirmText: t('common.delete'), cancelText: t('common.cancel') }
    );
  };

  const handleModalClose = () => {
    setModalOpen(false);
    setEditingProvider(null);
  };

  const copyRedirectPattern = async () => {
    const sample = providers[0];
    const url = sample?.callback_url
      ? sample.callback_url
      : `${window.location.origin}/api/auth/${sample?.provider_key ?? '{provider}'}/callback`;
    const ok = await copyTextToClipboard(url);
    showToast(ok ? t('common.success') : t('common.error'), ok ? 'success' : 'error');
  };

  if (loading) {
    return (
      <div className="pb-24">
        <PageLoadingSkeleton lines={6} />
      </div>
    );
  }

  return (
    <div className="space-y-6 pb-24">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h2 className="text-[18px] font-semibold tracking-tight text-[var(--fg-0)]">
            {t('admin.ssoPageTitle')}
          </h2>
          <p className="mt-1 text-[12.5px] text-[var(--fg-2)]">{t('admin.ssoPageSubtitle')}</p>
        </div>
        <Button
          onClick={() => setModalOpen(true)}
          icon={Plus}
          variant="primary"
          className="shrink-0 border-0 bg-primary-gradient text-primary-foreground shadow-glow hover:opacity-90"
        >
          {t('admin.addProvider')}
        </Button>
      </div>

      {providers.length === 0 ? (
        <EmptyState
          icon={Key}
          title={t('auth.noProviders')}
          action={
            <Button
              onClick={() => setModalOpen(true)}
              variant="primary"
              icon={Plus}
              className="border-0 bg-primary-gradient text-primary-foreground shadow-glow hover:opacity-90"
            >
              {t('admin.addProvider')}
            </Button>
          }
        />
      ) : (
        <ul className="space-y-3">
          {providers.map((provider) => {
            const color = providerColor(provider.provider_key);
            const abbr = providerAbbrev(provider.provider_key);
            return (
              <li
                key={provider.id}
                className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg-1)] p-[14px] shadow-[var(--shadow-sm)]"
              >
                <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex min-w-0 flex-1 gap-3">
                    <div
                      className="flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-[var(--radius-sm)] border font-mono text-[11px] font-semibold"
                      style={{
                        background: `${color}20`,
                        borderColor: `${color}55`,
                        color,
                      }}
                      aria-hidden
                    >
                      {abbr}
                    </div>
                    <div className="min-w-0">
                      <p className="truncate text-[14px] font-semibold text-[var(--fg-0)]">{provider.provider_key}</p>
                      <p className="mt-0.5 truncate font-mono text-[11.5px] text-[var(--fg-2)]" title={provider.issuer_url}>
                        {t('admin.issuerUrl')}: {provider.issuer_url}
                      </p>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center justify-end gap-3 sm:gap-4">
                    <Badge
                      variant="secondary"
                      className="border-[rgba(74,222,128,0.35)] bg-[rgba(74,222,128,0.1)] text-[var(--success)]"
                    >
                      {t('admin.oidcActive')}
                    </Badge>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <button
                          type="button"
                          className="inline-flex h-9 w-9 items-center justify-center rounded-[var(--radius-sm)] text-[var(--fg-2)] hover:bg-[var(--bg-hover)] hover:text-[var(--fg-0)]"
                        >
                          <MoreHorizontal className="h-4 w-4" />
                          <span className="sr-only">{t('common.actions')}</span>
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => handleEdit(provider)}>
                          <Edit className="mr-2 h-4 w-4" />
                          {t('common.edit')}
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onClick={() => handleDelete(provider.id)}
                          className="text-destructive focus:text-destructive"
                        >
                          <Trash2 className="mr-2 h-4 w-4" />
                          {t('common.delete')}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <div className="rounded-[var(--radius-lg)] border border-dashed border-[var(--border-strong)] bg-[var(--bg-1)] px-4 py-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 gap-2">
            <Info className="mt-0.5 h-4 w-4 shrink-0 text-[var(--accent-hi)]" aria-hidden />
            <div className="min-w-0">
              <p className="text-[12px] font-medium text-[var(--fg-0)]">{t('admin.callbackUrl')}</p>
              <code className="mt-1 block break-all font-mono text-[11px] text-[var(--fg-1)]">
                {providers[0]?.callback_url ??
                  `${window.location.origin}/api/auth/<${t('admin.providerKey')}>}/callback`}
              </code>
            </div>
          </div>
          <Button type="button" variant="secondary" size="sm" icon={Copy} onClick={() => void copyRedirectPattern()}>
            {t('admin.copyRedirect')}
          </Button>
        </div>
      </div>

      <OIDCProviderModal
        provider={editingProvider}
        isOpen={modalOpen}
        onClose={handleModalClose}
        onSuccess={loadProviders}
      />

      <ConfirmDialog {...dialogState} />
    </div>
  );
}
