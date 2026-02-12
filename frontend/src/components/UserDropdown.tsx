import { useState, useRef, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { User as UserIcon, LogOut, Settings } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { appBasePath } from '../config/api';
import { isCloud } from '../config/mode';
import type { User } from '../contexts/AuthContext';

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
  const { logout } = useAuth();
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const showAdmin =
    user?.is_admin || (isCloud && (user?.org_role === 'owner' || user?.org_role === 'admin'));

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [isOpen]);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setIsOpen(false);
      }
    }

    if (isOpen) {
      document.addEventListener('keydown', handleKeyDown);
      return () => document.removeEventListener('keydown', handleKeyDown);
    }
  }, [isOpen]);

  if (!user) return null;

  return (
    <div ref={dropdownRef} className="relative">
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center justify-center w-9 h-9 rounded-full bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-200 font-medium text-sm hover:bg-gray-300 dark:hover:bg-gray-600 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-gray-800"
        aria-haspopup="menu"
        aria-expanded={isOpen}
        aria-label={t('profile.title')}
      >
        {user.name ? (
          getInitials(user.name)
        ) : (
          <UserIcon className="h-5 w-5" />
        )}
      </button>

      {isOpen && (
        <>
          <div
            className="fixed inset-0 z-10"
            onClick={() => setIsOpen(false)}
            aria-hidden="true"
          />
          <div
            role="menu"
            className="absolute right-0 mt-2 w-48 py-1 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg z-50"
          >
            <div className="px-4 py-2 border-b border-gray-200 dark:border-gray-700">
              <p className="text-sm font-medium text-gray-900 dark:text-white truncate">
                {user.name}
              </p>
              <p className="text-xs text-gray-500 dark:text-gray-400 truncate">{user.email}</p>
            </div>

            <Link
              to={`${appBasePath}/profile`}
              role="menuitem"
              onClick={() => setIsOpen(false)}
              className="flex items-center gap-2 px-4 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
            >
              <UserIcon className="h-4 w-4" />
              {t('profile.title')}
            </Link>

            {showAdmin && (
              <Link
                to={`${appBasePath}/admin`}
                role="menuitem"
                onClick={() => setIsOpen(false)}
                className="flex items-center gap-2 px-4 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
              >
                <Settings className="h-4 w-4" />
                {t('admin.title')}
              </Link>
            )}

            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setIsOpen(false);
                logout();
              }}
              className="flex items-center gap-2 w-full px-4 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors text-left"
            >
              <LogOut className="h-4 w-4" />
              {t('auth.logout')}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
