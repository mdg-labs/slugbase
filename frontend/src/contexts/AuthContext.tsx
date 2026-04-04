import React, { createContext, useContext, useState, useEffect } from 'react';
import api from '../api/client';
import { getAuthProviderUrl } from '../config/api';
import { useTranslation } from 'react-i18next';
import { resolveSupportedLocale } from '../i18n';
import { useAppConfig } from './AppConfigContext';

export interface User {
  id: string;
  email: string;
  name: string;
  user_key: string;
  is_admin: boolean;
  /** Cloud only: owner or admin of current organization (from session org). */
  workspace_admin?: boolean;
  language: string;
  theme: string;
  ai_suggestions_enabled?: boolean;
  email_pending?: string | null;
  oidc_provider?: string | null;
  oidc_sub?: string | null;
  /** Present from GET /auth/me when authenticated. */
  mfa_enabled?: boolean;
}

interface AuthContextType {
  user: User | null;
  loading: boolean;
  login: (provider: string) => void;
  logout: () => Promise<void>;
  updateUser: (updates: Partial<User>) => Promise<void>;
  checkAuth: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const { i18n } = useTranslation();
  const { apiBaseUrl } = useAppConfig();

  useEffect(() => {
    // Apply initial theme based on browser preference before checking auth
    // This ensures dark mode works on login page and other public pages
    // Only apply if user hasn't set a preference yet
    const root = document.documentElement;
    if (!root.dataset.userTheme) {
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      if (prefersDark) {
        root.classList.add('dark');
      } else {
        root.classList.remove('dark');
      }
    }
    
    checkAuth();
  }, []);

  useEffect(() => {
    if (user) {
      i18n.changeLanguage(resolveSupportedLocale(user.language));
      applyTheme(user.theme);
    }
  }, [user, i18n]);

  async function checkAuth() {
    try {
      const response = await api.get('/auth/me');
      setUser(response.data);
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }

  function login(provider: string) {
    window.location.href = getAuthProviderUrl(provider, apiBaseUrl);
  }

  async function logout() {
    try {
      await api.post('/auth/logout');
      setUser(null);
      window.location.href = '/';
    } catch (error) {
      console.error('Logout error:', error);
    }
  }

  async function updateUser(updates: Partial<User>): Promise<any> {
    try {
      const response = await api.put('/users/me', updates);
      // Only update user if email wasn't changed (email verification required)
      if (!response.data.emailVerificationRequired) {
        setUser(response.data);
      } else {
        // Refresh user to get email_pending
        await checkAuth();
      }
      if (updates.language) {
        i18n.changeLanguage(resolveSupportedLocale(updates.language));
      }
      if (updates.theme) {
        applyTheme(updates.theme);
      }
      return response.data;
    } catch (error) {
      console.error('Update user error:', error);
      throw error;
    }
  }

  function applyTheme(theme: string) {
    const root = document.documentElement;
    // Mark that user has set a theme preference
    root.dataset.userTheme = 'true';
    
    if (theme === 'dark' || (theme === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
      root.classList.add('dark');
    } else {
      root.classList.remove('dark');
    }
    // Sync to localStorage for consistency when user logs out
    localStorage.setItem('slugbase_theme', theme);
  }

  return (
    <AuthContext.Provider value={{ user, loading, login, logout, updateUser, checkAuth }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
