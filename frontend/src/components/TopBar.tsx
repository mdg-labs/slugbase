import { useTranslation } from 'react-i18next';
import { SidebarTrigger, useSidebar } from './ui/sidebar';
import UserDropdown from './UserDropdown';
import { Breadcrumbs } from './Breadcrumbs';
import type { User } from '../contexts/AuthContext';

interface TopBarProps {
  user: User | null;
}

export default function TopBar({ user }: TopBarProps) {
  const { t } = useTranslation();
  const { isMobile } = useSidebar();

  return (
    <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-4 border-b border-ghost bg-background/80 px-4 backdrop-blur-xl supports-[backdrop-filter]:bg-background/65 lg:h-16 lg:px-8">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        {isMobile && (
          <SidebarTrigger className="-ml-1 shrink-0" aria-label={t('common.expandSidebar')} />
        )}
        <Breadcrumbs />
      </div>
      <div className="flex shrink-0 items-center gap-1 sm:gap-2">
        <UserDropdown user={user} />
      </div>
    </header>
  );
}
