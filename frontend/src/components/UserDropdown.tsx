import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { User as UserIcon, LogOut } from 'lucide-react';
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

  if (!user) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="avatar flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent-bg text-[11px] font-semibold text-accent-hi transition-opacity hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring focus-visible:ring-offset-2 focus-visible:ring-offset-bg-0"
          aria-haspopup="menu"
          aria-label={t('profile.title')}
        >
          {user.name ? (
            getInitials(user.name)
          ) : (
            <UserIcon className="h-5 w-5 text-accent-hi" strokeWidth={1.75} />
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="w-56 rounded-lg border border-border bg-bg-2 p-1 text-fg-0 shadow-lg"
      >
        <DropdownMenuLabel className="px-2 py-1.5 text-fg-0">
          <div className="flex flex-col gap-1">
            <p className="text-sm font-medium leading-none text-fg-0">{user.name}</p>
            <p className="text-xs leading-none text-fg-2">{user.email}</p>
          </div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator className="bg-border" />
        <DropdownMenuItem
          asChild
          className="h-7 cursor-pointer rounded-md px-3 py-0 text-sm text-fg-0 focus:bg-bg-hover data-[highlighted]:bg-bg-hover data-[highlighted]:text-fg-0"
        >
          <Link to={`${prefix}/profile`} className="flex w-full cursor-pointer items-center gap-2">
            <UserIcon className="h-4 w-4 shrink-0" strokeWidth={1.75} />
            {t('profile.title')}
          </Link>
        </DropdownMenuItem>
        <DropdownMenuSeparator className="bg-border" />
        <DropdownMenuItem
          onClick={() => logout()}
          className="h-7 cursor-pointer rounded-md px-3 py-0 text-sm text-destructive focus:bg-[rgba(248,113,113,0.12)] data-[highlighted]:bg-[rgba(248,113,113,0.12)] data-[highlighted]:text-destructive"
        >
          <LogOut className="h-4 w-4 shrink-0" strokeWidth={1.75} />
          {t('auth.logout')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
