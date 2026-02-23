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
  const { pathPrefixForLinks } = useAppConfig();
  const prefix = pathPrefixForLinks || '';
  const { isMobile } = useSidebar();

  return (
    <header className="sticky top-0 z-50 flex h-14 shrink-0 items-center border-b bg-background px-4 lg:h-16 lg:px-6 relative">
      {/* Left: SidebarTrigger (mobile) + Logo — left-aligned */}
      <div className="flex items-center gap-3 shrink-0">
        {isMobile && (
          <SidebarTrigger className="-ml-2" aria-label={t('common.expandSidebar')} />
        )}
        <Link
          to={prefix || '/'}
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

      {/* Center: search bar — truly centered in header */}
      <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-2xl px-4 pointer-events-none">
        <div className="pointer-events-auto w-full">
          <GlobalSearch />
        </div>
      </div>

      {/* Right: Create bookmark + Profile — right-aligned */}
      <div className="flex items-center gap-2 sm:gap-4 shrink-0 ml-auto">
        <Link to={`${prefix}/bookmarks?create=true`.replace(/\/+/g, '/') || '/bookmarks?create=true'}>
          <Button variant="primary" size="sm" icon={Plus}>
            <span className="hidden sm:inline">{t('bookmarks.create')}</span>
          </Button>
        </Link>
        <UserDropdown user={user} />
      </div>
    </header>
  );
}
