import { Link, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  Bookmark,
  Folder,
  Tag,
  Share2,
  Settings,
  LayoutDashboard,
  ChevronLeft,
  ChevronRight,
  Github,
  Users,
  UserCog,
  Key,
  Sparkles,
} from 'lucide-react';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarSeparator,
  useSidebar,
} from './ui/sidebar';
import { useAppConfig } from '../contexts/AppConfigContext';
import type { User } from '../contexts/AuthContext';

interface AppSidebarProps {
  user: User | null;
  version?: string | null;
}

export default function AppSidebar({ user, version = null }: AppSidebarProps) {
  const { t } = useTranslation();
  const location = useLocation();
  const pathname = location.pathname;
  const { appBasePath } = useAppConfig();
  const { setOpenMobile, toggleSidebar, isMobile, state } = useSidebar();
  const adminBase = `${appBasePath || ''}/admin`;

  const adminNavItems = [
    { path: `${adminBase}/members`, label: t('admin.users'), icon: Users },
    { path: `${adminBase}/teams`, label: t('admin.teams'), icon: UserCog },
    { path: `${adminBase}/oidc`, label: t('admin.oidcProviders'), icon: Key },
    { path: `${adminBase}/settings`, label: t('admin.settings'), icon: Settings },
    { path: `${adminBase}/ai`, label: t('admin.ai.nav'), icon: Sparkles },
  ];

  const isOverviewActive =
    pathname === appBasePath ||
    pathname === appBasePath + '/' ||
    pathname === (appBasePath || '/');

  const showAdmin = user?.is_admin;

  const primaryNavItems = [
    { path: appBasePath || '/', label: t('dashboard.overview'), icon: LayoutDashboard },
    { path: `${appBasePath}/bookmarks`, label: t('bookmarks.title'), icon: Bookmark },
    { path: `${appBasePath}/folders`, label: t('folders.title'), icon: Folder },
    { path: `${appBasePath}/tags`, label: t('tags.title'), icon: Tag },
    { path: `${appBasePath}/shared`, label: t('shared.title'), icon: Share2 },
  ];

  const handleNavClick = () => {
    if (isMobile) {
      setOpenMobile(false);
    }
  };

  return (
    <Sidebar collapsible="icon" side="left">
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {primaryNavItems.map((item) => (
                <SidebarMenuItem key={item.path}>
                  <SidebarMenuButton
                    asChild
                    isActive={
                      item.path === (appBasePath || '/') ? isOverviewActive : pathname === item.path
                    }
                    tooltip={item.label}
                  >
                    <Link to={item.path} onClick={handleNavClick} aria-current={pathname === item.path ? 'page' : undefined}>
                      <item.icon className="h-5 w-5" />
                      <span>{item.label}</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        {showAdmin && (
          <>
            <SidebarSeparator />
            <SidebarGroup>
              <SidebarGroupLabel>{t('admin.title')}</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  {adminNavItems.map((item) => {
                    const Icon = item.icon;
                    return (
                      <SidebarMenuItem key={item.path}>
                        <SidebarMenuButton
                          asChild
                          isActive={pathname === item.path}
                          tooltip={item.label}
                        >
                          <Link
                            to={item.path}
                            onClick={handleNavClick}
                            aria-current={pathname === item.path ? 'page' : undefined}
                          >
                            <Icon className="h-5 w-5" />
                            <span>{item.label}</span>
                          </Link>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    );
                  })}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          </>
        )}
      </SidebarContent>

      <SidebarFooter>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  asChild
                  tooltip="GitHub Repository"
                >
                  <a
                    href="https://github.com/mdg-labs/slugbase"
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label="GitHub Repository"
                  >
                    <Github className="h-5 w-5" />
                    <span>GitHub</span>
                    {version && state === 'expanded' && (
                      <span className="ml-1 truncate text-xs text-muted-foreground font-mono">
                        {version}
                      </span>
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
                    {state === 'collapsed' ? (
                      <ChevronRight className="h-5 w-5" />
                    ) : (
                      <ChevronLeft className="h-5 w-5" />
                    )}
                    <span>{t('common.collapseSidebar')}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              )}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarFooter>
    </Sidebar>
  );
}
