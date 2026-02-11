import { useState, useEffect } from 'react';
import { useAuth } from '../contexts/AuthContext';

const THEME_STORAGE_KEY = 'slugbase_theme';

function getIsDark(): boolean {
  return document.documentElement.classList.contains('dark');
}

function applyThemeToDocument(theme: 'light' | 'dark') {
  const root = document.documentElement;
  root.dataset.userTheme = 'true';
  localStorage.setItem(THEME_STORAGE_KEY, theme);
  if (theme === 'dark') {
    root.classList.add('dark');
  } else {
    root.classList.remove('dark');
  }
}

export function useMarketingTheme() {
  const { user, updateUser } = useAuth();
  const [isDark, setIsDark] = useState(getIsDark);

  useEffect(() => {
    const root = document.documentElement;
    const observer = new MutationObserver(() => setIsDark(getIsDark()));
    observer.observe(root, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  function setTheme(theme: 'light' | 'dark') {
    if (user) {
      updateUser({ theme });
    } else {
      applyThemeToDocument(theme);
      setIsDark(theme === 'dark');
    }
  }

  function toggleTheme() {
    const nextTheme: 'light' | 'dark' = isDark ? 'light' : 'dark';
    setTheme(nextTheme);
  }

  return { isDark, setTheme, toggleTheme };
}
