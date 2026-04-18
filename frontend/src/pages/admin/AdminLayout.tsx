import { useTranslation } from 'react-i18next';
import { NavLink, Outlet } from 'react-router-dom';
import {
  CreditCard,
  Key,
  ScrollText,
  Settings,
  Sparkles,
  UserCog,
  Users,
  ExternalLink,
} from 'lucide-react';
import { DOCS_API_OPERATIONS, getDocsApiReferenceOperationUrl, getDocsApiReferenceUrl } from '../../config/docs';
import { useAppConfig } from '../../contexts/AppConfigContext';
import {
  showAdminAiNav,
  showAdminAuditLogNav,
  showAdminMembersNav,
  showAdminTeamsNav,
  usePlan,
  usePlanLoadState,
} from '../../contexts/PlanContext';
import { cn } from '@/lib/utils';

export default function AdminLayout() {
  const { t } = useTranslation();
  const { pathPrefixForLinks, hideAdminOidcAndSmtp, extraAdminNavItems } = useAppConfig();
  const prefix = (pathPrefixForLinks || '').replace(/\/+/g, '/') || '';
  const planInfo = usePlan();
  const planLoadState = usePlanLoadState();
  const adminBase = `${prefix}/admin`.replace(/\/+/g, '/') || '/admin';

  const showMembers = showAdminMembersNav(planInfo, planLoadState);
  const showTeams = showAdminTeamsNav(planInfo, planLoadState);
  const showAuditLog = showAdminAuditLogNav(planInfo, planLoadState);
  const showAi = showAdminAiNav(planInfo);

  const items: { to: string; label: string; icon: typeof Users }[] = [
    ...(showMembers ? [{ to: `${adminBase}/members`, label: t('admin.users'), icon: Users }] : []),
    ...(showTeams ? [{ to: `${adminBase}/teams`, label: t('admin.teams'), icon: UserCog }] : []),
    ...(showAuditLog ? [{ to: `${adminBase}/audit-log`, label: t('admin.auditLog.nav'), icon: ScrollText }] : []),
    ...(!hideAdminOidcAndSmtp
      ? [
          { to: `${adminBase}/oidc`, label: t('admin.oidcProviders'), icon: Key },
          { to: `${adminBase}/settings`, label: t('admin.settings'), icon: Settings },
        ]
      : []),
    ...(showAi ? [{ to: `${adminBase}/ai`, label: t('admin.ai.nav'), icon: Sparkles }] : []),
    ...(extraAdminNavItems ?? []).map(({ path, label }) => ({
      to: `${adminBase}/${path}`.replace(/\/+/g, '/'),
      label,
      icon: CreditCard,
    })),
  ];

  const navLinkClass = ({ isActive }: { isActive: boolean }) =>
    cn(
      'sb-item flex items-center gap-2.5 rounded-[var(--radius)] border border-transparent px-2.5 py-2 text-[13px] text-[var(--fg-1)] transition-colors',
      'hover:border-[var(--border)] hover:bg-[var(--bg-hover)] hover:text-[var(--fg-0)]',
      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-ring)]',
      isActive && 'border-[var(--border)] bg-[var(--accent-bg)] font-medium text-[var(--fg-0)]',
    );

  return (
    <div className="space-y-8 pb-8">
      <div className="flex flex-col gap-8 lg:flex-row lg:items-start">
        <nav
          className="settings-nav shrink-0 lg:w-52"
          aria-label={t('admin.title')}
        >
          <ul className="space-y-0.5">
            {items.map(({ to, label, icon: Icon }) => (
              <li key={to}>
                <NavLink to={to} className={navLinkClass} end={to === adminBase}>
                  <Icon className="h-4 w-4 shrink-0 opacity-80" aria-hidden />
                  <span className="truncate">{label}</span>
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>

        <div className="min-w-0 flex-1">
          <Outlet />
        </div>
      </div>

      <div className="border-t border-[var(--border-soft)] pt-4">
        <p className="text-[12px] leading-relaxed text-[var(--fg-3)]">{t('admin.apiDocsNote')}</p>
        <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-[var(--fg-3)]">
          <span>{t('admin.apiDocsShortcuts')}</span>
          <a
            href={getDocsApiReferenceOperationUrl(DOCS_API_OPERATIONS.csrfToken)}
            target="_blank"
            rel="noopener noreferrer"
            className="font-mono text-[11px] text-[var(--fg-2)] underline-offset-2 hover:text-[var(--accent-hi)] hover:underline"
          >
            {t('admin.apiDocsCsrfEndpoint')}
          </a>
          <span aria-hidden className="text-[var(--fg-4)]">
            ·
          </span>
          <a
            href={getDocsApiReferenceOperationUrl(DOCS_API_OPERATIONS.listTokens)}
            target="_blank"
            rel="noopener noreferrer"
            className="font-mono text-[11px] text-[var(--fg-2)] underline-offset-2 hover:text-[var(--accent-hi)] hover:underline"
          >
            {t('admin.apiDocsTokensEndpoint')}
          </a>
        </p>
        <a
          href={getDocsApiReferenceUrl()}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-3 inline-flex items-center gap-1.5 text-[12px] text-[var(--fg-3)] underline-offset-2 hover:text-[var(--fg-1)] hover:underline"
        >
          <ExternalLink className="h-3.5 w-3.5 shrink-0 opacity-70" aria-hidden />
          {t('admin.viewApiDocs')}
        </a>
      </div>
    </div>
  );
}
