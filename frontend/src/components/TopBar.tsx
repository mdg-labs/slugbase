import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Plus } from 'lucide-react';
import Button from './ui/Button';
import GlobalSearch from './GlobalSearch';
import UserDropdown from './UserDropdown';
import { SidebarTrigger, useSidebar } from './ui/sidebar';
import { useAppConfig } from '../contexts/AppConfigContext';
import type { User } from '../contexts/AuthContext';

interface TopBarProps {
  user: User | null;
}

export default function TopBar({ user }: TopBarProps) {
  const { t } = useTranslation();
  const { appBasePath } = useAppConfig();
  const { isMobile } = useSidebar();

  return (
    <header className="sticky top-0 z-50 flex h-14 shrink-0 items-center gap-2 border-b bg-background px-4 lg:h-16 lg:px-6">
      <div className="flex flex-1 items-center justify-between gap-4">
        {/* Left: SidebarTrigger (mobile) + Logo */}
        <div className="flex items-center gap-3">
          {isMobile && (
            <SidebarTrigger className="-ml-2" aria-label={t('common.expandSidebar')} />
          )}
          <Link
            to={appBasePath || '/'}
            className="flex items-center gap-2 text-xl font-bold text-foreground hover:text-primary transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-lg"
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
