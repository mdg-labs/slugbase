import React, { useState, useEffect } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  Bookmark,
  Folder,
  Tag,
  Settings,
  LayoutDashboard,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  Github,
  Users,
  UserCog,
  Key,
  Sparkles,
  CreditCard,
  Shield,
  ScrollText,
  Search,
  Settings2,
} from 'lucide-react';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarSeparator,
  useSidebar,
} from './ui/sidebar';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip-base';
import { useAppConfig } from '../contexts/AppConfigContext';
import { useSearchCommand } from '../contexts/SearchCommandContext';
import {
  usePlan,
  usePlanLoadState,
  showAdminAiNav,
  showAdminMembersNav,
  showAdminTeamsNav,
  showAdminAuditLogNav,
} from '../contexts/PlanContext';
import type { User } from '../contexts/AuthContext';
import { cn } from '../lib/utils';
import { canAccessWorkspaceAdmin } from '../utils/adminAccess';

const SIDEBAR_ADMIN_OPEN_KEY = 'slugbase_sidebar_admin_open';

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }
  return name.slice(0, 2).toUpperCase();
}

interface AppSidebarProps {
  user: User | null;
  version?: string | null;
}

export default function AppSidebar({ user, version = null }: AppSidebarProps) {
  const { t } = useTranslation();
  const location = useLocation();
  const pathname = location.pathname;
  const { appBasePath, pathPrefixForLinks, hideAdminOidcAndSmtp, extraAdminNavItems } = useAppConfig();
  const planInfo = usePlan();
  const planLoadState = usePlanLoadState();
  const { setOpenMobile, toggleSidebar, isMobile, state } = useSidebar();
  const { openSearch } = useSearchCommand();
  const prefix = pathPrefixForLinks || '';
  const pathBaseForActive = pathPrefixForLinks ?? appBasePath ?? '';
  const adminBaseFull = `${pathBaseForActive}/admin`.replace(/\/+/g, '/') || '/admin';
  const adminBaseLink = `${prefix}/admin`.replace(/\/+/g, '/') || '/admin';

  const showMembers = showAdminMembersNav(planInfo, planLoadState);
  const showTeams = showAdminTeamsNav(planInfo, planLoadState);
  const showAuditLog = showAdminAuditLogNav(planInfo, planLoadState);
  const showAdminAi = showAdminAiNav(planInfo);

  const adminNavItems = [
    ...(showMembers
      ? [{ pathForLink: `${adminBaseLink}/members`, pathForActive: `${adminBaseFull}/members`, label: t('admin.users'), icon: Users }]
      : []),
    ...(showTeams
      ? [{ pathForLink: `${adminBaseLink}/teams`, pathForActive: `${adminBaseFull}/teams`, label: t('admin.teams'), icon: UserCog }]
      : []),
    ...(showAuditLog
      ? [
          {
            pathForLink: `${adminBaseLink}/audit-log`,
            pathForActive: `${adminBaseFull}/audit-log`,
            label: t('admin.auditLog.nav'),
            icon: ScrollText,
          },
        ]
      : []),
    ...(!hideAdminOidcAndSmtp
      ? [
          { pathForLink: `${adminBaseLink}/oidc`, pathForActive: `${adminBaseFull}/oidc`, label: t('admin.oidcProviders'), icon: Key },
          { pathForLink: `${adminBaseLink}/settings`, pathForActive: `${adminBaseFull}/settings`, label: t('admin.settings'), icon: Settings },
        ]
      : []),
    ...(showAdminAi
      ? [{ pathForLink: `${adminBaseLink}/ai`, pathForActive: `${adminBaseFull}/ai`, label: t('admin.ai.nav'), icon: Sparkles }]
      : []),
    ...(extraAdminNavItems ?? []).map(({ path, label }) => ({
      pathForLink: `${adminBaseLink}/${path}`.replace(/\/+/g, '/'),
      pathForActive: `${adminBaseFull}/${path}`.replace(/\/+/g, '/'),
      label,
      icon: CreditCard,
    })),
  ];

  const rootActivePath = pathBaseForActive || '/';
  const isOverviewActive =
    pathname === rootActivePath ||
    pathname === `${rootActivePath}/` ||
    pathname === (pathBaseForActive || '/');

  const showAdmin = canAccessWorkspaceAdmin(user);
  const [adminOpen, setAdminOpen] = useState(() => {
    if (typeof window === 'undefined') return true;
    const stored = localStorage.getItem(SIDEBAR_ADMIN_OPEN_KEY);
    return stored !== 'false';
  });

  useEffect(() => {
    localStorage.setItem(SIDEBAR_ADMIN_OPEN_KEY, String(adminOpen));
  }, [adminOpen]);

  const rootLink = prefix || '/';
  const rootActive = rootActivePath;
  const primaryNavItems = [
    { pathForLink: rootLink, pathForActive: rootActive, label: t('dashboard.overview'), icon: LayoutDashboard },
    { pathForLink: `${prefix}/bookmarks`.replace(/\/+/g, '/') || '/bookmarks', pathForActive: `${pathBaseForActive}/bookmarks`.replace(/\/+/g, '/') || '/bookmarks', label: t('bookmarks.title'), icon: Bookmark },
    { pathForLink: `${prefix}/folders`.replace(/\/+/g, '/') || '/folders', pathForActive: `${pathBaseForActive}/folders`.replace(/\/+/g, '/') || '/folders', label: t('folders.title'), icon: Folder },
    { pathForLink: `${prefix}/tags`.replace(/\/+/g, '/') || '/tags', pathForActive: `${pathBaseForActive}/tags`.replace(/\/+/g, '/') || '/tags', label: t('tags.title'), icon: Tag },
  ];

  const profileLink = `${prefix}/profile`.replace(/\/+/g, '/') || '/profile';

  const handleNavClick = () => {
    if (isMobile) {
      setOpenMobile(false);
    }
  };

  const isAdminPathActive = pathname === adminBaseFull || pathname.startsWith(`${adminBaseFull}/`);

  const itemClass = cn(
    'relative gap-2.5 rounded-md border-l-2 border-transparent px-2 py-1.5 text-[13px] text-fg-1',
    'hover:bg-bg-hover hover:text-fg-0',
    'data-[active=true]:border-transparent data-[active=true]:bg-accent-bg data-[active=true]:font-medium data-[active=true]:text-fg-0',
    'data-[active=true]:[&>svg]:text-accent-hi',
    'before:pointer-events-none before:absolute before:left-[-8px] before:top-2 before:bottom-2 before:w-0.5 before:rounded-sm before:bg-accent before:opacity-0 data-[active=true]:before:opacity-100',
    '[&>svg]:size-4 [&>svg]:shrink-0 [&>svg]:text-fg-2'
  );

  const brandInner = (
    <Link
      to={rootLink}
      onClick={handleNavClick}
      className={cn(
        'sb-brand flex items-center gap-2.5 border-b border-border-soft px-3.5 pb-2.5 pt-3.5 outline-none ring-sidebar-ring transition-colors hover:bg-bg-hover/40 focus-visible:ring-2',
        'group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-2 group-data-[collapsible=icon]:py-3'
      )}
    >
      <div className="grid h-8 w-8 shrink-0 place-items-center overflow-hidden rounded-lg border border-accent-ring bg-accent-bg">
        <img src="/slugbase_icon_purple.svg" alt="" className="h-6 w-6 object-contain" width={24} height={24} aria-hidden />
      </div>
      <div className="min-w-0 flex-1 group-data-[collapsible=icon]:sr-only">
        <div className="text-sm font-semibold tracking-tight text-fg-0">SlugBase</div>
        {version ? (
          <div className="mt-0.5 inline-block max-w-full truncate font-mono text-[10.5px] text-fg-2">{version}</div>
        ) : null}
      </div>
    </Link>
  );

  return (
    <React.Fragment>
      <Sidebar collapsible="icon" side="left">
        <SidebarHeader className="border-0 p-0">
          {!isMobile && state === 'collapsed' ? (
            <Tooltip>
              <TooltipTrigger asChild>{brandInner}</TooltipTrigger>
              <TooltipContent side="right" align="center">
                SlugBase
              </TooltipContent>
            </Tooltip>
          ) : (
            brandInner
          )}
          <button
            type="button"
            onClick={() => openSearch()}
            className={cn(
              'sb-search mx-2.5 mt-2 flex items-center gap-2 rounded-sm border border-border bg-bg-2 px-2 py-1.5 text-left text-xs text-fg-2 transition-colors hover:border-border-strong',
              'group-data-[collapsible=icon]:mx-auto group-data-[collapsible=icon]:h-9 group-data-[collapsible=icon]:w-9 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:p-0'
            )}
            aria-label={t('dashboard.searchPlaceholder')}
          >
            <Search className="h-3.5 w-3.5 shrink-0" strokeWidth={1.75} />
            <span className="min-w-0 flex-1 truncate group-data-[collapsible=icon]:sr-only">{t('dashboard.searchPlaceholder')}</span>
            <span className="ml-auto inline-flex gap-0.5 rounded border border-border bg-bg-3 px-1.5 py-0.5 font-mono text-[10.5px] leading-snug text-fg-2 group-data-[collapsible=icon]:sr-only">
              ⌘K
            </span>
          </button>
        </SidebarHeader>

        <SidebarContent className="gap-0">
          <SidebarGroup className="px-0 py-1">
            <SidebarGroupContent>
              <SidebarMenu className="gap-px px-2">
                {primaryNavItems.map((item) => (
                  <SidebarMenuItem key={item.pathForLink}>
                    <SidebarMenuButton
                      asChild
                      isActive={
                        item.pathForActive === rootActivePath ? isOverviewActive : pathname === item.pathForActive
                      }
                      tooltip={item.label}
                      className={itemClass}
                    >
                      <Link
                        to={item.pathForLink}
                        onClick={handleNavClick}
                        aria-current={pathname === item.pathForActive ? 'page' : undefined}
                      >
                        <item.icon className="shrink-0" strokeWidth={1.75} />
                        <span>{item.label}</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>

          {showAdmin && !isMobile && state === 'collapsed' && (
            <SidebarGroup className="px-0 py-1">
              <SidebarGroupContent>
                <SidebarMenu className="gap-px px-2">
                  <SidebarMenuItem>
                    <SidebarMenuButton
                      asChild
                      isActive={isAdminPathActive}
                      tooltip={t('admin.title')}
                      className={itemClass}
                    >
                      <Link to={adminBaseLink} onClick={handleNavClick} aria-current={isAdminPathActive ? 'page' : undefined}>
                        <Shield className="shrink-0" strokeWidth={1.75} />
                        <span>{t('admin.title')}</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          )}

          {showAdmin && (isMobile || state === 'expanded') && (
            <>
              <SidebarSeparator className="bg-border-soft" />
              <SidebarGroup className="px-0 py-1">
                <button
                  type="button"
                  onClick={() => setAdminOpen((prev) => !prev)}
                  data-sidebar="group-label"
                  className={cn(
                    'sb-section flex h-8 w-full shrink-0 items-center justify-between overflow-hidden px-2.5 pb-1 pt-3 font-mono text-[10px] font-normal uppercase tracking-[0.08em] text-fg-3 outline-none ring-sidebar-ring transition-[margin,opacity] duration-200 ease-linear focus-visible:ring-2',
                    'hover:text-fg-2'
                  )}
                  aria-expanded={adminOpen}
                >
                  <span className="flex items-center gap-1.5 truncate">
                    {adminOpen ? <ChevronDown className="h-4 w-4 shrink-0" strokeWidth={1.75} /> : <ChevronRight className="h-4 w-4 shrink-0" strokeWidth={1.75} />}
                    {t('admin.title')}
                  </span>
                </button>
                {adminOpen && (
                  <SidebarGroupContent>
                    <SidebarMenu className="gap-px px-2">
                      {adminNavItems.map((item) => {
                        const Icon = item.icon;
                        return (
                          <SidebarMenuItem key={item.pathForLink}>
                            <SidebarMenuButton
                              asChild
                              isActive={pathname === item.pathForActive}
                              tooltip={item.label}
                              className={itemClass}
                            >
                              <Link
                                to={item.pathForLink}
                                onClick={handleNavClick}
                                aria-current={pathname === item.pathForActive ? 'page' : undefined}
                              >
                                <Icon className="shrink-0" strokeWidth={1.75} />
                                <span>{item.label}</span>
                              </Link>
                            </SidebarMenuButton>
                          </SidebarMenuItem>
                        );
                      })}
                    </SidebarMenu>
                  </SidebarGroupContent>
                )}
              </SidebarGroup>
            </>
          )}
        </SidebarContent>

        <SidebarFooter className="mt-auto gap-0 border-t border-border-soft p-0 pt-1">
          {user && (
            <div
              className={cn(
                'sb-foot flex items-center gap-2.5 px-2.5 py-2.5',
                'group-data-[collapsible=icon]:flex-col group-data-[collapsible=icon]:gap-1'
              )}
            >
              <div className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-accent-bg text-[11px] font-semibold text-accent-hi">
                {user.name ? getInitials(user.name) : '•'}
              </div>
              <div className="min-w-0 flex-1 group-data-[collapsible=icon]:hidden">
                <div className="truncate text-[12.5px] font-medium text-fg-0">{user.name || '—'}</div>
                <div className="truncate text-[11px] text-fg-3">{user.email}</div>
              </div>
              <Link
                to={profileLink}
                onClick={handleNavClick}
                className="rounded p-1 text-fg-3 transition-colors hover:bg-bg-3 hover:text-fg-0 group-data-[collapsible=icon]:p-0"
                aria-label={t('profile.title')}
              >
                <Settings2 className="h-[15px] w-[15px]" strokeWidth={1.75} />
              </Link>
            </div>
          )}
          <SidebarGroup className="p-0">
            <SidebarGroupContent>
              <SidebarMenu className="gap-px px-2 pb-2">
                <SidebarMenuItem>
                  <SidebarMenuButton asChild tooltip="GitHub Repository" className={itemClass}>
                    <a
                      href="https://github.com/mdg-labs/slugbase"
                      target="_blank"
                      rel="noopener noreferrer"
                      aria-label="GitHub Repository"
                    >
                      <Github className="h-4 w-4 shrink-0" strokeWidth={1.75} />
                      <span>GitHub</span>
                    </a>
                  </SidebarMenuButton>
                </SidebarMenuItem>
                {!isMobile && (
                  <SidebarMenuItem>
                    <SidebarMenuButton
                      onClick={toggleSidebar}
                      tooltip={state === 'collapsed' ? t('common.expandSidebar') : t('common.collapseSidebar')}
                      aria-label={state === 'collapsed' ? t('common.expandSidebar') : t('common.collapseSidebar')}
                      className={itemClass}
                    >
                      {state === 'collapsed' ? <ChevronRight className="h-4 w-4 shrink-0" strokeWidth={1.75} /> : <ChevronLeft className="h-4 w-4 shrink-0" strokeWidth={1.75} />}
                      <span>{t('common.collapseSidebar')}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                )}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarFooter>
      </Sidebar>
    </React.Fragment>
  );
}
