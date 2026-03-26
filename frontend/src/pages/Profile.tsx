import React, { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { useAppConfig } from '../contexts/AppConfigContext';
import { usePlan } from '../contexts/PlanContext';
import { AlertCircle, Key, AlertTriangle } from 'lucide-react';
import Select from '../components/ui/Select';
import Button from '../components/ui/Button';
import { Switch } from '../components/ui/switch';
import { useToast } from '../components/ui/Toast';
import ConfirmDialog from '../components/ui/ConfirmDialog';
import CreateTokenModal from '../components/profile/CreateTokenModal';
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from '../components/ui/card';
import { Badge } from '../components/ui/badge';
import { Input } from '../components/ui/input';
import api from '../api/client';
import { getDocsApiReferenceUrl } from '../config/docs';

interface ApiToken {
  id: string;
  name: string;
  created_at: string;
  last_used_at: string | null;
}

function SettingsRow({
  label,
  value,
  action,
  helper,
  children,
  ariaLabel,
}: {
  label: string;
  value?: React.ReactNode;
  action?: React.ReactNode;
  helper?: React.ReactNode;
  children?: React.ReactNode;
  ariaLabel?: string;
}) {
  return (
    <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 py-3 border-b border-ghost last:border-0">
      <div className="min-w-0 flex-1">
        <dt className="text-sm font-medium text-foreground">{label}</dt>
        {value !== undefined && (
          <dd className="mt-0.5 text-sm text-muted-foreground">{value}</dd>
        )}
        {helper && <dd className="mt-0.5 text-xs text-muted-foreground">{helper}</dd>}
        {children}
      </div>
      {action && (
        <div className="flex-shrink-0 sm:ml-4" aria-label={ariaLabel}>
          {action}
        </div>
      )}
    </div>
  );
}

export default function Profile() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { pathPrefixForLinks, profileDeleteGuard } = useAppConfig();
  const prefix = (pathPrefixForLinks || '').replace(/\/+/g, '/') || '';
  const loginPath = `${prefix}/login`.replace(/\/+/g, '/') || '/login';
  const { user, updateUser, checkAuth, logout } = useAuth();
  const planInfo = usePlan();
  const { showToast } = useToast();
  const [formData, setFormData] = useState({
    email: '',
    name: '',
    language: 'en',
    theme: 'auto',
    ai_suggestions_enabled: true,
  });
  const [aiAvailable, setAiAvailable] = useState(false);
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<{ email?: string; name?: string }>({});
  const [editingEmail, setEditingEmail] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [tokens, setTokens] = useState<ApiToken[]>([]);
  const [tokensLoading, setTokensLoading] = useState(true);
  const [createTokenOpen, setCreateTokenOpen] = useState(false);
  const [revokeTokenId, setRevokeTokenId] = useState<string | null>(null);
  const [deleteAccountOpen, setDeleteAccountOpen] = useState(false);
  const [deleteAccountLoading, setDeleteAccountLoading] = useState(false);

  useEffect(() => {
    if (user) {
      setFormData({
        email: user.email || '',
        name: user.name || '',
        language: user.language || 'en',
        theme: user.theme || 'auto',
        ai_suggestions_enabled: Boolean((user as { ai_suggestions_enabled?: boolean | number }).ai_suggestions_enabled ?? true),
      });
    }
  }, [user]);

  useEffect(() => {
    if (user) {
      api.get('/config/ai-suggestions')
        .then((res) => setAiAvailable(res.data?.available === true))
        .catch(() => setAiAvailable(false));
    }
  }, [user]);

  const fetchTokens = useCallback(() => {
    setTokensLoading(true);
    api.get('/tokens').then((res) => {
      setTokens(Array.isArray(res.data) ? res.data : []);
    }).catch(() => setTokens([])).finally(() => setTokensLoading(false));
  }, []);

  useEffect(() => {
    if (user) fetchTokens();
  }, [user, fetchTokens]);

  const preferencesDirty = user && (
    formData.language !== (user.language || 'en') ||
    formData.theme !== (user.theme || 'auto') ||
    formData.ai_suggestions_enabled !== Boolean((user as { ai_suggestions_enabled?: boolean | number }).ai_suggestions_enabled ?? true)
  );

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setErrors({});
    try {
      const response = (await updateUser(formData)) as unknown;
      const data = response && typeof response === 'object' && 'emailVerificationRequired' in response
        ? (response as { emailVerificationRequired?: boolean })
        : null;
      if (data?.emailVerificationRequired) {
        showToast(t('emailVerification.emailSent'), 'success');
        setEditingEmail(false);
        await checkAuth();
      } else {
        setEditingEmail(false);
        setEditingName(false);
        showToast(t('common.success'), 'success');
      }
    } catch (error: unknown) {
      const err = error as { response?: { data?: { error?: string } } };
      console.error('Failed to update profile:', err);
      if (err.response?.data?.error) {
        const errorMessage = err.response.data.error;
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

  async function handleRevokeToken(tokenId: string) {
    try {
      await api.delete(`/tokens/${tokenId}`);
      setTokens((prev) => prev.filter((tok) => tok.id !== tokenId));
      showToast(t('common.success'), 'success');
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } } };
      showToast(e.response?.data?.error || t('common.error'), 'error');
    } finally {
      setRevokeTokenId(null);
    }
  }

  async function handleDeleteAccountClick() {
    if (profileDeleteGuard) {
      try {
        const result = await profileDeleteGuard();
        if (!result.allowed) {
          showToast(result.message || t('profile.deleteAccountGuardMessage'), 'error');
          return;
        }
      } catch {
        showToast(t('common.error'), 'error');
        return;
      }
    }
    setDeleteAccountOpen(true);
  }

  async function handleConfirmDeleteAccount() {
    setDeleteAccountLoading(true);
    try {
      await api.delete('/users/me');
      setDeleteAccountOpen(false);
      showToast(t('profile.deleteAccountSuccess'), 'success');
      await logout();
      navigate(loginPath, { replace: true });
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } } };
      showToast(e.response?.data?.error || t('common.error'), 'error');
    } finally {
      setDeleteAccountLoading(false);
    }
  }

  function formatDate(iso: string) {
    try {
      return new Date(iso).toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch {
      return iso;
    }
  }

  if (!user) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="text-muted-foreground">{t('common.loading')}</div>
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
      {/* Page header: title + subtitle left; signed-in summary + Admin badge right */}
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-2">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">
            {t('profile.title')}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t('profile.description')}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <span>
            {t('profile.signedInAs')}: <span className="text-foreground">{user.email}</span>
          </span>
          {!!user.is_admin && (
            <Badge variant="secondary" className="text-xs font-normal">
              {t('profile.admin')}
            </Badge>
          )}
        </div>
      </div>

      <div className="space-y-6">
        {/* Section A: Account */}
        <Card className="rounded-xl border border-ghost bg-surface shadow-none">
          <CardHeader>
            <CardTitle>{t('profile.account')}</CardTitle>
            <CardDescription>{t('profile.accountDescription')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-0">
            <dl className="divide-y-0">
              {/* Email row */}
              <SettingsRow
                label={t('profile.email')}
                value={
                  editingEmail ? undefined : (
                    <>
                      {user.email}
                      {user.email_pending && (
                        <span className="ml-2 text-primary text-xs font-medium">
                          ({t('emailVerification.pendingTitle')})
                        </span>
                      )}
                    </>
                  )
                }
                helper={
                  !editingEmail && user.oidc_provider
                    ? t('profile.emailManagedByOIDC')
                    : undefined
                }
                action={
                  editingEmail ? (
                    <div className="flex gap-2 mt-2 sm:mt-0">
                      <Button
                        type="button"
                        variant="primary"
                        size="sm"
                        onClick={handleSubmit}
                        disabled={saving}
                        aria-label={t('common.save')}
                        className="border-0 bg-primary-gradient text-primary-foreground shadow-glow hover:opacity-90"
                      >
                        {saving ? t('common.loading') : t('common.save')}
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setEditingEmail(false);
                          setFormData((prev) => ({ ...prev, email: user.email || '' }));
                          setErrors((prev) => ({ ...prev, email: undefined }));
                        }}
                        aria-label={t('common.cancel')}
                      >
                        {t('common.cancel')}
                      </Button>
                    </div>
                  ) : !user.oidc_provider ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setEditingEmail(true)}
                      aria-label={t('profile.email')}
                    >
                      {t('common.edit')}
                    </Button>
                  ) : null
                }
              >
                {editingEmail && (
                  <div className="space-y-1 mt-2">
                    <Input
                      type="email"
                      value={formData.email}
                      onChange={(e) => {
                        setFormData((prev) => ({ ...prev, email: e.target.value }));
                        setErrors((prev) => ({ ...prev, email: undefined }));
                      }}
                      placeholder={t('profile.emailPlaceholder')}
                      className="max-w-md"
                      aria-label={t('profile.email')}
                    />
                    {errors.email && (
                      <p className="text-xs text-destructive">{errors.email}</p>
                    )}
                  </div>
                )}
                {!editingEmail && user.email_pending && (
                  <div className="flex items-start gap-2 px-3 py-2 bg-primary/10 border border-primary/30 rounded-lg mt-2">
                    <AlertCircle className="h-4 w-4 text-primary flex-shrink-0 mt-0.5" />
                    <div className="flex-1">
                      <p className="text-xs text-foreground font-medium">
                        {t('emailVerification.pendingTitle')}
                      </p>
                      <p className="text-xs text-muted-foreground mt-1">
                        {t('emailVerification.pendingDescription', { email: user.email_pending })}
                      </p>
                    </div>
                  </div>
                )}
              </SettingsRow>

              {/* Name row */}
              <SettingsRow
                label={t('profile.name')}
                value={editingName ? undefined : user.name}
                action={
                  editingName ? (
                    <div className="flex gap-2 mt-2 sm:mt-0">
                      <Button
                        type="button"
                        variant="primary"
                        size="sm"
                        onClick={handleSubmit}
                        disabled={saving}
                        aria-label={t('common.save')}
                        className="border-0 bg-primary-gradient text-primary-foreground shadow-glow hover:opacity-90"
                      >
                        {saving ? t('common.loading') : t('common.save')}
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setEditingName(false);
                          setFormData((prev) => ({ ...prev, name: user.name || '' }));
                          setErrors((prev) => ({ ...prev, name: undefined }));
                        }}
                        aria-label={t('common.cancel')}
                      >
                        {t('common.cancel')}
                      </Button>
                    </div>
                  ) : (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setEditingName(true)}
                      aria-label={t('profile.name')}
                    >
                      {t('common.edit')}
                    </Button>
                  )
                }
              >
                {editingName && (
                  <div className="space-y-1 mt-2">
                    <Input
                      type="text"
                      value={formData.name}
                      onChange={(e) => {
                        setFormData((prev) => ({ ...prev, name: e.target.value }));
                        setErrors((prev) => ({ ...prev, name: undefined }));
                      }}
                      placeholder={t('profile.namePlaceholder')}
                      className="max-w-md"
                      aria-label={t('profile.name')}
                    />
                    {errors.name && (
                      <p className="text-xs text-destructive">{errors.name}</p>
                    )}
                  </div>
                )}
              </SettingsRow>

              {/* Quick Access row — muted, no primary action */}
              <SettingsRow
                label={t('profile.quickAccess')}
                helper={
                  <>
                    {t('profile.quickAccessDescription')}{' '}
                    <Link
                      to={`${prefix}/go-preferences`}
                      className="text-primary hover:text-primary/90 font-medium"
                    >
                      {t('profile.manageQuickAccess')} →
                    </Link>
                  </>
                }
              />
            </dl>
          </CardContent>
        </Card>

        {/* Section B: Preferences */}
        <Card className="rounded-xl border border-ghost bg-surface shadow-none">
          <CardHeader>
            <CardTitle>{t('profile.preferences')}</CardTitle>
            <CardDescription>{t('profile.preferencesDescription')}</CardDescription>
          </CardHeader>
          <form onSubmit={handleSubmit} id="profile-preferences-form">
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <label className="text-sm font-medium text-foreground" id="profile-language-label">
                  {t('profile.language')}
                </label>
                <Select
                  value={formData.language}
                  onChange={(value) => setFormData((prev) => ({ ...prev, language: value }))}
                  options={languageOptions}
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium text-foreground" id="profile-theme-label">
                  {t('profile.theme')}
                </label>
                <Select
                  value={formData.theme}
                  onChange={(value) => setFormData((prev) => ({ ...prev, theme: value }))}
                  options={themeOptions}
                />
              </div>
              {((!planInfo && aiAvailable) || (planInfo && planInfo.plan !== 'free')) && (
                <div className="flex items-center justify-between gap-3 py-2">
                  <div>
                    <label htmlFor="ai-suggestions" className="text-sm font-medium text-foreground">
                      {t('profile.aiSuggestions')}
                    </label>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {t('profile.aiSuggestionsDescription')}
                    </p>
                  </div>
                  <Switch
                    id="ai-suggestions"
                    checked={formData.ai_suggestions_enabled}
                    onCheckedChange={(checked) =>
                      setFormData((prev) => ({ ...prev, ai_suggestions_enabled: checked }))
                    }
                    aria-label={t('profile.aiSuggestions')}
                  />
                </div>
              )}
            </CardContent>
            <CardFooter className="flex flex-row items-center justify-between gap-4">
              <span className="text-xs text-muted-foreground">
                {preferencesDirty ? t('profile.unsavedChanges') : null}
              </span>
              <Button
                type="submit"
                form="profile-preferences-form"
                variant="primary"
                disabled={saving || !preferencesDirty}
                aria-label={t('common.save')}
                className="border-0 bg-primary-gradient text-primary-foreground shadow-glow hover:opacity-90"
              >
                {saving ? t('common.loading') : t('common.save')}
              </Button>
            </CardFooter>
          </form>
        </Card>

        {/* Section C: Developer / API Access */}
        <Card className="rounded-xl border border-ghost bg-surface shadow-none" aria-labelledby="developer-section-title">
          <CardHeader>
            <div className="flex flex-wrap items-center gap-2">
              <CardTitle id="developer-section-title" className="flex items-center gap-2">
                <Key className="h-5 w-5 text-primary" />
                {t('profile.developerApiTitle')}
              </CardTitle>
              <Badge
                variant="secondary"
                className="text-xs font-normal bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/20"
              >
                {t('profile.advanced')}
              </Badge>
            </div>
            <CardDescription>{t('profile.developerApiDescription')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-start gap-2 px-2.5 py-1.5 rounded-md bg-amber-500/10 border border-amber-500/20">
              <AlertCircle className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400 flex-shrink-0 mt-0.5" />
              <p className="text-xs text-amber-800 dark:text-amber-200">
                {t('profile.apiTokenWarning')}
              </p>
            </div>
            <a
              href={getDocsApiReferenceUrl()}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm font-medium text-primary hover:text-primary/90 inline-block"
            >
              {t('profile.viewApiDocs')} →
            </a>
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
              <span className="text-sm font-medium text-foreground">
                {t('profile.yourTokens')}
              </span>
              <Button
                type="button"
                variant="primary"
                size="sm"
                onClick={() => setCreateTokenOpen(true)}
                aria-label={t('profile.createToken')}
                className="border-0 bg-primary-gradient text-primary-foreground shadow-glow hover:opacity-90"
              >
                {t('profile.createToken')}
              </Button>
            </div>
            {tokensLoading ? (
              <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
            ) : tokens.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {t('profile.noTokensEmpty')}
              </p>
            ) : (
              <ul className="space-y-2" role="list">
                {tokens.map((tok) => (
                  <li
                    key={tok.id}
                    className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 py-2 px-3 rounded-xl border border-ghost bg-surface-low"
                  >
                    <div className="min-w-0 flex-1">
                      <span className="text-sm font-medium text-foreground block truncate">
                        {tok.name}
                      </span>
                      <span className="text-xs text-muted-foreground font-mono">
                        sb_********************************
                      </span>
                      <span className="text-xs text-muted-foreground block mt-0.5">
                        {t('profile.createdAt')}: {formatDate(tok.created_at)}
                        {' · '}
                        {t('profile.lastUsed')}: {tok.last_used_at ? formatDate(tok.last_used_at) : t('profile.neverUsed')}
                      </span>
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setRevokeTokenId(tok.id)}
                      className="text-destructive hover:text-destructive/90 sm:ml-auto"
                      aria-label={`${t('profile.revokeToken')} ${tok.name}`}
                    >
                      {t('profile.revokeToken')}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        {/* Danger Zone: delete account */}
        <Card className="rounded-xl border border-destructive/40 bg-surface-low shadow-none">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-destructive">
              <AlertTriangle className="h-5 w-5" />
              {t('profile.dangerZone')}
            </CardTitle>
            <CardDescription>{t('profile.dangerZoneDescription')}</CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground mb-4">
              {t('profile.deleteAccountDescription')}
            </p>
            <Button
              type="button"
              variant="ghost"
              className="text-destructive hover:text-destructive hover:bg-destructive/10"
              onClick={handleDeleteAccountClick}
              disabled={deleteAccountLoading}
              aria-label={t('profile.deleteAccount')}
            >
              {t('profile.deleteAccount')}
            </Button>
          </CardContent>
        </Card>
      </div>

      <CreateTokenModal
        isOpen={createTokenOpen}
        onClose={() => setCreateTokenOpen(false)}
        onCreated={fetchTokens}
      />
      <ConfirmDialog
        isOpen={revokeTokenId !== null}
        title={t('profile.revokeToken')}
        message={t('profile.revokeTokenConfirm')}
        variant="danger"
        confirmText={t('profile.revokeToken')}
        onConfirm={() => revokeTokenId && handleRevokeToken(revokeTokenId)}
        onCancel={() => setRevokeTokenId(null)}
      />
      <ConfirmDialog
        isOpen={deleteAccountOpen}
        title={t('profile.deleteAccount')}
        message={t('profile.deleteAccountConfirm')}
        variant="danger"
        confirmText={t('profile.deleteAccount')}
        onConfirm={handleConfirmDeleteAccount}
        onCancel={() => setDeleteAccountOpen(false)}
      />
    </div>
  );
}
