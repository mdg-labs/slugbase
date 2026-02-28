import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { User as UserIcon, LogOut, Settings } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { useAppConfig } from '../contexts/AppConfigContext';
import type { User } from '../contexts/AuthContext';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './ui/dropdown-menu';

interface UserDropdownProps {
  user: User | null;
}

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }
  return name.slice(0, 2).toUpperCase();
}

export default function UserDropdown({ user }: UserDropdownProps) {
  const { t } = useTranslation();
  const { pathPrefixForLinks } = useAppConfig();
  const prefix = (pathPrefixForLinks || '').replace(/\/+/g, '/') || '';
  const { logout } = useAuth();

  const showAdmin = !!(user?.is_admin);

  if (!user) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="flex items-center justify-center w-9 h-9 rounded-full bg-secondary text-secondary-foreground font-medium text-sm hover:bg-accent hover:text-accent-foreground transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          aria-haspopup="menu"
          aria-label={t('profile.title')}
        >
          {user.name ? (
            getInitials(user.name)
          ) : (
            <UserIcon className="h-5 w-5" />
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel>
          <div className="flex flex-col space-y-1">
            <p className="text-sm font-medium leading-none">{user.name}</p>
            <p className="text-xs leading-none text-muted-foreground">{user.email}</p>
          </div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link to={`${prefix}/profile`} className="flex items-center gap-2 cursor-pointer">
            <UserIcon className="h-4 w-4" />
            {t('profile.title')}
          </Link>
        </DropdownMenuItem>
        {showAdmin && (
          <DropdownMenuItem asChild>
            <Link to={`${prefix}/admin`.replace(/\/+/g, '/') || '/admin'} className="flex items-center gap-2 cursor-pointer">
              <Settings className="h-4 w-4" />
              {t('admin.title')}
            </Link>
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={() => logout()}
          className="flex items-center gap-2 cursor-pointer text-destructive focus:text-destructive"
        >
          <LogOut className="h-4 w-4" />
          {t('auth.logout')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
