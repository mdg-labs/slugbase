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
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import Tooltip from './ui/Tooltip';
import { appBasePath } from '../config/api';
import { isCloud } from '../config/mode';
import type { User } from '../contexts/AuthContext';

interface SidebarNavItemProps {
  to: string;
  icon: LucideIcon;
  label: string;
  isActive: boolean;
  isCollapsed: boolean;
  onClick?: () => void;
}

function SidebarNavItem({ to, icon: Icon, label, isActive, isCollapsed, onClick }: SidebarNavItemProps) {
  const baseClasses =
    'flex items-center gap-3 rounded-lg text-sm font-medium transition-colors w-full focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-gray-800 flex-shrink-0 min-h-[40px]';
  const activeClasses =
    'text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/20 border-l-2 border-blue-600 dark:border-blue-400';
  const inactiveClasses =
    'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700/50 border-l-2 border-transparent';

  const linkContent = (
    <Link
      to={to}
      onClick={onClick}
      className={`${baseClasses} ${isActive ? activeClasses : inactiveClasses} ${
        isCollapsed ? 'justify-center px-0' : 'px-3'
      }`}
      aria-current={isActive ? 'page' : undefined}
    >
      <Icon className="h-5 w-5 flex-shrink-0" />
      <span
        className={`overflow-hidden whitespace-nowrap transition-all duration-300 ease-in-out ${
          isCollapsed ? 'max-w-0 min-w-0 opacity-0' : 'max-w-[180px] opacity-100'
        }`}
      >
        {label}
      </span>
    </Link>
  );

  const wrapper = (
    <div className={`flex flex-shrink-0 ${isCollapsed ? 'justify-center' : 'justify-start'}`}>
      {linkContent}
    </div>
  );

  if (isCollapsed) {
    return (
      <Tooltip content={label} position="right">
        {wrapper}
      </Tooltip>
    );
  }

  return wrapper;
}

interface SidebarProps {
  isCollapsed: boolean;
  onToggleCollapse: () => void;
  isMobileOpen: boolean;
  onMobileClose: () => void;
  isMobile: boolean;
  user: User | null;
  version?: string | null;
}

