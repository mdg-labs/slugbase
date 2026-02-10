import { Outlet, Link, useLocation } from 'react-router-dom';
import { Suspense, useEffect, useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { useTranslation } from 'react-i18next';
import { Bookmark, Folder, Tag, LogOut, Settings, Share2, Github, RotateCcw, Plus } from 'lucide-react';
import Button from './ui/Button';
import GlobalSearch from './GlobalSearch';
import { useConfirmDialog } from '../hooks/useConfirmDialog';
import ConfirmDialog from './ui/ConfirmDialog';
import { useToast } from './ui/Toast';
import api from '../api/client';
import { appBasePath } from '../config/api';

export default function Layout() {
  const { user, logout } = useAuth();
  const { t } = useTranslation();
  const location = useLocation();
  const [version, setVersion] = useState<string | null>(null);
  const [demoMode, setDemoMode] = useState<boolean>(false);
  const [resetting, setResetting] = useState<boolean>(false);
  const { showConfirm, dialogState } = useConfirmDialog();
  const { showToast } = useToast();

  const handleResetDemo = async () => {
    try {
      setResetting(true);
      await api.post('/admin/demo-reset');
      showToast(t('common.resetDemoSuccess'), 'success');
      // Reload the page after a short delay to show fresh demo data
      setTimeout(() => {
        window.location.reload();
      }, 1500);
    } catch (error: any) {
      console.error('Failed to reset demo:', error);
      showToast(error.response?.data?.error || t('common.resetDemoError'), 'error');
    } finally {
      setResetting(false);
    }
  };

  const handleResetClick = () => {
    showConfirm(
      t('common.resetDemoConfirm'),
      t('common.resetDemoMessage'),
      handleResetDemo,
      { variant: 'warning', confirmText: t('common.resetDemo') }
    );
  };

  const navItems = [
    { path: `${appBasePath}/bookmarks`, label: t('bookmarks.title'), icon: Bookmark },
    { path: `${appBasePath}/folders`, label: t('folders.title'), icon: Folder },
    { path: `${appBasePath}/tags`, label: t('tags.title'), icon: Tag },
    { path: `${appBasePath}/shared`, label: t('shared.title'), icon: Share2 },
    ...(user?.is_admin ? [{ path: `${appBasePath}/admin`, label: t('admin.title'), icon: Settings }] : []),
  ];

  useEffect(() => {
    // Fetch version and demo mode status on mount
    api.get('/version')
      .then(res => {
        if (res.data.commit) {
          setVersion(res.data.commit.substring(0, 7)); // Show short commit hash
        }
        if (res.data.demoMode) {
          setDemoMode(res.data.demoMode);
        }
      })
      .catch(() => {
        // Silently fail if version endpoint is not available
      });
  }, []);

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900 flex flex-col">
      {/* Demo Mode Banner */}
      {demoMode && (
        <div className="bg-amber-500 dark:bg-amber-600 text-white px-4 py-2 text-center text-sm font-medium">
          <span className="font-bold">{t('common.demoMode')}</span>
          {' - '}
          {t('common.demoModeDescription')}
        </div>
      )}
      {/* Navigation */}
      <nav className="bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 shadow-sm">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center h-16">
            {/* Logo & Navigation */}
            <div className="flex items-center gap-8">
              <Link
                to={appBasePath || '/'}
                className="flex items-center gap-2 text-xl font-bold text-gray-900 dark:text-white hover:text-blue-600 dark:hover:text-blue-400 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 rounded-lg dark:focus-visible:ring-offset-gray-800"
              >
                <img
                  src="/slugbase_icon_blue.svg"
                  alt=""
                  className="h-12 w-12 dark:hidden"
                />
                <img
                  src="/slugbase_icon_white.svg"
                  alt=""
                  className="h-12 w-12 hidden dark:block"
                />
                {t('app.name')}
              </Link>
              <div className="hidden md:flex items-center gap-1">
                {navItems.map((item) => {
                  const Icon = item.icon;
                  const isActive = location.pathname === item.path;
                  return (
                    <Link
                      key={item.path}
                      to={item.path}
                      className={`inline-flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-gray-800 ${
                        isActive
                          ? 'text-blue-600 dark:text-blue-400 border-b-2 border-blue-600 dark:border-blue-400'
                          : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200'
                      }`}
                    >
                      <Icon className="h-4 w-4" />
                      {item.label}
                    </Link>
                  );
                })}
              </div>
            </div>

            {/* Search & User Menu */}
            <div className="flex items-center gap-4">
              <Link to={`${appBasePath}/bookmarks?create=true`}>
                <Button variant="primary" size="sm" icon={Plus}>
                  <span className="hidden sm:inline">{t('bookmarks.create')}</span>
                </Button>
              </Link>
              <GlobalSearch />
              <Link
                to={`${appBasePath}/profile`}
                className="hidden sm:block text-sm font-medium text-gray-700 dark:text-gray-300 hover:text-blue-600 dark:hover:text-blue-400 transition-colors cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 rounded dark:focus-visible:ring-offset-gray-800"
              >
                {user?.name}
              </Link>
              <Button variant="ghost" size="sm" icon={LogOut} onClick={logout}>
                <span className="hidden sm:inline">{t('auth.logout')}</span>
              </Button>
            </div>
          </div>
        </div>
      </nav>

      {/* Main Content */}
      <main className="flex-1 max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 w-full">
        <Suspense fallback={
          <div className="min-h-[400px] flex items-center justify-center">
            <div className="text-gray-500 dark:text-gray-400">{t('common.loading')}</div>
          </div>
        }>
          <Outlet />
        </Suspense>
      </main>

      {/* Footer */}
      <footer className="bg-white dark:bg-gray-800 border-t border-gray-200 dark:border-gray-700">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4">
          <div className="flex justify-center items-center gap-3">
            <a
              href="https://github.com/ghotso/slugbase"
              target="_blank"
              rel="noopener noreferrer"
              className="text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200 transition-colors"
              aria-label="GitHub Repository"
            >
              <Github className="h-5 w-5" />
            </a>
            {version && (
              <span className="text-xs text-gray-500 dark:text-gray-400 font-mono">
                {version}
              </span>
            )}
            {/* Demo Reset Button - Only visible in demo mode for admins */}
            {demoMode && user?.is_admin && (
              <>
                <span className="text-gray-400 dark:text-gray-600">|</span>
                <Button
                  variant="ghost"
                  size="sm"
                  icon={RotateCcw}
                  onClick={handleResetClick}
                  disabled={resetting}
                  className="text-amber-600 dark:text-amber-400 hover:text-amber-700 dark:hover:text-amber-300"
                >
                  <span className="hidden sm:inline">{t('common.resetDemo')}</span>
                </Button>
              </>
            )}
          </div>
        </div>
      </footer>

      {/* Confirm Dialog */}
      <ConfirmDialog
        isOpen={dialogState.isOpen}
        title={dialogState.title}
        message={dialogState.message}
        confirmText={dialogState.confirmText}
        cancelText={dialogState.cancelText}
        variant={dialogState.variant}
        onConfirm={dialogState.onConfirm}
        onCancel={dialogState.onCancel}
      />
    </div>
  );
}
