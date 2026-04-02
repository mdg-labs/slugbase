import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import api from '../../api/client';
import ConfirmDialog from '../ui/ConfirmDialog';
import { useConfirmDialog } from '../../hooks/useConfirmDialog';
import { Plus, Edit, Trash2, Key, Globe } from 'lucide-react';
import OIDCProviderModal from '../modals/OIDCProviderModal';
import Button from '../ui/Button';
import { PageLoadingSkeleton } from '../ui/PageLoadingSkeleton';
import { PageHeader } from '../PageHeader';
import { EmptyState } from '../EmptyState';

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

export default function AdminOIDCProviders() {
  const { t } = useTranslation();
  const { showConfirm, dialogState } = useConfirmDialog();
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
        } catch (error: any) {
          console.error('Failed to delete provider:', error);
          alert(error.response?.data?.error || t('common.error'));
        }
      },
      { variant: 'danger', confirmText: t('common.delete'), cancelText: t('common.cancel') }
    );
  };

  const handleModalClose = () => {
    setModalOpen(false);
    setEditingProvider(null);
  };

  if (loading) {
    return (
      <div className="pb-24">
        <PageLoadingSkeleton lines={6} />
      </div>
    );
  }

  const providerSubtitle = `${providers.length} ${providers.length === 1 ? t('common.provider') : t('common.providers')}`;

  return (
    <div className="space-y-6 pb-24">
      <PageHeader
        title={t('admin.oidcProviders')}
        subtitle={providerSubtitle}
        actions={
          <Button
            onClick={() => setModalOpen(true)}
            icon={Plus}
            className="border-0 bg-primary-gradient text-primary-foreground shadow-glow hover:opacity-90"
          >
            {t('admin.addProvider')}
          </Button>
        }
      />

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
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {providers.map((provider) => (
            <div
              key={provider.id}
              className="group overflow-hidden rounded-2xl border border-ghost bg-surface shadow-none transition-colors hover:border-primary/25"
            >
              <div className="p-4 space-y-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-center gap-2 flex-1 min-w-0">
                    <Key className="h-5 w-5 text-muted-foreground flex-shrink-0" />
                    <h3 className="text-lg font-semibold text-foreground truncate">
                      {provider.provider_key}
                    </h3>
                  </div>
                </div>
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Globe className="h-4 w-4 shrink-0" />
                  <span className="truncate">{provider.issuer_url}</span>
                </div>
                {(provider.authorization_url || provider.token_url || provider.userinfo_url) && (
                  <div className="text-xs text-muted-foreground space-y-1">
                    {provider.token_url && (
                      <div className="truncate">
                        <span className="font-medium">Token:</span> {provider.token_url}
                      </div>
                    )}
                  </div>
                )}
                {provider.callback_url && (
                  <div className="rounded-xl border border-ghost bg-surface-low p-3">
                    <div className="text-xs font-semibold text-foreground mb-1">
                      {t('admin.callbackUrl')}:
                    </div>
                    <code className="text-xs text-foreground break-all font-mono">
                      {provider.callback_url}
                    </code>
                  </div>
                )}
                <div className="flex flex-wrap gap-2">
                  <span className="rounded-full bg-surface-low px-2.5 py-1 text-xs font-medium text-muted-foreground border border-ghost">
                    {t('admin.autoCreate')}: {provider.auto_create_users ? t('common.yes') : t('common.no')}
                  </span>
                  <span className="rounded-full bg-surface-low px-2.5 py-1 text-xs font-medium text-muted-foreground border border-ghost">
                    {t('admin.defaultRole')}: {provider.default_role}
                  </span>
                </div>
                <div className="flex gap-2 pt-2 border-t border-ghost">
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={Edit}
                    onClick={() => handleEdit(provider)}
                    className="flex-1"
                  >
                    {t('common.edit')}
                  </Button>
                  <Button
                    variant="danger"
                    size="sm"
                    icon={Trash2}
                    onClick={() => handleDelete(provider.id)}
                  />
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

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
