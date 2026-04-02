import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Settings } from 'lucide-react';
import { SidebarTrigger, useSidebar } from './ui/sidebar';
import UserDropdown from './UserDropdown';
import { Breadcrumbs } from './Breadcrumbs';
import { useAppConfig } from '../contexts/AppConfigContext';
import type { User } from '../contexts/AuthContext';
import { canAccessWorkspaceAdmin } from '../utils/adminAccess';
import { usePlan, usePlanLoadState, getFirstAdminRedirectPath } from '../contexts/PlanContext';

interface TopBarProps {
  user: User | null;
}

export default function TopBar({ user }: TopBarProps) {
  const { t } = useTranslation();
  const { pathPrefixForLinks, hideAdminOidcAndSmtp, extraAdminNavItems } = useAppConfig();
  const planInfo = usePlan();
  const planLoadState = usePlanLoadState();
  const prefix = (pathPrefixForLinks || '').replace(/\/+/g, '/') || '';
  const { isMobile } = useSidebar();
  const showAdmin = canAccessWorkspaceAdmin(user);

  const settingsHref = (() => {
    const profile = `${prefix}/profile`.replace(/\/+/g, '/') || '/profile';
    if (!showAdmin) return profile;
    if (!hideAdminOidcAndSmtp) {
      return `${prefix}/admin/settings`.replace(/\/+/g, '/') || '/admin/settings';
    }
    const segment = getFirstAdminRedirectPath(planInfo, planLoadState, {
      hideAdminOidcAndSmtp: true,
      extraAdminNavItems,
    });
    return `${prefix}/admin/${segment}`.replace(/\/+/g, '/') || `/admin/${segment}`;
  })();

  const cloudAdminSegment =
    showAdmin && hideAdminOidcAndSmtp
      ? getFirstAdminRedirectPath(planInfo, planLoadState, {
          hideAdminOidcAndSmtp: true,
          extraAdminNavItems,
        })
      : null;

  const settingsAriaLabel =
    showAdmin && !hideAdminOidcAndSmtp
      ? t('admin.settings')
      : showAdmin && cloudAdminSegment === 'billing'
        ? t('admin.billing')
        : showAdmin && cloudAdminSegment === 'ai'
          ? t('admin.ai.nav')
          : showAdmin && cloudAdminSegment === 'members'
            ? t('admin.users')
            : showAdmin
              ? t('admin.billing')
              : t('profile.title');

  return (
    <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-4 border-b border-ghost bg-background/80 px-4 backdrop-blur-xl supports-[backdrop-filter]:bg-background/65 lg:h-16 lg:px-8">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        {isMobile && (
          <SidebarTrigger className="-ml-1 shrink-0" aria-label={t('common.expandSidebar')} />
        )}
        <Breadcrumbs />
      </div>
      <div className="flex shrink-0 items-center gap-1 sm:gap-2">
        <Link
          to={settingsHref}
          className="flex h-9 w-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-surface-low hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={settingsAriaLabel}
        >
          <Settings className="h-5 w-5" />
        </Link>
        <UserDropdown user={user} />
      </div>
    </header>
  );
}
