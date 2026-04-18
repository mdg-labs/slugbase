import { Outlet } from 'react-router-dom';
import { Suspense, useEffect, useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { useTranslation } from 'react-i18next';
import { SearchCommandProvider } from '../contexts/SearchCommandContext';
import { SidebarProvider, SidebarInset } from './ui/sidebar';
import TopBar from './TopBar';
import AppSidebar from './AppSidebar';
import GlobalSearch from './GlobalSearch';
import api from '../api/client';

const SIDEBAR_COLLAPSED_KEY = 'slugbase_sidebar_collapsed';

export default function Layout() {
  const { user } = useAuth();
  const { t } = useTranslation();
  const [version, setVersion] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(
    () => localStorage.getItem(SIDEBAR_COLLAPSED_KEY) !== 'true'
  );

  useEffect(() => {
    localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(!sidebarOpen));
  }, [sidebarOpen]);

  useEffect(() => {
    api
      .get('/version')
      .then((res) => {
        if (res.data.commit) {
          setVersion(res.data.commit.substring(0, 7));
        }
      })
      .catch(() => {});
  }, []);

  return (
    <SearchCommandProvider>
      <SidebarProvider
        open={sidebarOpen}
        onOpenChange={setSidebarOpen}
        className="app flex min-h-svh w-full flex-col overflow-hidden bg-bg-0"
      >
        <GlobalSearch />
        <div className="app-main flex min-h-0 flex-1 overflow-hidden md:grid md:grid-cols-[240px_minmax(0,1fr)]">
          <AppSidebar user={user} version={version} />
          <SidebarInset className="main relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-bg-0">
          <TopBar user={user} />
          <div className="min-h-0 flex-1 overflow-y-auto">
            <div className="min-h-full w-full px-[26px] pb-10 pt-[22px]">
              <Suspense
                fallback={
                  <div className="flex min-h-[400px] items-center justify-center">
                    <div className="text-fg-2">{t('common.loading')}</div>
                  </div>
                }
              >
                <Outlet />
              </Suspense>
            </div>
          </div>
        </SidebarInset>
        </div>
      </SidebarProvider>
    </SearchCommandProvider>
  );
}
