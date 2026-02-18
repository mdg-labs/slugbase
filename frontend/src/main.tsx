import './instrument'
import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.tsx'
import './index.css'
import './i18n'

// Apply initial dark mode: localStorage (anonymous users) > browser preference
const root = document.documentElement;
const storedTheme = localStorage.getItem('slugbase_theme');
if (storedTheme === 'dark') {
  root.classList.add('dark');
  root.dataset.userTheme = 'true';
} else if (storedTheme === 'light') {
  root.classList.remove('dark');
  root.dataset.userTheme = 'true';
} else {
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  if (prefersDark) {
    root.classList.add('dark');
  } else {
    root.classList.remove('dark');
  }
}

// Listen for changes to browser preference
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
  // Only apply if user hasn't set a preference (i.e., no user logged in or theme is 'auto')
  const root = document.documentElement;
  const hasUserTheme = root.dataset.userTheme === 'true';
  if (!hasUserTheme) {
    if (e.matches) {
      root.classList.add('dark');
    } else {
      root.classList.remove('dark');
    }
  }
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
