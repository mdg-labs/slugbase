import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Menu, Plus } from 'lucide-react';
import Button from './ui/Button';
import GlobalSearch from './GlobalSearch';
import UserDropdown from './UserDropdown';
import { appBasePath } from '../config/api';
import type { User } from '../contexts/AuthContext';

interface TopBarProps {
  onMenuClick: () => void;
  isMobile: boolean;
  user: User | null;
}

export default function TopBar({ onMenuClick, isMobile, user }: TopBarProps) {
  const { t } = useTranslation();

  return (
    <header className="bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 shadow-sm flex-shrink-0">
      <div className="h-14 lg:h-16 px-4 sm:px-6 flex items-center justify-between gap-4">
        {/* Left: Logo + Hamburger (mobile) */}
        <div className="flex items-center gap-3">
          {isMobile && (
            <button
              type="button"
              onClick={onMenuClick}
              className="p-2 -ml-2 text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-gray-800"
              aria-label={t('common.expandSidebar')}
            >
              <Menu className="h-6 w-6" />
            </button>
          )}
          <Link
            to={appBasePath || '/'}
            className="flex items-center gap-2 text-xl font-bold text-gray-900 dark:text-white hover:text-blue-600 dark:hover:text-blue-400 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 rounded-lg dark:focus-visible:ring-offset-gray-800"
          >
            <img
              src="/slugbase_icon_blue.svg"
              alt=""
              className="h-10 w-10 lg:h-12 lg:w-12 dark:hidden"
            />
            <img
              src="/slugbase_icon_white.svg"
              alt=""
              className="h-10 w-10 lg:h-12 lg:w-12 hidden dark:block"
            />
            <span className="hidden sm:inline">{t('app.name')}</span>
          </Link>
        </div>

        {/* Right: Search, Create, User */}
        <div className="flex items-center gap-2 sm:gap-4">
          <Link to={`${appBasePath}/bookmarks?create=true`}>
            <Button variant="primary" size="sm" icon={Plus}>
              <span className="hidden sm:inline">{t('bookmarks.create')}</span>
            </Button>
          </Link>
          <GlobalSearch />
          <UserDropdown user={user} />
        </div>
      </div>
    </header>
  );
}
