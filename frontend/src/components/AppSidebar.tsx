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
import { usePlan } from '../contexts/PlanContext';
import type { User } from '../contexts/AuthContext';
import { cn } from '../lib/utils';

const SIDEBAR_ADMIN_OPEN_KEY = 'slugbase_sidebar_admin_open';

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
  const { setOpenMobile, toggleSidebar, isMobile, state } = useSidebar();
  const prefix = pathPrefixForLinks || '';
  const pathBaseForActive = pathPrefixForLinks ?? appBasePath ?? '';
  const adminBaseFull = `${pathBaseForActive}/admin`.replace(/\/+/g, '/') || '/admin';
  const adminBaseLink = `${prefix}/admin`.replace(/\/+/g, '/') || '/admin';

  const showAdminUsersAndTeams = !planInfo || planInfo.canShareWithTeams;
  const showAdminAi = !planInfo || planInfo.aiAvailable;

  const adminNavItems = [
    ...(showAdminUsersAndTeams
      ? [
          { pathForLink: `${adminBaseLink}/members`, pathForActive: `${adminBaseFull}/members`, label: t('admin.users'), icon: Users },
          { pathForLink: `${adminBaseLink}/teams`, pathForActive: `${adminBaseFull}/teams`, label: t('admin.teams'), icon: UserCog },
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

  const showAdmin = !!(user?.is_admin);
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

  const handleNavClick = () => {
    if (isMobile) {
      setOpenMobile(false);
    }
  };

  const isAdminPathActive = pathname === adminBaseFull || pathname.startsWith(`${adminBaseFull}/`);

  const navItemClass =
    'rounded-xl py-2.5 pl-2 gap-3 text-muted-foreground hover:text-foreground data-[active=true]:font-semibold [&>svg]:size-5';

  const brandLink = (
    <Link
      to={rootLink}
      onClick={handleNavClick}
      className={cn(
        'flex items-center gap-3 rounded-xl px-1 py-1 outline-none ring-sidebar-ring transition-colors hover:bg-sidebar-accent/70 focus-visible:ring-2',
        'group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0'
      )}
    >
      <img
        src="/slugbase_icon_purple.svg"
        alt=""
        className="h-9 w-9 shrink-0 object-contain"
        width={36}
        height={36}
        aria-hidden
      />
      <span className="truncate text-xl font-black tracking-tighter text-primary group-data-[collapsible=icon]:sr-only">
        SlugBase
      </span>
    </Link>
  );

  return (
    <React.Fragment>
      <Sidebar collapsible="icon" side="left">
        <SidebarHeader className="border-0 px-3 py-5">
          {!isMobile && state === 'collapsed' ? (
            <Tooltip>
              <TooltipTrigger asChild>{brandLink}</TooltipTrigger>
              <TooltipContent side="right" align="center">
                SlugBase
              </TooltipContent>
            </Tooltip>
          ) : (
            brandLink
          )}
        </SidebarHeader>

        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupContent>
              <SidebarMenu>
                {primaryNavItems.map((item) => (
                  <SidebarMenuItem key={item.pathForLink}>
                    <SidebarMenuButton
                      asChild
                      isActive={
                        item.pathForActive === rootActivePath ? isOverviewActive : pathname === item.pathForActive
                      }
                      tooltip={item.label}
                      className={navItemClass}
                    >
                      <Link
                        to={item.pathForLink}
                        onClick={handleNavClick}
                        aria-current={pathname === item.pathForActive ? 'page' : undefined}
                      >
                        <item.icon className="shrink-0" />
                        <span>{item.label}</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>

          {showAdmin && !isMobile && state === 'collapsed' && (
            <SidebarGroup>
              <SidebarGroupContent>
                <SidebarMenu>
                  <SidebarMenuItem>
                    <SidebarMenuButton
                      asChild
                      isActive={isAdminPathActive}
                      tooltip={t('admin.title')}
                      className={navItemClass}
                    >
                      <Link to={adminBaseLink} onClick={handleNavClick} aria-current={isAdminPathActive ? 'page' : undefined}>
                        <Shield className="shrink-0" />
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
              <SidebarSeparator />
              <SidebarGroup>
                <button
                  type="button"
                  onClick={() => setAdminOpen((prev) => !prev)}
                  data-sidebar="group-label"
                  className={cn(
                    'flex h-8 w-full shrink-0 items-center gap-2 overflow-hidden rounded-md px-2 text-left text-xs font-medium text-sidebar-foreground/70 outline-none ring-sidebar-ring transition-[margin,opacity] duration-200 ease-linear focus-visible:ring-2 [&>svg]:size-4 [&>svg]:shrink-0',
                    'hover:bg-sidebar-accent hover:text-sidebar-accent-foreground'
                  )}
                  aria-expanded={adminOpen}
                >
                  {adminOpen ? <ChevronDown className="h-5 w-5 shrink-0" /> : <ChevronRight className="h-5 w-5 shrink-0" />}
                  <span className="truncate">{t('admin.title')}</span>
                </button>
                {adminOpen && (
                  <SidebarGroupContent>
                    <SidebarMenu>
                      {adminNavItems.map((item) => {
                        const Icon = item.icon;
                        return (
                          <SidebarMenuItem key={item.pathForLink}>
                            <SidebarMenuButton
                              asChild
                              isActive={pathname === item.pathForActive}
                              tooltip={item.label}
                              className={navItemClass}
                            >
                              <Link
                                to={item.pathForLink}
                                onClick={handleNavClick}
                                aria-current={pathname === item.pathForActive ? 'page' : undefined}
                              >
                                <Icon className="shrink-0" />
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

        <SidebarFooter className="gap-2 border-t border-ghost pt-3">
          <SidebarGroup className="p-0">
            <SidebarGroupContent>
              <SidebarMenu>
                <SidebarMenuItem>
                  <SidebarMenuButton asChild tooltip="GitHub Repository">
                    <a
                      href="https://github.com/mdg-labs/slugbase"
                      target="_blank"
                      rel="noopener noreferrer"
                      aria-label="GitHub Repository"
                    >
                      <Github className="h-5 w-5 shrink-0" />
                      <span>GitHub</span>
                      {version && state === 'expanded' && (
                        <span className="ml-1 truncate font-mono text-xs text-muted-foreground">{version}</span>
                      )}
                    </a>
                  </SidebarMenuButton>
                </SidebarMenuItem>
                {!isMobile && (
                  <SidebarMenuItem>
                    <SidebarMenuButton
                      onClick={toggleSidebar}
                      tooltip={state === 'collapsed' ? t('common.expandSidebar') : t('common.collapseSidebar')}
                      aria-label={state === 'collapsed' ? t('common.expandSidebar') : t('common.collapseSidebar')}
                    >
                      {state === 'collapsed' ? <ChevronRight className="h-5 w-5 shrink-0" /> : <ChevronLeft className="h-5 w-5 shrink-0" />}
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