export default function Sidebar({
  isCollapsed,
  onToggleCollapse,
  isMobileOpen,
  onMobileClose,
  isMobile,
  user,
  version = null,
}: SidebarProps) {
  const { t } = useTranslation();
  const location = useLocation();
  const pathname = location.pathname;

  const isOverviewActive = pathname === appBasePath || pathname === appBasePath + '/' || pathname === (appBasePath || '/');

  const showAdmin =
    user?.is_admin || (isCloud && (user?.org_role === 'owner' || user?.org_role === 'admin'));

  const primaryNavItems = [
    { path: appBasePath || '/', label: t('dashboard.overview'), icon: LayoutDashboard },
    { path: `${appBasePath}/bookmarks`, label: t('bookmarks.title'), icon: Bookmark },
    { path: `${appBasePath}/folders`, label: t('folders.title'), icon: Folder },
    { path: `${appBasePath}/tags`, label: t('tags.title'), icon: Tag },
    { path: `${appBasePath}/shared`, label: t('shared.title'), icon: Share2 },
  ];

  const sidebarContent = (
    <>
      <nav
        className="flex flex-col flex-1 py-4 overflow-y-auto"
        aria-label="Main navigation"
      >
        <div className="px-3 space-y-1 flex flex-col">
          {primaryNavItems.map((item) => (
            <SidebarNavItem
              key={item.path}
              to={item.path}
              icon={item.icon}
              label={item.label}
              isActive={
                item.path === (appBasePath || '/') ? isOverviewActive : pathname === item.path
              }
              isCollapsed={isCollapsed && !isMobile}
              onClick={isMobile ? onMobileClose : undefined}
            />
          ))}
        </div>

        {showAdmin && (
          <>
            <div className="my-2 border-t border-gray-200 dark:border-gray-700" />
            <div className="px-3 space-y-1 flex flex-col">
              <SidebarNavItem
                to={`${appBasePath}/admin`}
                icon={Settings}
                label={t('admin.title')}
                isActive={pathname === `${appBasePath}/admin`}
                isCollapsed={isCollapsed && !isMobile}
                onClick={isMobile ? onMobileClose : undefined}
              />
            </div>
          </>
        )}

        {!isMobile && (
          <div className="flex-1" />
        )}

        {/* GitHub link, version */}
        <div className="pt-4 pb-2 px-3 border-t border-gray-200 dark:border-gray-700 space-y-2 flex-shrink-0">
          <div className={`flex items-center gap-2 ${(isCollapsed && !isMobile) || (!version && !isMobile) ? 'justify-center' : ''}`}>
            {isCollapsed && !isMobile ? (
              <Tooltip content="GitHub Repository" position="right">
                <a
                  href="https://github.com/mdg-labs/slugbase"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center justify-center w-10 h-10 rounded-lg text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700/50 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
                  aria-label="GitHub Repository"
                >
                  <Github className="h-5 w-5" />
                </a>
              </Tooltip>
            ) : (
              <>
                <a
                  href="https://github.com/mdg-labs/slugbase"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700/50 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
                  aria-label="GitHub Repository"
                >
                  <Github className="h-5 w-5" />
                  <span className="truncate">GitHub</span>
                </a>
                {version && (
                  <span className="text-xs text-gray-500 dark:text-gray-400 font-mono ml-1 truncate">
                    {version}
                  </span>
                )}
              </>
            )}
          </div>
        </div>

        {/* Collapse toggle - at the very bottom */}
        {!isMobile && (
          <div className="pt-2 pb-3 px-3 border-t border-gray-200 dark:border-gray-700 flex-shrink-0">
            <button
              type="button"
              onClick={onToggleCollapse}
              className={`flex items-center w-full gap-3 py-2 text-sm font-medium text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700/50 rounded-lg transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-gray-800 ${
                isCollapsed ? 'justify-center px-0' : 'justify-start px-3'
              }`}
              aria-label={isCollapsed ? t('common.expandSidebar') : t('common.collapseSidebar')}
            >
              {isCollapsed ? (
                <ChevronRight className="h-5 w-5 flex-shrink-0" />
              ) : (
                <ChevronLeft className="h-5 w-5 flex-shrink-0" />
              )}
              <span
                className={`overflow-hidden whitespace-nowrap transition-all duration-300 ease-in-out ${
                  isCollapsed ? 'max-w-0 min-w-0 opacity-0' : 'max-w-[180px] opacity-100'
                }`}
              >
                {t('common.collapseSidebar')}
              </span>
            </button>
          </div>
        )}
      </nav>
    </>
  );

  const sidebarWidthClasses = isMobile ? 'w-60' : isCollapsed ? 'w-16' : 'w-60';
  const baseSidebarClasses =
    'flex flex-col h-full min-h-0 bg-white dark:bg-gray-800 border-r border-gray-200 dark:border-gray-700 flex-shrink-0 overflow-hidden transition-[width] duration-300 ease-in-out';

  if (isMobile) {
    return (
      <>
        {isMobileOpen && (
          <div
            className="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm lg:hidden"
            onClick={onMobileClose}
            aria-hidden="true"
          />
        )}
        <aside
          className={`fixed top-0 left-0 z-50 h-full ${baseSidebarClasses} ${sidebarWidthClasses} shadow-xl transition-transform duration-300 ease-in-out lg:hidden ${
            isMobileOpen ? 'translate-x-0' : '-translate-x-full'
          }`}
        >
          {sidebarContent}
        </aside>
      </>
    );
  }

  return (
    <aside className={`${baseSidebarClasses} ${sidebarWidthClasses}`}>
      {sidebarContent}
    </aside>
  );
}
