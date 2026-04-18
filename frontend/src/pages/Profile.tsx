import React, { useState, useEffect, useCallback, useId, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { useAppConfig } from '../contexts/AppConfigContext';
import { usePlan, usePlanLoadState, isCloudMode } from '../contexts/PlanContext';
import { AlertCircle, Key, AlertTriangle, Shield, Upload, Download } from 'lucide-react';
import Select from '../components/ui/Select';
import Button from '../components/ui/Button';
import { Switch } from '../components/ui/switch';
import { useToast } from '../components/ui/Toast';
import ConfirmDialog from '../components/ui/ConfirmDialog';
import CreateTokenModal from '../components/profile/CreateTokenModal';
import MfaEnrollSetupModal from '../components/profile/MfaEnrollSetupModal';
import MfaEnrollBackupCodesModal from '../components/profile/MfaEnrollBackupCodesModal';
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from '../components/ui/card';
import { Badge } from '../components/ui/badge';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../components/ui/dialog';
import api from '../api/client';
import { DOCS_API_OPERATIONS, getDocsApiReferenceOperationUrl, getDocsApiReferenceUrl } from '../config/docs';
import { resolveSupportedLocale } from '../i18n';
import { canAccessWorkspaceAdmin } from '../utils/adminAccess';
import { copyTextToClipboard } from '../utils/copyTextToClipboard';
import { applyAccent } from '../lib/applyAccent';
import { SegmentedControl, SegmentedControlItem } from '../components/ui/SegmentedControl';
import ImportModal from '../components/modals/ImportModal';

const BOOKMARKS_VIEW_STORAGE_KEY = 'slugbase_bookmarks_view';

const ACCENT_PRESETS = ['#7b7ef4', '#60a5fa', '#4ade80', '#fbbf24', '#f87171', '#f472b6'] as const;

function profileInitials(name: string, email: string) {
  const n = name.trim();
  if (n) {
    const p = n.split(/\s+/).filter(Boolean);
    if (p.length >= 2) return `${p[0][0] ?? ''}${p[1][0] ?? ''}`.toUpperCase();
    return p[0].slice(0, 2).toUpperCase();
  }
  return email.slice(0, 2).toUpperCase();
}

function getStoredBookmarksView(): 'cards' | 'table' {
  if (typeof window === 'undefined') return 'cards';
  try {
    const v = localStorage.getItem(BOOKMARKS_VIEW_STORAGE_KEY);
    if (v === 'table' || v === 'cards') return v;
  } catch {
    /* ignore */
  }
  return 'cards';
}

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
  const planLoadState = usePlanLoadState();
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

  const [dashStats, setDashStats] = useState<{ totalBookmarks: number } | null>(null);
  const [slugRouteCount, setSlugRouteCount] = useState<number | null>(null);
  const [bookmarksView, setBookmarksView] = useState<'cards' | 'table'>(() => getStoredBookmarksView());
  const [importModalOpen, setImportModalOpen] = useState(false);

  const mfaIds = useId();
  /** Avoid calling enroll/cancel when Radix closes the setup dialog after a successful confirm. */
  const mfaEnrollSucceededRef = useRef(false);

  const [mfaWizard, setMfaWizard] = useState<'idle' | 'enrolling' | 'backup_view'>('idle');
  const [mfaOtpauthUrl, setMfaOtpauthUrl] = useState<string | null>(null);
  const [mfaSecretB32, setMfaSecretB32] = useState<string | null>(null);
  const [mfaConfirmCode, setMfaConfirmCode] = useState('');
  const [mfaBackupCodes, setMfaBackupCodes] = useState<string[] | null>(null);
  const [mfaBackupAck, setMfaBackupAck] = useState(false);
  const [mfaBusy, setMfaBusy] = useState(false);
  const [mfaError, setMfaError] = useState('');

  const [disableDlgOpen, setDisableDlgOpen] = useState(false);
  const [disableCode, setDisableCode] = useState('');
  const [disablePassword, setDisablePassword] = useState('');
  const [disableNeedsPassword, setDisableNeedsPassword] = useState(false);
  const [disableError, setDisableError] = useState('');
  const [disableBusy, setDisableBusy] = useState(false);

  const [regenDlgOpen, setRegenDlgOpen] = useState(false);
  const [regenStep, setRegenStep] = useState<'form' | 'codes'>('form');
  const [regenCode, setRegenCode] = useState('');
  const [regenPassword, setRegenPassword] = useState('');
  const [regenNeedsPassword, setRegenNeedsPassword] = useState(false);
  const [regenError, setRegenError] = useState('');
  const [regenBusy, setRegenBusy] = useState(false);
  const [regenCodes, setRegenCodes] = useState<string[] | null>(null);
  const [regenAck, setRegenAck] = useState(false);

  useEffect(() => {
    if (user) {
      setFormData({
        email: user.email || '',
        name: user.name || '',
        language: resolveSupportedLocale(user.language),
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

  useEffect(() => {
    if (!user) return;
    api
      .get<{ totalBookmarks?: number }>('/dashboard/stats')
      .then((res) => setDashStats({ totalBookmarks: res.data?.totalBookmarks ?? 0 }))
      .catch(() => setDashStats(null));
    api
      .get<unknown[]>('/go/preferences')
      .then((res) => setSlugRouteCount(Array.isArray(res.data) ? res.data.length : 0))
      .catch(() => setSlugRouteCount(null));
  }, [user]);

  useEffect(() => {
    try {
      localStorage.setItem(BOOKMARKS_VIEW_STORAGE_KEY, bookmarksView);
    } catch {
      /* ignore */
    }
  }, [bookmarksView]);

  const resetDisableDialog = useCallback(() => {
    setDisableCode('');
    setDisablePassword('');
    setDisableNeedsPassword(false);
    setDisableError('');
  }, []);

  const resetRegenDialog = useCallback(() => {
    setRegenStep('form');
    setRegenCode('');
    setRegenPassword('');
    setRegenNeedsPassword(false);
    setRegenError('');
    setRegenCodes(null);
    setRegenAck(false);
  }, []);

  const normalizeTotpDigits = (raw: string) => raw.replace(/\D/g, '').slice(0, 6);

  const handleMfaBegin = async () => {
    mfaEnrollSucceededRef.current = false;
    setMfaError('');
    setMfaBusy(true);
    try {
      const res = await api.post('/auth/mfa/enroll/begin', {});
      const url = res.data?.otpauth_url;
      const sec = res.data?.secret;
      if (typeof url === 'string' && typeof sec === 'string') {
        setMfaOtpauthUrl(url);
        setMfaSecretB32(sec);
        setMfaWizard('enrolling');
        setMfaConfirmCode('');
      } else {
        setMfaError(t('common.error'));
      }
    } catch (err: unknown) {
      const ax = err as { response?: { status?: number; data?: { error?: string } } };
      if (ax.response?.status === 409) {
        setMfaError(t('mfa.alreadyEnabled'));
      } else {
        setMfaError(ax.response?.data?.error || t('common.error'));
      }
    } finally {
      setMfaBusy(false);
    }
  };

  const handleMfaCancelSetup = async () => {
    if (mfaEnrollSucceededRef.current) {
      mfaEnrollSucceededRef.current = false;
      return;
    }
    setMfaError('');
    setMfaBusy(true);
    try {
      await api.post('/auth/mfa/enroll/cancel', {});
    } catch {
      /* idempotent on server */
    } finally {
      setMfaBusy(false);
      setMfaWizard('idle');
      setMfaOtpauthUrl(null);
      setMfaSecretB32(null);
      setMfaConfirmCode('');
      setMfaBackupCodes(null);
      setMfaBackupAck(false);
    }
  };

  const handleMfaConfirmEnroll = async (e: React.FormEvent) => {
    e.preventDefault();
    const digits = normalizeTotpDigits(mfaConfirmCode);
    if (digits.length !== 6) {
      setMfaError(t('mfa.invalidTotpLength'));
      return;
    }
    setMfaError('');
    setMfaBusy(true);
    try {
      const res = await api.post('/auth/mfa/enroll/confirm', { code: digits });
      const codes = res.data?.backup_codes;
      if (!Array.isArray(codes) || codes.length === 0) {
        setMfaError(t('common.error'));
        return;
      }
      mfaEnrollSucceededRef.current = true;
      setMfaBackupCodes(codes.map(String));
      setMfaBackupAck(false);
      setMfaWizard('backup_view');
      setMfaConfirmCode('');
    } catch (err: unknown) {
      const ax = err as { response?: { data?: { code?: string; error?: string } } };
      const c = ax.response?.data?.code;
      if (c === 'INVALID_CODE') {
        setMfaError(t('mfa.invalidCode'));
      } else if (c === 'MFA_ALREADY_ENABLED') {
        setMfaError(t('mfa.alreadyEnabled'));
      } else {
        setMfaError(ax.response?.data?.error || t('common.error'));
      }
    } finally {
      setMfaBusy(false);
    }
  };

  const handleMfaBackupDone = async () => {
    if (!mfaBackupAck) return;
    setMfaBusy(true);
    try {
      await checkAuth();
      mfaEnrollSucceededRef.current = false;
      setMfaWizard('idle');
      setMfaOtpauthUrl(null);
      setMfaSecretB32(null);
      setMfaBackupCodes(null);
      setMfaBackupAck(false);
      showToast(t('mfa.enrollComplete'), 'success');
    } finally {
      setMfaBusy(false);
    }
  };

  const handleDisableSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setDisableError('');
    setDisableBusy(true);
    try {
      const body: { code: string; password?: string } = { code: disableCode.trim() };
      if (disablePassword) body.password = disablePassword;
      await api.post('/auth/mfa/disable', body);
      setDisableDlgOpen(false);
      resetDisableDialog();
      await checkAuth();
      showToast(t('mfa.disabledSuccess'), 'success');
    } catch (err: unknown) {
      const ax = err as { response?: { data?: { code?: string; error?: string } } };
      const c = ax.response?.data?.code;
      if (c === 'PASSWORD_REQUIRED') {
        setDisableNeedsPassword(true);
        setDisableError(t('mfa.passwordRequired'));
      } else {
        setDisableError(ax.response?.data?.error || t('common.error'));
      }
    } finally {
      setDisableBusy(false);
    }
  };

  const handleRegenSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setRegenError('');
    setRegenBusy(true);
    try {
      const body: { code: string; password?: string } = { code: regenCode.trim() };
      if (regenPassword) body.password = regenPassword;
      const res = await api.post('/auth/mfa/backup/regenerate', body);
      const codes = res.data?.backup_codes;
      if (!Array.isArray(codes) || codes.length === 0) {
        setRegenError(t('common.error'));
        return;
      }
      setRegenCodes(codes.map(String));
      setRegenStep('codes');
      setRegenAck(false);
    } catch (err: unknown) {
      const ax = err as { response?: { data?: { code?: string; error?: string } } };
      const c = ax.response?.data?.code;
      if (c === 'PASSWORD_REQUIRED') {
        setRegenNeedsPassword(true);
        setRegenError(t('mfa.passwordRequired'));
      } else {
        setRegenError(ax.response?.data?.error || t('common.error'));
      }
    } finally {
      setRegenBusy(false);
    }
  };

  const copyBackupCodes = async (codes: string[]) => {
    const ok = await copyTextToClipboard(codes.join('\n'));
    if (ok) {
      showToast(t('mfa.backupCodesCopied'), 'success');
    } else {
      showToast(t('mfa.copyFailed'), 'error');
    }
  };

  const showAiSuggestionsPreference = isCloudMode
    ? planLoadState === 'ready' && planInfo?.aiAvailable === true
    : aiAvailable;

  const preferencesDirty =
    !!user &&
    (formData.language !== resolveSupportedLocale(user.language) ||
      formData.theme !== (user.theme || 'auto') ||
      (showAiSuggestionsPreference &&
        formData.ai_suggestions_enabled !==
          Boolean((user as { ai_suggestions_enabled?: boolean | number }).ai_suggestions_enabled ?? true)));

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setErrors({});
    try {
      const preferencePayload = {
        language: formData.language,
        theme: formData.theme,
        ...(showAiSuggestionsPreference ? { ai_suggestions_enabled: formData.ai_suggestions_enabled } : {}),
      };
      const response = (await updateUser(preferencePayload)) as unknown;
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

  function handleExportBookmarks() {
    api
      .get('/bookmarks/export')
      .then((response) => {
        const dataStr = JSON.stringify(response.data, null, 2);
        const dataBlob = new Blob([dataStr], { type: 'application/json' });
        const urlObj = URL.createObjectURL(dataBlob);
        const link = document.createElement('a');
        link.href = urlObj;
        link.download = `slugbase-bookmarks-${new Date().toISOString().split('T')[0]}.json`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(urlObj);
        showToast(t('common.success'), 'success');
      })
      .catch(() => {
        showToast(t('common.error'), 'error');
      });
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
  ];

  /** SlugBase TOTP applies to password login; hide enrollment for pure OIDC unless MFA was enabled (e.g. hybrid or legacy). */
  const showSlugbaseMfaCard = user.has_password !== false || Boolean(user.mfa_enabled);
  const showOidcMfaManagedNote =
    Boolean(user.oidc_provider) && user.has_password === false && !user.mfa_enabled;

  const appOrigin =
    typeof window !== 'undefined' ? `${window.location.origin}${prefix || ''}`.replace(/\/+$/, '') || window.location.origin : '';

  return (
    <div className="space-y-8">
      <div className="profile-head rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--bg-1)] p-6 shadow-[var(--shadow-sm)]">
        <div className="flex flex-col gap-6 lg:flex-row lg:items-start lg:justify-between">
          <div className="flex min-w-0 gap-4">
            <div
              className="flex h-16 w-16 shrink-0 items-center justify-center rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--accent-bg)] font-mono text-lg font-semibold text-[var(--accent-hi)]"
              aria-hidden
            >
              {profileInitials(user.name || '', user.email)}
            </div>
            <div className="min-w-0 space-y-1">
              <h1 className="text-[22px] font-semibold tracking-[-0.02em] text-[var(--fg-0)]">{user.name || '—'}</h1>
              <p className="text-[13px] text-[var(--fg-2)]">{user.email}</p>
              <div className="flex flex-wrap items-center gap-2 pt-1">
                {canAccessWorkspaceAdmin(user) && (
                  <Badge variant="secondary" className="text-[11px] font-normal">
                    {t('profile.admin')}
                  </Badge>
                )}
                {user.oidc_provider ? (
                  <Badge variant="outline" className="text-[11px] font-normal border-[var(--border)] text-[var(--fg-2)]">
                    {user.oidc_provider}
                  </Badge>
                ) : null}
              </div>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => document.getElementById('profile-section-general')?.scrollIntoView({ behavior: 'smooth' })}
            >
              {t('profile.editProfile')}
            </Button>
            {user.has_password ? (
              <Link
                to={`${prefix}/password-reset`.replace(/\/+/g, '/')}
                className="inline-flex h-8 items-center rounded-[var(--radius-sm)] px-3 text-[13px] font-medium text-[var(--fg-1)] hover:bg-[var(--bg-hover)] hover:text-[var(--fg-0)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)]"
              >
                {t('profile.changePassword')}
              </Link>
            ) : null}
          </div>
        </div>
      </div>

      {(dashStats || slugRouteCount !== null) && (
        <div className="stats grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="stat rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg-1)] px-4 py-3">
            <p className="font-mono text-[10px] uppercase tracking-wide text-[var(--fg-3)]">{t('profile.statBookmarks')}</p>
            <p className="mt-1 tabular-nums text-[20px] font-semibold text-[var(--fg-0)]">
              {dashStats?.totalBookmarks ?? '—'}
            </p>
          </div>
          <div className="stat rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg-1)] px-4 py-3">
            <p className="font-mono text-[10px] uppercase tracking-wide text-[var(--fg-3)]">{t('profile.statSlugs')}</p>
            <p className="mt-1 tabular-nums text-[20px] font-semibold text-[var(--fg-0)]">
              {slugRouteCount ?? '—'}
            </p>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Card className="rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--bg-1)] shadow-none">
          <CardHeader className="pb-2">
            <CardTitle className="text-[15px]">{t('profile.membershipsTitle')}</CardTitle>
            <CardDescription>{t('profile.membershipsDescription')}</CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-[13px] text-[var(--fg-1)]">
              {isCloudMode && planLoadState === 'ready'
                ? t('profile.membershipsCloudPlan', { plan: planInfo?.plan ?? '—' })
                : t('profile.membershipsSelfHosted')}
            </p>
          </CardContent>
        </Card>
        <Card className="rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--bg-1)] shadow-none">
          <CardHeader className="pb-2">
            <CardTitle className="text-[15px]">{t('profile.shortcutsTitle')}</CardTitle>
            <CardDescription>{t('profile.shortcutsDescription')}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-2 text-[13px]">
            <Link className="font-medium text-[var(--accent-hi)] hover:underline" to={`${prefix}/go-preferences`}>
              {t('profile.manageQuickAccess')} →
            </Link>
            <Link className="font-medium text-[var(--accent-hi)] hover:underline" to={`${prefix}/search-engine-guide`}>
              {t('searchEngineGuide.title')} →
            </Link>
          </CardContent>
        </Card>
      </div>

      <div className="settings-layout flex flex-col gap-8 lg:flex-row lg:items-start">
        <nav
          className="settings-nav flex flex-row flex-wrap gap-1 lg:w-52 lg:flex-col lg:flex-nowrap"
          aria-label={t('profile.settingsNavLabel')}
        >
          {(
            [
              ['general', t('profile.sectionGeneral')],
              ['appearance', t('profile.sectionAppearance')],
              ['security', t('profile.sectionSecurity')],
              ['tokens', t('profile.sectionApiTokens')],
              ['data', t('profile.sectionDataPrivacy')],
              ['integrations', t('profile.sectionIntegrations')],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => document.getElementById(`profile-section-${key}`)?.scrollIntoView({ behavior: 'smooth' })}
              className="sb-item rounded-[var(--radius)] px-2.5 py-2 text-left text-[13px] text-[var(--fg-1)] hover:bg-[var(--bg-hover)] hover:text-[var(--fg-0)]"
            >
              {label}
            </button>
          ))}
        </nav>

      <div className="min-w-0 flex-1 space-y-6">
        <form onSubmit={handleSubmit} id="profile-preferences-form">
        {/* Section A: Account */}
        <Card id="profile-section-general" className="scroll-mt-24 rounded-xl border border-ghost bg-surface shadow-none">
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

              {/* Quick Access row - muted, no primary action */}
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

              <SettingsRow
                label={t('profile.appBaseUrl')}
                value={<code className="font-mono text-[12px] text-[var(--fg-1)]">{appOrigin || '—'}</code>}
              />

              <SettingsRow label={t('profile.language')}>
                <div className="mt-2 max-w-xs sm:mt-0">
                  <Select
                    value={formData.language}
                    onChange={(value) => setFormData((prev) => ({ ...prev, language: value }))}
                    options={languageOptions}
                  />
                </div>
              </SettingsRow>
            </dl>
          </CardContent>
        </Card>

        {/* Section B: Preferences / Appearance */}
        <Card
          id="profile-section-appearance"
          className="scroll-mt-24 rounded-xl border border-ghost bg-surface shadow-none tweaks"
        >
          <CardHeader>
            <CardTitle>{t('profile.preferences')}</CardTitle>
            <CardDescription>{t('profile.preferencesDescription')}</CardDescription>
          </CardHeader>
            <CardContent className="space-y-6">
              <div className="tweaks-body space-y-4">
              <div className="space-y-2">
                <span className="text-sm font-medium text-foreground" id="profile-theme-label">
                  {t('profile.theme')}
                </span>
                <SegmentedControl
                  value={formData.theme}
                  onValueChange={(v) => v && setFormData((prev) => ({ ...prev, theme: v }))}
                  className="flex-wrap"
                  aria-labelledby="profile-theme-label"
                >
                  <SegmentedControlItem value="auto">{t('profile.themeAuto')}</SegmentedControlItem>
                  <SegmentedControlItem value="light">{t('profile.themeLight')}</SegmentedControlItem>
                  <SegmentedControlItem value="dark">{t('profile.themeDark')}</SegmentedControlItem>
                </SegmentedControl>
              </div>

              <div className="space-y-2">
                <p className="text-sm font-medium text-foreground">{t('profile.accentColor')}</p>
                <div className="swatches flex flex-wrap gap-2">
                  {ACCENT_PRESETS.map((hex) => (
                    <button
                      key={hex}
                      type="button"
                      className="swatch h-7 w-7 rounded-full border-2 border-[var(--border)] shadow-[var(--shadow-sm)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)]"
                      style={{ background: hex }}
                      onClick={() => applyAccent(hex)}
                      aria-label={hex}
                    />
                  ))}
                </div>
              </div>

              <div className="space-y-2">
                <span className="text-sm font-medium text-foreground" id="profile-bm-view-label">
                  {t('profile.defaultBookmarkView')}
                </span>
                <SegmentedControl
                  value={bookmarksView}
                  onValueChange={(v) => v && setBookmarksView(v as 'cards' | 'table')}
                  className="flex-wrap"
                  aria-labelledby="profile-bm-view-label"
                >
                  <SegmentedControlItem value="cards">{t('bookmarks.viewCard')}</SegmentedControlItem>
                  <SegmentedControlItem value="table">{t('bookmarks.viewList')}</SegmentedControlItem>
                </SegmentedControl>
              </div>

              {showAiSuggestionsPreference && (
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
              </div>
            </CardContent>
            <CardFooter className="flex flex-row items-center justify-between gap-4">
              <span className="text-xs text-muted-foreground">
                {preferencesDirty ? t('profile.unsavedChanges') : null}
              </span>
              <Button
                type="submit"
                variant="primary"
                disabled={saving || !preferencesDirty}
                aria-label={t('common.save')}
                className="border-0 bg-primary-gradient text-primary-foreground shadow-glow hover:opacity-90"
              >
                {saving ? t('common.loading') : t('common.save')}
              </Button>
            </CardFooter>
        </Card>
        </form>

        {/* MFA (password / hybrid); pure OIDC sees SSO note instead */}
        {showOidcMfaManagedNote || showSlugbaseMfaCard ? (
        <section id="profile-section-security" className="scroll-mt-24 space-y-6">
        {showOidcMfaManagedNote ? (
          <Card
            className="rounded-xl border border-ghost bg-surface shadow-none"
            aria-labelledby="mfa-sso-note-title"
          >
            <CardHeader>
              <CardTitle id="mfa-sso-note-title" className="flex items-center gap-2">
                <Shield className="h-4 w-4 text-primary" aria-hidden />
                {t('mfa.profileSectionTitle')}
              </CardTitle>
              <CardDescription>{t('mfa.oidcManagedByIdp')}</CardDescription>
            </CardHeader>
          </Card>
        ) : null}
        {showSlugbaseMfaCard ? (
          <Card className="rounded-xl border border-ghost bg-surface shadow-none" aria-labelledby="mfa-section-title">
            <CardHeader>
              <CardTitle id="mfa-section-title" className="flex items-center gap-2">
                <Shield className="h-4 w-4 text-primary" aria-hidden />
                {t('mfa.profileSectionTitle')}
              </CardTitle>
              <CardDescription>{t('mfa.profileSectionDescription')}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {user.mfa_enabled ? (
                <>
                  <p className="text-sm text-foreground">{t('mfa.enabledStatus')}</p>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="text-destructive hover:text-destructive hover:bg-destructive/10"
                      onClick={() => {
                        resetDisableDialog();
                        setDisableDlgOpen(true);
                      }}
                      aria-label={t('mfa.disable')}
                    >
                      {t('mfa.disable')}
                    </Button>
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      onClick={() => {
                        resetRegenDialog();
                        setRegenDlgOpen(true);
                      }}
                      aria-label={t('mfa.regenerateBackupCodes')}
                    >
                      {t('mfa.regenerateBackupCodes')}
                    </Button>
                  </div>
                </>
              ) : mfaWizard === 'idle' ? (
                <div className="space-y-2">
                  <Button
                    type="button"
                    variant="primary"
                    size="sm"
                    disabled={mfaBusy}
                    onClick={handleMfaBegin}
                    className="border-0 bg-primary-gradient text-primary-foreground shadow-glow hover:opacity-90"
                    aria-label={t('mfa.startSetup')}
                  >
                    {mfaBusy ? t('common.loading') : t('mfa.startSetup')}
                  </Button>
                  {mfaError ? (
                    <p className="text-sm text-destructive" role="alert" aria-live="assertive">
                      {mfaError}
                    </p>
                  ) : null}
                </div>
              ) : null}
            </CardContent>
          </Card>
        ) : null}
        </section>
        ) : null}

        {/* Section C: Developer / API Access */}
        <Card
          id="profile-section-tokens"
          className="scroll-mt-24 rounded-xl border border-ghost bg-surface shadow-none"
          aria-labelledby="developer-section-title"
        >
          <CardHeader>
            <div className="flex flex-wrap items-center gap-2">
              <CardTitle id="developer-section-title" className="flex items-center gap-2">
                <Key className="h-4 w-4 text-primary" />
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
            <div className="space-y-2">
              <a
                href={getDocsApiReferenceUrl()}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm font-medium text-primary hover:text-primary/90 inline-block"
              >
                {t('profile.viewApiDocs')} →
              </a>
              <p className="text-xs text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-1">
                <span>{t('profile.apiDocsShortcuts')}</span>
                <a
                  href={getDocsApiReferenceOperationUrl(DOCS_API_OPERATIONS.csrfToken)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-medium text-primary hover:text-primary/90 underline-offset-2 hover:underline"
                >
                  {t('profile.apiDocsCsrfEndpoint')}
                </a>
                <span className="text-muted-foreground/70" aria-hidden>
                  ·
                </span>
                <a
                  href={getDocsApiReferenceOperationUrl(DOCS_API_OPERATIONS.listTokens)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-medium text-primary hover:text-primary/90 underline-offset-2 hover:underline"
                >
                  {t('profile.apiDocsTokensEndpoint')}
                </a>
              </p>
            </div>
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

        <Card
          id="profile-section-integrations"
          className="scroll-mt-24 rounded-xl border border-ghost bg-surface shadow-none"
        >
          <CardHeader>
            <CardTitle>{t('profile.sectionIntegrations')}</CardTitle>
            <CardDescription>{t('profile.integrationsDescription')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm text-[var(--fg-1)]">
            <p>
              {user.oidc_provider
                ? t('profile.integrationOidc', { provider: user.oidc_provider })
                : t('profile.integrationsPassword')}
            </p>
          </CardContent>
        </Card>

        <div id="profile-section-data" className="scroll-mt-24 space-y-6">
          <Card className="rounded-xl border border-ghost bg-surface shadow-none">
            <CardHeader>
              <CardTitle>{t('profile.dataImportExport')}</CardTitle>
              <CardDescription>{t('profile.dataImportExportDescription')}</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                icon={Upload}
                onClick={() => setImportModalOpen(true)}
              >
                {t('bookmarks.import')}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                icon={Download}
                onClick={handleExportBookmarks}
              >
                {t('bookmarks.export')}
              </Button>
            </CardContent>
          </Card>

          <Card className="rounded-xl border border-destructive/40 bg-surface-low shadow-none">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-destructive">
                <AlertTriangle className="h-4 w-4" />
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
      </div>
      </div>

      <ImportModal isOpen={importModalOpen} onClose={() => setImportModalOpen(false)} onSuccess={() => setImportModalOpen(false)} />

      <Dialog
        open={disableDlgOpen}
        onOpenChange={(open) => {
          if (!open) {
            setDisableDlgOpen(false);
            resetDisableDialog();
          }
        }}
      >
        <DialogContent className="rounded-2xl border border-ghost bg-surface-high sm:max-w-md">
          <form onSubmit={handleDisableSubmit} className="space-y-4">
            <DialogHeader>
              <DialogTitle>{t('mfa.disableTitle')}</DialogTitle>
              <DialogDescription>{t('mfa.disableDescription')}</DialogDescription>
            </DialogHeader>
            <div className="space-y-2">
              <Label htmlFor={`${mfaIds}-d-code`}>{t('mfa.trustCodeLabel')}</Label>
              <Input
                id={`${mfaIds}-d-code`}
                name="mfa-disable-code"
                value={disableCode}
                onChange={(e) => setDisableCode(e.target.value)}
                autoComplete="one-time-code"
                disabled={disableBusy}
                aria-describedby={`${mfaIds}-d-hint`}
              />
              <p id={`${mfaIds}-d-hint`} className="text-xs text-muted-foreground">
                {t('mfa.trustCodeHint')}
              </p>
            </div>
            {disableNeedsPassword ? (
              <div className="space-y-2">
                <Label htmlFor={`${mfaIds}-d-pw`}>{t('auth.password')}</Label>
                <Input
                  id={`${mfaIds}-d-pw`}
                  name="mfa-disable-password"
                  type="password"
                  value={disablePassword}
                  onChange={(e) => setDisablePassword(e.target.value)}
                  autoComplete="current-password"
                  disabled={disableBusy}
                />
              </div>
            ) : null}
            {disableError ? (
              <p className="text-sm text-destructive" role="alert" aria-live="assertive">
                {disableError}
              </p>
            ) : null}
            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setDisableDlgOpen(false);
                  resetDisableDialog();
                }}
              >
                {t('common.cancel')}
              </Button>
              <Button
                type="submit"
                variant="primary"
                disabled={disableBusy}
                className="bg-destructive text-destructive-foreground hover:opacity-90"
              >
                {disableBusy ? t('common.loading') : t('mfa.disableConfirm')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog
        open={regenDlgOpen}
        onOpenChange={(open) => {
          if (!open) {
            setRegenDlgOpen(false);
            resetRegenDialog();
          }
        }}
      >
        <DialogContent className="rounded-2xl border border-ghost bg-surface-high sm:max-w-md">
          {regenStep === 'form' ? (
            <form onSubmit={handleRegenSubmit} className="space-y-4">
              <DialogHeader>
                <DialogTitle>{t('mfa.regenerateTitle')}</DialogTitle>
                <DialogDescription>{t('mfa.regenerateDescription')}</DialogDescription>
              </DialogHeader>
              <div className="space-y-2">
                <Label htmlFor={`${mfaIds}-r-code`}>{t('mfa.trustCodeLabel')}</Label>
                <Input
                  id={`${mfaIds}-r-code`}
                  name="mfa-regen-code"
                  value={regenCode}
                  onChange={(e) => setRegenCode(e.target.value)}
                  autoComplete="one-time-code"
                  disabled={regenBusy}
                  aria-describedby={`${mfaIds}-r-hint`}
                />
                <p id={`${mfaIds}-r-hint`} className="text-xs text-muted-foreground">
                  {t('mfa.trustCodeHint')}
                </p>
              </div>
              {regenNeedsPassword ? (
                <div className="space-y-2">
                  <Label htmlFor={`${mfaIds}-r-pw`}>{t('auth.password')}</Label>
                  <Input
                    id={`${mfaIds}-r-pw`}
                    name="mfa-regen-password"
                    type="password"
                    value={regenPassword}
                    onChange={(e) => setRegenPassword(e.target.value)}
                    autoComplete="current-password"
                    disabled={regenBusy}
                  />
                </div>
              ) : null}
              {regenError ? (
                <p className="text-sm text-destructive" role="alert" aria-live="assertive">
                  {regenError}
                </p>
              ) : null}
              <DialogFooter>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => {
                    setRegenDlgOpen(false);
                    resetRegenDialog();
                  }}
                >
                  {t('common.cancel')}
                </Button>
                <Button
                  type="submit"
                  variant="primary"
                  disabled={regenBusy}
                  className="border-0 bg-primary-gradient text-primary-foreground shadow-glow hover:opacity-90"
                >
                  {regenBusy ? t('common.loading') : t('mfa.regenerateSubmit')}
                </Button>
              </DialogFooter>
            </form>
          ) : regenCodes ? (
            <div className="space-y-4">
              <DialogHeader>
                <DialogTitle>{t('mfa.newBackupCodesTitle')}</DialogTitle>
                <DialogDescription>{t('mfa.backupCodesWarning')}</DialogDescription>
              </DialogHeader>
              <ul className="grid max-h-48 gap-1 overflow-auto rounded-lg border border-ghost bg-surface-low p-3 font-mono text-sm" role="list">
                {regenCodes.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
              <Button type="button" variant="secondary" size="sm" onClick={() => copyBackupCodes(regenCodes)}>
                {t('mfa.copyAllBackupCodes')}
              </Button>
              <div className="flex items-start gap-2">
                <input
                  id={`${mfaIds}-rack`}
                  type="checkbox"
                  checked={regenAck}
                  onChange={(e) => setRegenAck(e.target.checked)}
                  className="mt-1 h-4 w-4 rounded border-ghost"
                />
                <Label htmlFor={`${mfaIds}-rack`} className="text-sm font-normal leading-snug cursor-pointer">
                  {t('mfa.backupCodesAck')}
                </Label>
              </div>
              <DialogFooter>
                <Button
                  type="button"
                  variant="primary"
                  disabled={!regenAck}
                  className="border-0 bg-primary-gradient text-primary-foreground shadow-glow hover:opacity-90"
                  onClick={() => {
                    setRegenDlgOpen(false);
                    resetRegenDialog();
                    showToast(t('mfa.regenerateSuccess'), 'success');
                  }}
                >
                  {t('common.close')}
                </Button>
              </DialogFooter>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>

      {mfaOtpauthUrl && mfaSecretB32 ? (
        <MfaEnrollSetupModal
          open={mfaWizard === 'enrolling'}
          otpauthUrl={mfaOtpauthUrl}
          secretB32={mfaSecretB32}
          confirmCode={mfaConfirmCode}
          onConfirmCodeChange={setMfaConfirmCode}
          error={mfaError}
          busy={mfaBusy}
          onSubmit={handleMfaConfirmEnroll}
          onCancelSetup={handleMfaCancelSetup}
        />
      ) : null}

      {mfaBackupCodes ? (
        <MfaEnrollBackupCodesModal
          open={mfaWizard === 'backup_view'}
          codes={mfaBackupCodes}
          ack={mfaBackupAck}
          onAckChange={setMfaBackupAck}
          busy={mfaBusy}
          onContinue={handleMfaBackupDone}
        />
      ) : null}

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
