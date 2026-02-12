import { Outlet } from 'react-router-dom';
import { Suspense, useEffect, useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { useTranslation } from 'react-i18next';
import TopBar from './TopBar';
import Sidebar from './Sidebar';
import api from '../api/client';

const SIDEBAR_COLLAPSED_KEY = 'slugbase_sidebar_collapsed';
const MOBILE_BREAKPOINT = 1024; // lg

export default function Layout() {
  const { user } = useAuth();
  const { t } = useTranslation();
  const [version, setVersion] = useState<string | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === 'true'
  );
  const [sidebarMobileOpen, setSidebarMobileOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  // Persist sidebar collapsed state
  useEffect(() => {
    localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(sidebarCollapsed));
  }, [sidebarCollapsed]);

  // Mobile breakpoint
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`);
    setIsMobile(mq.matches);
    const handler = () => setIsMobile(mq.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  // ESC to close mobile drawer
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && sidebarMobileOpen) {
        setSidebarMobileOpen(false);
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [sidebarMobileOpen]);

  // Fetch version
  useEffect(() => {
    api.get('/version')
      .then(res => {
        if (res.data.commit) {
          setVersion(res.data.commit.substring(0, 7));
        }
      })
      .catch(() => {});
  }, []);

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900 flex flex-col">
      {/* Top Bar */}
      <TopBar
        onMenuClick={() => setSidebarMobileOpen(true)}
        isMobile={isMobile}
        user={user}
      />

      {/* AppShell: Sidebar + Main Content */}
      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar - hidden on mobile (drawer), docked on desktop */}
        <Sidebar
          isCollapsed={sidebarCollapsed}
          onToggleCollapse={() => setSidebarCollapsed(v => !v)}
          isMobileOpen={sidebarMobileOpen}
          onMobileClose={() => setSidebarMobileOpen(false)}
          isMobile={isMobile}
          user={user}
          version={version}
        />

        {/* Main Content */}
        <main className="flex-1 overflow-auto">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 w-full">
            <Suspense fallback={
              <div className="min-h-[400px] flex items-center justify-center">
                <div className="text-gray-500 dark:text-gray-400">{t('common.loading')}</div>
              </div>
            }>
              <Outlet />
            </Suspense>
          </div>
        </main>
      </div>
    </div>
  );
}
