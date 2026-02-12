import { Outlet } from 'react-router-dom';
import { Suspense, useEffect, useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { useTranslation } from 'react-i18next';
import { SidebarProvider, SidebarInset } from './ui/sidebar';
import TopBar from './TopBar';
import AppSidebar from './AppSidebar';
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
    api.get('/version')
      .then((res) => {
        if (res.data.commit) {
          setVersion(res.data.commit.substring(0, 7));
        }
      })
      .catch(() => {});
  }, []);

  return (
    <SidebarProvider open={sidebarOpen} onOpenChange={setSidebarOpen}>
      <AppSidebar user={user} version={version} />
      <SidebarInset>
        <TopBar user={user} />
        <div className="flex-1 min-h-0 overflow-auto">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 w-full min-h-full">
            <Suspense
              fallback={
                <div className="min-h-[400px] flex items-center justify-center">
                  <div className="text-muted-foreground">{t('common.loading')}</div>
                </div>
              }
            >
              <Outlet />
            </Suspense>
          </div>
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}
